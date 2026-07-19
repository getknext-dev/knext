package appdb

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"time"

	_ "github.com/lib/pq" // postgres driver for the warm-hold connections (SCRAM-SHA-256)
)

// DefaultHoldTimeout bounds every warm-hold Dial/Ping (review finding, #388).
// EnsureHold runs synchronously inside the controller's single-goroutine
// reconcileAll, on the long-lived signal context (no deadline) — without a
// bound, one unreachable/black-holed compute would block on the OS TCP
// connect timeout (tens of seconds+), stalling reconciliation of EVERY other
// AppDatabase behind it. Mirrors the APPDB_HTTP_TIMEOUT_MS pattern already
// used for the pageserver/safekeeper HTTP calls (cmd/appdb-operator/main.go).
// Best-effort warming must never degrade the whole operator.
const DefaultHoldTimeout = 5 * time.Second

// The warm-hold manager (knext #388, ADR-0030 addendum) is the production
// actuator behind the WarmHolds port. A "hold" is ONE open, authenticated,
// idle postgres connection per app through the apps-gateway. It warms the app
// TWO ways at once:
//
//  1. The FIRST dial rides the gateway's normal wake path, scaling the compute
//     0->1 exactly like a client connection would (single-writer preserved —
//     the operator never touches spec.replicas; it holds no deployments/scale
//     grant). One wake-budget token per cold wake, like any client.
//  2. While the connection stays open the gateway counts the compute as
//     ACTIVE, so its idle scale-to-zero (GW_IDLE_MS) never arms — the compute
//     stays at 1 for the whole declared window no matter how little traffic
//     the app sees. This is the piece a replica-scaling CronJob CANNOT do: a
//     Deployment pinned at 1 is still parked by the gateway 60s after the last
//     query (the gateway owns replica counts; two writers would thrash — the
//     same defect ADR-0030 §Context records for min-scale patches).
//
// The authentication is REAL (SCRAM-SHA-256 via lib/pq against the per-app
// verifier), so a held window also proves the app's credential path end-to-end
// — the first user query in the window pays neither the compute wake nor a
// cold-auth surprise. The DSN is read from the operator-minted app-db-<app>
// Secret's DATABASE_URL key (the external-driver contract), never reconstructed.
//
// Cost (documented): 1 of GW_MAX_CONNS (90) per held app, one SELECT-1 ping per
// reconcile pass (APPDB_RESYNC_MS, default 15s) as the liveness check, and the
// compute's reserved cpu/mem for the window — the opt-in warm cost the owner
// declared. The manager is in-memory ON PURPOSE: an operator restart drops all
// holds (TCP dies with the process), the gateway parks the computes on idle,
// and the next resync re-establishes — crash-only, self-healing, no state to
// rebuild.

// HoldConn is one held connection. The production implementation wraps
// *sql.DB; tests fake it.
type HoldConn interface {
	// Ping verifies the connection is still live end-to-end (through the
	// gateway, against the compute). A dead hold must be re-dialed.
	Ping(ctx context.Context) error
	Close() error
}

// HoldDialer opens a hold connection for a DSN.
type HoldDialer interface {
	Dial(ctx context.Context, dsn string) (HoldConn, error)
}

// HoldManager tracks one hold per app. Safe for concurrent use (the controller
// is single-goroutine today; the lock keeps that an accident, not a contract).
type HoldManager struct {
	dsn     func(ctx context.Context, app string) (string, error) // reads app-db-<app> DATABASE_URL
	dial    HoldDialer
	timeout time.Duration // bounds every Dial/Ping regardless of the caller's ctx deadline
	mu      sync.Mutex
	holds   map[string]HoldConn
}

// NewHoldManager builds a manager. dsn resolves an app to its writer DSN (the
// Secret's DATABASE_URL key); dial opens connections. timeout bounds every
// Dial/Ping the manager issues (DefaultHoldTimeout when <= 0) — see
// DefaultHoldTimeout for why this must never be unbounded.
func NewHoldManager(dsn func(ctx context.Context, app string) (string, error), dial HoldDialer, timeout time.Duration) *HoldManager {
	if timeout <= 0 {
		timeout = DefaultHoldTimeout
	}
	return &HoldManager{dsn: dsn, dial: dial, timeout: timeout, holds: map[string]HoldConn{}}
}

