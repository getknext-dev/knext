package rpc

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect/v2"
	"connectrpc.com/connect/v2/connecthttp"
	"connectrpc.com/connect/v2/connectproto"
	"connectrpc.com/grpchealth/v2"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	examplev1 "example.com/function/gen/example/v1"
	"example.com/function/gen/example/v1/examplev1connect"
	"example.com/function/internal/auth"
)

// acceptOnly is a test verifier that admits exactly one token. It exists only
// in this test file: the binary's wiring (New) has no way to select it.
type acceptOnly string

func (a acceptOnly) Verify(_ context.Context, token, _ string) error {
	if token == string(a) {
		return nil
	}
	return errors.New("test verifier: token refused")
}

// serve starts f on a loopback listener and returns its base URL.
func serve(t *testing.T, f *Function) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- f.Serve(ctx, ln) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("Serve returned %v after shutdown; want nil", err)
			}
		case <-time.After(10 * time.Second):
			t.Error("Serve did not return within 10s of shutdown")
		}
	})
	return "http://" + ln.Addr().String()
}

func absentJWKS(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "jwks", "jwks.json")
}

// h2cClient speaks HTTP/2 without TLS and nothing else, so a passing call
// proves the server accepted h2c (the transport the zone uses by default).
func h2cClient() *http.Client {
	p := new(http.Protocols)
	p.SetUnencryptedHTTP2(true)
	return &http.Client{Transport: &http.Transport{Protocols: p}}
}

// boundedH2C is h2cClient with a whole-request deadline, for the raw scans: a
// procedure that is wrongly SERVED may stream forever (health Watch does), and
// that must red, not hang the suite.
func boundedH2C() *http.Client {
	c := h2cClient()
	c.Timeout = 5 * time.Second
	return c
}

// http1Client speaks HTTP/1.1 only (the per-binding fallback, and gRPC-Web).
func http1Client() *http.Client {
	p := new(http.Protocols)
	p.SetHTTP1(true)
	return &http.Client{Transport: &http.Transport{Protocols: p}}
}

type protocol struct {
	name   string
	client *http.Client
	opts   []connecthttp.Option
}

func protocols() []protocol {
	return []protocol{
		{"connect+proto over h2c", h2cClient(), nil},
		{"connect+json over h2c", h2cClient(), []connecthttp.Option{connecthttp.WithProtoJSON()}},
		{"connect GET over h2c", h2cClient(), []connecthttp.Option{connecthttp.WithHTTPGet()}},
		{"connect+proto over HTTP/1.1", http1Client(), nil},
		{"connect+proto gzip over h2c", h2cClient(), []connecthttp.Option{connecthttp.WithSendGzip()}},
		{"grpc over h2c", h2cClient(), []connecthttp.Option{connecthttp.WithGRPC()}},
		{"grpc-web over HTTP/1.1", http1Client(), []connecthttp.Option{connecthttp.WithGRPCWeb()}},
	}
}

func bearer(t *testing.T, token string) context.Context {
	t.Helper()
	ctx, info := connect.NewClientContext(t.Context())
	info.RequestHeader().Set("Authorization", "Bearer "+token)
	return ctx
}

func wantCode(t *testing.T, what string, err error, code connect.Code) {
	t.Helper()
	if got := connect.CodeOf(err); err == nil || got != code {
		t.Fatalf("%s: err = %v (code %v); want code %v", what, err, got, code)
	}
}

