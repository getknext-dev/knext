package wake

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// F5 phase 3 review fixes. Three distinct properties, all about NOT confusing a
// PERMANENT LOCAL CONFIG error with a transient backend state:
//
//	(1) a clientConfig failure (unreadable/unparseable CA, unloadable keypair)
//	    must NOT trigger a wake — no budget token, no scale write, no poll;
//	(2) the backend-TLS sentinels must SURVIVE the terminal wake error, so the
//	    gateway can meter a mid-migration fleet distinctly from a dead compute;
//	(3) NewBackendTLSFromEnv must LOAD the certs at boot (fail fast), not merely
//	    reject blank paths.
// ---------------------------------------------------------------------------

// recordingDriver counts driver.Wake invocations. A permanent local config error
// must leave this at ZERO: waking is an apiserver WRITE, and nothing the compute
// does can fix a CA file the gateway cannot read.
type recordingDriver struct {
	mu    sync.Mutex
	wakes int
}

func (d *recordingDriver) Mode() string                        { return "test" }
func (d *recordingDriver) Resolve(string) Target               { return Target{} }
func (d *recordingDriver) Sleep(context.Context, Target) error { return nil }
func (d *recordingDriver) CanSleep() bool                      { return true }
func (d *recordingDriver) Wake(context.Context, Target) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.wakes++
	return nil
}
func (d *recordingDriver) count() int { d.mu.Lock(); defer d.mu.Unlock(); return d.wakes }

// (1) A typo'd GW_COMPUTE_CA_FILE (or an absent Secret) is a PERMANENT LOCAL
// error: it fails before a single backend byte moves. Routing it into the wake
// path would burn a wake-budget token, issue a 0->1 scale write, and then poll
// for the whole GW_WAKE_TIMEOUT_MS — PER client connection — while blaming a
// compute that is healthy and awake. It must return IMMEDIATELY instead.
func TestConnectWithWake_PermanentConfigErrorDoesNotWake(t *testing.T) {
	p := newTestPKI(t)
	f := newFakeCompute(t, p, true, "") // healthy, AWAKE, TLS-serving compute
	host, port := f.addr()
	btls, _, _ := clientBackendTLS(t, p)
	btls.CAFile = filepath.Join(t.TempDir(), "absent-ca.crt") // the local misconfig

	d := &recordingDriver{}
	guardCalls := 0
	opts := Opts{
		ConnectTimeoutMs: 500,
		RetryMs:          20,
		WakeTimeoutMs:    5000, // a wake-path fall-through would burn ~5s here
		BackendTLS:       btls,
		WakeGuard: func(string) error {
			guardCalls++
			return nil
		},
	}
	start := time.Now()
	conn, woke, _, err := ConnectWithWake(context.Background(), d, Target{Host: host, Port: port, Key: "orders"}, opts, nil)
	elapsed := time.Since(start)
	if conn != nil {
		_ = conn.Close()
		t.Fatalf("fail-closed violated: a connection was returned despite an unusable backend TLS config")
	}
	if woke {
		t.Fatalf("a local config error must not report a wake")
	}
	if err == nil {
		t.Fatalf("expected an error for an unreadable CA file")
	}
	if !errors.Is(err, ErrBackendTLSConfig) {
		t.Fatalf("expected ErrBackendTLSConfig (permanent local misconfig), got: %v", err)
	}
	if d.count() != 0 {
		t.Fatalf("driver.Wake called %d times for a PERMANENT local config error — a typo'd cert path must not churn the apiserver", d.count())
	}
	if guardCalls != 0 {
		t.Fatalf("wake budget consulted (%d) for a permanent local config error — a typo'd cert path must not burn the per-app wake budget", guardCalls)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("took %v — a permanent local config error must fail FAST, not sit out the wake deadline", elapsed)
	}
}