// EnsureHold makes sure the app's hold is established and alive. Idempotent:
// an already-held app is pinged (liveness) and re-dialed only if the ping
// fails (compute restart, gateway rollout, network partition). A fresh dial is
// verified with a ping BEFORE it counts as held, so a half-open connection
// (e.g. the role not yet re-applied on a cold boot) surfaces as an error and
// is retried on the next pass instead of falsely reporting warm.
func (m *HoldManager) EnsureHold(ctx context.Context, app string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if held, ok := m.holds[app]; ok {
		pingCtx, cancel := context.WithTimeout(ctx, m.timeout)
		err := held.Ping(pingCtx)
		cancel()
		if err == nil {
			return nil
		}
		// Dead hold: close the corpse and fall through to a fresh dial.
		_ = held.Close()
		delete(m.holds, app)
	}
	dsn, err := m.dsn(ctx, app)
	if err != nil {
		return err
	}
	dialCtx, cancel := context.WithTimeout(ctx, m.timeout)
	conn, err := m.dial.Dial(dialCtx, dsn)
	cancel()
	if err != nil {
		return err
	}
	pingCtx, cancel := context.WithTimeout(ctx, m.timeout)
	err = conn.Ping(pingCtx)
	cancel()
	if err != nil {
		_ = conn.Close()
		return err
	}
	m.holds[app] = conn
	return nil
}

// ReleaseHold drops the app's hold. A no-op when unheld — window-end and
// delete paths both call it, and a double-release must be safe.
func (m *HoldManager) ReleaseHold(app string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if held, ok := m.holds[app]; ok {
		_ = held.Close()
		delete(m.holds, app)
	}
}

// Held snapshots the currently-held apps (the /metrics gauge reads this:
// appdb_warm_hold_active{app=...} 1). The returned map is a copy.
func (m *HoldManager) Held() map[string]bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]bool, len(m.holds))
	for app := range m.holds {
		out[app] = true
	}
	return out
}

// ---- production adapter (lib/pq over database/sql) -------------------------

// SQLDialer opens holds with database/sql + lib/pq. The DSN is the Secret's
// DATABASE_URL (postgres://app_<app>:<pw>@pggw-apps...:55432/<app>?sslmode=disable)
// — lib/pq speaks SCRAM-SHA-256, which is what the operator-minted role uses
// from boot (#117).
//
// ConnectTimeout bounds lib/pq's OWN raw TCP connect (review finding, #388).
// database/sql's LEGACY connector path — the only one lib/pq implements, it
// has no driver.DriverContext/OpenConnector — calls driver.Open(dsn)
// SYNCHRONOUSLY with the caller's context.Context discarded entirely
// (database/sql's dsnConnector.Connect ignores its ctx argument). A
// context.WithTimeout around Dial (HoldManager already applies one, above)
// therefore does NOT bound a fresh connect against a black-holed/unreachable
// compute — only the DSN's connect_timeout parameter does (lib/pq reads it
// and calls net.Dialer.DialTimeout internally). SQLDialer derives a
// LOCAL, warm-hold-only DSN with connect_timeout appended; the Secret's
// DATABASE_URL (the external-driver contract apps read) is never touched.
type SQLDialer struct {
	// ConnectTimeout bounds the raw TCP connect. <= 0 falls back to
	// DefaultHoldTimeout — never silently unbounded.
	ConnectTimeout time.Duration
}

// dsnWithTimeout returns dsn with a connect_timeout query parameter applied,
// derived from ConnectTimeout (DefaultHoldTimeout if unset). A DSN that
// already declares connect_timeout (an explicit owner override) is left
// untouched.
func (d SQLDialer) dsnWithTimeout(dsn string) string {
	timeout := d.ConnectTimeout
	if timeout <= 0 {
		timeout = DefaultHoldTimeout
	}
	secs := int(timeout / time.Second)
	if secs <= 0 {
		secs = 1 // a sub-second timeout still needs a >=1s DSN value (lib/pq parses whole seconds)
	}
	return appendConnectTimeout(dsn, secs)
}

// appendConnectTimeout adds connect_timeout=<seconds> to a postgres DSN's
// query string if one is not already present. String-level rather than
// net/url-based: the DSN's userinfo (role:password) must reach lib/pq
// byte-for-byte, and a round-trip through url.Parse/url.String is unnecessary
// risk for a simple query-param append.
func appendConnectTimeout(dsn string, seconds int) string {
	if strings.Contains(dsn, "connect_timeout=") {
		return dsn
	}
	sep := "?"
	if strings.Contains(dsn, "?") {
		sep = "&"
	}
	return fmt.Sprintf("%s%sconnect_timeout=%d", dsn, sep, seconds)
}

type sqlHoldConn struct{ db *sql.DB }

func (d SQLDialer) Dial(_ context.Context, dsn string) (HoldConn, error) {
	db, err := sql.Open("postgres", d.dsnWithTimeout(dsn))
	if err != nil {
		return nil, err
	}
	// Exactly ONE held connection per app: pool of 1, kept idle-open, no
	// lifetime recycling (a recycled conn would flap the hold each lifetime).
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)
	db.SetConnMaxIdleTime(0)
	return &sqlHoldConn{db: db}, nil
}

func (c *sqlHoldConn) Ping(ctx context.Context) error { return c.db.PingContext(ctx) }
func (c *sqlHoldConn) Close() error                   { return c.db.Close() }
