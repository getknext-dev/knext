package wake

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/proto"
)

// ---------------------------------------------------------------------------
// F5 phase 3 (ADR-0003): the gateway is the TLS CLIENT on the gateway->compute
// dial. Every assertion below is on the BACKEND leg only; the front-door
// (client->gateway) TLS path is untouched by this phase.
// ---------------------------------------------------------------------------

// testPKI is a throwaway CA plus the two leaves the backend leg needs: a
// serverAuth leaf for the fake compute and a clientAuth leaf for the gateway.
type testPKI struct {
	dir    string
	caFile string
	caPool *x509.CertPool
	caCert *x509.Certificate
	caKey  *ecdsa.PrivateKey
}

func newTestPKI(t *testing.T) *testPKI {
	t.Helper()
	dir := t.TempDir()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("ca key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "test mTLS CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("ca cert: %v", err)
	}
	caCert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("parse ca: %v", err)
	}
	caFile := filepath.Join(dir, "ca.crt")
	writePEM(t, caFile, "CERTIFICATE", der)
	pool := x509.NewCertPool()
	pool.AddCert(caCert)
	return &testPKI{dir: dir, caFile: caFile, caPool: pool, caCert: caCert, caKey: key}
}

// leaf issues a cert from the CA and writes it to certFile/keyFile (PEM).
func (p *testPKI) leaf(t *testing.T, name, cn string, dnsNames []string, server bool) (certFile, keyFile string) {
	t.Helper()
	certFile = filepath.Join(p.dir, name+".crt")
	keyFile = filepath.Join(p.dir, name+".key")
	p.writeLeaf(t, certFile, keyFile, cn, dnsNames, server)
	return certFile, keyFile
}

// writeLeaf (re)writes a leaf at the given paths — used to simulate a
// cert-manager rotation of an already-mounted Secret.
func (p *testPKI) writeLeaf(t *testing.T, certFile, keyFile, cn string, dnsNames []string, server bool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("leaf key: %v", err)
	}
	usage := x509.ExtKeyUsageClientAuth
	if server {
		usage = x509.ExtKeyUsageServerAuth
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{usage},
		DNSNames:     dnsNames,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, p.caCert, &key.PublicKey, p.caKey)
	if err != nil {
		t.Fatalf("leaf cert: %v", err)
	}
	writePEM(t, certFile, "CERTIFICATE", der)
	kder, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	writePEM(t, keyFile, "EC PRIVATE KEY", kder)
}

func writePEM(t *testing.T, path, blockType string, der []byte) {
	t.Helper()
	buf := pem.EncodeToMemory(&pem.Block{Type: blockType, Bytes: der})
	if err := os.WriteFile(path, buf, 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// fakeCompute is a Postgres-shaped listener: it reads the 8-byte SSLRequest and
// answers 'S' (then completes a TLS server handshake, requiring + recording the
// client cert) or 'N' (TLS refused — a not-yet-migrated compute).
type fakeCompute struct {
	ln       net.Listener
	offerTLS bool
	conf     *tls.Config

	mu        sync.Mutex
	clientCNs []string
	sslReqs   int
}

func newFakeCompute(t *testing.T, p *testPKI, offerTLS bool, addr string) *fakeCompute {
	t.Helper()
	if addr == "" {
		addr = "127.0.0.1:0"
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	f := &fakeCompute{ln: ln, offerTLS: offerTLS}
	if offerTLS {
		crt, key := p.leaf(t, "compute-server", "compute.test.svc", []string{"compute.test.svc"}, true)
		pair, err := tls.LoadX509KeyPair(crt, key)
		if err != nil {
			t.Fatalf("server keypair: %v", err)
		}
		f.conf = &tls.Config{
			Certificates: []tls.Certificate{pair},
			MinVersion:   tls.VersionTLS12,
			ClientAuth:   tls.RequireAndVerifyClientCert,
			ClientCAs:    p.caPool,
		}
	}
	go f.serve()
	t.Cleanup(func() { _ = ln.Close() })
	return f
}

func (f *fakeCompute) addr() (string, int) { return ParseHostPort(f.ln.Addr().String(), 0) }

func (f *fakeCompute) serve() {
	for {
		c, err := f.ln.Accept()
		if err != nil {
			return
		}
		go f.handle(c)
	}
}

func (f *fakeCompute) handle(c net.Conn) {
	buf := make([]byte, 8)
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(c, buf); err != nil {
		_ = c.Close()
		return
	}
	_ = c.SetReadDeadline(time.Time{})
	if binary.BigEndian.Uint32(buf[0:4]) != 8 || binary.BigEndian.Uint32(buf[4:8]) != proto.SSLRequestCode {
		_ = c.Close()
		return
	}
	f.mu.Lock()
	f.sslReqs++
	f.mu.Unlock()
	if !f.offerTLS {
		_, _ = c.Write([]byte{'N'})
		// A real un-migrated compute keeps the plaintext session open.
		io.Copy(c, c) //nolint:errcheck // test echo
		_ = c.Close()
		return
	}
	if _, err := c.Write([]byte{'S'}); err != nil {
		_ = c.Close()
		return
	}
	tc := tls.Server(c, f.conf)
	if err := tc.Handshake(); err != nil {
		_ = tc.Close()
		return
	}
	cn := ""
	if st := tc.ConnectionState(); len(st.PeerCertificates) > 0 {
		cn = st.PeerCertificates[0].Subject.CommonName
	}
	f.mu.Lock()
	f.clientCNs = append(f.clientCNs, cn)
	f.mu.Unlock()
	io.Copy(tc, tc) //nolint:errcheck // test echo
	_ = tc.Close()
}

func (f *fakeCompute) seenCNs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.clientCNs...)
}

func (f *fakeCompute) sslRequests() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sslReqs
}

