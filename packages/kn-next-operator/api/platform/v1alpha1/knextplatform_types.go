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

// SingletonName is the only KnextPlatform name the operator honours.
const SingletonName = "default"

// Platform profile names. A profile only ever sets values a user could have set
// field by field, and explicit platform fields override the profile.
const (
	// ProfileDefault sets nothing: it IS the built-in defaults.
	ProfileDefault = "default"
	// ProfileFastColdStart is accepted by the API but sets no value in this
	// release; it takes effect in a later phase of the platform layer.
	ProfileFastColdStart = "fastColdStart"
)

// KnextPlatformSpec is the platform layer's configuration (ADR-0064).
//
// Every field is optional and every unset field means "the built-in value":
// an empty spec (`spec: {}`) renders byte-identically to a cluster with no
// KnextPlatform at all. There are deliberately NO schema-level defaults here — a
// CRD default would write a value into the stored object and turn "unset" into
// "set", which is exactly the distinction the merge depends on.
type KnextPlatformSpec struct {
	// Profile names a bundle of platform values. "default" sets nothing (it is the
	// built-in defaults). "fastColdStart" is accepted but takes effect in a later
	// phase: in this release it sets no value.
	// +optional
	// +kubebuilder:validation:Enum=default;fastColdStart
	Profile string `json:"profile,omitempty"`

	// Scaling carries cluster-wide autoscaling defaults for apps that leave the
	// matching spec.scaling field unset.
	// +optional
	Scaling *PlatformScaling `json:"scaling,omitempty"`

	// Resources carries cluster-wide container resource defaults for apps that
	// leave the matching spec.resources field unset.
	// +optional
	Resources *PlatformResources `json:"resources,omitempty"`

	// Limits carries cluster-wide request limits.
	// +optional
	Limits *PlatformLimits `json:"limits,omitempty"`

	// Database carries the cluster-wide database connection budget. It turns the
	// operator's hardcoded cap into a per-cluster value; it provisions nothing.
	// +optional
	Database *PlatformDatabase `json:"database,omitempty"`

	// Rollout bounds how fast a platform change is applied across apps.
	// +optional
	Rollout *PlatformRollout `json:"rollout,omitempty"`
}

// PlatformScaling groups the autoscaling defaults.
type PlatformScaling struct {
	// Defaults applies to every app that leaves the matching field unset.
	// +optional
	Defaults *PlatformScalingDefaults `json:"defaults,omitempty"`
}

// PlatformScalingDefaults mirrors the NextApp spec.scaling knobs a platform may
// default. Each unset field falls back to the built-in value.
type PlatformScalingDefaults struct {
	// ContainerConcurrency is the per-pod concurrent-request soft target used
	// when an app sets none. Built-in: 20.
	// +optional
	// +kubebuilder:validation:Minimum=1
	ContainerConcurrency int32 `json:"containerConcurrency,omitempty"`

	// ScaleDownDelay is how long the last pod stays routable after traffic
	// stops, used when an app sets none. Unset leaves the Knative cluster default
	// in force. Validated by the same Knative validator the app field uses.
	// +optional
	// +kubebuilder:validation:MaxLength=16
	ScaleDownDelay string `json:"scaleDownDelay,omitempty"`

	// TargetBurstCapacity is the activator burst capacity used when an app sets
	// none: -1 keeps the activator in the request path, >= 0 is a capacity in
	// requests. Unset leaves the Knative cluster default in force.
	// +optional
	// +kubebuilder:validation:Minimum=-1
	TargetBurstCapacity *int32 `json:"targetBurstCapacity,omitempty"`

	// PanicWindowPercentage is the KPA panic window used when an app sets none.
	// Unset leaves the Knative cluster default in force.
	// +optional
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=100
	PanicWindowPercentage *int32 `json:"panicWindowPercentage,omitempty"`

	// PanicThresholdPercentage is the KPA panic threshold used when an app sets
	// none. Unset leaves the Knative cluster default in force.
	// +optional
	// +kubebuilder:validation:Minimum=110
	PanicThresholdPercentage *int32 `json:"panicThresholdPercentage,omitempty"`
}

// PlatformResources groups the resource defaults.
type PlatformResources struct {
	// Defaults applies per field: an app that sets cpuLimit but not memoryLimit
	// inherits the platform memoryLimit.
	// +optional
	Defaults *PlatformResourceDefaults `json:"defaults,omitempty"`
}

