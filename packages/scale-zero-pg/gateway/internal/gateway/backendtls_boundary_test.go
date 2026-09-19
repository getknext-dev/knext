package gateway

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/metrics"
	"github.com/alpheya/scale-zero-pg/gateway/internal/proto"
	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// ---------------------------------------------------------------------------
// F5 phase 3, CONSUME side. The backend-TLS error classes only buy anything if
// they survive to the gateway boundary and are metered there: a fleet mid-TLS-
// migration ('N' from a pre-phase-2 compute) and a gateway whose cert Secret is
// missing must BOTH be distinguishable from an ordinary "wake timed out".
// ---------------------------------------------------------------------------

// testCerts writes a throwaway CA + a client leaf and returns their paths.
func testCerts(t *testing.T) (caFile, certFile, keyFile string) {
	t.Helper()
	dir := t.TempDir()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "test mTLS CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leafTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "pggw.test.svc"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTmpl, caCert, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	leafKeyDER, err := x509.MarshalECPrivateKey(leafKey)
	if err != nil {
		t.Fatal(err)
	}
	caFile = filepath.Join(dir, "ca.crt")
	certFile = filepath.Join(dir, "tls.crt")
	keyFile = filepath.Join(dir, "tls.key")
	writeTestPEM(t, caFile, "CERTIFICATE", caDER)
	writeTestPEM(t, certFile, "CERTIFICATE", leafDER)
	writeTestPEM(t, keyFile, "EC PRIVATE KEY", leafKeyDER)
	return caFile, certFile, keyFile
}

func writeTestPEM(t *testing.T, path, typ string, der []byte) {
	t.Helper()
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: typ, Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
}

// refusingCompute is a pre-phase-2 compute: it answers 'N' to the SSLRequest.
func refusingCompute(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, aerr := ln.Accept()
			if aerr != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close() //nolint:errcheck
				buf := make([]byte, 8)
				_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
				if _, rerr := io.ReadFull(c, buf); rerr != nil {
					return
				}
				if binary.BigEndian.Uint32(buf[4:8]) != proto.SSLRequestCode {
					return
				}
				_, _ = c.Write([]byte{'N'})
				time.Sleep(200 * time.Millisecond)
			}(c)
		}
	}()
	return ln.Addr().String()
}

// newBoundaryGateway builds a static-mode gateway whose backend dial uses btls.
func newBoundaryGateway(t *testing.T, target string, btls *wake.BackendTLS, wakeTimeoutMs int) *Gateway {
	t.Helper()
	drv, err := wake.MakeDriver(wake.Env{"GW_COMPUTE_MODE": "static", "GW_TARGET": target})
	if err != nil {
		t.Fatal(err)
	}
	return &Gateway{
		driver:  drv,
		metrics: metrics.NewMetrics(),
		opts: wake.Opts{
			ConnectTimeoutMs: 300,
			WakeTimeoutMs:    wakeTimeoutMs,
			RetryMs:          20,
			BackendTLS:       btls,
		},
		active: map[string]*activeEntry{},
		log:    func(string) {},
	}
}

func dialStartup(t *testing.T, front net.Listener) {
	t.Helper()
	c, err := net.Dial("tcp", front.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close() //nolint:errcheck
	_, _ = c.Write(proto.BuildStartup(map[string]string{"user": "app", "database": "app"}))
	_ = c.SetReadDeadline(time.Now().Add(10 * time.Second))
	buf := make([]byte, 256)
	_, _ = c.Read(buf)
}

// A compute that refuses TLS must be metered as a BACKEND-TLS failure at the
// gateway boundary — not swallowed into the generic wake-failure counter, which
// would make a fleet mid-migration indistinguishable from a dead compute.
func TestProxyMetersBackendTLSUnavailableDistinctly(t *testing.T) {
	ca, crt, key := testCerts(t)
	addr := refusingCompute(t)
	gw := newBoundaryGateway(t, addr, &wake.BackendTLS{CAFile: ca, CertFile: crt, KeyFile: key}, 120)

	front, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer front.Close() //nolint:errcheck
	go gw.Serve(front)

	dialStartup(t, front)

	if got := gw.Metrics().BackendTLSFailureCount(); got != 1 {
		t.Fatalf("backend_tls_failures_total = %d, want 1 — the TLS sentinel is not metered distinctly at the gateway boundary", got)
	}
}

// The PERMANENT LOCAL class (cert Secret missing / CA unreadable) is metered the
// same way AND returns without sitting out the wake deadline — per connection.
func TestProxyMetersBackendTLSConfigErrorWithoutWaiting(t *testing.T) {
	_, crt, key := testCerts(t)
	addr := refusingCompute(t)
	btls := &wake.BackendTLS{CAFile: filepath.Join(t.TempDir(), "absent-ca.crt"), CertFile: crt, KeyFile: key}
	// A generous wake deadline: a config error that fell through to the wake path
	// would burn all of it before answering the client.
	gw := newBoundaryGateway(t, addr, btls, 5000)

	front, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer front.Close() //nolint:errcheck
	go gw.Serve(front)

	start := time.Now()
	dialStartup(t, front)
	elapsed := time.Since(start)

	if got := gw.Metrics().BackendTLSFailureCount(); got != 1 {
		t.Fatalf("backend_tls_failures_total = %d, want 1 for an unreadable CA", got)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("the client waited %v for a PERMANENT local config error — it must fail fast, not poll the wake deadline", elapsed)
	}
}
