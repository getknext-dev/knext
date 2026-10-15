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
	"context"
	"regexp"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/validation"
)

// A Redis-cached app that leaves spec.cache.keyPrefix unset used to get NO
// REDIS_KEY_PREFIX, so the runtime fell back to the shared literal 'kn-next'.
// Every such app on one Redis then shared one keyspace, and the outage collapse
// (SCAN MATCH <prefix>:cache:* / <prefix>:uc:* + DEL) of one app deleted every
// other app's cache. The operator now renders a per-app default derived from
// namespace/name, the same derivation as the CDN tag prefix, so no two apps
// share a prefix unless a user sets the same one on purpose.

func redisApp(namespace, name, keyPrefix string) *appsv1alpha1.NextApp {
	return &appsv1alpha1.NextApp{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
		Spec: appsv1alpha1.NextAppSpec{
			Image: "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
			Cache: &appsv1alpha1.CacheSpec{Provider: "redis", URL: "redis://shared:6379", KeyPrefix: keyPrefix},
		},
	}
}

func renderedRedisPrefix(t *testing.T, app *appsv1alpha1.NextApp) (corev1.EnvVar, int) {
	t.Helper()
	env, _, _ := (&NextAppReconciler{}).buildKsvcEnv(app)
	var found corev1.EnvVar
	n := 0
	for _, ev := range env {
		if ev.Name == "REDIS_KEY_PREFIX" {
			found = ev
			n++
		}
	}
	return found, n
}

var derivedPrefixShape = regexp.MustCompile(`^kn-[0-9a-f]{12}$`)

func TestRedisKeyPrefix_DefaultIsDerivedPerApp(t *testing.T) {
	apps := []*appsv1alpha1.NextApp{
		redisApp("default", "shop", ""),
		redisApp("team-b", "shop", ""), // same name, other namespace
		redisApp("default", "blog", ""),
	}
	seen := map[string]string{}
	for _, app := range apps {
		ev, n := renderedRedisPrefix(t, app)
		if n != 1 {
			t.Fatalf("%s/%s: REDIS_KEY_PREFIX rendered %d times, want exactly 1", app.Namespace, app.Name, n)
		}
		if ev.Value == "kn-next" || !derivedPrefixShape.MatchString(ev.Value) {
			t.Fatalf("%s/%s: REDIS_KEY_PREFIX = %q, want kn-<12 hex> derived from namespace/name", app.Namespace, app.Name, ev.Value)
		}
		if other, dup := seen[ev.Value]; dup {
			t.Fatalf("%s/%s and %s share REDIS_KEY_PREFIX %q — one app's collapse would delete the other's cache",
				app.Namespace, app.Name, other, ev.Value)
		}
		seen[ev.Value] = app.Namespace + "/" + app.Name
	}
}

// Lockstep with the CLI's doctor (packages/kn-next/src/cli/doctor/checks/redis-prefix.ts,
// defaultRedisKeyPrefix): both sides pin the same vector.
func TestRedisKeyPrefix_DerivationVector(t *testing.T) {
	ev, _ := renderedRedisPrefix(t, redisApp("default", "shop", ""))
	if ev.Value != "kn-5be479caf0c0" {
		t.Fatalf("default/shop: REDIS_KEY_PREFIX = %q, want kn-5be479caf0c0 (kn- + sha256(\"default/shop\")[:12])", ev.Value)
	}
	ev, _ = renderedRedisPrefix(t, redisApp("team-b", "shop", ""))
	if ev.Value != "kn-d8bd7dc33539" {
		t.Fatalf("team-b/shop: REDIS_KEY_PREFIX = %q, want kn-d8bd7dc33539", ev.Value)
	}
}

func TestRedisKeyPrefix_ExplicitKeyPrefixWins(t *testing.T) {
	ev, n := renderedRedisPrefix(t, redisApp("default", "shop", "legacy-shop"))
	if n != 1 || ev.Value != "legacy-shop" {
		t.Fatalf("explicit keyPrefix: got %d entries, value %q; want exactly one, legacy-shop", n, ev.Value)
	}
}

// A user who already sets REDIS_KEY_PREFIX through spec.env or an envMap Secret
// keeps that value: the default yields, like KNEXT_PUBLIC_ORIGINS.
func TestRedisKeyPrefix_UserEnvWins(t *testing.T) {
	app := redisApp("default", "shop", "")
	app.Spec.Env = map[string]string{"REDIS_KEY_PREFIX": "mine"}
	ev, n := renderedRedisPrefix(t, app)
	if n != 1 || ev.Value != "mine" {
		t.Fatalf("spec.env REDIS_KEY_PREFIX: got %d entries, value %q; want exactly one, mine", n, ev.Value)
	}

	app = redisApp("default", "shop", "")
	app.Spec.Secrets = &appsv1alpha1.SecretsSpec{EnvMap: map[string]appsv1alpha1.EnvMapEntry{
		"REDIS_KEY_PREFIX": {SecretName: "s", SecretKey: "k"},
	}}
	env, _, report := (&NextAppReconciler{}).buildKsvcEnv(app)
	if got := countNamed(env, "REDIS_KEY_PREFIX"); got != 1 {
		t.Fatalf("envMap REDIS_KEY_PREFIX appears %d times, want exactly 1", got)
	}
	for _, e := range env {
		if e.Name == "REDIS_KEY_PREFIX" && e.ValueFrom == nil {
			t.Fatalf("REDIS_KEY_PREFIX = %+v, want the envMap Secret ref", e)
		}
	}
	if !report.empty() {
		t.Fatalf("an envMap REDIS_KEY_PREFIX with keyPrefix unset is not a collision: got %+v", report)
	}
	// Not reserved: admission must keep accepting it.
	if _, reserved := validation.ReservedOperatorEnvNames(&app.Spec)["REDIS_KEY_PREFIX"]; reserved {
		t.Fatalf("REDIS_KEY_PREFIX must not be reserved while keyPrefix is unset (the default yields to the user)")
	}
}