// clientBackendTLS builds the gateway-side config pointed at the test PKI.
func clientBackendTLS(t *testing.T, p *testPKI) (*BackendTLS, string, string) {
	t.Helper()
	crt, key := p.leaf(t, "gateway-client", "pggw.test.svc", nil, false)
	return &BackendTLS{
		CAFile:     p.caFile,
		CertFile:   crt,
		KeyFile:    key,
		ServerName: "compute.test.svc",
	}, crt, key
}

func roundTrip(t *testing.T, c net.Conn, msg string) string {
	t.Helper()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := c.Write([]byte(msg)); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(c, buf); err != nil {
		t.Fatalf("read: %v", err)
	}
	return string(buf)
}

// (a) The compute offers TLS -> TryConnect returns a COMPLETED *tls.Conn and the
// compute saw the gateway's client cert (mTLS, both legs).
func TestTryConnectTLS_UpgradesWhenComputeOffersTLS(t *testing.T) {
	p := newTestPKI(t)
	f := newFakeCompute(t, p, true, "")
	host, port := f.addr()
	btls, _, _ := clientBackendTLS(t, p)

	conn, err := TryConnectTLS(Target{Host: host, Port: port, Key: "orders"}, time.Second, btls)
	if err != nil {
		t.Fatalf("TryConnectTLS: %v", err)
	}
	defer conn.Close() //nolint:errcheck
	tc, ok := conn.(*tls.Conn)
	if !ok {
		t.Fatalf("expected a *tls.Conn on the backend leg, got %T — the dial is still plaintext", conn)
	}
	st := tc.ConnectionState()
	if !st.HandshakeComplete {
		t.Fatalf("handshake not complete")
	}
	if st.Version < tls.VersionTLS12 {
		t.Fatalf("negotiated TLS version %x below the TLS1.2 floor", st.Version)
	}
	if got := roundTrip(t, conn, "ping"); got != "ping" {
		t.Fatalf("backend round-trip over TLS: got %q", got)
	}
	if cns := f.seenCNs(); len(cns) != 1 || cns[0] != "pggw.test.svc" {
		t.Fatalf("compute did not see the gateway client cert (mTLS): %v", cns)
	}
}

