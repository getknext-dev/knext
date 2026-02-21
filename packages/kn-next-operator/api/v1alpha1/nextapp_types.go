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

	// GitOps Preview Environment configuration
	// +optional
	Preview *PreviewSpec `json:"preview,omitempty"`
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
}

type CacheSpec struct {
	Provider            string `json:"provider,omitempty"`
	URL                 string `json:"url,omitempty"`
	EnableBytecodeCache bool   `json:"enableBytecodeCache,omitempty"`
	BytecodeCacheSize   string `json:"bytecodeCacheSize,omitempty"`
}

type RevalidationSpec struct {
	Queue          string `json:"queue,omitempty"`
	KafkaBrokerUrl string `json:"kafkaBrokerUrl,omitempty"`
}

type SecretsSpec struct {
	EnvFrom []string `json:"envFrom,omitempty"`
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
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status

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
