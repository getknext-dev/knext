// Package zone implements the Zone operator (ADR-0007, #139 v2-2): a client-go
// reconcile controller for the zone-scaling axis (docs/SCALING.md §4). A Zone is a
// higher-altitude controller that COMPOSES an AppDatabase (ADR-0006 delegation
// pattern — the zone's strong-consistency in-zone DB + RO pool) and layers the
// cross-zone fabric on top: a per-zone REPLICATION role, publications (the declared
// export boundary), and — per declared dataDependency — logical-replication
// subscriptions (mode: replicate) or postgres_fdw foreign tables (mode: federate).
//
// The reconcile decision logic (reconcile.go) is pure and port-driven so it is
// table-testable with faked AppDatabase / SQL / cluster surfaces, exactly like the
// appdb operator it mirrors. The SQL it emits is built + validated by the pure
// helpers in sql.go (identifier quoting, table-name validation, the both-sides-agree
// and single-writer-per-replicated-table governance guards).
package zone

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// Group/Version/Resource for the Zone CRD (deploy/86-zone-crd.yaml).
const (
	Group    = "zones.scale-zero-pg.dev"
	Version  = "v1alpha1"
	Resource = "zones"
	Kind     = "Zone"

	// Finalizer runs cross-zone deprovision hygiene (ADR-0007 §4d) BEFORE the
	// composed AppDatabase teardown reclaims the timeline.
	Finalizer = "zones.scale-zero-pg.dev/deprovision"
)

// GVR is the dynamic-client resource handle for Zone objects.
var GVR = schema.GroupVersionResource{Group: Group, Version: Version, Resource: Resource}

// AppDatabase GVR the Zone operator COMPOSES (ADR-0006). Referenced by the stable
// public group/version/resource strings — the zone operator never imports the appdb
// package (the layers stay independently ownable, ADR-0007 §1), it only creates/owns
// an AppDatabase CR the appdb operator reconciles.
var AppDBGVR = schema.GroupVersionResource{
	Group: "apps.scale-zero-pg.dev", Version: "v1alpha1", Resource: "appdatabases",
}

// Replication modes (spec.dataDependencies[].mode).
const (
	ModeReplicate = "replicate" // logical replication: a local, eventually-consistent copy
	ModeFederate  = "federate"  // postgres_fdw foreign tables: live cross-zone read, no copy
)

// Phases (status.phase).
const (
	PhaseComposing = "Composing" // the in-zone AppDatabase is still coming up
	PhaseReady     = "Ready"     // DB ready + all declared fabric reconciled
	PhaseDegraded  = "Degraded"  // a dependency could not be wired (governance denial / peer absent)
	PhaseFailed    = "Failed"    // spec is invalid — terminal until the spec changes
	PhaseDeleting  = "Deleting"
)

// Condition types.
const (
	CondComposed  = "Composed"  // the composed AppDatabase exists and is Ready
	CondPublished = "Published" // spec.publishes reconciled onto this zone's compute
	CondFabric    = "Fabric"    // all dataDependencies wired (or explicitly denied)
)

// Zone is the typed view of the CR the reconciler operates on.
type Zone struct {
	Name              string
	Namespace         string
	UID               string
	ResourceVersion   string
	Generation        int64
	DeletionTimestamp *metav1.Time
	Finalizers        []string
	Spec              ZoneSpec
	Status            ZoneStatus
}

// ZoneSpec mirrors deploy/86-zone-crd.yaml .spec.
type ZoneSpec struct {
	// Database is the in-zone AppDatabase this Zone composes (delegated 1:1).
	Database ZoneDatabase `json:"database,omitempty"`
	// Publishes is the table subset this zone EXPORTS (opt-in; nothing by default —
	// the sovereignty contract, ADR-0007 §3).
	Publishes []Publication `json:"publishes,omitempty"`
	// DataDependencies is the tables this zone IMPORTS from named peers.
	DataDependencies []DataDependency `json:"dataDependencies,omitempty"`
}

