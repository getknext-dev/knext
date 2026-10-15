package rpc

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"example.com/function/internal/auth"
)

// gzipBomb returns a gzip body that inflates to about a thousand times its
// size: copies of one gzip member holding 1 MiB of zeros (a gzip reader reads
// every member of a concatenated stream), as many as fit in budget bytes.
func gzipBomb(t *testing.T, budget int) (body []byte, inflated int64) {
	t.Helper()
	var member bytes.Buffer
	zw, err := gzip.NewWriterLevel(&member, gzip.BestCompression)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := zw.Write(make([]byte, 1<<20)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	n := budget / member.Len()
	inflated = int64(n) << 20
	if inflated < 1<<30 {
		t.Fatalf("the bomb inflates to only %d bytes; want at least 1 GiB", inflated)
	}
	return bytes.Repeat(member.Bytes(), n), inflated
}

// reportedSize is the inflated size connect-go reports when it refuses an
// oversized message: the bytes it decompressed before giving up.
var reportedSize = regexp.MustCompile(`message size (\d+) is larger than configured max`)

func inflatedBytes(t *testing.T, what, message string) int64 {
	t.Helper()
	m := reportedSize.FindStringSubmatch(message)
	if m == nil {
		t.Fatalf("%s: refusal %q does not report the message size", what, message)
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// The health Check is served without a token, so it is the one procedure any
// pod in the zone can send a body to. A gzip body that fits the read limit but
// inflates to gigabytes is refused once the inflated bytes pass the limit: the
// server stops decompressing there instead of inflating (and discarding) the
// rest. Over the Connect protocol and over gRPC.
func TestGzipBombToHealthCheckIsRefusedInBoundedTime(t *testing.T) {
	f, err := New(Config{JWKSPath: absentJWKS(t)})
	if err != nil {
		t.Fatal(err)
	}
	base := serve(t, f)
	// One message at the limit, compressed: under connect-go's raw read limit
	// (a gRPC envelope adds its 5-byte prefix on top) and the raw body cap.
	bomb, inflated := gzipBomb(t, MaxRequestBytes-16)
	client := h2cClient()
	client.Timeout = 60 * time.Second // the bound asserted below is far tighter

	t.Run("connect", func(t *testing.T) {
		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, base+auth.HealthCheckProcedure, bytes.NewReader(bomb))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/proto")
		req.Header.Set("Content-Encoding", "gzip")
		start := time.Now()
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		elapsed := time.Since(start)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusTooManyRequests || !strings.Contains(string(body), `"resource_exhausted"`) {
			t.Fatalf("gzip bomb: HTTP %d %s; want 429 resource_exhausted", resp.StatusCode, body)
		}
		if n := inflatedBytes(t, "connect", string(body)); n > MaxRequestBytes+1 {
			t.Errorf("the server inflated %d bytes of a %d-byte bomb; want at most %d", n, inflated, MaxRequestBytes+1)
		}
		if elapsed > 3*time.Second {
			t.Errorf("refusing the gzip bomb took %v; want well under 3s", elapsed)
		}
	})

	t.Run("grpc", func(t *testing.T) {
		frame := make([]byte, 5, 5+len(bomb))
		frame[0] = 1 // compressed
		binary.BigEndian.PutUint32(frame[1:], uint32(len(bomb)))
		frame = append(frame, bomb...)
		req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, base+auth.HealthCheckProcedure, bytes.NewReader(frame))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/grpc+proto")
		req.Header.Set("Grpc-Encoding", "gzip")
		req.Header.Set("Te", "trailers")
		start := time.Now()
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.Copy(io.Discard, resp.Body); err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		elapsed := time.Since(start)
		status, message := resp.Trailer.Get("Grpc-Status"), resp.Trailer.Get("Grpc-Message")
		if status == "" {
			status, message = resp.Header.Get("Grpc-Status"), resp.Header.Get("Grpc-Message")
		}
		if status != "8" {
			t.Fatalf("gzip bomb: grpc-status %q %q; want 8 (RESOURCE_EXHAUSTED)", status, message)
		}
		decoded, err := url.PathUnescape(message)
		if err != nil {
			t.Fatal(err)
		}
		if n := inflatedBytes(t, "grpc", decoded); n > MaxRequestBytes+1 {
			t.Errorf("the server inflated %d bytes of a %d-byte bomb; want at most %d", n, inflated, MaxRequestBytes+1)
		}
		if elapsed > 3*time.Second {
			t.Errorf("refusing the gzip bomb took %v; want well under 3s", elapsed)
		}
	})
}

// The decompressor the server mounts ends its stream one byte past the
// message limit, whatever the compressed input would inflate to.
func TestBoundedGzipStopsOneBytePastTheLimit(t *testing.T) {
	bomb, _ := gzipBomb(t, MaxRequestBytes-16)
	r, err := boundedGzip(MaxRequestBytes).Decompress(bytes.NewReader(bomb))
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	n, err := io.Copy(io.Discard, r)
	if err != nil {
		t.Fatal(err)
	}
	if n != MaxRequestBytes+1 {
		t.Errorf("read %d inflated bytes; want exactly %d (the limit plus the byte that detects it)", n, MaxRequestBytes+1)
	}
}

// countingBody counts the request-body bytes the server's handler chain reads.
type countingBody struct {
	io.ReadCloser
	n *atomic.Int64
}

func (c countingBody) Read(p []byte) (int, error) {
	n, err := c.ReadCloser.Read(p)
	c.n.Add(int64(n))
	return n, err
}

// countBodies wraps f's handler (outermost) so a test sees how much of each
// request body the server read off the wire.
func countBodies(f *Function) *atomic.Int64 {
	var n atomic.Int64
	inner := f.HTTP.Handler
	f.HTTP.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = countingBody{ReadCloser: r.Body, n: &n}
		inner.ServeHTTP(w, r)
	})
	return &n
}