// The Connect conformance of this function's own RPCs: each protocol the
// zone or a tool may use (Connect binary/JSON/GET, gRPC, gRPC-Web, over h2c
// and HTTP/1.1) gets the same answers, error codes included.
func TestProtocolMatrix(t *testing.T) {
	f, err := newFunction(Config{JWKSPath: absentJWKS(t)}, acceptOnly("good"))
	if err != nil {
		t.Fatal(err)
	}
	base := serve(t, f)

	for _, p := range protocols() {
		t.Run(p.name, func(t *testing.T) {
			client := connect.NewClient(connecthttp.NewTransport(p.client, base, p.opts...))
			example := examplev1connect.NewExampleServiceClient(client)
			health := grpchealth.NewClient(client)

			res, err := health.Check(t.Context(), &grpchealth.CheckRequest{})
			if err != nil || res.Status != grpchealth.StatusServing {
				t.Fatalf("health Check without a token = %v, %v; want SERVING", res, err)
			}
			res, err = health.Check(t.Context(), &grpchealth.CheckRequest{Service: examplev1connect.ExampleServiceName})
			if err != nil || res.Status != grpchealth.StatusServing {
				t.Fatalf("health Check of %s = %v, %v; want SERVING", examplev1connect.ExampleServiceName, res, err)
			}

			_, err = example.GetItem(t.Context(), &examplev1.GetItemRequest{Id: "a"})
			wantCode(t, "GetItem without a token", err, connect.CodeUnauthenticated)
			_, err = example.PutItem(bearer(t, "forged"), &examplev1.PutItemRequest{Id: "a", Value: "1"})
			wantCode(t, "PutItem with a refused token", err, connect.CodeUnauthenticated)

			id := strings.ReplaceAll(p.name, " ", "-")
			if _, err := example.PutItem(bearer(t, "good"), &examplev1.PutItemRequest{Id: id, Value: "v-" + id}); err != nil {
				t.Fatalf("PutItem with an accepted token: %v", err)
			}
			got, err := example.GetItem(bearer(t, "good"), &examplev1.GetItemRequest{Id: id})
			if err != nil || got.GetValue() != "v-"+id {
				t.Fatalf("GetItem after PutItem = %v, %v; want value %q", got, err, "v-"+id)
			}

			_, err = example.GetItem(bearer(t, "good"), &examplev1.GetItemRequest{Id: "missing"})
			wantCode(t, "GetItem of a missing id", err, connect.CodeNotFound)
			_, err = example.PutItem(bearer(t, "good"), &examplev1.PutItemRequest{Value: "x"})
			wantCode(t, "PutItem with no id", err, connect.CodeInvalidArgument)
		})
	}
}

// rawGRPC sends one gRPC request frame (an empty message) over h2c and returns
// the HTTP status, the grpc-status (from the trailers, or the headers of a
// trailers-only response) and the negotiated protocol major version.
func rawGRPC(t *testing.T, base, procedure, authorization string) (int, string, int) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, base+procedure, bytes.NewReader([]byte{0, 0, 0, 0, 0}))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/grpc+proto")
	req.Header.Set("Te", "trailers")
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	resp, err := boundedH2C().Do(req)
	if err != nil {
		t.Fatalf("%s: %v", procedure, err)
	}
	defer resp.Body.Close()
	if _, err := io.Copy(io.Discard, resp.Body); err != nil {
		t.Fatalf("%s: reading the body: %v", procedure, err)
	}
	status := resp.Trailer.Get("Grpc-Status")
	if status == "" {
		status = resp.Header.Get("Grpc-Status")
	}
	return resp.StatusCode, status, resp.ProtoMajor
}

