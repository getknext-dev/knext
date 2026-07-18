package appdb

import (
	"context"
	"database/sql"
	"sync"

	_ "github.com/lib/pq" // postgres driver for the warm-hold connections (SCRAM-SHA-256)
)

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
	dsn   func(ctx context.Context, app string) (string, error) // reads app-db-<app> DATABASE_URL
	dial  HoldDialer
	mu    sync.Mutex
	holds map[string]HoldConn
}

// NewHoldManager builds a manager. dsn resolves an app to its writer DSN (the
// Secret's DATABASE_URL key); dial opens connections.
func NewHoldManager(dsn func(ctx context.Context, app string) (string, error), dial HoldDialer) *HoldManager {
	return &HoldManager{dsn: dsn, dial: dial, holds: map[string]HoldConn{}}
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
		if err := held.Ping(ctx); err == nil {
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
	conn, err := m.dial.Dial(ctx, dsn)
	if err != nil {
		return err
	}
	if err := conn.Ping(ctx); err != nil {
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
type SQLDialer struct{}

type sqlHoldConn struct{ db *sql.DB }

func (SQLDialer) Dial(_ context.Context, dsn string) (HoldConn, error) {
	db, err := sql.Open("postgres", dsn)
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