// (1b) The retryable class is unchanged: a compute that answers 'N' is a
// mid-migration signal the wake poll retries, so it MUST still reach the wake
// path. This is the mutation guard on the fix above — a short-circuit that also
// caught ErrBackendTLSUnavailable would red this test.
func TestConnectWithWake_TLSUnavailableStillWakes(t *testing.T) {
	p := newTestPKI(t)
	f := newFakeCompute(t, p, false, "") // pre-phase-2 compute: answers 'N'
	host, port := f.addr()
	btls, _, _ := clientBackendTLS(t, p)

	d := &recordingDriver{}
	opts := Opts{ConnectTimeoutMs: 300, RetryMs: 20, WakeTimeoutMs: 150, WakeRetryBaseMs: 5, BackendTLS: btls}
	conn, _, _, err := ConnectWithWake(context.Background(), d, Target{Host: host, Port: port, Key: "orders"}, opts, nil)
	if conn != nil {
		_ = conn.Close()
		t.Fatalf("fail-closed violated: a plaintext connection was returned for an 'N' compute")
	}
	if err == nil {
		t.Fatalf("expected a wake failure for a compute that refuses TLS")
	}
	if d.count() == 0 {
		t.Fatalf("a TLS-unavailable compute is RETRYABLE (mid-boot / mid-migration) and must still reach the wake path")
	}
}

// (2) The sentinel must survive the terminal wake error. Without %w the gateway
// sees a generic "wake timed out" and a fleet mid-migration is indistinguishable
// from a dead compute — the C2 distinguishability the phase claims would exist
// only in TryConnectTLS-level tests.
func TestConnectWithWake_TerminalErrorPreservesTLSSentinel(t *testing.T) {
	p := newTestPKI(t)
	f := newFakeCompute(t, p, false, "") // answers 'N' forever
	host, port := f.addr()
	btls, _, _ := clientBackendTLS(t, p)

	d := &recordingDriver{}
	opts := Opts{ConnectTimeoutMs: 300, RetryMs: 20, WakeTimeoutMs: 150, WakeRetryBaseMs: 5, BackendTLS: btls}
	_, _, _, err := ConnectWithWake(context.Background(), d, Target{Host: host, Port: port, Key: "orders"}, opts, nil)
	if err == nil {
		t.Fatalf("expected a terminal wake error")
	}
	if !errors.Is(err, ErrBackendTLSUnavailable) {
		t.Fatalf("the backend-TLS sentinel did not survive the terminal wake error (formatted with %%v instead of %%w?): %v", err)
	}
}

// The PLAINTEXT dev path (GW_COMPUTE_TLS=false) tunes the SAME raw socket, so
// the gateway's own post-connect `conn.(*net.TCPConn).SetNoDelay` blocks are
// redundant in both modes — dead under TLS (a *tls.Conn never satisfies the
// assert) and duplicated here. This is what makes removing them a no-op.
func TestTryConnect_PlaintextTunesTheRawSocketToo(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close() //nolint:errcheck
	host, port := ParseHostPort(ln.Addr().String(), 0)

	var mu sync.Mutex
	var tuned net.Conn
	prev := setNoDelay
	setNoDelay = func(raw net.Conn) {
		mu.Lock()
		tuned = raw
		mu.Unlock()
		prev(raw)
	}
	t.Cleanup(func() { setNoDelay = prev })

	conn, err := TryConnectTLS(Target{Host: host, Port: port}, time.Second, nil)
	if err != nil {
		t.Fatalf("plaintext connect: %v", err)
	}
	defer conn.Close() //nolint:errcheck
	mu.Lock()
	defer mu.Unlock()
	if _, ok := tuned.(*net.TCPConn); !ok {
		t.Fatalf("the plaintext path must tune the raw *net.TCPConn too, got %T", tuned)
	}
}