// PlatformResourceDefaults are the container resource defaults. Each unset
// field falls back to the built-in value (250m / 1000m CPU, 512Mi / 1Gi memory).
//
// The pattern on each field is the Kubernetes resource.Quantity grammar (the
// regular expression the apiserver itself publishes for the type). These values
// are admin-authored but rendered into every inheriting app's pod spec, so a
// malformed one is rejected at the door rather than at reconcile time.
type PlatformResourceDefaults struct {
	// +optional
	// +kubebuilder:validation:MaxLength=32
	// +kubebuilder:validation:Pattern=`^(\+|-)?(([0-9]+(\.[0-9]*)?)|(\.[0-9]+))(([KMGTPE]i)|[numkMGTPE]|([eE](\+|-)?(([0-9]+(\.[0-9]*)?)|(\.[0-9]+))))?$`
	CPURequest string `json:"cpuRequest,omitempty"`
	// +optional
	// +kubebuilder:validation:MaxLength=32
	// +kubebuilder:validation:Pattern=`^(\+|-)?(([0-9]+(\.[0-9]*)?)|(\.[0-9]+))(([KMGTPE]i)|[numkMGTPE]|([eE](\+|-)?(([0-9]+(\.[0-9]*)?)|(\.[0-9]+))))?$`
	CPULimit string `json:"cpuLimit,omitempty"`
	// +optional
	// +kubebuilder:validation:MaxLength=32
	// +kubebuilder:validation:Pattern=`^(\+|-)?(([0-9]+(\.[0-9]*)?)|(\.[0-9]+))(([KMGTPE]i)|[numkMGTPE]|([eE](\+|-)?(([0-9]+(\.[0-9]*)?)|(\.[0-9]+))))?$`
	MemoryRequest string `json:"memoryRequest,omitempty"`
	// +optional
	// +kubebuilder:validation:MaxLength=32
	// +kubebuilder:validation:Pattern=`^(\+|-)?(([0-9]+(\.[0-9]*)?)|(\.[0-9]+))(([KMGTPE]i)|[numkMGTPE]|([eE](\+|-)?(([0-9]+(\.[0-9]*)?)|(\.[0-9]+))))?$`
	MemoryLimit string `json:"memoryLimit,omitempty"`
}

// PlatformLimits groups request limits.
type PlatformLimits struct {
	// TimeoutSeconds is the maximum seconds a request may take before Knative
	// times it out, used when an app sets none. Built-in: 300.
	// +optional
	// +kubebuilder:validation:Minimum=1
	// +kubebuilder:validation:Maximum=3600
	TimeoutSeconds int32 `json:"timeoutSeconds,omitempty"`
}

// PlatformDatabase groups the database-facing budget.
type PlatformDatabase struct {
	// ConnectionBudget is the cap that maxScale x poolMax must fit within for an
	// app that declares a poolMax. Built-in: 80. It creates no database, pooler
	// or connection of any kind; it only moves the cap the operator enforces.
	// +optional
	// +kubebuilder:validation:Minimum=1
	ConnectionBudget int32 `json:"connectionBudget,omitempty"`
}

// PlatformRollout bounds platform-triggered re-renders.
type PlatformRollout struct {
	// MaxAppsPerMinute bounds how many apps the operator re-renders per minute
	// when a platform change alters their effective values. Each re-render is a
	// new Knative revision (initial-scale 1), so an unbounded edit would boot one
	// pod per app at once. Built-in: 10.
	// +optional
	// +kubebuilder:validation:Minimum=1
	MaxAppsPerMinute int32 `json:"maxAppsPerMinute,omitempty"`
}

// KnextPlatformStatus is the observed state. The operator writes ONLY this and
// never the spec.
type KnextPlatformStatus struct {
	// ObservedGeneration is the metadata.generation the operator last evaluated.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// Conditions: Accepted (the spec is valid and the object is the singleton),
	// DefaultsPropagated (every inheriting app re-rendered, or Progressing with
	// counts) and Ready.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`

	// Rollout counts apps by how far the current platform config has reached.
	// +optional
	Rollout *PlatformRolloutStatus `json:"rollout,omitempty"`
}

// PlatformRolloutStatus counts NextApps by propagation state.
type PlatformRolloutStatus struct {
	// Pending is the number of apps still waiting to be re-rendered (rate-limited).
	Pending int32 `json:"pending"`
	// Applied is the number of apps rendered with the current platform config.
	Applied int32 `json:"applied"`
	// Held is the number of apps whose current Knative Service is held because
	// the platform config would make their effective spec invalid.
	Held int32 `json:"held"`
}

// +kubebuilder:object:root=true
// +kubebuilder:resource:scope=Cluster,shortName=kplatform
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Profile",type="string",JSONPath=".spec.profile"
// +kubebuilder:printcolumn:name="Accepted",type="string",JSONPath=".status.conditions[?(@.type=='Accepted')].status"
// +kubebuilder:printcolumn:name="Ready",type="string",JSONPath=".status.conditions[?(@.type=='Ready')].status"
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"
// +kubebuilder:validation:XValidation:rule="self.metadata.name == 'default'",message="the KnextPlatform is a singleton: only an object named 'default' is honoured"

// KnextPlatform is the cluster-scoped platform layer configuration (ADR-0064).
// The operator reads it and merges its defaults into every NextApp at render
// time, under the app's own fields and over the built-in values. Applied with
// kubectl or GitOps; never written by the CLI.
type KnextPlatform struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata.
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the platform configuration.
	// +optional
	Spec KnextPlatformSpec `json:"spec,omitzero"`

	// status defines the observed state.
	// +optional
	Status KnextPlatformStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// KnextPlatformList contains a list of KnextPlatform.
type KnextPlatformList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []KnextPlatform `json:"items"`
}

func init() {
	SchemeBuilder.Register(&KnextPlatform{}, &KnextPlatformList{})
}
