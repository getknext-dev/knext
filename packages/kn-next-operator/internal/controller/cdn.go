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
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"

	corev1 "k8s.io/api/core/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/validation"
)

// ADR-0068 D3: spec.cdn is rendered as KNEXT_CDN_* environment variables and
// nothing else. The operator carries no per-cloud logic: the provider is an
// opaque string the runtime resolves to a data row. Names and formats here are
// the runtime contract (packages/kn-next/src/adapters/cdn-edge.cjs).

const (
	// ConditionCDNAdvisory is an informational, non-fatal condition: spec.cdn is
	// set but something about this app means the CDN tier does less than the
	// user may expect. Ready and Degraded are never touched by it. It is absent
	// whenever there is nothing to say (and never added to an app that does not
	// set spec.cdn, so every other app's conditions stay byte-identical, #98).
	ConditionCDNAdvisory = "CDNAdvisory"

	// ReasonCDNInertOnVinext marks spec.cdn on build "vinext" (Beta): the vinext
	// runtime has a different cache adapter and a Bun.serve seam, so the first
	// cut renders no KNEXT_CDN_* env there (ADR-0068 D11).
	ReasonCDNInertOnVinext = "CDNInertOnVinext"

	// ReasonCDNCanaryWithoutAssetRetention marks spec.cdn with a canary split and
	// no object storage: mixed-build HTML at the edge is only self-consistent if
	// both builds' immutable assets stay served (ADR-0068 D9, ADR-0011).
	ReasonCDNCanaryWithoutAssetRetention = "CDNCanaryWithoutAssetRetention"

	// cdnDefaultHTMLTTLSeconds mirrors the CRD default for spec.cdn.htmlTTLSeconds
	// (applied by the apiserver; a Go client that omits the field gets 0 here).
	cdnDefaultHTMLTTLSeconds = 30
)

// cdnRendersEnv reports whether spec.cdn is rendered as env for this app: the
// field is set and the build is not vinext (D11).
func cdnRendersEnv(app *appsv1alpha1.NextApp) bool {
	return validation.CDNRendersEnv(&app.Spec)
}

// cdnTagPrefix is the per-app cache-tag prefix (ADR-0068 D5.3): the first 12
// lowercase hex of sha256("<namespace>/<name>"). It is derived, never a field, so
// a CR cannot choose another app's prefix.
func cdnTagPrefix(app *appsv1alpha1.NextApp) string {
	sum := sha256.Sum256([]byte(app.Namespace + "/" + app.Name))
	return hex.EncodeToString(sum[:])[:12]
}

// cdnEnvVars renders spec.cdn. It returns nil when nothing is to be rendered, so
// an app without spec.cdn is byte-identical to one written before the field
// existed. The order is fixed (it is part of the revision template).
func cdnEnvVars(app *appsv1alpha1.NextApp) []corev1.EnvVar {
	if !cdnRendersEnv(app) {
		return nil
	}
	cdn := app.Spec.CDN
	ttl := cdn.HTMLTTLSeconds
	if ttl <= 0 {
		ttl = cdnDefaultHTMLTTLSeconds
	}
	env := []corev1.EnvVar{
		{Name: "KNEXT_CDN_PROVIDER", Value: cdn.Provider},
		{Name: "KNEXT_CDN_TAG_PREFIX", Value: cdnTagPrefix(app)},
		{Name: "KNEXT_CDN_HTML_TTL_SECONDS", Value: strconv.Itoa(int(ttl))},
		{Name: "KNEXT_CDN_SWR_SECONDS", Value: strconv.Itoa(int(cdn.StaleWhileRevalidateSeconds))},
	}
	if len(cdn.ExcludePaths) > 0 {
		env = append(env, corev1.EnvVar{Name: "KNEXT_CDN_EXCLUDE_PATHS", Value: strings.Join(cdn.ExcludePaths, ",")})
	}
	if len(cdn.IncludePaths) > 0 {
		env = append(env, corev1.EnvVar{Name: "KNEXT_CDN_INCLUDE_PATHS", Value: strings.Join(cdn.IncludePaths, ",")})
	}
	if p := cdn.Purge; p != nil {
		env = append(env, corev1.EnvVar{Name: "KNEXT_CDN_PURGE_TARGET", Value: p.Target})
		if p.RequestsPerMinute > 0 {
			env = append(env, corev1.EnvVar{Name: "KNEXT_CDN_PURGE_RPM", Value: strconv.Itoa(int(p.RequestsPerMinute))})
		}
	}
	if cdn.EmulatorEndpoint != "" {
		env = append(env, corev1.EnvVar{Name: "KNEXT_CDN_EMULATOR_ENDPOINT", Value: cdn.EmulatorEndpoint})
	}
	if p := cdn.Purge; p != nil {
		// The token is a secretKeyRef (the DATABASE_URL mechanism): the value never
		// appears in the CR, the revision template or the status.
		env = append(env, corev1.EnvVar{
			Name: "KNEXT_CDN_PURGE_TOKEN",
			ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
				LocalObjectReference: corev1.LocalObjectReference{Name: p.SecretRef.Name},
				Key:                  p.SecretRef.Key,
			}},
		})
	}
	return env
}

// isReservedCDNEnvName reports whether a user-supplied env name is in the
// operator's reserved KNEXT_CDN_* namespace — whether or not spec.cdn is set
// (ADR-0068 D3: a name the operator does not render would otherwise pass
// straight through and let a CR choose its own prefix or endpoint).
func isReservedCDNEnvName(name string) bool {
	return strings.HasPrefix(name, appsv1alpha1.CDNEnvPrefix)
}

// cdnAdvisory returns the informational CDNAdvisory reason and message for an
// app, or ok=false when there is nothing to report. vinext takes precedence: if
// nothing is rendered, the canary dependency is moot.
func cdnAdvisory(app *appsv1alpha1.NextApp) (reason, message string, ok bool) {
	if app.Spec.CDN == nil {
		return "", "", false
	}
	if app.Spec.Build == "vinext" {
		return ReasonCDNInertOnVinext,
			"spec.cdn is set but build is vinext (Beta): no KNEXT_CDN_* environment is rendered and the " +
				"CDN tier is inert. The vinext runtime uses a different cache adapter and server seam; CDN " +
				"support there is a follow-up. Use build turbopack or webpack to get CDN headers.", true
	}
	canary := app.Spec.Traffic != nil && app.Spec.Traffic.RevisionName != "" && app.Spec.Traffic.CanaryPercent > 0
	hasStorage := app.Spec.Storage != nil && app.Spec.Storage.Provider != ""
	if canary && !hasStorage {
		return ReasonCDNCanaryWithoutAssetRetention,
			"spec.cdn is set while a canary split is active and the app has no object storage (spec.storage). " +
				"During the split the edge can hold HTML from either build for up to the edge TTL; that HTML is " +
				"only self-consistent if both builds' immutable assets are still served, and without object " +
				"storage each pod serves only its own build's assets, so old HTML can request a chunk from a " +
				"new pod and get a 404. Configure object storage, or finish the rollout.", true
	}
	return "", "", false
}