// zeros is an endless request body.
type zeros struct{ sent atomic.Int64 }

func (z *zeros) Read(p []byte) (int, error) {
	clear(p)
	z.sent.Add(int64(len(p)))
	return len(p), nil
}

// An endless body is cut off at the request-body cap instead of being read
// (and discarded) for as long as the client keeps sending.
func TestEndlessBodyIsCutOff(t *testing.T) {
	f, err := New(Config{JWKSPath: absentJWKS(t)})
	if err != nil {
		t.Fatal(err)
	}
	read := countBodies(f)
	base := serve(t, f)
	client := h2cClient()
	client.Timeout = 20 * time.Second

	body := new(zeros)
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, base+auth.HealthCheckProcedure, body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/proto")
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("an endless body was not answered (client sent %d bytes): %v", body.sent.Load(), err)
	}
	if _, err := io.Copy(io.Discard, resp.Body); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatalf("an endless body was answered 200")
	}
	if n := read.Load(); n > MaxRequestBodyBytes+1 {
		t.Errorf("the server read %d bytes of an endless body; want at most %d", n, MaxRequestBodyBytes+1)
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("cutting off an endless body took %v; want well under 5s", elapsed)
	}
}

// A body that stops arriving is cut off by the server's ReadTimeout, over h2c
// and HTTP/1.1. The test shortens the timeout so it runs fast; the production
// value is asserted in TestHTTPServerSettings.
func TestSlowBodyIsCutOff(t *testing.T) {
	for _, p := range []struct {
		name   string
		client *http.Client
	}{{"h2c", h2cClient()}, {"HTTP/1.1", http1Client()}} {
		t.Run(p.name, func(t *testing.T) {
			f, err := New(Config{JWKSPath: absentJWKS(t)})
			if err != nil {
				t.Fatal(err)
			}
			f.HTTP.ReadTimeout = 300 * time.Millisecond
			base := serve(t, f)
			p.client.Timeout = 20 * time.Second

			pr, pw := io.Pipe()
			t.Cleanup(func() { pw.Close() })
			go func() { _, _ = pw.Write([]byte("{")) }() // one byte, then nothing
			req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, base+auth.HealthCheckProcedure, pr)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Content-Type", "application/json")
			start := time.Now()
			resp, err := p.client.Do(req)
			if err == nil {
				_, _ = io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					t.Fatalf("a body that stopped arriving was answered 200")
				}
			}
			if elapsed := time.Since(start); elapsed > 5*time.Second {
				t.Errorf("cutting off a stalled body took %v (err %v); want about the 300ms ReadTimeout", elapsed, err)
			}
		})
	}
}

// SIGTERM (the Serve context ending) lets a call already in flight finish:
// the server stops accepting, waits for the call, and only then returns.
func TestInFlightCallSurvivesShutdown(t *testing.T) {
	f, err := New(Config{JWKSPath: absentJWKS(t)})
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{}, 1)
	inner := f.HTTP.Handler
	f.HTTP.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case entered <- struct{}{}:
		default:
		}
		inner.ServeHTTP(w, r)
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	base := "http://" + ln.Addr().String()
	ctx, sigterm := context.WithCancel(context.Background())
	defer sigterm()
	served := make(chan error, 1)
	go func() { served <- f.Serve(ctx, ln) }()

	// The call's body is held open, so the handler is mid-call when SIGTERM
	// arrives.
	pr, pw := io.Pipe()
	defer pw.Close()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, base+auth.HealthCheckProcedure, pr)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	type result struct {
		code int
		body string
		err  error
	}
	results := make(chan result, 1)
	go func() {
		resp, err := h2cClient().Do(req)
		if err != nil {
			results <- result{err: err}
			return
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		results <- result{resp.StatusCode, string(body), err}
	}()
	if _, err := pw.Write([]byte("{")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the call never reached the handler")
	}

	sigterm()
	time.Sleep(300 * time.Millisecond)
	select {
	case err := <-served:
		t.Fatalf("Serve returned %v while a call was in flight; want it to wait for the call", err)
	case r := <-results:
		t.Fatalf("the in-flight call ended before it finished sending: %+v", r)
	default:
	}

	if _, err := pw.Write([]byte("}")); err != nil {
		t.Fatal(err)
	}
	pw.Close()
	select {
	case r := <-results:
		if r.err != nil || r.code != http.StatusOK || !strings.Contains(r.body, "SERVING") {
			t.Fatalf("the in-flight call during shutdown = HTTP %d %q, %v; want 200 SERVING", r.code, r.body, r.err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the in-flight call did not finish within 10s of its body completing")
	}
	select {
	case err := <-served:
		if err != nil {
			t.Fatalf("Serve returned %v after draining; want nil", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Serve did not return within 10s of the drained call")
	}
}
