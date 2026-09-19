package wake

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/proto"
)

// F5 phase 3 (ADR-0003): the gateway is the TLS CLIENT on the gateway->compute
// leg. Every backend dial funnels through TryConnectTLS, so the warm fast path
// AND the cold-wake poll (ConnectWithWake) are both covered by ONE wrap — which
// is also what makes a handshake failure RETRYABLE for free: the wrap sits
// INSIDE the retried unit, not around it.
//
// The negotiation is the libpq one: dial TCP, send the 8-byte SSLRequest, read
// the one-byte reply ('S' = server will speak TLS, 'N' = it will not), and only
// then run the TLS handshake over the same socket. SCRAM + query proxying then
// run over the *tls.Conn unchanged.

// Backend-leg error classes. They are deliberately DISTINCT (condition C2): a
// TLS-unavailable backend is a *migration* signal that the wake loop retries,
// while a refused dial is the pre-existing asleep/unreachable signal that ends
// in "wake timed out". Collapsing them would make a fleet mid-migration
// indistinguishable from a dead compute.
var (
	// ErrBackendTLSUnavailable: the compute refused TLS ('N') or the handshake
	// failed (cert not mounted yet, wrong CA, expired leaf). FAIL-CLOSED — the
	// caller gets this error and NEVER a plaintext connection.
	ErrBackendTLSUnavailable = errors.New("backend TLS unavailable")
	// ErrBackendDialFailed: the raw TCP dial itself failed (compute asleep or
	// unreachable) — the pre-phase-3 failure mode.
	ErrBackendDialFailed = errors.New("backend dial failed")
)

// Default mount paths for the phase-1 Secrets (deploy/11-mtls-certs.yaml), as
// mounted by deploy/10-gateway.yaml + deploy/81-apps-gateway.yaml.
const (
	defaultComputeCAFile         = "/etc/pggw-mtls-ca/ca.crt"
	defaultComputeClientCertFile = "/etc/pggw-client-tls/tls.crt"
	defaultComputeClientKeyFile  = "/etc/pggw-client-tls/tls.key"
)

// BackendTLS is the gateway's TLS-client config for the backend leg. It holds
// FILE PATHS, never loaded key material: the keypair is re-read on every
// handshake (GetClientCertificate) so a cert-manager rotation of the mounted
// Secret is picked up without a gateway restart, and an expiring leaf cannot
// strand a long-lived gateway process on a stale cert.
type BackendTLS struct {
	// CAFile verifies the compute server cert (the shared mTLS CA, ca.crt).
	CAFile string
	// CertFile/KeyFile are the gateway's clientAuth leaf — the identity the
	// compute's pg_hba will verify in phase 4.
	CertFile string
	KeyFile  string
	// ServerName overrides the name verified against the compute cert's SANs.
	// Empty = the dialled Target.Host, which IS the compute Service DNS the
	// phase-1 leaf asserts. Leave the name UNROOTED: crypto/x509 trims a
	// trailing dot from the candidate name, so an unrooted SAN matches a rooted
	// dial host — but an unrooted SAN never matches a rooted *pattern*.
	ServerName string
}

// NewBackendTLSFromEnv builds the backend TLS-client config from the injected
// env. GW_COMPUTE_TLS defaults to TRUE (fail-closed by construction): shipping
// the safe value as the DEFAULT means a manifest that forgets the knob is
// encrypted, not plaintext. GW_COMPUTE_TLS=false is the documented dev opt-out
// (local/kind clusters with no cert-manager) and returns nil = plaintext dial,
// byte-identical to the pre-phase-3 behaviour.
//
// OPERATIONAL GATE (ADR-0003, phase 2->3): the code default flips here, but a
// live rollout must first have 100% of the compute fleet serving TLS (phase 2,
// including already-awake pre-phase-2 pods, which need a Recreate / 0<->N
// cycle). A compute that predates phase 2 answers 'N' and is refused.
func NewBackendTLSFromEnv(env Env) (*BackendTLS, error) {
	if !envTruthy(env.get("GW_COMPUTE_TLS", "true")) {
		return nil, nil
	}
	b := &BackendTLS{
		CAFile:     strings.TrimSpace(env.get("GW_COMPUTE_CA_FILE", defaultComputeCAFile)),
		CertFile:   strings.TrimSpace(env.get("GW_COMPUTE_CLIENT_CERT_FILE", defaultComputeClientCertFile)),
		KeyFile:    strings.TrimSpace(env.get("GW_COMPUTE_CLIENT_KEY_FILE", defaultComputeClientKeyFile)),
		ServerName: strings.TrimSpace(env.get("GW_COMPUTE_SERVER_NAME", "")),
	}
	// Half-configured fails FAST at startup (mirrors the front-door loadTLS
	// guard): a blanked path would otherwise dial half-secure — no client
	// identity, or no CA to verify the compute against.
	for _, f := range []struct{ key, val string }{
		{"GW_COMPUTE_CA_FILE", b.CAFile},
		{"GW_COMPUTE_CLIENT_CERT_FILE", b.CertFile},
		{"GW_COMPUTE_CLIENT_KEY_FILE", b.KeyFile},
	} {
		if f.val == "" {
			return nil, fmt.Errorf("backend TLS half-configured: %s is blank while GW_COMPUTE_TLS is on — set it, or set GW_COMPUTE_TLS=false for a plaintext dev cluster", f.key)
		}
	}
	return b, nil
}

