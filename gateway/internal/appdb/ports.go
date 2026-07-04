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
}

// ClusterOps is everything the reconciler needs from the API server: the per-app
// child objects (Secret / ConfigMap / Deployment / Service), the reclaim ledger,
// and the CR's own status/finalizer. All methods are idempotent.
type ClusterOps interface {
	// SecretExists reports whether the per-app credential Secret already exists.
	SecretExists(ctx context.Context, app string) (bool, error)
	// CreateSecret mints the per-app credential Secret (role + md5 + DSN). Only
	// called when SecretExists is false, so a live app is never locked out.
	CreateSecret(ctx context.Context, app, role, password, md5, dsn string) error
	// EnsureSecretROKey reconciles the DATABASE_URL_RO key on the per-app Secret
	// to match the read-replica-pool request (ADR-0006 #119). When enabled it
	// derives DATABASE_URL_RO from the writer DATABASE_URL (same role/password/
	// host/database, gateway RO port) and sets it; when disabled it removes the
	// key. Idempotent (no write when already in the desired state) and it NEVER
	// touches PGPASSWORD, so a live app is never locked out.
	EnsureSecretROKey(ctx context.Context, app string, enabled bool, writerPort, roPort int) error
	// ApplyCompute server-side-applies the ConfigMap + Deployment + Service for the app.
	ApplyCompute(ctx context.Context, spec ComputeSpec) error
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
