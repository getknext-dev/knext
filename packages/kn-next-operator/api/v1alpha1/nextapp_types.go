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
// Cross-field rule (ADR-0019): spec.database owns DATABASE_URL / DATABASE_URL_RO
// when set — a spec.secrets.envMap entry for the same env var is rejected by
// the validating WEBHOOK, not by CRD CEL. The webhook RATCHETS: it rejects the
// collision on create and on updates that ADD it, while letting CRs stored
// before the rules keep taking unrelated updates (a spec-root CEL rule would
// re-fire on ANY spec change and brick them). The reconciler resolves
// carried-forward collisions loudly: spec.database wins + a Warning event.
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

	// Database binds an EXISTING database to the app (ADR-0019). knext is
	// engine-agnostic and provisions NO database (the managed scale-to-zero-pg
	// mode was removed — ADR-0025): set spec.database.secretRef to bind an
	// existing same-namespace Secret's DSN as DATABASE_URL (+ roSecretRef ->
	// DATABASE_URL_RO). Leave nil to wire a DB by hand via spec.secrets.envMap.
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

// DatabaseSpec is the author-facing surface of the app's database. knext is
// engine-agnostic and provisions NO database (the managed scale-to-zero-Postgres
// mode was removed — ADR-0025). The only mode is BRING-YOUR-OWN:
//
//   - BINDING (secretRef): bind an EXISTING same-namespace Secret's DSN as
//     DATABASE_URL (+ roSecretRef -> DATABASE_URL_RO). Typed sugar over the
//     proven spec.secrets.envMap path (ADR-0019): the operator injects through
//     the exact same envMap -> SecretKeyRef machinery, so precedence/dedupe
//     semantics are identical. No provisioning, no hard-gate; a missing Secret
//     surfaces as CreateContainerConfigError (envMap semantics).
//
// SECURITY: there is deliberately no namespace field — cross-namespace
// secretKeyRef is impossible in Kubernetes, so a NextApp can only ever bind a
// Secret in its OWN namespace.
// +kubebuilder:validation:XValidation:rule="!has(self.roSecretRef) || has(self.secretRef)",message="spec.database.roSecretRef requires spec.database.secretRef"
type DatabaseSpec struct {
	// SecretRef binds an EXISTING Secret in the app's namespace as the app's
	// DATABASE_URL (BYO mode, ADR-0019). key defaults to "DATABASE_URL".
	// +optional
	SecretRef *DatabaseSecretRef `json:"secretRef,omitempty"`

	// ROSecretRef optionally binds a read-only DSN as DATABASE_URL_RO (BYO
	// mode). key defaults to "DATABASE_URL_RO", so a single Secret carrying
	// both keys binds with roSecretRef: {name: <same>}. Requires secretRef.
	// +optional
	ROSecretRef *DatabaseSecretRef `json:"roSecretRef,omitempty"`
}

// DatabaseSecretRef points at a key in an existing Secret IN THE APP'S OWN
// NAMESPACE that carries a database DSN (ADR-0019 BYO binding). There is
// deliberately no namespace field — cross-namespace secretKeyRef is impossible
// in Kubernetes, keeping a NextApp bound to a Secret in its own namespace only.
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

type PreviewSpec struct {
	Enabled bool   `json:"enabled,omitempty"`
	Branch  string `json:"branch,omitempty"`
	PRID    string `json:"prId,omitempty"`
}

// ScalingSpec tunes the app's 0→N autoscaling and its coupling to the shared
// Postgres connection ceiling (ADR-0028).
//
// MinScale is the warm floor (default 0 for cost — the app scales to zero when
// idle). MaxScale caps the reactive fan-out. ContainerConcurrency is the
// per-pod concurrent-request soft target that drives when Knative adds a pod
// (default 20 — ADR-0028, W1-refinable; lower = scales sooner, more pods).
//
// PoolMax is the OPTIONAL per-pod DB connection-pool maximum. When set (>0) it
// lets the operator enforce the ADR-0028 connection-wall invariant
// `maxScale × poolMax ≤ 80` — the app connection budget (GW_MAX_CONNS 90 minus
// an admin/replication reserve), NOT the raw Postgres max_connections (100). A
// lower ContainerConcurrency scales apps to more pods sooner, so without this
// guard it could silently exhaust the gateway/DB. Leave unset (0) to skip the
// check (documented, not enforced). W3 (#378) owns breaking the wall (e.g. a
// shared pooler).
type ScalingSpec struct {
	MinScale             int32 `json:"minScale,omitempty"`
	MaxScale             int32 `json:"maxScale,omitempty"`
	ContainerConcurrency int32 `json:"containerConcurrency,omitempty"`
	// PoolMax is the per-pod DATABASE_URL connection-pool maximum. When >0 the
	// operator enforces maxScale × poolMax ≤ 80 (the app connection budget,
	// ADR-0028).
	// +optional
	PoolMax int32 `json:"poolMax,omitempty"`

	// WarmSchedule declares SCHEDULED warm-floor windows (ADR-0030, W5/#380):
	// during each window the app is pre-warmed to a floor of `replicas` pods so
	// a predictable traffic spike (a known daily peak, a scheduled campaign) does
	// NOT pay a cold start on the first request. This is OWNER-AUTHORED
	// scheduling, NOT learned prediction — the learned/heuristic controller
	// (same-hour-last-week RPS percentile), the DB-compute lockstep pre-warm, and
	// the per-tenant warm-budget cap are DEFERRED follow-ups (see ADR-0030).
	//
	// MECHANISM (ADR-0030): the operator generates a pair of Kubernetes CronJobs
	// per window (owned by the NextApp) that patch the app's Knative Service
	// `autoscaling.knative.dev/min-scale` annotation to `replicas` at the window
	// `start` and back to "0" at the `end`. The Knative KPA reads that annotation
	// as its scale FLOOR and still scales ABOVE it reactively. This is the
	// Knative-native scheduled-floor path: KEDA is NOT used because it actuates
	// via the Kubernetes /scale subresource, which a Knative Service does not
	// expose. Outside every window the floor is "0", so the default scale-to-zero
	// (minScale 0) cost model is preserved. Empty/nil => no CronJobs generated
	// (byte-identical back-compat). NOTE: a min-scale patch rolls a new Knative
	// Revision (the template is Knative's source of truth) — acceptable for a
	// twice-a-window annotation flip; do not use warmSchedule on an app that pins
	// traffic to a fixed revision (spec.traffic.revisionName).
	// +optional
	WarmSchedule []WarmWindow `json:"warmSchedule,omitempty"`
}