// rawConnectUnary sends one Connect-protocol unary request with a JSON body.
func rawConnectUnary(t *testing.T, base, procedure, authorization string) (int, string) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, base+procedure, strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	resp, err := boundedH2C().Do(req)
	if err != nil {
		t.Fatalf("%s: %v", procedure, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, string(body)
}

// The binary's own wiring (New, as main calls it, with no JWKS mounted):
// on the wire, every registered procedure except health Check is refused with
// gRPC status 16 (UNAUTHENTICATED), with or without a token, and a Connect
// unary call gets HTTP 401. Scanned from the server's registered procedures,
// so an RPC added later is covered without editing this test.
func TestProductionWiringFailsClosedOnTheWire(t *testing.T) {
	f, err := New(Config{JWKSPath: absentJWKS(t)})
	if err != nil {
		t.Fatal(err)
	}
	base := serve(t, f)

	var scanned int
	for spec := range f.Specs() {
		scanned++
		for _, authorization := range []string{"", "Bearer some.jwt.token"} {
			httpStatus, grpcStatus, proto := rawGRPC(t, base, spec.Procedure, authorization)
			if proto != 2 {
				t.Fatalf("%s: answered over HTTP/%d; want h2c (HTTP/2)", spec.Procedure, proto)
			}
			want := "16"
			if spec.Procedure == auth.HealthCheckProcedure {
				want = "0"
			}
			if httpStatus != http.StatusOK || grpcStatus != want {
				t.Errorf("gRPC %s (Authorization %q): HTTP %d grpc-status %q; want HTTP 200 grpc-status %s",
					spec.Procedure, authorization, httpStatus, grpcStatus, want)
			}
			if spec.StreamType != connect.StreamTypeUnary {
				continue
			}
			code, body := rawConnectUnary(t, base, spec.Procedure, authorization)
			if spec.Procedure == auth.HealthCheckProcedure {
				if code != http.StatusOK {
					t.Errorf("Connect %s: HTTP %d %s; want 200", spec.Procedure, code, body)
				}
				continue
			}
			if code != http.StatusUnauthorized || !strings.Contains(body, `"unauthenticated"`) {
				t.Errorf("Connect %s (Authorization %q): HTTP %d %s; want 401 unauthenticated",
					spec.Procedure, authorization, code, body)
			}
		}
	}
	if scanned != 4 {
		t.Fatalf("scanned %d procedures; want 4 (GetItem, PutItem, health Check and Watch)", scanned)
	}
}

// The HTTP server serves h2c and HTTP/1.1 and bounds slow clients.
func TestHTTPServerSettings(t *testing.T) {
	f, err := New(Config{Addr: ":9999", JWKSPath: absentJWKS(t)})
	if err != nil {
		t.Fatal(err)
	}
	s := f.HTTP
	if s.Addr != ":9999" {
		t.Errorf("Addr = %q; want :9999", s.Addr)
	}
	if s.Protocols == nil || !s.Protocols.UnencryptedHTTP2() || !s.Protocols.HTTP1() {
		t.Errorf("Protocols = %v; want h2c and HTTP/1.1", s.Protocols)
	}
	for _, d := range []struct {
		name      string
		got, want time.Duration
	}{
		{"ReadHeaderTimeout", s.ReadHeaderTimeout, ReadHeaderTimeout},
		{"ReadTimeout", s.ReadTimeout, ReadTimeout},
		{"IdleTimeout", s.IdleTimeout, IdleTimeout},
	} {
		if d.got <= 0 || d.got != d.want {
			t.Errorf("%s = %v; want %v", d.name, d.got, d.want)
		}
	}
	if ReadTimeout <= ReadHeaderTimeout {
		t.Errorf("ReadTimeout = %v; want above ReadHeaderTimeout (%v)", ReadTimeout, ReadHeaderTimeout)
	}
}

// The OTel interceptor records the zone's trace: a W3C traceparent sent by
// the caller is linked from the function's server span, rejected
// calls included.
func TestOTelContinuesTheCallersTrace(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	f, err := newFunction(Config{JWKSPath: absentJWKS(t), TracerProvider: provider}, acceptOnly("good"))
	if err != nil {
		t.Fatal(err)
	}
	base := serve(t, f)
	client := examplev1connect.NewExampleServiceClient(connect.NewClient(connecthttp.NewTransport(h2cClient(), base)))

	const traceID = "4bf92f3577b34da6a3ce929d0e0e4736"
	ctx, info := connect.NewClientContext(t.Context())
	info.RequestHeader().Set("Traceparent", "00-"+traceID+"-00f067aa0ba902b7-01")
	_, err = client.GetItem(ctx, &examplev1.GetItemRequest{Id: "a"})
	wantCode(t, "GetItem without a token", err, connect.CodeUnauthenticated)

	spans := recorder.Ended()
	if len(spans) != 1 {
		t.Fatalf("recorded %d spans; want 1", len(spans))
	}
	span := spans[0]
	if span.SpanKind() != trace.SpanKindServer || span.Name() != "example.v1.ExampleService/GetItem" {
		t.Errorf("span = %q kind %v; want a server span named example.v1.ExampleService/GetItem", span.Name(), span.SpanKind())
	}
	// otelconnect's default for a server: the caller's context is untrusted
	// (it arrives before the token check), so the span is a new root that
	// LINKS to the caller's span rather than claiming it as a parent.
	links := span.Links()
	if len(links) != 1 || links[0].SpanContext.TraceID().String() != traceID {
		t.Errorf("span links = %v; want one link to the caller's trace %s", links, traceID)
	}
}

// A panicking handler is answered with CodeInternal and the process lives.
func TestRecoverInterceptor(t *testing.T) {
	boom := func(context.Context, connect.Spec, connect.ServerStream) error { panic("boom") }
	err := recoverInterceptor(boom)(t.Context(), connect.Spec{Procedure: "/x.v1.X/Y"}, nil)
	wantCode(t, "a panicking handler", err, connect.CodeInternal)
	var cerr *connect.Error
	if errors.As(err, &cerr) && strings.Contains(cerr.Message(), "boom") {
		t.Errorf("the panic value leaked into the error message: %q", cerr.Message())
	}
}

// Messages larger than the read limit are refused.
func TestReadLimit(t *testing.T) {
	f, err := newFunction(Config{JWKSPath: absentJWKS(t)}, acceptOnly("good"))
	if err != nil {
		t.Fatal(err)
	}
	base := serve(t, f)
	client := examplev1connect.NewExampleServiceClient(connect.NewClient(connecthttp.NewTransport(h2cClient(), base,
		connecthttp.WithCodecs(connectproto.NewBinaryCodec()))))
	_, err = client.PutItem(bearer(t, "good"), &examplev1.PutItemRequest{Id: "big", Value: strings.Repeat("x", MaxRequestBytes+1)})
	wantCode(t, "PutItem over the read limit", err, connect.CodeResourceExhausted)
}