// envTruthy reads a boolean GW_* knob. Anything other than an explicit false
// spelling keeps the secure value — a typo must not silently disable TLS.
func envTruthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "false", "0", "no", "off":
		return false
	}
	return true
}

// clientConfig builds the per-dial *tls.Config. The CA is read here (so a CA
// rotation is picked up per connection) and the client keypair is read inside
// GetClientCertificate (so it is re-read per HANDSHAKE, condition C3).
func (b *BackendTLS) clientConfig(host string) (*tls.Config, error) {
	pem, err := os.ReadFile(b.CAFile)
	if err != nil {
		return nil, fmt.Errorf("%w: reading the compute CA (GW_COMPUTE_CA_FILE=%s): %w", ErrBackendTLSUnavailable, b.CAFile, err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("%w: no certificate found in GW_COMPUTE_CA_FILE=%s", ErrBackendTLSUnavailable, b.CAFile)
	}
	name := b.ServerName
	if name == "" {
		name = host
	}
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		RootCAs:    pool,
		ServerName: name,
		// Re-read per handshake, NEVER read-once at boot: cert-manager rotates
		// the leaf in place on the mounted Secret (renewBefore 15d), and a
		// read-once gateway would keep presenting the stale/expired cert until
		// someone restarted it.
		GetClientCertificate: func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
			pair, err := tls.LoadX509KeyPair(b.CertFile, b.KeyFile)
			if err != nil {
				return nil, fmt.Errorf("loading the gateway client keypair (%s / %s): %w", b.CertFile, b.KeyFile, err)
			}
			return &pair, nil
		},
	}, nil
}

// setNoDelay applies TCP_NODELAY to the RAW socket. It MUST run on the raw
// *net.TCPConn BEFORE the TLS wrap — a *tls.Conn exposes no SetNoDelay, so
// deferring it past the upgrade would silently leave Nagle ON and add latency
// to every small Postgres message. Seam (a var) so the ordering is testable.
var setNoDelay = func(raw net.Conn) {
	if tcp, ok := raw.(*net.TCPConn); ok {
		_ = tcp.SetNoDelay(true)
	}
}

// startTLSHandshake is a seam over (*tls.Conn).Handshake so tests can observe
// WHEN the handshake runs relative to the raw-socket tuning above.
var startTLSHandshake = func(c *tls.Conn) error { return c.Handshake() }

// upgradeBackendTLS performs the libpq SSLRequest negotiation and, on 'S', the
// TLS client handshake. FAIL-CLOSED: every failure path returns an error
// wrapping ErrBackendTLSUnavailable and NO connection — a compute that refuses
// TLS is refused, never downgraded to plaintext.
func upgradeBackendTLS(raw net.Conn, host string, b *BackendTLS, timeout time.Duration) (net.Conn, error) {
	conf, err := b.clientConfig(host)
	if err != nil {
		return nil, err
	}
	if timeout > 0 {
		// Bound the negotiation + handshake the same way the dial is bounded, so
		// a wedged backend cannot hang a wake poll. Cleared on success.
		_ = raw.SetDeadline(time.Now().Add(timeout))
	}
	if _, err := raw.Write(proto.BuildSSLRequest()); err != nil {
		return nil, fmt.Errorf("%w: sending SSLRequest to %s: %w", ErrBackendTLSUnavailable, host, err)
	}
	reply := make([]byte, 1)
	if _, err := io.ReadFull(raw, reply); err != nil {
		return nil, fmt.Errorf("%w: reading the SSLRequest reply from %s: %w", ErrBackendTLSUnavailable, host, err)
	}
	if reply[0] != 'S' {
		// 'N' = this compute does not serve TLS (a pod that predates phase 2, or
		// a certless cluster). REFUSE. Retryable: a compute mid-boot may not have
		// its cert mounted yet, and the wake poll retries TryConnect.
		return nil, fmt.Errorf("%w: compute %s answered %q to SSLRequest (not yet serving TLS — see ADR-0003 phase 2->3 gate); refusing to fall back to plaintext", ErrBackendTLSUnavailable, host, string(reply))
	}
	tc := tls.Client(raw, conf)
	if err := startTLSHandshake(tc); err != nil {
		return nil, fmt.Errorf("%w: TLS handshake with compute %s (ServerName=%s): %w", ErrBackendTLSUnavailable, host, conf.ServerName, err)
	}
	if timeout > 0 {
		_ = raw.SetDeadline(time.Time{})
	}
	return tc, nil
}

// TryConnectTLS opens a backend connection with a timeout, upgrading it to TLS
// when b is non-nil (GW_COMPUTE_TLS on). b == nil is the plaintext dev path:
// no SSLRequest is sent at all, so the bytes on the wire are identical to the
// pre-phase-3 gateway.
func TryConnectTLS(t Target, timeout time.Duration, b *BackendTLS) (net.Conn, error) {
	addr := net.JoinHostPort(t.Host, strconv.Itoa(t.Port))
	raw, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrBackendDialFailed, err)
	}
	// TCP_NODELAY on the RAW socket, BEFORE any TLS wrap (see setNoDelay).
	setNoDelay(raw)
	if b == nil {
		return raw, nil
	}
	conn, err := upgradeBackendTLS(raw, t.Host, b, timeout)
	if err != nil {
		_ = raw.Close()
		return nil, err
	}
	return conn, nil
}
