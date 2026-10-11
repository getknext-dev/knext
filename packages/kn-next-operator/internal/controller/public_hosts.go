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

package controller

import (
	"strings"

	corev1 "k8s.io/api/core/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// publicOriginsEnvName is the variable the knext runtime's public-origin
// preload (packages/kn-next/src/adapters/public-origin.cjs) reads. Its name and
// entry format are the runtime contract; spec.networking.publicHosts is only
// the typed way to fill it.
const publicOriginsEnvName = "KNEXT_PUBLIC_ORIGINS"

// publicOriginsEnv renders spec.networking.publicHosts as the
// KNEXT_PUBLIC_ORIGINS allowlist: each host becomes `https://<host>`,
// comma-joined, in list order (the first entry is the preload's fallback).
//
// It returns ok=false — render nothing — when the list is empty or unset, so a
// CR that does not use the field is byte-identical to one written before it
// existed, and when the user already supplies KNEXT_PUBLIC_ORIGINS in the
// assembled env (spec.env or a spec.secrets.envMap Secret reference). The user
// value wins so that setups that set the variable by hand before this field
// existed keep working, and a deliberate value is never silently overridden.
func publicOriginsEnv(app *appsv1alpha1.NextApp, assembled []corev1.EnvVar) (corev1.EnvVar, bool) {
	if app.Spec.Networking == nil || len(app.Spec.Networking.PublicHosts) == 0 {
		return corev1.EnvVar{}, false
	}
	for _, ev := range assembled {
		if ev.Name == publicOriginsEnvName {
			return corev1.EnvVar{}, false
		}
	}
	origins := make([]string, 0, len(app.Spec.Networking.PublicHosts))
	for _, host := range app.Spec.Networking.PublicHosts {
		origins = append(origins, "https://"+host)
	}
	return corev1.EnvVar{Name: publicOriginsEnvName, Value: strings.Join(origins, ",")}, true
}