// WarmWindow is one scheduled warm-floor window (ADR-0030, W5/#380). Start/End
// are standard 5-field cron expressions (minute hour day month weekday) in the
// window's Timezone; Replicas is the warm floor enforced between Start and End.
type WarmWindow struct {
	// Start is the cron expression at which the warm floor begins (the "set"
	// CronJob's schedule). Standard 5-field cron (e.g. "0 8 * * 1-5" = 08:00 on
	// weekdays).
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	Start string `json:"start"`

	// End is the cron expression at which the warm floor ends (the "clear"
	// CronJob's schedule, e.g. "0 20 * * 1-5" = 20:00 on weekdays). Between Start
	// and End the floor of `replicas` pods is held.
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	End string `json:"end"`

	// Replicas is the warm-pod FLOOR held during the window (the min-scale value
	// the "set" CronJob patches onto the ksvc). Must be >= 1 — a window that
	// floors at 0 warms nothing (use no window at all for scale-to-zero). The
	// Knative KPA still scales ABOVE this floor on real traffic.
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:Minimum=1
	Replicas int32 `json:"replicas"`

	// Timezone is an IANA timezone (e.g. "UTC", "America/New_York") the cron
	// schedules are evaluated in (the CronJobs' spec.timeZone). Defaults to
	// "UTC" when unset.
	// +optional
	Timezone string `json:"timezone,omitempty"`
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

	// DatabaseSecretName is the name of the same-namespace Secret currently
	// feeding DATABASE_URL(+_RO): the user-supplied Secret named by
	// spec.database.secretRef (BINDING mode, ADR-0019). Cleared when
	// spec.database is removed.
	// +optional
	DatabaseSecretName string `json:"databaseSecretName,omitempty"`

	// ObservedRevision is the child Knative Service's latest-READY Revision
	// (mirrored from ksvc.status.latestReadyRevisionName). It is the revision an
	// operator can trust is actually serving — surfaced so `kubectl get nextapp
	// -o wide` answers "which build is live?" without a Knative round-trip (#312).
	// +optional
	ObservedRevision string `json:"observedRevision,omitempty"`

	// ScaledToZero reports whether the app currently has no active compute: it is
	// true when the observed (latest-ready) Revision's Knative "Active" condition
	// is False — a Ready-but-Inactive revision, i.e. scaled to zero. nil means the
	// activeness is unknown (the revision could not be read yet); the operator
	// omits the field rather than guessing. Derived from the Revision the operator
	// already reconciles — no replica-count bookkeeping is invented (#312).
	// +optional
	ScaledToZero *bool `json:"scaledToZero,omitempty"`

	// LastSuccessfulDeployTime is the time the operator first observed the CURRENT
	// observedRevision reach Ready — i.e. the last time a deploy actually went
	// live. It is only advanced when a NEW revision becomes Ready; a subsequent
	// failed rollout (ksvc Ready=False) leaves it pointing at the last good
	// deploy, so operators can see "how long has this been the live build" and
	// distinguish a stale-but-serving app from a broken new push (#312).
	// +optional
	LastSuccessfulDeployTime *metav1.Time `json:"lastSuccessfulDeployTime,omitempty"`
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
// +kubebuilder:printcolumn:name="Revision",type="string",priority=1,JSONPath=".status.observedRevision"
// +kubebuilder:printcolumn:name="ScaledToZero",type="boolean",priority=1,JSONPath=".status.scaledToZero"
// +kubebuilder:printcolumn:name="Degraded",type="string",priority=1,JSONPath=".status.conditions[?(@.type=='Degraded')].status"
// +kubebuilder:printcolumn:name="LastDeploy",type="date",priority=1,JSONPath=".status.lastSuccessfulDeployTime"

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
