/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// EDIT THIS FILE!  THIS IS SCAFFOLDING FOR YOU TO OWN!
// NOTE: json tags are required.  Any new fields you add must have json tags for the fields to be serialized.

// NextAppSpec defines the desired state of NextApp
//
// Cross-field rules (ADR-0019): spec.database owns DATABASE_URL / DATABASE_URL_RO
// when set — a spec.secrets.envMap entry for the same env var is rejected at
// admission so there is never a silent precedence between the two.
// +kubebuilder:validation:XValidation:rule="!(has(self.database) && (has(self.database.secretRef) || (has(self.database.enabled) && self.database.enabled)) && has(self.secrets) && has(self.secrets.envMap) && 'DATABASE_URL' in self.secrets.envMap)",message="spec.database and spec.secrets.envMap both define DATABASE_URL — remove one (no silent precedence)"
// +kubebuilder:validation:XValidation:rule="!(has(self.database) && (has(self.database.roSecretRef) || (has(self.database.enabled) && self.database.enabled && has(self.database.readReplicas) && self.database.readReplicas)) && has(self.secrets) && has(self.secrets.envMap) && 'DATABASE_URL_RO' in self.secrets.envMap)",message="spec.database and spec.secrets.envMap both define DATABASE_URL_RO — remove one (no silent precedence)"
type NextAppSpec struct {
	// INSERT ADDITIONAL SPEC FIELDS - desired state of cluster
	// Important: Run "make" to regenerate code after modifying this file
	// The following markers will use OpenAPI v3 schema to validate the value
	// More info: https://book.kubebuilder.io/reference/markers/crd-validation.html

	// The OpenNext bundled Next.js image
	// +kubebuilder:validation:Required
	Image string `json:"image"`

	// How many concurrent Next.js pods should be active
	// +optional
	Scaling *ScalingSpec `json:"scaling,omitempty"`

	// Container resource requests and limits
	// +optional
	Resources *ResourcesSpec `json:"resources,omitempty"`

	// Storage bindings (GCS, S3, or Local)
	// +optional
	Storage *StorageSpec `json:"storage,omitempty"`

	// Caching infrastructure
	// +optional
	Cache *CacheSpec `json:"cache,omitempty"`

	// Revalidation options
	// +optional
	Revalidation *RevalidationSpec `json:"revalidation,omitempty"`

	// External Secrets mapping
	// +optional
	Secrets *SecretsSpec `json:"secrets,omitempty"`

	// Database declares an INLINE scale-zero-pg database that the knext operator
	// auto-provisions (via an AppDatabase CR in the scale-zero-pg namespace) and
	// wires into the app's env as DATABASE_URL (+ DATABASE_URL_RO when
	// readReplicas). This is the unified-config flagship (ADR-0006, #119): the
	// author declares an app AND its database in one NextApp, one namespace, and
	// the two scale-to-zero and wake together.
	//
	// Escape hatch (BYO database): leave this nil / enabled=false and wire an
	// external/existing DB by hand via spec.secrets.envMap — that path is fully
	// preserved and additive to this one.
	// +optional
	Database *DatabaseSpec `json:"database,omitempty"`

	// Env sets plain, NON-SECRET environment variables (name → value) on the
	// app container — configuration flags like KNEXT_CACHE_CONTROL_NORMALIZE=0.
	// Secrets do NOT belong here: values are stored verbatim in the CR (visible
	// to anyone who can read it); use spec.secrets for anything sensitive.
	//
	// Names must be C_IDENTIFIERs. Reserved names are rejected at admission:
	// HOSTNAME (operator-injected 0.0.0.0 bind fix — overriding it resurrects
	// the pod-IP-bind outage, #178/#184) and PORT / K_SERVICE / K_REVISION /
	// K_CONFIGURATION (Knative-reserved). Precedence: spec.env never overrides
	// operator-injected system env or spec.secrets.envMap entries — colliding
	// names are dropped (issue #186).
	// +optional
	// +kubebuilder:validation:XValidation:rule="self.all(k, k.matches('^[A-Za-z_][A-Za-z0-9_]*$'))",message="env var names must be C_IDENTIFIERs ([A-Za-z_][A-Za-z0-9_]*)"
	// +kubebuilder:validation:XValidation:rule="!('HOSTNAME' in self) && !('PORT' in self) && !('K_SERVICE' in self) && !('K_REVISION' in self) && !('K_CONFIGURATION' in self)",message="env var name is reserved (HOSTNAME, PORT, K_SERVICE, K_REVISION, K_CONFIGURATION are operator/Knative-managed)"
	Env map[string]string `json:"env,omitempty"`

	// Observability — Prometheus metrics
	// +optional
	Observability *ObservabilitySpec `json:"observability,omitempty"`

	// Custom health check path (default: /api/health)
	// +optional
	HealthCheckPath string `json:"healthCheckPath,omitempty"`

	// GitOps Preview Environment configuration
	// +optional
	Preview *PreviewSpec `json:"preview,omitempty"`

	// Runtime selects the process that executes the Next.js standalone server.js.
	// Valid values: "bun" or "node" (default "node").
	// Maps from KnativeNextConfig.runtime.
	// NOTE: images built by `kn-next build` with runtime "bun" have their
	// server-side JS precompiled to Bun bytecode and only boot under Bun —
	// flipping this field to "node" for such an image requires REBUILDING the
	// image (the entry exits 1 with a FATAL message under Node rather than
	// crash-looping silently). Images built for "node" run under either runtime.
	// +optional
	// +kubebuilder:validation:Enum=bun;node
	Runtime string `json:"runtime,omitempty"`

	// TimeoutSeconds is the maximum number of seconds a request can take before
	// the Knative Service times it out.  Defaults to 300 (5 min) when unset.
	// Maps from the knative-manifest hardcoded timeoutSeconds=300.
	// +optional
	TimeoutSeconds int32 `json:"timeoutSeconds,omitempty"`

	// Security controls defense-in-depth network/auth hardening for the app.
	// +optional
	Security *SecuritySpec `json:"security,omitempty"`

	// Traffic pins which Knative Revision serves traffic (issue #92 — rollback).
	// nil => serve the latest-ready revision (DEFAULT, byte-identical back-compat).
	// +optional
	Traffic *TrafficSpec `json:"traffic,omitempty"`

	// BuildID is the deploy's Next.js BUILD_ID (issue #93 — skew protection).
	// The CLI sets NEXT_DEPLOYMENT_ID == this value at build time, so the
	// `_next/static/<BuildID>/` asset prefix in the object store is named by it.
	// The operator stamps it onto the Knative Service's revision (pod) template
	// as the label `apps.kn-next.dev/build-id`, which propagates to every
	// Revision. The deploy-time asset GC then resolves a live revision back to
	// its build-id via that label (read-only) so a live revision's assets are
	// never reaped. Empty => no label stamped (back-compat).
	// +optional
	BuildID string `json:"buildId,omitempty"`
}

