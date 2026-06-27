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
	Provider            string `json:"provider,omitempty"`
	URL                 string `json:"url,omitempty"`
	EnableBytecodeCache bool   `json:"enableBytecodeCache,omitempty"`
	BytecodeCacheSize   string `json:"bytecodeCacheSize,omitempty"`
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
