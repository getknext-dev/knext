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

const redisKeyPrefixEnvName = "REDIS_KEY_PREFIX"

// legacySharedRedisKeyPrefix is the runtime's fallback for an app with no
// REDIS_KEY_PREFIX (LEGACY_SHARED_KEY_PREFIX in
// packages/kn-next/src/adapters/use-cache-handler.js). Every such app on a Redis
// lands on it, so no app owns the keys under it: the runtime refuses to sweep it
// (collapseSweepAllowed) and the finalizer refuses to reap it.
const legacySharedRedisKeyPrefix = "kn-next"

// isSharedRedisKeyspace reports whether prefix is the shared fallback "kn-next"
// or nested under it ("kn-next:cache", "kn-next:uc"). Reaping either would
// delete keys that apps without a prefix of their own wrote: "kn-next:cache:*"
// is every such app's ISR entries. The finalizer and DefaultCleaner.CleanupCache
// both refuse it; the runtime's collapseSweepAllowed refuses the same set.
//
// Matching is literal: CleanupCache glob-escapes the prefix, so a prefix that
// only LOOKS like it reaches kn-next ("kn-nex?", "kn-nex[t]", "kn-*") reaps
// its own literal keyspace and nothing else, and needs no refusal. The derived
// per-app prefixes (kn-<12 hex>) need none either: once escaped, only an
// explicit keyPrefix equal to another app's derived prefix reaches that
// keyspace, which is two apps sharing one prefix on purpose (doctor warns).
func isSharedRedisKeyspace(prefix string) bool {
	return prefix == legacySharedRedisKeyPrefix || strings.HasPrefix(prefix, legacySharedRedisKeyPrefix+":")
}

// defaultRedisKeyPrefix is the Redis key prefix of an app that sets no
// spec.cache.keyPrefix: "kn-" plus the first 12 lowercase hex of
// sha256("<namespace>/<name>") — the CDN tag prefix's derivation. Without it the
// runtime falls back to the literal "kn-next", which every such app on a shared
// Redis would share: each would read the others' entries, and one app's outage
// collapse (a prefix-wide SCAN + DEL) would delete the others' caches.
//
// Lockstep with the CLI's doctor (defaultRedisKeyPrefix in
// packages/kn-next/src/cli/doctor/checks/redis-prefix.ts); both pin the same vector.
func defaultRedisKeyPrefix(app *appsv1alpha1.NextApp) string {
	return "kn-" + cdnTagPrefix(app)
}

func cacheIsRedis(app *appsv1alpha1.NextApp) bool {
	return app.Spec.Cache != nil && app.Spec.Cache.Provider == "redis"
}

// userSetsRedisKeyPrefix reports whether the CR sets REDIS_KEY_PREFIX itself,
// through spec.env or a spec.secrets.envMap Secret. That value predates the
// derived default and keeps winning, the way KNEXT_PUBLIC_ORIGINS yields.
// An EMPTY spec.env value is unset: the runtime reads "" as unset and would fall
// back to the shared "kn-next", so the derived default is rendered in its place
// (see dropsEmptyUserRedisKeyPrefix). The CLI's doctor resolves it the same way.
// (A REDIS_KEY_PREFIX inside an envFrom Secret or baked into the image is
// invisible here, and the rendered env takes precedence over both: such an app
// moves to the derived prefix unless it sets spec.cache.keyPrefix.)
func userSetsRedisKeyPrefix(app *appsv1alpha1.NextApp) bool {
	if v, ok := app.Spec.Env[redisKeyPrefixEnvName]; ok && v != "" {
		return true
	}
	if app.Spec.Secrets != nil {
		if _, ok := app.Spec.Secrets.EnvMap[redisKeyPrefixEnvName]; ok {
			return true
		}
	}
	return false
}

// rendersDefaultRedisKeyPrefix reports whether the operator renders the derived
// default for this app: a Redis cache, no spec.cache.keyPrefix, and no
// REDIS_KEY_PREFIX of the user's own.
func rendersDefaultRedisKeyPrefix(app *appsv1alpha1.NextApp) bool {
	return cacheIsRedis(app) && app.Spec.Cache.KeyPrefix == "" && !userSetsRedisKeyPrefix(app)
}

// defaultRedisKeyPrefixEnv returns the derived REDIS_KEY_PREFIX entry, or false
// when it is not rendered. It is appended AFTER the user's env and only when the
// user set no REDIS_KEY_PREFIX (rendersDefaultRedisKeyPrefix), so it is never a
// duplicate and never a reserved name (validation.ReservedOperatorEnvNames does
// not list it: admission keeps accepting a user-set REDIS_KEY_PREFIX while
// keyPrefix is unset).
func defaultRedisKeyPrefixEnv(app *appsv1alpha1.NextApp) (corev1.EnvVar, bool) {
	if !rendersDefaultRedisKeyPrefix(app) {
		return corev1.EnvVar{}, false
	}
	return corev1.EnvVar{Name: redisKeyPrefixEnvName, Value: defaultRedisKeyPrefix(app)}, true
}

// dropsEmptyUserRedisKeyPrefix reports whether spec.env[name] is an empty
// REDIS_KEY_PREFIX that the derived default replaces. appendUserEnv skips it so
// the pod gets one REDIS_KEY_PREFIX, the derived one, not a duplicate whose
// winner depends on kubelet's last-wins resolution.
func dropsEmptyUserRedisKeyPrefix(app *appsv1alpha1.NextApp, name string) bool {
	return name == redisKeyPrefixEnvName && app.Spec.Env[name] == "" && rendersDefaultRedisKeyPrefix(app)
}

// operatorRedisKeyPrefix is the keyspace the operator owns for this app: the
// explicit spec.cache.keyPrefix, or the derived default when it renders it.
// Empty when the operator owns none: no Redis cache, a user-set env prefix, or
// an explicit keyPrefix of the shared fallback "kn-next" or one nested under it
// such as "kn-next:cache" (other apps' keys live there too). The finalizer reaps
// exactly the keys that literally start with "<this keyspace>:" on delete.
func operatorRedisKeyPrefix(app *appsv1alpha1.NextApp) string {
	if !cacheIsRedis(app) {
		return ""
	}
	if isSharedRedisKeyspace(app.Spec.Cache.KeyPrefix) {
		return ""
	}
	if app.Spec.Cache.KeyPrefix != "" {
		return app.Spec.Cache.KeyPrefix
	}
	if rendersDefaultRedisKeyPrefix(app) {
		return defaultRedisKeyPrefix(app)
	}
	return ""
}