// BuildIDLabel is the revision (pod-template) label key carrying the Next.js
// BUILD_ID for skew-protection asset retention (issue #93). It MUST stay in
// lock-step with the CLI's resolver in deploy.ts and the GC in asset-gc.ts.
const BuildIDLabel = "apps.kn-next.dev/build-id"

// TrafficSpec expresses the desired Knative traffic target for rollback /
// canary. When nil the operator emits no spec.traffic and Knative defaults to
// 100% of the latest-ready revision (the pre-#92 behavior).
type TrafficSpec struct {
	// RevisionName pins traffic to a specific prior Knative Revision (e.g.
	// "my-app-00002"). Empty => latest-ready (no pin).
	// +optional
	RevisionName string `json:"revisionName,omitempty"`

	// CanaryPercent, when 1..99 and RevisionName is set, sends this percentage
	// of traffic to the LATEST-ready revision and the remainder (100-p) to the
	// pinned RevisionName — a canary back toward latest. 0 => 100% pinned.
	// +optional
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=100
	CanaryPercent int32 `json:"canaryPercent,omitempty"`
}

// SecuritySpec holds defense-in-depth controls reconciled by the operator.
type SecuritySpec struct {
	// NetworkPolicy toggles the operator-reconciled Kubernetes NetworkPolicy that
	// restricts ingress to the app's pods to in-cluster sources only (the Knative
	// serving system, the Kourier gateway, and the app's own namespace), denying
	// arbitrary cross-namespace / external pod-direct traffic.
	//
	// This is L3/L4 (pod-level) network isolation, NOT L7: a NetworkPolicy cannot
	// target a specific HTTP path, so it hardens the POD's network exposure as
	// defense-in-depth for the (already Bearer-authed) mutating cache endpoints —
	// it does not provide per-route isolation.
	//
	// Semantics: nil (unset) or true => the policy is reconciled (DEFAULT-ON);
	// false => the policy is not reconciled and any previously-created one is deleted.
	// +optional
	NetworkPolicy *bool `json:"networkPolicy,omitempty"`
}

