package gateway

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/proto"
	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// writeTestCert generates a throwaway self-signed cert+key, writes them as PEM
// into a temp dir, and returns the two file paths — the same shape the gateway
// reads from GW_TLS_CERT_FILE / GW_TLS_KEY_FILE.
func writeTestCert(t *testing.T) (certFile, keyFile string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "pggw.test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		DNSNames:     []string{"localhost", "pggw.test"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create cert: %v", err)
	}
	dir := t.TempDir()
	certFile = filepath.Join(dir, "tls.crt")
	keyFile = filepath.Join(dir, "tls.key")
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := os.WriteFile(certFile, certPEM, 0o600); err != nil {
		t.Fatalf("write cert: %v", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := os.WriteFile(keyFile, keyPEM, 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}
	return certFile, keyFile
}

// startTLSGateway builds a static-mode gateway pointed at fc and returns its addr.
func startTLSGateway(t *testing.T, fc *fakeCompute, extra wake.Env) (addr string, gw *Gateway) {
	t.Helper()
	env := wake.Env{
		"GW_COMPUTE_MODE":       "static",
		"GW_TARGET":             fmt.Sprintf("127.0.0.1:%d", fc.port),
		"GW_WAKE_TIMEOUT_MS":    "5000",
		"GW_CONNECT_TIMEOUT_MS": "500",
		"GW_RETRY_MS":           "50",
		"GW_IDLE_MS":            "0", // static never sleeps; keep timers out of the way
	}
	for k, v := range extra {
		env[k] = v
	}
	gw, err := New(env, func(string) {})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go gw.Serve(ln)
	return ln.Addr().String(), gw
}

func pgQuery() []byte {
	q := append([]byte{0x51, 0, 0, 0, 0}, []byte("SELECT 1\x00")...)
	binary.BigEndian.PutUint32(q[1:5], uint32(len(q)-1))
	return q
}

// TestHandleTLSHandshakeAndProxy: a TLS-configured gateway answers SSLRequest
// with 'S', completes a real TLS handshake, then proxies the startup + a query
// to the fake compute over the encrypted channel.
func TestHandleTLSHandshakeAndProxy(t *testing.T) {
	certFile, keyFile := writeTestCert(t)
	fc := &fakeCompute{port: freePort(t)}
	if err := fc.start(); err != nil {
		t.Fatalf("start compute: %v", err)
	}
	defer fc.stop()

	addr, _ := startTLSGateway(t, fc, wake.Env{
		"GW_TLS_CERT_FILE": certFile,
		"GW_TLS_KEY_FILE":  keyFile,
	})

	raw, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer raw.Close()

	// SSLRequest -> expect 'S'
	if _, err := raw.Write(proto.BuildSSLRequest()); err != nil {
		t.Fatalf("write SSLRequest: %v", err)
	}
	reply := make([]byte, 1)
	_ = raw.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := raw.Read(reply); err != nil {
		t.Fatalf("read SSL reply: %v", err)
	}
	if reply[0] != 'S' {
		t.Fatalf("SSL reply = %q, want S", reply[0])
	}
	_ = raw.SetReadDeadline(time.Time{})

	// TLS handshake over the same conn.
	tc := tls.Client(raw, &tls.Config{InsecureSkipVerify: true, ServerName: "localhost"})
	if err := tc.Handshake(); err != nil {
		t.Fatalf("client TLS handshake: %v", err)
	}

	// Startup over TLS -> AuthenticationOk (R=0x52) + ReadyForQuery (Z=0x5a).
	if _, err := tc.Write(proto.BuildStartup(map[string]string{"user": "app", "database": "testdb"})); err != nil {
		t.Fatalf("write startup: %v", err)
	}
	got := readUntil(t, tc, func(b []byte) bool {
		return bytes.IndexByte(b, 0x52) >= 0 && bytes.IndexByte(b, 0x5a) >= 0
	})
	if bytes.IndexByte(got, 0x52) < 0 || bytes.IndexByte(got, 0x5a) < 0 {
		t.Fatalf("no AuthOk/ReadyForQuery over TLS")
	}

	// Query flows through the encrypted pipe.
	if _, err := tc.Write(pgQuery()); err != nil {
		t.Fatalf("write query: %v", err)
	}
	got = readUntil(t, tc, func(b []byte) bool { return bytes.Contains(b, []byte("it-works")) })
	if !bytes.Contains(got, []byte("it-works")) {
		t.Fatalf("query row not piped back over TLS")
	}
}

// TestHandleTLSPlaintextStillWorks: with TLS configured, a client that does NOT
// send SSLRequest (sslmode=disable) still connects in plaintext — TLS is
// optional, not enforced.
func TestHandleTLSPlaintextStillWorks(t *testing.T) {
	certFile, keyFile := writeTestCert(t)
	fc := &fakeCompute{port: freePort(t)}
	if err := fc.start(); err != nil {
		t.Fatalf("start compute: %v", err)
	}
	defer fc.stop()

	addr, _ := startTLSGateway(t, fc, wake.Env{
		"GW_TLS_CERT_FILE": certFile,
		"GW_TLS_KEY_FILE":  keyFile,
	})

	c := dialGateway(t, addr)
	defer c.c.Close()
	c.c.Write(proto.BuildStartup(map[string]string{"user": "app", "database": "testdb"}))
	c.waitFor(t, func(b []byte) bool {
		return bytes.IndexByte(b, 0x52) >= 0 && bytes.IndexByte(b, 0x5a) >= 0
	}, 5*time.Second)
}

// TestHandleTLSUnconfiguredDeclines: no TLS env -> SSLRequest still gets 'N'
// (byte-identical to today's plaintext-only behavior).
func TestHandleTLSUnconfiguredDeclines(t *testing.T) {
	fc := &fakeCompute{port: freePort(t)}
	if err := fc.start(); err != nil {
		t.Fatalf("start compute: %v", err)
	}
	defer fc.stop()

	addr, _ := startTLSGateway(t, fc, nil)

	c := dialGateway(t, addr)
	defer c.c.Close()
	c.c.Write(proto.BuildSSLRequest())
	ssl := c.waitFor(t, func(b []byte) bool { return len(b) >= 1 }, 5*time.Second)
	if ssl[0] != 'N' {
		t.Fatalf("SSL reply = %q, want N (TLS unconfigured)", ssl[0])
	}
}

// TestNewTLSFailFast: cert/key set but unloadable -> New returns an error
// (fail-fast at startup), and a half-configured pair is rejected too.
func TestNewTLSFailFast(t *testing.T) {
	base := wake.Env{
		"GW_COMPUTE_MODE": "static",
		"GW_TARGET":       "127.0.0.1:1",
	}
	t.Run("missing files", func(t *testing.T) {
		env := wake.Env{}
		for k, v := range base {
			env[k] = v
		}
		env["GW_TLS_CERT_FILE"] = "/nonexistent/tls.crt"
		env["GW_TLS_KEY_FILE"] = "/nonexistent/tls.key"
		if _, err := New(env, nil); err == nil {
			t.Fatalf("expected error for unloadable cert/key")
		}
	})
	t.Run("half configured", func(t *testing.T) {
		certFile, _ := writeTestCert(t)
		env := wake.Env{}
		for k, v := range base {
			env[k] = v
		}
		env["GW_TLS_CERT_FILE"] = certFile // key missing
		if _, err := New(env, nil); err == nil {
			t.Fatalf("expected error when only cert is set")
		}
	})
	t.Run("both empty ok", func(t *testing.T) {
		env := wake.Env{}
		for k, v := range base {
			env[k] = v
		}
		if _, err := New(env, nil); err != nil {
			t.Fatalf("no TLS env should be fine: %v", err)
		}
	})
}

// readUntil reads from a plain io conn (e.g. *tls.Conn) until pred is satisfied.
func readUntil(t *testing.T, c net.Conn, pred func([]byte) bool) []byte {
	t.Helper()
	var buf []byte
	tmp := make([]byte, 4096)
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	defer c.SetReadDeadline(time.Time{})
	for {
		if pred(buf) {
			return buf
		}
		n, err := c.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}
		if pred(buf) {
			return buf
		}
		if err != nil {
			t.Fatalf("readUntil: %v (got %d bytes)", err, len(buf))
		}
	}
}