// (3) NewBackendTLSFromEnv is the production boot path. Both backend volumes are
// mounted optional:true, so the ordinary missing-Secret case would otherwise
// yield a READY gateway that fails 100% of its connections. Load + validate once
// at boot so the process exits non-zero and crashloops visibly instead.
func TestNewBackendTLSFromEnv_LoadsAndValidatesCertsAtBoot(t *testing.T) {
	p := newTestPKI(t)
	crt, key := p.leaf(t, "boot-client", "pggw.test.svc", nil, false)

	valid := Env{
		"GW_COMPUTE_CA_FILE":          p.caFile,
		"GW_COMPUTE_CLIENT_CERT_FILE": crt,
		"GW_COMPUTE_CLIENT_KEY_FILE":  key,
	}
	b, err := NewBackendTLSFromEnv(valid)
	if err != nil {
		t.Fatalf("a fully-mounted cert set must boot: %v", err)
	}
	if b == nil {
		t.Fatalf("backend TLS must default ON")
	}

	// (a) CA file absent (the Secret was never issued) -> boot FAILS.
	missingCA := Env{
		"GW_COMPUTE_CA_FILE":          filepath.Join(t.TempDir(), "absent-ca.crt"),
		"GW_COMPUTE_CLIENT_CERT_FILE": crt,
		"GW_COMPUTE_CLIENT_KEY_FILE":  key,
	}
	if _, err := NewBackendTLSFromEnv(missingCA); err == nil {
		t.Fatalf("an ABSENT CA file must fail boot — an optional: true volume otherwise yields a Ready gateway that fails every connection")
	} else if !strings.Contains(err.Error(), "GW_COMPUTE_CA_FILE") {
		t.Fatalf("the boot error must name the offending knob, got: %v", err)
	}

	// (b) CA file present but not a certificate -> boot FAILS.
	junk := filepath.Join(t.TempDir(), "ca.crt")
	if werr := os.WriteFile(junk, []byte("not a pem\n"), 0o600); werr != nil {
		t.Fatal(werr)
	}
	junkCA := Env{
		"GW_COMPUTE_CA_FILE":          junk,
		"GW_COMPUTE_CLIENT_CERT_FILE": crt,
		"GW_COMPUTE_CLIENT_KEY_FILE":  key,
	}
	if _, err := NewBackendTLSFromEnv(junkCA); err == nil {
		t.Fatalf("an UNPARSEABLE CA file must fail boot")
	}

	// (c) client keypair unloadable -> boot FAILS (mirrors the front-door loadTLS
	// guard, which LoadX509KeyPairs rather than just checking for a blank path).
	missingKey := Env{
		"GW_COMPUTE_CA_FILE":          p.caFile,
		"GW_COMPUTE_CLIENT_CERT_FILE": crt,
		"GW_COMPUTE_CLIENT_KEY_FILE":  filepath.Join(t.TempDir(), "absent.key"),
	}
	if _, err := NewBackendTLSFromEnv(missingKey); err == nil {
		t.Fatalf("an UNLOADABLE client keypair must fail boot")
	}

	// (d) the dev opt-out still short-circuits BEFORE any load: a certless kind
	// cluster must boot with GW_COMPUTE_TLS=false even with nonsense paths.
	off := Env{
		"GW_COMPUTE_TLS":              "false",
		"GW_COMPUTE_CA_FILE":          "/nope/ca.crt",
		"GW_COMPUTE_CLIENT_CERT_FILE": "/nope/tls.crt",
		"GW_COMPUTE_CLIENT_KEY_FILE":  "/nope/tls.key",
	}
	b, err = NewBackendTLSFromEnv(off)
	if err != nil || b != nil {
		t.Fatalf("GW_COMPUTE_TLS=false must return (nil, nil) without loading anything, got (%v, %v)", b, err)
	}
}

// (3b) The boot load is VALIDATION ONLY — it must not replace the per-handshake
// keypair re-read that makes a cert-manager rotation take effect without a
// restart. Rotate the mounted leaf after boot and assert the NEW CN reaches the
// compute.
func TestBackendTLS_BootLoadDoesNotFreezeTheRotatingKeypair(t *testing.T) {
	p := newTestPKI(t)
	f := newFakeCompute(t, p, true, "")
	host, port := f.addr()
	crt, key := p.leaf(t, "rotating-client", "old.pggw.test.svc", nil, false)

	b, err := NewBackendTLSFromEnv(Env{
		"GW_COMPUTE_CA_FILE":          p.caFile,
		"GW_COMPUTE_CLIENT_CERT_FILE": crt,
		"GW_COMPUTE_CLIENT_KEY_FILE":  key,
		"GW_COMPUTE_SERVER_NAME":      "compute.test.svc",
	})
	if err != nil {
		t.Fatalf("boot: %v", err)
	}
	// cert-manager rotates the leaf in place on the mounted Secret.
	p.writeLeaf(t, crt, key, "new.pggw.test.svc", nil, false)

	conn, err := TryConnectTLS(Target{Host: host, Port: port}, 3*time.Second, b)
	if err != nil {
		t.Fatalf("connect after rotation: %v", err)
	}
	defer conn.Close() //nolint:errcheck
	_ = roundTrip(t, conn, "ping")
	cns := f.seenCNs()
	if len(cns) == 0 || cns[len(cns)-1] != "new.pggw.test.svc" {
		t.Fatalf("the compute saw %v — the boot load froze the keypair, defeating rotation", cns)
	}
}
