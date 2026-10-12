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
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/tools/record"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// ADR-0068 D3 / D5.3: spec.cdn is rendered as KNEXT_CDN_* env and nothing else;
// the tag prefix is derived from namespace/name; the whole KNEXT_CDN_* namespace
// is the operator's. These tests pin the render contract at the pure seam
// (buildKsvcEnv); the envtest file pins admission and the rendered ksvc end to end.

func cdnApp(spec appsv1alpha1.NextAppSpec) *appsv1alpha1.NextApp {
	spec.Image = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
	return &appsv1alpha1.NextApp{
		ObjectMeta: metav1.ObjectMeta{Name: "my-app", Namespace: "default"},
		Spec:       spec,
	}
}

func cdnEnvOf(env []corev1.EnvVar) map[string]corev1.EnvVar {
	out := map[string]corev1.EnvVar{}
	for _, ev := range env {
		if strings.HasPrefix(ev.Name, "KNEXT_CDN_") {
			out[ev.Name] = ev
		}
	}
	return out
}

func buildEnvFor(t *testing.T, app *appsv1alpha1.NextApp) []corev1.EnvVar {
	t.Helper()
	r := &NextAppReconciler{}
	env, _, _ := r.buildKsvcEnv(app)
	return env
}

func TestCDNEnv_RendersEveryField(t *testing.T) {
	app := cdnApp(appsv1alpha1.NextAppSpec{CDN: &appsv1alpha1.CDNSpec{
		Provider:                    "cloudflare",
		HTMLTTLSeconds:              45,
		StaleWhileRevalidateSeconds: 10,
		ExcludePaths:                []string{"/account", "/admin"},
		IncludePaths:                []string{"/blog"},
		Purge: &appsv1alpha1.CDNPurgeSpec{
			SecretRef:         appsv1alpha1.CDNSecretRef{Name: "cdn-purge", Key: "token"},
			Target:            "0123456789abcdef0123456789abcdef",
			RequestsPerMinute: 20,
		},
	}})
	got := cdnEnvOf(buildEnvFor(t, app))

	want := map[string]string{
		"KNEXT_CDN_PROVIDER":         "cloudflare",
		"KNEXT_CDN_TAG_PREFIX":       "24116dd4a062", // first 12 hex of sha256("default/my-app")
		"KNEXT_CDN_HTML_TTL_SECONDS": "45",
		"KNEXT_CDN_SWR_SECONDS":      "10",
		"KNEXT_CDN_EXCLUDE_PATHS":    "/account,/admin",
		"KNEXT_CDN_INCLUDE_PATHS":    "/blog",
		"KNEXT_CDN_PURGE_TARGET":     "0123456789abcdef0123456789abcdef",
		"KNEXT_CDN_PURGE_RPM":        "20",
	}
	for name, value := range want {
		ev, ok := got[name]
		if !ok {
			t.Errorf("%s not rendered; rendered: %v", name, got)
			continue
		}
		if ev.Value != value || ev.ValueFrom != nil {
			t.Errorf("%s = %+v, want plain value %q", name, ev, value)
		}
	}
	token, ok := got["KNEXT_CDN_PURGE_TOKEN"]
	if !ok {
		t.Fatalf("KNEXT_CDN_PURGE_TOKEN not rendered")
	}
	ref := token.ValueFrom
	if token.Value != "" || ref == nil || ref.SecretKeyRef == nil ||
		ref.SecretKeyRef.Name != "cdn-purge" || ref.SecretKeyRef.Key != "token" {
		t.Errorf("KNEXT_CDN_PURGE_TOKEN must be a secretKeyRef to cdn-purge/token and carry no literal, got %+v", token)
	}
	if len(got) != len(want)+1 {
		t.Errorf("unexpected extra KNEXT_CDN_* env: %v", got)
	}
}