// DatabaseSpec is the author-facing surface of the app's database. It has two
// MUTUALLY-EXCLUSIVE modes, validated at admission:
//
//   - MANAGED (enabled: true): inline scale-zero-pg provisioning (ADR-0006).
//     Exposes the SMALL, author-relevant subset of AppDatabase.spec; the
//     operator derives/defaults the rest (appName, credentials, plane wiring).
//   - BINDING (secretRef): bring-your-own — bind an EXISTING same-namespace
//     Secret's DSN as DATABASE_URL (+ roSecretRef -> DATABASE_URL_RO). Typed
//     sugar over the proven spec.secrets.envMap path (ADR-0019): the operator
//     injects through the exact same envMap -> SecretKeyRef machinery, so
//     precedence/dedupe semantics are identical. No provisioning, no hard-gate;
//     a missing Secret surfaces as CreateContainerConfigError (envMap semantics).
//
// SECURITY (ADR-0006 §4.4): appName is NEVER surfaced here — it is DERIVED by
// the operator from the NextApp's own (namespace, name). A NextApp can therefore
// only ever provision/bind the AppDatabase minted for ITS OWN identity; it can
// never name an arbitrary existing database in another namespace.
// +kubebuilder:validation:XValidation:rule="!(has(self.enabled) && self.enabled && has(self.secretRef))",message="spec.database.enabled (managed) and spec.database.secretRef (BYO binding) are mutually exclusive — pick one mode"
// +kubebuilder:validation:XValidation:rule="!has(self.roSecretRef) || has(self.secretRef)",message="spec.database.roSecretRef requires spec.database.secretRef"
// +kubebuilder:validation:XValidation:rule="!(has(self.secretRef) && (has(self.tier) || has(self.quotas) || (has(self.readReplicas) && self.readReplicas) || (has(self.keepOnDelete) && self.keepOnDelete)))",message="tier/readReplicas/quotas/keepOnDelete are managed-mode only and cannot be combined with secretRef"
type DatabaseSpec struct {
	// Enabled turns on inline provisioning. false/nil => no DB is provisioned
	// (bring-your-own via secretRef below, or the raw spec.secrets.envMap
	// escape hatch).
	// +optional
	Enabled bool `json:"enabled,omitempty"`

	// SecretRef binds an EXISTING Secret in the app's namespace as the app's
	// DATABASE_URL (BYO mode, ADR-0019). key defaults to "DATABASE_URL".
	// Mutually exclusive with enabled: true.
	// +optional
	SecretRef *DatabaseSecretRef `json:"secretRef,omitempty"`

	// ROSecretRef optionally binds a read-only DSN as DATABASE_URL_RO (BYO
	// mode). key defaults to "DATABASE_URL_RO", so a single Secret carrying
	// both keys (the scale-zero-pg layout) binds with roSecretRef: {name: <same>}.
	// Requires secretRef.
	// +optional
	ROSecretRef *DatabaseSecretRef `json:"roSecretRef,omitempty"`

	// Tier maps 1:1 to AppDatabase.spec.tier. cold = scale-to-zero (default);
	// warm = one parked replica for ~0.4s wake.
	// +optional
	// +kubebuilder:validation:Enum=cold;warm
	Tier string `json:"tier,omitempty"`

	// ReadReplicas requests the read-only pool. Maps to
	// AppDatabase.spec.roPool.enabled; when true the operator ALSO injects
	// DATABASE_URL_RO (tolerating its absence until scale-zero-pg emits the key).
	// Default false.
	// +optional
	ReadReplicas bool `json:"readReplicas,omitempty"`

	// Quotas maps 1:1 to AppDatabase.spec.quotas (per-app noisy-neighbour bound).
	// Empty fields inherit AppDatabase defaults (1000m/250m CPU, 1Gi/256Mi mem,
	// 100 conns).
	// +optional
	Quotas *DatabaseQuotas `json:"quotas,omitempty"`

	// KeepOnDelete maps to AppDatabase.spec.keepTimelineOnDelete. Default false
	// (deleting the NextApp reclaims the Neon timeline). true retains it for PITR.
	// +optional
	KeepOnDelete bool `json:"keepOnDelete,omitempty"`
}

