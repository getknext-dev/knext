package appdb

import (
	"context"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// The reconciler depends only on these narrow ports, so the decision logic in
// reconcile.go is exercised in table tests against in-memory fakes (reconcile_test.go)
// and against real client-go / HTTP surfaces in production (k8s.go, pageserver.go).

// PageserverOps is the pageserver management API (:9898) the reconciler needs to
// branch and reclaim an app's timeline. Mirrors provision-app.sh's PS() calls.
type PageserverOps interface {
	// TimelineExists reports whether timeline tl exists under tenant.
	TimelineExists(ctx context.Context, tenant, tl string) (bool, error)
	// TemplateLastLSN returns the template timeline's last_record_lsn (the branch point).
	TemplateLastLSN(ctx context.Context, tenant, template string) (string, error)
	// Branch creates timeline tl as a child of template at lsn (idempotent on tl).
	Branch(ctx context.Context, tenant, tl, template, lsn string, pgVersion int) error
	// DeleteTimeline removes tl's pages/WAL from the pageserver (404 == already gone).
	DeleteTimeline(ctx context.Context, tenant, tl string) error
}

// SafekeeperOps deletes a timeline's WAL dir on each safekeeper (:7676). Two-sided
// delete (pageserver + all safekeepers) is what keeps deprovision from leaking WAL
// (issue #91). Replicas() is the safekeeper StatefulSet size.
type SafekeeperOps interface {
	Replicas() int
	// DeleteTimeline removes tl's WAL on safekeeper ordinal (best-effort per pod).
	DeleteTimeline(ctx context.Context, ordinal int, tenant, tl string) error
}

// ComputeSpec is the fully-resolved input to rendering an app's compute objects.
// It is the Go equivalent of the sed-substituted deploy/compute-app.template.yaml.
type ComputeSpec struct {
	App        string
	TenantID   string
	TimelineID string
	Replicas   int
	Quotas     Quotas
	// OwnerRef is the controller ownerReference to the owning AppDatabase, stamped on
	// the rendered children so k8s cascade-GC reaps them on CR delete (#122). Nil when
	// the CR has no UID yet — the apply then leaves ownerReferences untouched.
	OwnerRef *metav1.OwnerReference
}

// ROComputeSpec is the fully-resolved input to rendering an app's PER-APP read-only
// compute (compute-ro-<app>, issue #127). It is attached to the app's OWN timeline
// (the SAME TenantID/TimelineID as the writer ComputeSpec) so reads reflect the
// app's committed data and NEVER another tenant's. The RO compute is the read-scaling
// serving endpoint DATABASE_URL_RO points at (via the apps-gateway RO listener). It
// mirrors deploy/26-compute-ro.yaml but per-app: own Deployment/Service, ephemeral
// storage sized for a loaded replica (#121), and an OPTIONAL per-app HPA when
// MaxReplicas>0. At rest it sits at 0 replicas (the apps-gateway RO lane scales it
// 0<->N on read connections, like the writer lane scales the writer 0<->1).
type ROComputeSpec struct {
	App         string
	TenantID    string
	TimelineID  string
	MinReplicas int // per-app HPA floor (0 = gateway-managed scale-to-zero, no HPA)
	MaxReplicas int // per-app HPA ceiling (0 = no HPA rendered)
	// OwnerRef is the controller ownerReference to the owning AppDatabase (#122).
	OwnerRef *metav1.OwnerReference
}

// ClusterOps is everything the reconciler needs from the API server: the per-app
// child objects (Secret / ConfigMap / Deployment / Service), the reclaim ledger,
// and the CR's own status/finalizer. All methods are idempotent.
type ClusterOps interface {
	// SecretExists reports whether the per-app credential Secret already exists.
	SecretExists(ctx context.Context, app string) (bool, error)
	// CreateSecret mints the per-app credential Secret (role + SCRAM verifier + DSN).
	// Only called when SecretExists is false, so a live app is never locked out. owner
	// (nil-safe) is the controller ownerReference to the AppDatabase (#122).
	CreateSecret(ctx context.Context, app, role, password, verifier, dsn string, owner *metav1.OwnerReference) error
	// EnsureSecretOwnerRef back-fills the controller ownerReference on an EXISTING
	// per-app Secret so live apps provisioned before ownerRefs (or by provision-app.sh)
	// converge on the next reconcile (#122). Idempotent: no-op when owner is nil, the
	// secret is absent, or the ref is already present. Never touches secret data.
	EnsureSecretOwnerRef(ctx context.Context, app string, owner *metav1.OwnerReference) error
	// EnsureSecretROKey reconciles the DATABASE_URL_RO key on the per-app Secret
	// to match the read-replica-pool request (ADR-0006 #119). When enabled it
	// derives DATABASE_URL_RO from the writer DATABASE_URL (same role/password/
	// host/database, gateway RO port) and sets it; when disabled it removes the
	// key. Idempotent (no write when already in the desired state) and it NEVER
	// touches PGPASSWORD, so a live app is never locked out.
	EnsureSecretROKey(ctx context.Context, app string, enabled bool, writerPort, roPort int) error
	// ApplyCompute server-side-applies the ConfigMap + Deployment + Service for the app.
	ApplyCompute(ctx context.Context, spec ComputeSpec) error
	// ApplyROCompute upserts the app's PER-APP read-only compute (compute-ro-<app>
	// Deployment + Service, and an optional per-app HPA when MaxReplicas>0), attached
	// to the app's OWN timeline (issue #127). Idempotent; preserves the live replica
	// count (the apps-gateway RO lane owns 0<->N scaling).
	ApplyROCompute(ctx context.Context, spec ROComputeSpec) error
	// DeleteROCompute removes the app's read-only compute (Deployment + Service + HPA).
	// Called when roPool is disabled or the app is deleted. Idempotent (ignore-not-found).
	DeleteROCompute(ctx context.Context, app string) error
	// DeleteCompute removes the app's Deployment + Service + ConfigMap + Secret.
	DeleteCompute(ctx context.Context, app string) error
	// DeploymentAvailable reports whether compute-<app> has >=1 available replica.
	DeploymentAvailable(ctx context.Context, app string) (bool, error)

	// RecordReclaimPending durably notes safekeeper DELETEs that could not complete
	// (safekeeper down), keyed by timeline id — the reclaim-orphans backstop (#91).
	RecordReclaimPending(ctx context.Context, tl, ordinals string) error
	// ClearReclaimPending drops a timeline's pending record once fully reclaimed.
	ClearReclaimPending(ctx context.Context, tl string) error

	// UpdateStatus persists cr.Status via the status subresource.
	UpdateStatus(ctx context.Context, cr *AppDatabase) error
	// AddFinalizer / RemoveFinalizer edit cr.Finalizers (and the object).
	AddFinalizer(ctx context.Context, cr *AppDatabase) error
	RemoveFinalizer(ctx context.Context, cr *AppDatabase) error
	// Event records a Kubernetes Event on the CR (Normal/Warning).
	Event(cr *AppDatabase, eventType, reason, message string)
}

// Clock and id/secret generators are injected so tests are deterministic.
type Deps struct {
	Pageserver    PageserverOps
	Safekeeper    SafekeeperOps
	Cluster       ClusterOps
	Tenant        string // apps tenant id (APPS_TENANT)
	Template      string // shared template timeline id (TEMPLATE_TL)
	PGVersion     int
	RolePrefix    string // app role prefix, e.g. "app_"
	GatewayHost   string // apps-gateway service DNS for the DSN, e.g. pggw-apps.scale-zero-pg.svc
	GatewayPort   int    // apps-gateway writer port (55432)
	GatewayROPort int    // apps-gateway read-only pool port (55434) for DATABASE_URL_RO
	Namespace     string

	// NewTimelineID mints a fresh 32-hex timeline id (crypto/rand in prod; fixed in tests).
	NewTimelineID func() string
	// NewPassword mints a fresh per-app password (crypto/rand in prod; fixed in tests).
	NewPassword func() string
	// Now returns the current time (for condition timestamps).
	Now func() metav1.Time
}
