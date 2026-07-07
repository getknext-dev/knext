package zone

import (
	"context"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// The reconciler depends only on these narrow ports so the decision logic in
// reconcile.go is exercised in table tests against in-memory fakes (reconcile_test.go)
// and against real client-go surfaces in production (appdbclient.go, execsql.go, k8s.go).

// AppDBOps is the compose layer: the Zone operator OWNS an AppDatabase CR named after
// the zone (ADR-0006 delegation). It never renders compute itself — the appdb
// operator reconciles the AppDatabase. All methods are idempotent.
type AppDBOps interface {
	// EnsureAppDatabase creates-or-updates the zone's AppDatabase (spec fields the
	// Zone delegates: tier, quotas, roPool), owned by the Zone via ownerReferences.
	EnsureAppDatabase(ctx context.Context, spec ComposeSpec) error
	// AppDatabaseReady reports whether the composed AppDatabase's status.phase is Ready.
	AppDatabaseReady(ctx context.Context, name string) (bool, error)
	// DeleteAppDatabase deletes the composed AppDatabase (its own finalizer reclaims
	// the timeline two-sided). Idempotent (ignore-not-found). Returns gone=true once
	// the object is actually removed, so the Zone finalizer waits for the reclaim.
	DeleteAppDatabase(ctx context.Context, name string) (gone bool, err error)
}

// ComposeSpec is the fully-resolved input to the composed AppDatabase.
type ComposeSpec struct {
	Zone         string // AppDatabase name (== zone name)
	Tier         string // cold | warm
	Quotas       Quotas
	ReadReplicas bool // → AppDatabase.spec.roPool.enabled
	// OwnerUID/OwnerName wire the ownerReference so deleting the Zone garbage-collects
	// the AppDatabase even if the finalizer path is bypassed.
	OwnerUID  string
	OwnerName string
}

// SQLOps runs admin SQL against a zone's compute as cloud_admin over pod-local
// loopback (exec into compute-<zone>, the #112/#133 pattern — cloud_admin is
// loopback-only). Every method ensures the target compute is awake first. All are
// idempotent.
type SQLOps interface {
	// EnsureReplRole (re)asserts the per-zone repl_<zone> role (LOGIN REPLICATION)
	// on the zone's own compute, setting its PLAINTEXT password under
	// password_encryption=scram-sha-256 so Postgres stores a SCRAM-SHA-256 verifier
	// (issue #117; no precomputed md5). Durable on the timeline.
	EnsureReplRole(ctx context.Context, zone, role, password string) error
	// EnsurePublication (re)creates a publication for the tables + grants the repl
	// role SELECT, on the zone's own compute.
	EnsurePublication(ctx context.Context, zone, pub, replRole string, tables []string) error
	// DropPublication drops a publication on the zone's own compute.
	DropPublication(ctx context.Context, zone, pub string) error
	// EnsureSubscription (re)creates a subscription on THIS zone's compute against the
	// peer publications over the gateway-mediated conninfo.
	EnsureSubscription(ctx context.Context, zone, sub, conn string, publications []string) error
	// DropSubscription disables + detaches the slot then drops the subscription on
	// THIS zone's compute (safe when the peer is unreachable).
	DropSubscription(ctx context.Context, zone, sub string) error
	// DropReplicationSlot drops an INACTIVE slot on a PEER publisher's compute
	// (deprovision hygiene, ADR-0007 §4d). The peer must be awake (caller wakes it).
	DropReplicationSlot(ctx context.Context, peerZone, slot string) error
	// SlotInvalidatedOnPeer reports whether the named slot on peerZone's compute has
	// been invalidated (wal_status in lost/unreserved — the #143 max_slot_wal_keep_size
	// degrade). Reads pg_replication_slots on the PEER WITHOUT waking it: the caller
	// MUST gate on the peer already being awake (ComputeAwake) so a settled healthy
	// publisher is never force-woken just to poll (the #145 scale-to-zero invariant).
	// A not-ready peer surfaces as an error the caller treats as transient (retry).
	SlotInvalidatedOnPeer(ctx context.Context, peerZone, slot string) (bool, error)
	// ResyncSubscription DROPs and re-CREATEs a subscription WITH copy_data on THIS
	// zone's compute — the designed recovery from an invalidated slot (ADR-0007 §4a
	// "degrade to re-sync"). The CREATE's initial COPY connects the walreceiver through
	// the apps-gateway, which wakes the (real-signal-driven) publisher; this is a
	// recovery action, NOT a per-tick poll, so it does not violate scale-to-zero.
	ResyncSubscription(ctx context.Context, zone, sub, conn string, publications []string) error
	// EnsureFederation provisions postgres_fdw foreign tables on THIS zone's compute
	// for a mode:federate dependency.
	EnsureFederation(ctx context.Context, zone, fromZone, conn, replRole, password string, tables []string) error
	// DropFederation removes a federated peer's FDW objects on THIS zone's compute.
	DropFederation(ctx context.Context, zone, fromZone string) error
}

// ClusterOps is everything the reconciler needs from the API server for the Zone's
// own child objects (the per-zone repl Secret), compute wake control (for SQL apply),
// and the CR's status/finalizer. All methods are idempotent.
type ClusterOps interface {
	// EnsureReplSecret mints zone-repl-<zone> (REPL_PASSWORD + REPL_ROLE_MD5) if
	// absent, preserving a live password on re-reconcile. Returns the password + md5
	// currently in the Secret so the operator can (a) assert the role and (b) build a
	// consumer's conninfo to THIS zone.
	EnsureReplSecret(ctx context.Context, zone, role string, newPassword func() string) (password, md5hex string, err error)
	// ReplSecret reads a (possibly peer) zone's repl Secret. ok=false when absent.
	ReplSecret(ctx context.Context, zone string) (password, md5hex string, ok bool, err error)
	// DeleteReplSecret removes zone-repl-<zone> (deprovision). Idempotent.
	DeleteReplSecret(ctx context.Context, zone string) error
	// ComputeExists reports whether the compute-<zone> Deployment exists at all. Used
	// by deprovision to skip in-DB drops when the composed AppDatabase (and thus the
	// compute + its catalog objects) is already gone — the finalizer must still
	// complete, never wedge on "deployment not found".
	ComputeExists(ctx context.Context, zone string) (bool, error)
	// ComputeAwake reports whether compute-<zone> has >=1 ready replica.
	ComputeAwake(ctx context.Context, zone string) (bool, error)
	// WakeCompute scales compute-<zone> to >=1 and waits until a replica is ready, so
	// admin SQL can run. No-op if already awake.
	WakeCompute(ctx context.Context, zone string) error

	UpdateStatus(ctx context.Context, cr *Zone) error
	AddFinalizer(ctx context.Context, cr *Zone) error
	RemoveFinalizer(ctx context.Context, cr *Zone) error
	Event(cr *Zone, eventType, reason, message string)
}

// ZoneLister lists every Zone in the namespace — the reconciler needs peer specs to
// enforce the both-sides-agree + single-writer governance guards (spec-level, §3/§5).
type ZoneLister interface {
	ListZones(ctx context.Context) ([]*Zone, error)
}

// Deps is the reconciler's injected surface. Clock + password generator are injected
// so tests are deterministic.
type Deps struct {
	AppDB   AppDBOps
	SQL     SQLOps
	Cluster ClusterOps
	Zones   ZoneLister

	Namespace      string
	GatewayHost    string // apps-gateway service DNS (pggw-apps.scale-zero-pg.svc)
	GatewayPort    int    // apps-gateway writer/replication port (55432)
	ReplRolePrefix string // "repl_" — lock-step with the apps-gateway GW_REPL_ROLE_PREFIX (#140)

	// AutoResync, when true, makes the operator auto-actuate the re-sync (DROP+CREATE
	// SUBSCRIPTION copy_data) on an invalidated slot. When false, the operator only
	// flips status to NeedsResync + surfaces the one-command runbook (operator choice).
	AutoResync bool

	NewPassword func() string
	Now         func() metav1.Time
}