// DatabaseSecretRef points at a key in an existing Secret IN THE APP'S OWN
// NAMESPACE that carries a database DSN (ADR-0019 BYO binding). There is
// deliberately no namespace field — cross-namespace secretKeyRef is impossible
// in Kubernetes, and allowing one here would be the exact security seam
// ADR-0006 §4.4 closes.
type DatabaseSecretRef struct {
	// Name of the Secret (DNS-1123 subdomain).
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=253
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`
	Name string `json:"name"`

	// Key inside the Secret holding the DSN. Defaults to "DATABASE_URL" for
	// secretRef and "DATABASE_URL_RO" for roSecretRef.
	// +optional
	// +kubebuilder:validation:MinLength=1
	Key string `json:"key,omitempty"`
}

// DatabaseQuotas mirrors AppDatabase.spec.quotas (the per-app resource bound).
type DatabaseQuotas struct {
	// CPU limit (e.g. "1000m").
	// +optional
	CPU string `json:"cpu,omitempty"`
	// CPURequest is the scheduling floor (e.g. "250m").
	// +optional
	CPURequest string `json:"cpuRequest,omitempty"`
	// Mem limit (OOM bound, e.g. "1Gi").
	// +optional
	Mem string `json:"mem,omitempty"`
	// MemRequest is the scheduling floor (e.g. "256Mi").
	// +optional
	MemRequest string `json:"memRequest,omitempty"`
	// MaxConnections is the app compute's Postgres max_connections.
	// +optional
	// +kubebuilder:validation:Minimum=1
	MaxConnections int `json:"maxConnections,omitempty"`
}

type PreviewSpec struct {
	Enabled bool   `json:"enabled,omitempty"`
	Branch  string `json:"branch,omitempty"`
	PRID    string `json:"prId,omitempty"`
}

type ScalingSpec struct {
	MinScale             int32 `json:"minScale,omitempty"`
	MaxScale             int32 `json:"maxScale,omitempty"`
	ContainerConcurrency int32 `json:"containerConcurrency,omitempty"`
}

type StorageSpec struct {
	Provider string `json:"provider,omitempty"`
	Bucket   string `json:"bucket,omitempty"`
	// Region is used for S3 / S3-compatible providers (e.g. "us-east-1")
	// +optional
	Region string `json:"region,omitempty"`
	// Endpoint overrides the default service endpoint — required for MinIO and S3-compatible stores
	// +optional
	Endpoint string `json:"endpoint,omitempty"`
}

type CacheSpec struct {
	Provider string `json:"provider,omitempty"`
	URL      string `json:"url,omitempty"`
	// EnableBytecodeCache provisions a PVC mounted at /cache/bytecode and wires
	// the runtime code cache for the selected runtime: NODE_COMPILE_CACHE
	// (/cache/bytecode/latest) always, plus BUN_RUNTIME_TRANSPILER_CACHE_PATH
	// (/cache/bytecode/bun-transpiler) when spec.runtime is "bun" — one field
	// covers BOTH caches. Growth is bounded only by BytecodeCacheSize (no
	// eviction); both runtimes fail open when the volume is full or unwritable.
	// +optional
	EnableBytecodeCache bool `json:"enableBytecodeCache,omitempty"`
	// BytecodeCacheSize sizes the bytecode-cache PVC (default 512Mi).
	// +optional
	BytecodeCacheSize string `json:"bytecodeCacheSize,omitempty"`
	// KeyPrefix is prepended to every cache key — maps from KnativeNextConfig.cache.keyPrefix
	// +optional
	KeyPrefix string `json:"keyPrefix,omitempty"`
}

type RevalidationSpec struct {
	Queue          string `json:"queue,omitempty"`
	KafkaBrokerUrl string `json:"kafkaBrokerUrl,omitempty"`

	// ProvisionKafkaSource gates whether the operator provisions a Knative
	// KafkaSource for `queue: kafka`.
	//
	// nil/false (DEFAULT) => no KafkaSource is provisioned. The `{app}-revalidator`
	// consumer that the source would sink into is design-now/build-later (issue #95):
	// provisioning the source by default would point eventing at a service that is
	// never deployed (events delivered nowhere). When kafka is selected but this is
	// not opted in, the operator surfaces a non-fatal `RevalidationDeferred` status
	// condition instead.
	//
	// true => explicit opt-in. The operator provisions the KafkaSource; setting this
	// asserts that you have deployed an external revalidator consumer for the
	// `{app}-revalidation` topic yourself.
	// +optional
	ProvisionKafkaSource *bool `json:"provisionKafkaSource,omitempty"`
}

type ResourcesSpec struct {
	CPURequest    string `json:"cpuRequest,omitempty"`
	MemoryRequest string `json:"memoryRequest,omitempty"`
	CPULimit      string `json:"cpuLimit,omitempty"`
	MemoryLimit   string `json:"memoryLimit,omitempty"`
}

type ObservabilitySpec struct {
	Enabled bool `json:"enabled,omitempty"`
	// Rum (#94): self-hosted Web Vitals → Prometheus/Grafana. Default OFF.
	// When enabled, the operator propagates NEXT_PUBLIC_RUM_ENABLED (and
	// optionally NEXT_PUBLIC_RUM_SAMPLE_RATE) so the client beacon activates.
	Rum *RumSpec `json:"rum,omitempty"`
	// Tracing (#30): server-side OTel distributed tracing via OTLP/gRPC → a
	// self-hostable backend (Tempo/Jaeger, ADR-0012). Default OFF. When enabled,
	// the operator sets OTEL_TRACING_ENABLED (and optionally
	// OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_TRACES_SAMPLER_ARG) so the runtime
	// instrumentation hook initializes the exporter.
	Tracing *TracingSpec `json:"tracing,omitempty"`
}

// RumSpec configures the Real User Monitoring (Web Vitals) client beacon.
type RumSpec struct {
	Enabled bool `json:"enabled,omitempty"`
	// SampleRate is the client-side sampling fraction (0..1). Empty → 1 (all).
	SampleRate string `json:"sampleRate,omitempty"`
}

// TracingSpec configures server-side OpenTelemetry distributed tracing (#30).
type TracingSpec struct {
	Enabled bool `json:"enabled,omitempty"`
	// Endpoint is the OTLP/gRPC collector endpoint. Empty → the runtime default
	// (a cluster-local OTLP collector; never a SaaS endpoint — no lock-in).
	Endpoint string `json:"endpoint,omitempty"`
	// SampleRate is the head-based trace sampling fraction (0..1). Empty → 1 (all).
	SampleRate string `json:"sampleRate,omitempty"`
}

// EnvMapEntry maps an environment variable name to a specific key in a Kubernetes Secret
type EnvMapEntry struct {
	SecretName string `json:"secretName"`
	SecretKey  string `json:"secretKey"`
}

type SecretsSpec struct {
	EnvFrom []string               `json:"envFrom,omitempty"`
	EnvMap  map[string]EnvMapEntry `json:"envMap,omitempty"`
}

// NextAppStatus defines the observed state of NextApp.
type NextAppStatus struct {
	// INSERT ADDITIONAL STATUS FIELD - define observed state of cluster
	// Important: Run "make" to regenerate code after modifying this file

	URL string `json:"url,omitempty"`

	// conditions represent the current state of the NextApp resource.
	// Each condition has a unique type and reflects the status of a specific aspect of the resource.
	//
	// Standard condition types include:
	// - "Available": the resource is fully functional
	// - "Progressing": the resource is being created or updated
	// - "Degraded": the resource failed to reach or maintain its desired state
	//
	// The status of each condition is one of True, False, or Unknown.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`

	// CurrentTraffic reports the revision(s) currently serving traffic and their
	// split, mirrored from the Knative Service status (issue #92).
	// +optional
	CurrentTraffic []TrafficStatus `json:"currentTraffic,omitempty"`

	// DatabaseAppName is the DERIVED, plane-globally-unique appName the operator
	// created the AppDatabase under (ADR-0006 §4.4). Surfaced on status so the
	// derivation is auditable and the security seam (a NextApp can only bind its
	// OWN derived DB) is observable. Empty when spec.database is not enabled.
	// +optional
	DatabaseAppName string `json:"databaseAppName,omitempty"`

	// DatabaseSecretName is the name of the same-namespace mirrored Secret the
	// operator wrote (ownerRef'd to this NextApp) carrying DATABASE_URL(+_RO).
	// Empty when spec.database is not enabled.
	// +optional
	DatabaseSecretName string `json:"databaseSecretName,omitempty"`
}

// TrafficStatus is one entry of the observed Knative traffic distribution.
type TrafficStatus struct {
	RevisionName   string `json:"revisionName,omitempty"`
	Percent        int64  `json:"percent,omitempty"`
	LatestRevision bool   `json:"latestRevision,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="URL",type="string",JSONPath=".status.url"
// +kubebuilder:printcolumn:name="Ready",type="string",JSONPath=".status.conditions[?(@.type=='Ready')].status"
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"

// NextApp is the Schema for the nextapps API
type NextApp struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of NextApp
	// +required
	Spec NextAppSpec `json:"spec"`

	// status defines the observed state of NextApp
	// +optional
	Status NextAppStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// NextAppList contains a list of NextApp
type NextAppList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []NextApp `json:"items"`
}

func init() {
	SchemeBuilder.Register(&NextApp{}, &NextAppList{})
}
