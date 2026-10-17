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
	"fmt"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// BackendService is a zone function (ADR-0004, Amendment 2): a cluster-local,
// scale-to-zero Knative Service on an h2c port that belongs to exactly one zone
// (a NextApp in the same namespace).
//
// The binding contract is two-sided. The function names its zone with
// spec.zone, and the zone lists the function in its NextApp.spec.backends[].
// Until both halves agree the operator renders no Knative Service for the
// function, mounts nothing into it and renders no binding env into the zone.
//
// What the spec deliberately does NOT have, because each would bypass the
// data-sovereignty controls (ADR-0004 Amendment 2 Decision 4):
//   - no serviceAccountName: the function always runs as an operator-owned
//     ServiceAccount with no Role or RoleBinding and automount off. A stray
//     serviceAccountName in a manifest is pruned by the apiserver (or rejected
//     by a strict apply) and has no effect;
//   - no pod template and no free-form volume list: volumes are limited by type
//     to Secret, ConfigMap, projected Secret/ConfigMap and emptyDir sources.
//
// Any future field that passes pod-spec content through MUST add a CEL rule
// forbidding serviceAccountName in it, in the same change.
type BackendServiceSpec struct {
	// Zone is the name of the NextApp in this namespace that owns the function.
	// The operator resolves it and sets the ownerReference itself (users never
	// write one). Required and immutable.
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=63
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="spec.zone is immutable"
	Zone string `json:"zone"`

	// Image is the function's container image, pinned by digest. A tag-only
	// reference and :latest are refused, as for NextApp.
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	Image string `json:"image"`

	// Language is informational metadata (go, rust, typescript, ...). The
	// operator does not act on it.
	// +optional
	// +kubebuilder:validation:MaxLength=32
	// +kubebuilder:validation:Pattern=`^[a-z][a-z0-9+-]*$`
	Language string `json:"language,omitempty"`

	// Port is the container port the function serves h2c (gRPC/Connect) on.
	// The Knative Service names it h2c so Knative routes HTTP/2 cleartext.
	// Defaults to 8080.
	// +optional
	// +kubebuilder:default=8080
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=65535
	Port int32 `json:"port,omitempty"`

	// ProtoVersion is the contract version this image serves
	// (MAJOR.MINOR.PATCH, semver 2.0). The operator stamps it on the revision
	// template and reports, in status.servedProtoVersion, the stamp of the
	// revision that is actually Ready. The zone receives that served value as
	// <NAME>_SERVICE_PROTO_VERSION; while no revision with a stamp is Ready the
	// variable is unset and the zone's calls fail closed.
	// +optional
	// +kubebuilder:validation:MaxLength=128
	// +kubebuilder:validation:Pattern=`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*)?(\+[0-9a-zA-Z-]+(\.[0-9a-zA-Z-]+)*)?$`
	ProtoVersion string `json:"protoVersion,omitempty"`

	// WakeAhead controls whether the zone wakes this function when the zone
	// itself starts (one non-blocking request to the function's health RPC).
	// nil or true: the function's binding name is listed in the zone's
	// KNEXT_WAKE_FUNCTIONS. false: it is left out (the per-function opt-out).
	// +optional
	WakeAhead *bool `json:"wakeAhead,omitempty"`

	// Scaling bounds the function's autoscaling. Its scale-to-zero retention is
	// derived from the zone's and is not a field: a bound function stays up
	// longer than its zone after its own last call.
	// +optional
	Scaling *FunctionScalingSpec `json:"scaling,omitempty"`

	// Resources are the function container's requests and limits.
	// +optional
	Resources *ResourcesSpec `json:"resources,omitempty"`

	// Env is the function container's environment. A secretKeyRef may name only
	// the owning zone's database Secret (spec.database of the zone) or a Secret
	// marked as belonging to the same zone; anything else is refused and the
	// function is not rendered. Names starting with KNEXT_TOKEN_ are reserved:
	// the operator sets the verifier's KNEXT_TOKEN_ISSUER and
	// KNEXT_TOKEN_AUDIENCE itself.
	// +optional
	// +listType=map
	// +listMapKey=name
	// +kubebuilder:validation:MaxItems=128
	// +kubebuilder:validation:XValidation:rule="self.all(e, !has(e.valueFrom) || !has(e.valueFrom.secretKeyRef) || (has(e.valueFrom.secretKeyRef.name) && e.valueFrom.secretKeyRef.name.size() > 0 && e.valueFrom.secretKeyRef.name.size() <= 253))",message="a Secret reference must name a Secret: a non-empty name of at most 253 characters"
	// +kubebuilder:validation:XValidation:rule="self.all(e, !e.name.startsWith('KNEXT_TOKEN_'))",message="env names starting with KNEXT_TOKEN_ are reserved: the operator sets the function's token issuer and audience"
	Env []corev1.EnvVar `json:"env,omitempty"`

	// EnvFrom imports whole Secrets or ConfigMaps. The same Secret allowlist as
	// Env applies.
	// +optional
	// +kubebuilder:validation:MaxItems=16
	// +kubebuilder:validation:XValidation:rule="self.all(e, !has(e.secretRef) || (has(e.secretRef.name) && e.secretRef.name.size() > 0 && e.secretRef.name.size() <= 253))",message="a Secret reference must name a Secret: a non-empty name of at most 253 characters"
	EnvFrom []corev1.EnvFromSource `json:"envFrom,omitempty"`

	// Volumes mounts Secret, ConfigMap, projected (Secret/ConfigMap) or emptyDir
	// volumes. The same Secret allowlist applies to Secret and projected
	// sources. /var/run/knext is reserved for operator mounts.
	// +optional
	// +listType=map
	// +listMapKey=name
	// +kubebuilder:validation:MaxItems=16
	Volumes []FunctionVolume `json:"volumes,omitempty"`

	// ImagePullSecrets names registry pull Secrets. They are exempt from the
	// data-sovereignty allowlist (they expose no data store) and are set on the
	// operator-owned ServiceAccount.
	// +optional
	// +kubebuilder:validation:MaxItems=8
	ImagePullSecrets []corev1.LocalObjectReference `json:"imagePullSecrets,omitempty"`
}