// ZoneDatabase is the composed-AppDatabase surface (the fields the Zone delegates).
type ZoneDatabase struct {
	Tier         string `json:"tier,omitempty"`   // cold (default) | warm
	Quotas       Quotas `json:"quotas,omitempty"` // per-zone noisy-neighbour bound
	ReadReplicas bool   `json:"readReplicas,omitempty"`
}

// Quotas mirrors AppDatabase.spec.quotas (defined locally to keep the layers
// decoupled — the zone operator does not import the appdb package).
type Quotas struct {
	CPU            string `json:"cpu,omitempty"`
	CPURequest     string `json:"cpuRequest,omitempty"`
	Mem            string `json:"mem,omitempty"`
	MemRequest     string `json:"memRequest,omitempty"`
	MaxConnections int    `json:"maxConnections,omitempty"`
}

// Publication is a named export set (→ CREATE PUBLICATION).
type Publication struct {
	Name   string   `json:"name"`
	Tables []string `json:"tables"`
}

// DataDependency is a declared import from a peer zone (→ subscription or FDW).
type DataDependency struct {
	FromZone string   `json:"fromZone"`
	Tables   []string `json:"tables"`
	Mode     string   `json:"mode"` // replicate | federate
}

// ZoneStatus mirrors deploy/86-zone-crd.yaml .status.
type ZoneStatus struct {
	Phase              string               `json:"phase,omitempty"`
	ZoneDB             string               `json:"zoneDB,omitempty"` // the composed AppDatabase name (== zone name)
	Publications       []string             `json:"publications,omitempty"`
	ReplicationSlots   []string             `json:"replicationSlots,omitempty"` // slots THIS zone's subscriptions pin on peers
	Subscriptions      []SubscriptionStatus `json:"subscriptions,omitempty"`
	Message            string               `json:"message,omitempty"`
	ObservedGeneration int64                `json:"observedGeneration,omitempty"`
	Conditions         []Condition          `json:"conditions,omitempty"`
}

// SubscriptionStatus reports one dataDependency's wiring outcome.
type SubscriptionStatus struct {
	FromZone string `json:"fromZone"`
	Name     string `json:"name,omitempty"`
	Mode     string `json:"mode,omitempty"`
	// State: streaming | pending | federated | denied | error
	State   string `json:"state,omitempty"`
	Message string `json:"message,omitempty"`
}

// Subscription states.
const (
	SubStreaming = "streaming"
	SubPending   = "pending"
	SubFederated = "federated"
	SubDenied    = "denied" // governance: peer does not publish the requested tables / single-writer violation
	SubError     = "error"
)

// Condition is a minimal k8s-style status condition (same shape as appdb).
type Condition struct {
	Type               string       `json:"type"`
	Status             string       `json:"status"`
	Reason             string       `json:"reason,omitempty"`
	Message            string       `json:"message,omitempty"`
	LastTransitionTime *metav1.Time `json:"lastTransitionTime,omitempty"`
}

// DefaultQuotas mirror AppDatabase's DEF_* knobs (a publishing zone defaults, like
// any app, to the shared 1c/1Gi/100-conn envelope).
var DefaultQuotas = Quotas{
	CPU: "1000m", CPURequest: "250m", Mem: "1Gi", MemRequest: "256Mi", MaxConnections: 100,
}

func (z *Zone) hasFinalizer() bool {
	for _, f := range z.Finalizers {
		if f == Finalizer {
			return true
		}
	}
	return false
}

func (z *Zone) deleting() bool { return z.DeletionTimestamp != nil }

// needsReplication reports whether this zone participates in logical replication at
// all — it either exports (publishes) or imports via replicate. A zone that only
// federates (or is a pure leaf) needs no repl role.
func (z *Zone) needsReplication() bool {
	if len(z.Spec.Publishes) > 0 {
		return true
	}
	for _, d := range z.Spec.DataDependencies {
		if d.Mode == ModeReplicate {
			return true
		}
	}
	return false
}