func TestCDNEnv_OptionalFieldsAreOmittedAndDefaultsApply(t *testing.T) {
	// htmlTTLSeconds==0 (omitted by a Go client; the CRD default only applies at
	// the apiserver) must still render the ADR default of 30; SWR renders 0.
	app := cdnApp(appsv1alpha1.NextAppSpec{CDN: &appsv1alpha1.CDNSpec{Provider: "cloudfront"}})
	got := cdnEnvOf(buildEnvFor(t, app))
	for _, absent := range []string{
		"KNEXT_CDN_EXCLUDE_PATHS", "KNEXT_CDN_INCLUDE_PATHS", "KNEXT_CDN_PURGE_TARGET",
		"KNEXT_CDN_PURGE_RPM", "KNEXT_CDN_PURGE_TOKEN", "KNEXT_CDN_EMULATOR_ENDPOINT",
	} {
		if _, ok := got[absent]; ok {
			t.Errorf("%s rendered although its field is unset", absent)
		}
	}
	if got["KNEXT_CDN_HTML_TTL_SECONDS"].Value != "30" {
		t.Errorf("KNEXT_CDN_HTML_TTL_SECONDS = %q, want default 30", got["KNEXT_CDN_HTML_TTL_SECONDS"].Value)
	}
	if got["KNEXT_CDN_SWR_SECONDS"].Value != "0" {
		t.Errorf("KNEXT_CDN_SWR_SECONDS = %q, want 0", got["KNEXT_CDN_SWR_SECONDS"].Value)
	}
}

func TestCDNEnv_EmulatorEndpoint(t *testing.T) {
	app := cdnApp(appsv1alpha1.NextAppSpec{CDN: &appsv1alpha1.CDNSpec{
		Provider:         "emulator",
		EmulatorEndpoint: "http://cdn-emulator.e2e.svc.cluster.local:8080",
	}})
	got := cdnEnvOf(buildEnvFor(t, app))
	if got["KNEXT_CDN_EMULATOR_ENDPOINT"].Value != "http://cdn-emulator.e2e.svc.cluster.local:8080" {
		t.Errorf("KNEXT_CDN_EMULATOR_ENDPOINT = %+v", got["KNEXT_CDN_EMULATOR_ENDPOINT"])
	}
}

// D5.3: the prefix is a pure function of namespace/name, so two apps cannot
// collide by accident and a CR cannot pick one.
func TestCDNEnv_TagPrefixIsDerivedFromNamespaceAndName(t *testing.T) {
	a := cdnApp(appsv1alpha1.NextAppSpec{CDN: &appsv1alpha1.CDNSpec{Provider: "cloudflare"}})
	b := cdnApp(appsv1alpha1.NextAppSpec{CDN: &appsv1alpha1.CDNSpec{Provider: "cloudflare"}})
	b.Namespace = "other"
	pa := cdnEnvOf(buildEnvFor(t, a))["KNEXT_CDN_TAG_PREFIX"].Value
	pb := cdnEnvOf(buildEnvFor(t, b))["KNEXT_CDN_TAG_PREFIX"].Value
	if pa != "24116dd4a062" || pb != "222f2582e8eb" {
		t.Errorf("prefixes = %q / %q, want 24116dd4a062 / 222f2582e8eb (sha256 of namespace/name)", pa, pb)
	}
}

// Zero diff: no spec.cdn renders no KNEXT_CDN_* env at all.
func TestCDNEnv_ZeroDiffWithoutSpecCDN(t *testing.T) {
	app := cdnApp(appsv1alpha1.NextAppSpec{})
	if got := cdnEnvOf(buildEnvFor(t, app)); len(got) != 0 {
		t.Fatalf("no spec.cdn must render no KNEXT_CDN_* env, got %v", got)
	}
}

// D11: vinext (Beta) renders nothing; the verdict reports it instead.
func TestCDNEnv_VinextRendersNothing(t *testing.T) {
	app := cdnApp(appsv1alpha1.NextAppSpec{
		Build: "vinext",
		CDN:   &appsv1alpha1.CDNSpec{Provider: "cloudflare"},
	})
	if got := cdnEnvOf(buildEnvFor(t, app)); len(got) != 0 {
		t.Fatalf("build: vinext must render no KNEXT_CDN_* env, got %v", got)
	}
}

