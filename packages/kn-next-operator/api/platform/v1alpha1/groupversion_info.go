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

// Package v1alpha1 contains API Schema definitions for the platform
// v1alpha1 API group (platform.kn-next.dev): the cluster-scoped KnextPlatform
// that carries the platform layer's own configuration (ADR-0064).
//
// The group is separate from apps.kn-next.dev on purpose: platform admins and
// app developers get separate RBAC.
// +kubebuilder:object:generate=true
// +groupName=platform.kn-next.dev
package v1alpha1

import (
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/scheme"
)

var (
	// GroupVersion is group version used to register these objects.
	GroupVersion = schema.GroupVersion{Group: "platform.kn-next.dev", Version: "v1alpha1"}

	// SchemeBuilder is used to add go types to the GroupVersionKind scheme.
	SchemeBuilder = &scheme.Builder{GroupVersion: GroupVersion}

	// AddToScheme adds the types in this group-version to the given scheme.
	AddToScheme = SchemeBuilder.AddToScheme
)

// CRDInstalled reports whether the cluster serves the KnextPlatform kind, per
// discovery. Everything that touches the kind — the NextApp reconciler's read
// and watch, the platform's own reconciler, the admission webhook's budget read —
// is wired only when it does, so an operator on a cluster without the CRD starts
// and behaves exactly as before the platform layer existed (ADR-0064 D3). A CRD
// installed later is picked up on the next operator restart.
func CRDInstalled(mapper meta.RESTMapper) bool {
	_, err := mapper.RESTMapping(
		schema.GroupKind{Group: GroupVersion.Group, Kind: "KnextPlatform"}, GroupVersion.Version)
	return err == nil
}