// (b) FAIL-CLOSED: the compute refuses TLS ('N') while backend TLS is ON ->
// a distinguishable TLS-unavailable error and NO usable conn. Never plaintext.
// Mutation-proof: make the 'N' branch fall through to the raw conn -> RED here.
func TestTryConnectTLS_FailsClosedWhenComputeRefusesTLS(t *testing.T) {
	p := newTestPKI(t)
	f := newFakeCompute(t, p, false, "")
	host, port := f.addr()
	btls, _, _ := clientBackendTLS(t, p)

	conn, err := TryConnectTLS(Target{Host: host, Port: port, Key: "orders"}, time.Second, btls)
	if conn != nil {
		_ = conn.Close()
		t.Fatalf("fail-closed violated: got a usable conn (%T) from a compute that refused TLS", conn)
	}
	if err == nil {
		t.Fatalf("expected an error when the compute refuses TLS")
	}
	if !errors.Is(err, ErrBackendTLSUnavailable) {
		t.Fatalf("expected ErrBackendTLSUnavailable, got %v", err)
	}
	if errors.Is(err, ErrBackendDialFailed) {
		t.Fatalf("TLS-unavailable must NOT be collapsed into the dial-failure class: %v", err)
	}
	if f.sslRequests() != 1 {
		t.Fatalf("expected exactly one SSLRequest, got %d", f.sslRequests())
	}
}

// (c) Dev opt-out: GW_COMPUTE_TLS=false -> no backend TLS at all; the same 'N'
// compute still yields a usable PLAINTEXT conn (local/kind keeps working).
func TestTryConnect_PlaintextOptOutStillConnects(t *testing.T) {
	p := newTestPKI(t)
	f := newFakeCompute(t, p, false, "")
	host, port := f.addr()

	btls, err := NewBackendTLSFromEnv(Env{"GW_COMPUTE_TLS": "false"})
	if err != nil {
		t.Fatalf("NewBackendTLSFromEnv: %v", err)
	}
	if btls != nil {
		t.Fatalf("GW_COMPUTE_TLS=false must disable the backend TLS client, got %+v", btls)
	}
	conn, err := TryConnectTLS(Target{Host: host, Port: port, Key: "orders"}, time.Second, btls)
	if err != nil {
		t.Fatalf("plaintext opt-out dial failed: %v", err)
	}
	defer conn.Close() //nolint:errcheck
	if _, isTLS := conn.(*tls.Conn); isTLS {
		t.Fatalf("opt-out must not wrap the conn in TLS")
	}
	// No SSLRequest is sent on the opt-out path: the gateway dials plaintext as before.
	if f.sslRequests() != 0 {
		t.Fatalf("opt-out sent an SSLRequest (%d) — the plaintext path must be byte-identical to pre-phase-3", f.sslRequests())
	}
}

// The shipped default is ON (fail-closed by construction), with the documented
// mount paths.
func TestNewBackendTLSFromEnv_DefaultsOnWithMountPaths(t *testing.T) {
	btls, err := NewBackendTLSFromEnv(Env{})
	if err != nil {
		t.Fatalf("NewBackendTLSFromEnv: %v", err)
	}
	if btls == nil {
		t.Fatalf("GW_COMPUTE_TLS must default to TRUE (fail-closed by construction)")
	}
	if btls.CAFile != "/etc/pggw-mtls-ca/ca.crt" {
		t.Fatalf("default CA file: %q", btls.CAFile)
	}
	if btls.CertFile != "/etc/pggw-client-tls/tls.crt" || btls.KeyFile != "/etc/pggw-client-tls/tls.key" {
		t.Fatalf("default client keypair paths: %q %q", btls.CertFile, btls.KeyFile)
	}
	// Explicit overrides win.
	btls, err = NewBackendTLSFromEnv(Env{
		"GW_COMPUTE_CA_FILE":          "/x/ca.crt",
		"GW_COMPUTE_CLIENT_CERT_FILE": "/x/tls.crt",
		"GW_COMPUTE_CLIENT_KEY_FILE":  "/x/tls.key",
		"GW_COMPUTE_SERVER_NAME":      "compute.other.svc",
	})
	if err != nil {
		t.Fatalf("NewBackendTLSFromEnv overrides: %v", err)
	}
	if btls.CAFile != "/x/ca.crt" || btls.CertFile != "/x/tls.crt" || btls.KeyFile != "/x/tls.key" || btls.ServerName != "compute.other.svc" {
		t.Fatalf("overrides not honoured: %+v", btls)
	}
	// Half-configured (a blanked path) fails fast rather than dialling half-secure.
	if _, err := NewBackendTLSFromEnv(Env{"GW_COMPUTE_CLIENT_CERT_FILE": " "}); err == nil {
		t.Fatalf("a blank client cert path must fail fast at construction")
	}
}