func TestRedisKeyPrefix_NotRenderedWithoutRedis(t *testing.T) {
	for _, provider := range []string{"", "memory"} {
		app := redisApp("default", "shop", "")
		app.Spec.Cache.Provider = provider
		if _, n := renderedRedisPrefix(t, app); n != 0 {
			t.Fatalf("provider %q: REDIS_KEY_PREFIX rendered %d times, want 0", provider, n)
		}
	}
	app := redisApp("default", "shop", "")
	app.Spec.Cache = nil
	if _, n := renderedRedisPrefix(t, app); n != 0 {
		t.Fatalf("no cache: REDIS_KEY_PREFIX rendered %d times, want 0", n)
	}
}

// The finalizer reaps the keyspace the operator rendered, so an app on the
// derived default leaves no keys behind — and only its own.
func TestRedisKeyPrefix_FinalizerReapsDerivedPrefix(t *testing.T) {
	app := redisApp("default", "shop", "")
	fc := &fakeCleaner{}
	r := &NextAppReconciler{Cleaner: fc}
	if err := r.cleanupExternalState(context.Background(), app); err != nil {
		t.Fatalf("cleanupExternalState: %v", err)
	}
	if len(fc.cacheCalls) != 1 || fc.cacheCalls[0].keyPrefix != "kn-5be479caf0c0" {
		t.Fatalf("cache cleanup calls = %+v, want one under kn-5be479caf0c0", fc.cacheCalls)
	}

	// A prefix the user set through env is not the operator's to reap.
	app.Spec.Env = map[string]string{"REDIS_KEY_PREFIX": "mine"}
	fc = &fakeCleaner{}
	r = &NextAppReconciler{Cleaner: fc}
	if err := r.cleanupExternalState(context.Background(), app); err != nil {
		t.Fatalf("cleanupExternalState: %v", err)
	}
	if len(fc.cacheCalls) != 0 {
		t.Fatalf("cache cleanup calls = %+v, want none for a user-set env prefix", fc.cacheCalls)
	}
}

// An explicit spec.cache.keyPrefix of "kn-next" is the shared fallback that
// every app without a prefix lands on. Reaping it on delete would SCAN + DEL
// every legacy app's cache, so the finalizer never touches it — the runtime's
// collapseSweepAllowed refuses the same prefix for the same reason.
func TestRedisKeyPrefix_FinalizerNeverReapsSharedFallback(t *testing.T) {
	app := redisApp("default", "shop", "kn-next")
	if got := operatorRedisKeyPrefix(app); got != "" {
		t.Fatalf("operatorRedisKeyPrefix(keyPrefix=kn-next) = %q, want empty (the shared fallback is no app's to reap)", got)
	}
	fc := &fakeCleaner{}
	r := &NextAppReconciler{Cleaner: fc}
	if err := r.cleanupExternalState(context.Background(), app); err != nil {
		t.Fatalf("cleanupExternalState: %v", err)
	}
	if len(fc.cacheCalls) != 0 {
		t.Fatalf("cache cleanup calls = %+v, want none under the shared fallback kn-next", fc.cacheCalls)
	}
	// The explicit value is still rendered: the app keeps the prefix it chose.
	if ev, n := renderedRedisPrefix(t, app); n != 1 || ev.Value != "kn-next" {
		t.Fatalf("explicit keyPrefix kn-next: got %d entries, value %q; want exactly one, kn-next", n, ev.Value)
	}
}

// An empty spec.env REDIS_KEY_PREFIX is unset: the runtime reads "" as unset
// and falls back to the shared "kn-next", so the operator renders the derived
// default in its place — one entry, never the empty one. Lockstep with the
// doctor (doctor-redis-prefix.test.ts), which resolves the same app to the same
// vector.
func TestRedisKeyPrefix_EmptyUserEnvIsUnset(t *testing.T) {
	app := redisApp("default", "shop", "")
	app.Spec.Env = map[string]string{"REDIS_KEY_PREFIX": ""}
	ev, n := renderedRedisPrefix(t, app)
	if n != 1 || ev.Value != "kn-5be479caf0c0" {
		t.Fatalf("spec.env REDIS_KEY_PREFIX=\"\": got %d entries, value %q; want exactly one, kn-5be479caf0c0", n, ev.Value)
	}
	fc := &fakeCleaner{}
	r := &NextAppReconciler{Cleaner: fc}
	if err := r.cleanupExternalState(context.Background(), app); err != nil {
		t.Fatalf("cleanupExternalState: %v", err)
	}
	if len(fc.cacheCalls) != 1 || fc.cacheCalls[0].keyPrefix != "kn-5be479caf0c0" {
		t.Fatalf("cache cleanup calls = %+v, want one under kn-5be479caf0c0", fc.cacheCalls)
	}
}
