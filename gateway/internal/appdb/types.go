// Package appdb implements the AppDatabase operator (ADR-0004, #96): a client-go
// reconcile controller that makes reality match an AppDatabase custom resource by
// reimplementing the proven imperative logic of deploy/provision-app.sh in Go —
// branch the shared apps-template timeline, render the per-app compute
// (Deployment + Service + ConfigMap), mint the per-app credential Secret, and wire
// the apps-gateway routing. The reconcile decision logic (reconcile.go) is pure and
// port-driven so it is table-testable with faked k8s + pageserver surfaces.
package appdb

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
)

// Group/Version/Resource for the AppDatabase CRD (deploy/82-appdb-crd.yaml).
const (
	Group    = "apps.scale-zero-pg.dev"
	Version  = "v1alpha1"
	Resource = "appdatabases"
	Kind     = "AppDatabase"

	// Finalizer runs safe deprovision before the CR object is removed.
	Finalizer = "apps.scale-zero-pg.dev/deprovision"
)

// GVR is the dynamic-client resource handle for AppDatabase objects.
var GVR = schema.GroupVersionResource{Group: Group, Version: Version, Resource: Resource}

// Phases (status.phase).
const (
	PhaseProvisioning = "Provisioning"
	PhaseReady        = "Ready"
	PhaseFailed       = "Failed"
	PhaseDeleting     = "Deleting"
)

// Condition types.
const (
	CondProvisioned = "Provisioned" // branch + child objects exist
	CondReady       = "Ready"       // compute has an available replica
	// CondColdRestorable reports whether this app is recoverable by a COLD restore
	// (fresh cluster, object-storage bucket only) RIGHT NOW. It is True once the shared
	// template timeline's remote_consistent_lsn has caught up to this branch's ancestor
	// LSN — i.e. the template layers the branch's unmodified pages depend on are durable
	// in object storage (docs/runbook-dr.md §9d-bis). It is briefly False in the first
	// seconds-to-minutes of a freshly-provisioned app while the template WAL tail flushes.
	// It does NOT gate serving readiness (that is CondReady) — the app is fully usable
	// while this is still False; this condition is purely about disaster-restore coverage.
	CondColdRestorable = "ColdRestorable"
)

// AppDatabase is the typed view of the CR the reconciler operates on. The
// controller converts unstructured <-> this struct at the edges (controller.go);
// tests construct it directly.
type AppDatabase struct {
	Name              string // metadata.name
	Namespace         string
	UID               string // metadata.uid (for Event involvedObject)
	ResourceVersion   string // metadata.resourceVersion (optimistic concurrency)
	Generation        int64
	DeletionTimestamp *metav1.Time
	Finalizers        []string
	Spec              AppDatabaseSpec
	Status            AppDatabaseStatus
}

// AppDatabaseSpec mirrors deploy/82-appdb-crd.yaml .spec.
type AppDatabaseSpec struct {
	AppName              string `json:"appName"`
	Tier                 string `json:"tier,omitempty"`
	Quotas               Quotas `json:"quotas,omitempty"`
	ROPool               ROPool `json:"roPool,omitempty"`
	KeepTimelineOnDelete bool   `json:"keepTimelineOnDelete,omitempty"`
}

// Quotas is the per-app noisy-neighbour bound (issue #89). cpu/mem are LIMITS;
// requests default. Empty fields resolve to DefaultQuotas.
type Quotas struct {
	CPU            string `json:"cpu,omitempty"`
	CPURequest     string `json:"cpuRequest,omitempty"`
	Mem            string `json:"mem,omitempty"`
	MemRequest     string `json:"memRequest,omitempty"`
	MaxConnections int    `json:"maxConnections,omitempty"`
}

// ROPool is the declarative read-replica surface (reconciled by the read-scaling lane).
type ROPool struct {
	Enabled     bool `json:"enabled,omitempty"`
	MinReplicas int  `json:"minReplicas,omitempty"`
	MaxReplicas int  `json:"maxReplicas,omitempty"`
}