// D3: the reservation is unconditional — an envMap name in the namespace is
// dropped from the rendered env even with NO spec.cdn (defence in depth for a CR
// that predates the admission rule), and the drop is reported.
func TestCDNEnv_EnvMapReservedNamesAreDroppedWithoutSpecCDN(t *testing.T) {
	app := cdnApp(appsv1alpha1.NextAppSpec{Secrets: &appsv1alpha1.SecretsSpec{
		EnvMap: map[string]appsv1alpha1.EnvMapEntry{
			"KNEXT_CDN_TAG_PREFIX": {SecretName: "s", SecretKey: "k"},
			"KEEP_ME":              {SecretName: "s", SecretKey: "k"},
		},
	}})
	r := &NextAppReconciler{}
	env, _, report := r.buildKsvcEnv(app)
	if got := cdnEnvOf(env); len(got) != 0 {
		t.Fatalf("envMap KNEXT_CDN_TAG_PREFIX must not reach the container, got %v", got)
	}
	found := false
	for _, ev := range env {
		if ev.Name == "KEEP_ME" {
			found = true
		}
	}
	if !found {
		t.Errorf("an unrelated envMap entry must be kept")
	}
	if len(report.operatorWins) != 1 || report.operatorWins[0] != "KNEXT_CDN_TAG_PREFIX" {
		t.Errorf("drop must be reported, got %+v", report)
	}
}

func TestCDNEnv_EnvMapCannotOverrideARenderedName(t *testing.T) {
	app := cdnApp(appsv1alpha1.NextAppSpec{
		CDN: &appsv1alpha1.CDNSpec{Provider: "cloudflare"},
		Secrets: &appsv1alpha1.SecretsSpec{EnvMap: map[string]appsv1alpha1.EnvMapEntry{
			"KNEXT_CDN_TAG_PREFIX": {SecretName: "s", SecretKey: "k"},
		}},
	})
	got := buildEnvFor(t, app)
	n := 0
	for _, ev := range got {
		if ev.Name == "KNEXT_CDN_TAG_PREFIX" {
			n++
			if ev.ValueFrom != nil || ev.Value != "24116dd4a062" {
				t.Errorf("operator value must win, got %+v", ev)
			}
		}
	}
	if n != 1 {
		t.Errorf("want exactly one KNEXT_CDN_TAG_PREFIX entry, got %d", n)
	}
}

func TestCDNEnv_SpecEnvReservedNamesAreDroppedWithAWarning(t *testing.T) {
	cases := map[string]*appsv1alpha1.CDNSpec{
		"without spec.cdn": nil,
		"with spec.cdn":    {Provider: "cloudflare"},
	}
	for name, cdn := range cases {
		t.Run(name, func(t *testing.T) {
			app := cdnApp(appsv1alpha1.NextAppSpec{
				CDN: cdn,
				Env: map[string]string{
					"KNEXT_CDN_TAG_PREFIX":        "forged",
					"KNEXT_CDN_EMULATOR_ENDPOINT": "http://evil.example.com",
					"KEEP_ME":                     "1",
				},
			})
			rec := record.NewFakeRecorder(64)
			r := &NextAppReconciler{Recorder: rec}
			env, _, _ := r.buildKsvcEnv(app)
			keep := false
			for _, ev := range env {
				if ev.Name == "KNEXT_CDN_EMULATOR_ENDPOINT" {
					t.Errorf("spec.env KNEXT_CDN_EMULATOR_ENDPOINT leaked: %+v", ev)
				}
				if ev.Name == "KNEXT_CDN_TAG_PREFIX" && ev.Value == "forged" {
					t.Errorf("spec.env forged the tag prefix: %+v", ev)
				}
				if ev.Name == "KEEP_ME" {
					keep = true
				}
			}
			if !keep {
				t.Errorf("an unrelated spec.env entry must be kept")
			}
			events := strings.Join(drainEvents(rec), "\n")
			if !strings.Contains(events, "spec.env[KNEXT_CDN_TAG_PREFIX] ignored") ||
				!strings.Contains(events, "spec.env[KNEXT_CDN_EMULATOR_ENDPOINT] ignored") {
				t.Errorf("each dropped name needs a Warning, got:\n%s", events)
			}
		})
	}
}