// C3: the client keypair is re-read on EVERY handshake, so a cert-manager
// rotation of the mounted Secret is picked up WITHOUT a gateway restart.
// Mutation-proof: load the keypair once into tls.Config.Certificates -> RED.
func TestBackendTLS_ClientCertIsReReadPerHandshake(t *testing.T) {
	p := newTestPKI(t)
	f := newFakeCompute(t, p, true, "")
	host, port := f.addr()
	btls, crt, key := clientBackendTLS(t, p)
	tgt := Target{Host: host, Port: port, Key: "orders"}

	c1, err := TryConnectTLS(tgt, time.Second, btls)
	if err != nil {
		t.Fatalf("first dial: %v", err)
	}
	_ = roundTrip(t, c1, "a")
	_ = c1.Close()

	// cert-manager rotates the leaf IN PLACE on the mounted Secret.
	p.writeLeaf(t, crt, key, "pggw-rotated.test.svc", nil, false)

	c2, err := TryConnectTLS(tgt, time.Second, btls)
	if err != nil {
		t.Fatalf("dial after rotation: %v", err)
	}
	_ = roundTrip(t, c2, "b")
	_ = c2.Close()

	cns := f.seenCNs()
	if len(cns) != 2 {
		t.Fatalf("expected two handshakes, got %v", cns)
	}
	if cns[1] != "pggw-rotated.test.svc" {
		t.Fatalf("client cert was read ONCE (stale after rotation): second handshake presented %q", cns[1])
	}
}

// C1: TCP_NODELAY is applied to the RAW socket BEFORE the TLS wrap — Nagle must
// be off on the underlying socket, not on a tls.Conn (which cannot set it).
// Mutation-proof: move the setNoDelay call below the TLS upgrade -> RED.
func TestTryConnectTLS_NoDelayOnRawConnBeforeHandshake(t *testing.T) {
	p := newTestPKI(t)
	f := newFakeCompute(t, p, true, "")
	host, port := f.addr()
	btls, _, _ := clientBackendTLS(t, p)

	var mu sync.Mutex
	var order []string
	var tuned net.Conn
	prev := setNoDelay
	setNoDelay = func(raw net.Conn) {
		mu.Lock()
		order = append(order, "nodelay")
		tuned = raw
		mu.Unlock()
		prev(raw)
	}
	prevHS := startTLSHandshake
	startTLSHandshake = func(c *tls.Conn) error {
		mu.Lock()
		order = append(order, "handshake")
		mu.Unlock()
		return prevHS(c)
	}
	t.Cleanup(func() { setNoDelay, startTLSHandshake = prev, prevHS })

	conn, err := TryConnectTLS(Target{Host: host, Port: port, Key: "orders"}, time.Second, btls)
	if err != nil {
		t.Fatalf("TryConnectTLS: %v", err)
	}
	defer conn.Close() //nolint:errcheck

	mu.Lock()
	defer mu.Unlock()
	if len(order) != 2 || order[0] != "nodelay" || order[1] != "handshake" {
		t.Fatalf("SetNoDelay must run on the raw socket BEFORE the TLS handshake, got %v", order)
	}
	if _, ok := tuned.(*net.TCPConn); !ok {
		t.Fatalf("SetNoDelay must be applied to the raw *net.TCPConn, got %T", tuned)
	}
}

// C2: a failed DIAL and a failed TLS upgrade are DISTINGUISHABLE error classes.
func TestTryConnectTLS_DialFailureIsDistinctFromTLSUnavailable(t *testing.T) {
	// Reserve then release a port so the dial is refused (compute asleep).
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("probe listen: %v", err)
	}
	host, port := ParseHostPort(probe.Addr().String(), 0)
	_ = probe.Close()

	p := newTestPKI(t)
	btls, _, _ := clientBackendTLS(t, p)
	conn, err := TryConnectTLS(Target{Host: host, Port: port, Key: "orders"}, 200*time.Millisecond, btls)
	if conn != nil {
		_ = conn.Close()
		t.Fatalf("expected no conn against a closed port")
	}
	if !errors.Is(err, ErrBackendDialFailed) {
		t.Fatalf("expected ErrBackendDialFailed, got %v", err)
	}
	if errors.Is(err, ErrBackendTLSUnavailable) {
		t.Fatalf("a refused dial must NOT report as TLS-unavailable: %v", err)
	}
}