// AppDatabaseStatus mirrors deploy/82-appdb-crd.yaml .status.
type AppDatabaseStatus struct {
	Phase string `json:"phase,omitempty"`
	// SecretName is the output credential Secret an external driver reads/mirrors
	// (app-db-<appName>). Published so consumers wait on + read the name from
	// status rather than reconstructing it (external-driver contract, #119).
	SecretName string `json:"secretName,omitempty"`
	TimelineID string `json:"timelineId,omitempty"`
	// AncestorLSN is the template `last_record_lsn` this app branched from (its
	// ancestor point). Persisted at branch time so the cold-restorability check
	// (docs/runbook-dr.md §9d-bis) can compare it against the template's advancing
	// remote_consistent_lsn without re-reading the branch. Empty for apps provisioned
	// before this field existed (or by provision-app.sh); those skip the check.
	AncestorLSN        string      `json:"ancestorLsn,omitempty"`
	ComputeReady       bool        `json:"computeReady,omitempty"`
	Message            string      `json:"message,omitempty"`
	ObservedGeneration int64       `json:"observedGeneration,omitempty"`
	Conditions         []Condition `json:"conditions,omitempty"`
}

// Condition is a minimal k8s-style status condition.
type Condition struct {
	Type               string       `json:"type"`
	Status             string       `json:"status"`
	Reason             string       `json:"reason,omitempty"`
	Message            string       `json:"message,omitempty"`
	LastTransitionTime *metav1.Time `json:"lastTransitionTime,omitempty"`
}

// DefaultQuotas mirror provision-app.sh's DEF_* knobs.
var DefaultQuotas = Quotas{
	CPU:            "1000m",
	CPURequest:     "250m",
	Mem:            "1Gi",
	MemRequest:     "256Mi",
	MaxConnections: 100,
}

// resolved fills empty quota fields from DefaultQuotas so the reconciler and the
// rendered Deployment always see a complete set (idempotent).
func (q Quotas) resolved() Quotas {
	out := q
	if out.CPU == "" {
		out.CPU = DefaultQuotas.CPU
	}
	if out.CPURequest == "" {
		out.CPURequest = DefaultQuotas.CPURequest
	}
	if out.Mem == "" {
		out.Mem = DefaultQuotas.Mem
	}
	if out.MemRequest == "" {
		out.MemRequest = DefaultQuotas.MemRequest
	}
	if out.MaxConnections == 0 {
		out.MaxConnections = DefaultQuotas.MaxConnections
	}
	return out
}

// hasFinalizer reports whether the CR carries the deprovision finalizer.
func (a *AppDatabase) hasFinalizer() bool {
	for _, f := range a.Finalizers {
		if f == Finalizer {
			return true
		}
	}
	return false
}

// deleting reports whether the CR is pending deletion.
func (a *AppDatabase) deleting() bool { return a.DeletionTimestamp != nil }

// ownerRef returns a controller owner reference to this AppDatabase for the child
// objects the operator creates (Secret / ConfigMap / Deployment / Service / HPA), so
// k8s garbage-collects them NATIVELY when the CR is deleted — defense-in-depth over
// the finalizer deprovision path: if the finalizer is force-removed while the
// operator is down, the children still reap via ownerReference cascade GC (issue #122).
//
// Returns nil when the CR has no UID (a hand-built object in a test, or a CR not yet
// persisted): an ownerReference with an EMPTY UID is dangerous — the GC controller
// treats it as a dangling owner and would DELETE the child. Omitting it is the safe
// default; the next reconcile of a persisted CR (UID populated) back-fills the ref.
//
// blockOwnerDeletion is false on purpose. Setting it true makes the
// OwnerReferencesPermissionEnforcement admission plugin require the operator
// ServiceAccount to hold `update` on the appdatabases/finalizers subresource — an
// extra RBAC grant. Background cascade delete (the default when an AppDatabase is
// deleted) reclaims the children without it, so we keep RBAC unchanged.
func (a *AppDatabase) ownerRef() *metav1.OwnerReference {
	if a.UID == "" {
		return nil
	}
	controller := true
	blockOwnerDeletion := false
	return &metav1.OwnerReference{
		APIVersion:         Group + "/" + Version,
		Kind:               Kind,
		Name:               a.Name,
		UID:                types.UID(a.UID),
		Controller:         &controller,
		BlockOwnerDeletion: &blockOwnerDeletion,
	}
}

// desiredReplicas is 1 for the warm tier, 0 (scale-to-zero) otherwise.
func (a *AppDatabase) desiredReplicas() int {
	if a.Spec.Tier == "warm" {
		return 1
	}
	return 0
}