// FunctionScalingSpec bounds a function's 0→N autoscaling.
// +kubebuilder:validation:XValidation:rule="!has(self.maxScale) || self.maxScale == 0 || !has(self.minScale) || self.minScale <= self.maxScale",message="scaling.minScale must not exceed scaling.maxScale"
type FunctionScalingSpec struct {
	// MinScale is the warm floor. Default 0 (scale to zero).
	// +optional
	// +kubebuilder:validation:Minimum=0
	MinScale int32 `json:"minScale,omitempty"`

	// MaxScale caps the fan-out. 0 means the Knative default.
	// +optional
	// +kubebuilder:validation:Minimum=0
	MaxScale int32 `json:"maxScale,omitempty"`

	// ContainerConcurrency is the per-pod concurrent-request limit. 0 means
	// unlimited (the Knative default).
	// +optional
	// +kubebuilder:validation:Minimum=0
	// +kubebuilder:validation:Maximum=1000
	ContainerConcurrency int32 `json:"containerConcurrency,omitempty"`
}

// FunctionVolume is one volume and its mount. Exactly one source is set.
// +kubebuilder:validation:XValidation:rule="!has(self.secret) || (has(self.secret.secretName) && self.secret.secretName.size() > 0 && self.secret.secretName.size() <= 253)",message="a Secret reference must name a Secret: a non-empty name of at most 253 characters"
// +kubebuilder:validation:XValidation:rule="[has(self.secret), has(self.configMap), has(self.projected), has(self.emptyDir)].filter(x, x).size() == 1",message="a volume sets exactly one of secret, configMap, projected or emptyDir"
// +kubebuilder:validation:XValidation:rule="self.mountPath != '/var/run/knext' && !self.mountPath.startsWith('/var/run/knext/')",message="/var/run/knext is reserved for operator mounts"
type FunctionVolume struct {
	// Name of the volume (DNS label).
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MaxLength=63
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`
	Name string `json:"name"`

	// MountPath is the absolute path the volume is mounted at.
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MaxLength=512
	// +kubebuilder:validation:Pattern=`^/`
	MountPath string `json:"mountPath"`

	// Secret mounts a Secret. Subject to the Secret allowlist.
	// +optional
	Secret *corev1.SecretVolumeSource `json:"secret,omitempty"`

	// ConfigMap mounts a ConfigMap. A zone's JWKS ConfigMap may not be named:
	// the operator mounts the owning zone's JWKS itself.
	// +optional
	ConfigMap *corev1.ConfigMapVolumeSource `json:"configMap,omitempty"`

	// Projected combines Secret and ConfigMap sources. Subject to the same
	// rules as Secret and ConfigMap.
	// +optional
	Projected *FunctionProjectedVolume `json:"projected,omitempty"`

	// EmptyDir mounts scratch space.
	// +optional
	EmptyDir *corev1.EmptyDirVolumeSource `json:"emptyDir,omitempty"`
}

// FunctionProjectedVolume is a projected volume limited to Secret and
// ConfigMap sources: no service-account token, cluster trust bundle or pod
// certificate projection.
type FunctionProjectedVolume struct {
	// Sources to project. Each sets exactly one of secret or configMap.
	// +kubebuilder:validation:MinItems=1
	// +kubebuilder:validation:MaxItems=16
	Sources []FunctionVolumeProjection `json:"sources"`

	// DefaultMode is the file mode for projected files.
	// +optional
	DefaultMode *int32 `json:"defaultMode,omitempty"`
}

// FunctionVolumeProjection is one projected source.
// +kubebuilder:validation:XValidation:rule="!has(self.secret) || (has(self.secret.name) && self.secret.name.size() > 0 && self.secret.name.size() <= 253)",message="a Secret reference must name a Secret: a non-empty name of at most 253 characters"
// +kubebuilder:validation:XValidation:rule="has(self.secret) != has(self.configMap)",message="a projected source sets exactly one of secret or configMap"
type FunctionVolumeProjection struct {
	// Secret projects keys of a Secret. Subject to the Secret allowlist.
	// +optional
	Secret *corev1.SecretProjection `json:"secret,omitempty"`

	// ConfigMap projects keys of a ConfigMap.
	// +optional
	ConfigMap *corev1.ConfigMapProjection `json:"configMap,omitempty"`
}

// BackendServiceStatus is the observed state of a BackendService.
type BackendServiceStatus struct {
	// ObservedGeneration is the spec generation the status describes.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// Conditions: Ready, Bound (both halves of the binding agree) and
	// SovereigntyCompliant (the Secret allowlist holds), plus a
	// DatabaseHostLint warning condition when an env literal names another
	// zone's database host (a heuristic, not the control).
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`

	// URL is the cluster-local address the zone reaches the function at.
	// +optional
	URL string `json:"url,omitempty"`

	// ServedProtoVersion is the contract version stamped on the function's
	// latest Ready revision: the version that is actually serving, which may lag
	// spec.protoVersion during a rollout. Empty while no stamped revision is
	// Ready, or after the binding is revoked.
	// +optional
	ServedProtoVersion string `json:"servedProtoVersion,omitempty"`

	// ObservedRevision is the function's latest Ready Knative Revision.
	// +optional
	ObservedRevision string `json:"observedRevision,omitempty"`

	// ServiceAccountName is the operator-owned ServiceAccount the function runs as.
	// +optional
	ServiceAccountName string `json:"serviceAccountName,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=bsvc
// +kubebuilder:printcolumn:name="Zone",type="string",JSONPath=".spec.zone"
// +kubebuilder:printcolumn:name="Ready",type="string",JSONPath=".status.conditions[?(@.type=='Ready')].status"
// +kubebuilder:printcolumn:name="Served",type="string",JSONPath=".status.servedProtoVersion"
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"
// +kubebuilder:printcolumn:name="URL",type="string",priority=1,JSONPath=".status.url"
// +kubebuilder:printcolumn:name="Reason",type="string",priority=1,JSONPath=".status.conditions[?(@.type=='Ready')].reason"

// BackendService is the Schema for the backendservices API.
type BackendService struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of BackendService
	// +required
	Spec BackendServiceSpec `json:"spec"`

	// status defines the observed state of BackendService
	// +optional
	Status BackendServiceStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// BackendServiceList contains a list of BackendService
type BackendServiceList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []BackendService `json:"items"`
}

func init() {
	SchemeBuilder.Register(&BackendService{}, &BackendServiceList{})
}

// BackendServiceCRDInstalled reports whether the cluster serves the
// BackendService kind. A no-match error is "not installed" (the operator then
// runs without zone functions, exactly as before they existed); any other
// discovery error is returned, because unknown is not absent.
func BackendServiceCRDInstalled(mapper meta.RESTMapper) (bool, error) {
	_, err := mapper.RESTMapping(schema.GroupKind{Group: GroupVersion.Group, Kind: "BackendService"}, GroupVersion.Version)
	switch {
	case err == nil:
		return true, nil
	case meta.IsNoMatchError(err):
		return false, nil
	default:
		return false, fmt.Errorf("discovering whether the BackendService CRD is installed: %w", err)
	}
}