// ---- status verdict: the informational CDNAdvisory condition (D9, D11) ----

func cdnVerdict(app *appsv1alpha1.NextApp) statusVerdict {
	now := time.Now()
	return computeStatusVerdict(app, readyKsvc(now), databaseCheckState{mode: databaseModeNone},
		revisionCheck{}, imageCacheState{}, netpolEnforcementState{}, envMapCollisionReport{}, privateExposureState{}, podCreationState{}, now)
}

func cdnCondition(v statusVerdict, condType string) (metav1.Condition, bool) {
	for _, c := range v.conditions {
		if c.Type == condType {
			return c, true
		}
	}
	return metav1.Condition{}, false
}

func TestCDNAdvisory_VinextIsInertAndSaysSo(t *testing.T) {
	app := verdictApp()
	app.Spec.Build = "vinext"
	app.Spec.CDN = &appsv1alpha1.CDNSpec{Provider: "cloudflare"}
	c, ok := cdnCondition(cdnVerdict(app), ConditionCDNAdvisory)
	if !ok {
		t.Fatalf("vinext + spec.cdn must report %s", ConditionCDNAdvisory)
	}
	if c.Status != metav1.ConditionTrue || c.Reason != ReasonCDNInertOnVinext {
		t.Errorf("got %+v", c)
	}
	if !strings.Contains(c.Message, "vinext") {
		t.Errorf("message must say why: %q", c.Message)
	}
}

func TestCDNAdvisory_CanaryWithoutObjectStorage(t *testing.T) {
	app := verdictApp()
	app.Spec.CDN = &appsv1alpha1.CDNSpec{Provider: "cloudflare"}
	app.Spec.Traffic = &appsv1alpha1.TrafficSpec{RevisionName: "shop-00001", CanaryPercent: 10}
	c, ok := cdnCondition(cdnVerdict(app), ConditionCDNAdvisory)
	if !ok {
		t.Fatalf("canary + spec.cdn + no storage must report %s", ConditionCDNAdvisory)
	}
	if c.Status != metav1.ConditionTrue || c.Reason != ReasonCDNCanaryWithoutAssetRetention {
		t.Errorf("got %+v", c)
	}
	if !strings.Contains(c.Message, "object storage") {
		t.Errorf("message must name the dependency: %q", c.Message)
	}
}

func TestCDNAdvisory_AbsentWhenThereIsNothingToSay(t *testing.T) {
	storage := &appsv1alpha1.StorageSpec{Provider: "s3", Bucket: "b"}
	canary := &appsv1alpha1.TrafficSpec{RevisionName: "shop-00001", CanaryPercent: 10}
	cdn := &appsv1alpha1.CDNSpec{Provider: "cloudflare"}
	cases := map[string]func(*appsv1alpha1.NextApp){
		"no spec.cdn":               func(a *appsv1alpha1.NextApp) { a.Spec.Traffic = canary },
		"spec.cdn, no canary":       func(a *appsv1alpha1.NextApp) { a.Spec.CDN = cdn },
		"spec.cdn, canary, storage": func(a *appsv1alpha1.NextApp) { a.Spec.CDN, a.Spec.Traffic, a.Spec.Storage = cdn, canary, storage },
		"spec.cdn, full rollback pin": func(a *appsv1alpha1.NextApp) {
			a.Spec.CDN, a.Spec.Traffic = cdn, &appsv1alpha1.TrafficSpec{RevisionName: "shop-00001"}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			app := verdictApp()
			mutate(app)
			v := cdnVerdict(app)
			if c, ok := cdnCondition(v, ConditionCDNAdvisory); ok {
				t.Errorf("unexpected %s: %+v", ConditionCDNAdvisory, c)
			}
			for _, rc := range v.removeConditions {
				if rc == ConditionCDNAdvisory {
					t.Errorf("a never-reported app must not grow a removal of %s (#98 no-op)", ConditionCDNAdvisory)
				}
			}
		})
	}
}