// An untrusted server cert (wrong CA) is a TLS-unavailable failure, not a
// silent downgrade — and it stays RETRYABLE through the wake loop.
func TestTryConnectTLS_UntrustedServerCertFailsClosed(t *testing.T) {
	p := newTestPKI(t)
	f := newFakeCompute(t, p, true, "")
	host, port := f.addr()

	other := newTestPKI(t) // a DIFFERENT CA: the compute's cert cannot verify
	btls, _, _ := clientBackendTLS(t, other)
	conn, err := TryConnectTLS(Target{Host: host, Port: port, Key: "orders"}, time.Second, btls)
	if conn != nil {
		_ = conn.Close()
		t.Fatalf("an unverifiable compute cert must not yield a conn")
	}
	if !errors.Is(err, ErrBackendTLSUnavailable) {
		t.Fatalf("expected ErrBackendTLSUnavailable on a failed verify, got %v", err)
	}
}

// The wrap sits INSIDE TryConnect, so BOTH ConnectWithWake paths get it: the
// warm fast path...
func TestConnectWithWake_WarmPathIsTLS(t *testing.T) {
	p := newTestPKI(t)
	f := newFakeCompute(t, p, true, "")
	host, port := f.addr()
	btls, _, _ := clientBackendTLS(t, p)

	d := &wakeListenerDriver{} // its Wake must never be called on a warm compute
	opts := Opts{ConnectTimeoutMs: 1000, RetryMs: 10, WakeTimeoutMs: 3000, BackendTLS: btls}
	conn, woke, _, err := ConnectWithWake(context.Background(), d, Target{Host: host, Port: port, Key: "orders"}, opts, nil)
	if err != nil {
		t.Fatalf("warm connect: %v", err)
	}
	defer conn.Close() //nolint:errcheck
	if woke {
		t.Fatalf("warm compute must not wake")
	}
	if _, ok := conn.(*tls.Conn); !ok {
		t.Fatalf("warm path is still plaintext: %T", conn)
	}
}

// ...and the COLD-WAKE poll, whose retry loop makes a TLS failure retryable.
func TestConnectWithWake_ColdWakePollIsTLS(t *testing.T) {
	p := newTestPKI(t)
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("probe listen: %v", err)
	}
	addr := probe.Addr().String()
	host, port := ParseHostPort(addr, 0)
	_ = probe.Close()

	d := &tlsWakeDriver{t: t, pki: p, addr: addr}
	btls, _, _ := clientBackendTLS(t, p)
	opts := Opts{ConnectTimeoutMs: 500, RetryMs: 10, WakeTimeoutMs: 5000, WakeRetryBaseMs: 5, BackendTLS: btls}
	conn, woke, _, err := ConnectWithWake(context.Background(), d, Target{Host: host, Port: port, Key: "orders"}, opts, nil)
	if err != nil {
		t.Fatalf("cold wake: %v", err)
	}
	defer conn.Close() //nolint:errcheck
	if !woke {
		t.Fatalf("expected woke=true")
	}
	if _, ok := conn.(*tls.Conn); !ok {
		t.Fatalf("cold-wake poll path is still plaintext: %T — the wrap is not inside TryConnect", conn)
	}
}

// tlsWakeDriver brings up a TLS-offering fake compute on the Nth wake.
type tlsWakeDriver struct {
	t    *testing.T
	pki  *testPKI
	addr string
	mu   sync.Mutex
	up   bool
}

func (d *tlsWakeDriver) Mode() string                        { return "test" }
func (d *tlsWakeDriver) Resolve(string) Target               { return Target{} }
func (d *tlsWakeDriver) Sleep(context.Context, Target) error { return nil }
func (d *tlsWakeDriver) CanSleep() bool                      { return true }
func (d *tlsWakeDriver) Wake(context.Context, Target) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.up {
		newFakeCompute(d.t, d.pki, true, d.addr)
		d.up = true
	}
	return nil
}
