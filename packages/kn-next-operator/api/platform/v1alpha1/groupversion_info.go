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
	"fmt"

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
//
// Only a definitive "no such kind" (meta.IsNoMatchError) means the CRD is absent.
// Any OTHER error — a discovery timeout, a 5xx, an aggregated API that is down —
// is an unknown, returned to the caller, because reading it as "absent" would
// switch the whole platform layer off, silently, for the life of the process: a
// platform whose defaults were in force would stop reaching every app and the
// only trace would be a NoPlatformCRD condition on a cluster that has the CRD.
// Callers fail start-up on the error; the pod restart is the retry.
func CRDInstalled(mapper meta.RESTMapper) (bool, error) {
	_, err := mapper.RESTMapping(
		schema.GroupKind{Group: GroupVersion.Group, Kind: "KnextPlatform"}, GroupVersion.Version)
	switch {
	case err == nil:
		return true, nil
	case meta.IsNoMatchError(err):
		return false, nil
	default:
		return false, fmt.Errorf("discovering whether the KnextPlatform CRD is installed: %w", err)
	}
}