func TestCDNAdvisory_IsRemovedOnceItNoLongerApplies(t *testing.T) {
	app := verdictApp()
	app.Status.Conditions = []metav1.Condition{{
		Type: ConditionCDNAdvisory, Status: metav1.ConditionTrue, Reason: ReasonCDNInertOnVinext,
	}}
	v := cdnVerdict(app)
	removed := false
	for _, rc := range v.removeConditions {
		if rc == ConditionCDNAdvisory {
			removed = true
		}
	}
	if !removed {
		t.Errorf("a stale %s must be removed, removeConditions = %v", ConditionCDNAdvisory, v.removeConditions)
	}
}

// Round 2: spec.secrets.envFrom imports a Secret's keys unfiltered (the operator
// cannot read the Secret), so a KNEXT_CDN_* key inside it reaches the pod. The
// namespace is the trust boundary (documented on spec.cdn and in the CRD
// reference). What the operator DOES guarantee: with spec.cdn set, the rendered
// KNEXT_CDN_TAG_PREFIX is a plain `value` env entry, and Kubernetes applies
// `env` entries after `envFrom`, so the rendered value wins at runtime.
func TestCDNEnv_RenderedPrefixIsAPlainValueThatEnvFromCannotOverride(t *testing.T) {
	app := cdnApp(appsv1alpha1.NextAppSpec{
		CDN:     &appsv1alpha1.CDNSpec{Provider: "cloudflare"},
		Secrets: &appsv1alpha1.SecretsSpec{EnvFrom: []string{"leaky-secret"}},
	})
	r := &NextAppReconciler{}
	env, envFrom, _ := r.buildKsvcEnv(app)

	var prefix []corev1.EnvVar
	for _, ev := range env {
		if ev.Name == "KNEXT_CDN_TAG_PREFIX" {
			prefix = append(prefix, ev)
		}
	}
	if len(prefix) != 1 {
		t.Fatalf("want exactly one KNEXT_CDN_TAG_PREFIX env entry, got %+v", prefix)
	}
	if prefix[0].ValueFrom != nil || prefix[0].Value != "24116dd4a062" {
		t.Errorf("the rendered prefix must be a plain value entry, got %+v", prefix[0])
	}
	// envFrom is a separate list, applied by Kubernetes BEFORE env: the Secret is
	// passed through untouched, and a same-named key inside it loses to the entry above.
	if len(envFrom) != 1 || envFrom[0].SecretRef == nil || envFrom[0].SecretRef.Name != "leaky-secret" {
		t.Errorf("envFrom must be passed through unfiltered, got %+v", envFrom)
	}
}

func TestCDNEnv_EnvFromIsNotFilteredWithoutSpecCDN(t *testing.T) {
	app := cdnApp(appsv1alpha1.NextAppSpec{
		Secrets: &appsv1alpha1.SecretsSpec{EnvFrom: []string{"leaky-secret"}},
	})
	r := &NextAppReconciler{}
	env, envFrom, _ := r.buildKsvcEnv(app)
	if got := cdnEnvOf(env); len(got) != 0 {
		t.Errorf("no spec.cdn must render no KNEXT_CDN_* env, got %v", got)
	}
	if len(envFrom) != 1 || envFrom[0].SecretRef == nil || envFrom[0].SecretRef.Name != "leaky-secret" {
		t.Errorf("envFrom is the namespace's responsibility and must pass through, got %+v", envFrom)
	}
}
