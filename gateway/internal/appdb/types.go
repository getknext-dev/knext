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
	Phase              string      `json:"phase,omitempty"`
	TimelineID         string      `json:"timelineId,omitempty"`
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

// desiredReplicas is 1 for the warm tier, 0 (scale-to-zero) otherwise.
func (a *AppDatabase) desiredReplicas() int {
	if a.Spec.Tier == "warm" {
		return 1
	}
	return 0
}
