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
	"fmt"
	"sort"
	"strconv"

	corev1 "k8s.io/api/core/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/validation"
)

// envMapCollisionReport records the two GRANDFATHERED resolution outcomes
// buildKsvcEnv can produce for a spec.secrets.envMap entry that collides with
// an operator-managed reserved env name (#1391 — admission REJECTS any NEW
// such collision; this only fires for a CR that predates that rule). Zero
// value = no collision.
type envMapCollisionReport struct {
	// operatorWins is the sorted set of collision names where the operator's
	// own value was kept and the envMap entry dropped —
	// validation.OperatorAlwaysWinsEnvNames (currently only HOSTNAME).
	operatorWins []string
	// userWinsGrandfathered is the sorted set of collision names — EXCLUDING
	// validation.EnvMapUserAlwaysWinsEnvNames — where the envMap value
	// REPLACED the operator's own entry in place, preserving the value the
	// app was actually getting before #1288 shipped (kubelet's real
	// last-wins duplicate-env semantics already favored the later-appended
	// envMap entry there). Reaching this for a NEW CR is impossible —
	// admission rejects it — so every name here means the CR predates that
	// rule, or reconciled while the validating webhook was unavailable: a
	// real, alarm-worthy collision (#1391 round 3).
	userWinsGrandfathered []string
	// userWinsExempt is the sorted set of collision names IN
	// validation.EnvMapUserAlwaysWinsEnvNames (REDIS_URL, KAFKA_BROKER_URL,
	// OTEL_EXPORTER_OTLP_ENDPOINT) where the envMap value replaced the
	// operator's own entry. This is the DOCUMENTED, expected pattern — these
	// names have no typed `*SecretRef` CRD field yet, so envMap is the
	// sanctioned way to source them from a Secret — never rejected at
	// admission, on any CR. Kept separate from userWinsGrandfathered so the
	// status verdict can treat a report that ONLY contains exempt names as
	// informational (Normal event) rather than an alarm (#1391 round 3: users
	// must not learn to ignore Warnings because the documented pattern keeps
	// firing one).
	userWinsExempt []string
}

func (r envMapCollisionReport) empty() bool {
	return len(r.operatorWins) == 0 && len(r.userWinsGrandfathered) == 0 && len(r.userWinsExempt) == 0
}

// buildKsvcEnv assembles the container env (operator-managed system env,
// storage/cache/revalidation/observability wiring, then the Secret-backed
// envFrom/envMap entries) and finishes with the spec.env merge. Moved VERBATIM
// out of buildDesiredKsvc (#254 companion move) — behavior-preserving; the env
// ordering is part of the rendered-output characterization (spec_env_test.go).
//
// The third return value reports any spec.secrets.envMap entry that collides
// with an operator-injected system env var — see the envMap loop below for
// resolution. Reconcile threads it into computeStatusVerdict, which owns the
// EnvMapCollision condition + Warning event (#1288/#1391; architecture.md:
// new honest-status conditions/events go in computeStatusVerdict, never as
// new branches in Reconcile).
func (r *NextAppReconciler) buildKsvcEnv(nextApp *appsv1alpha1.NextApp) ([]corev1.EnvVar, []corev1.EnvFromSource, envMapCollisionReport) {
	var envVars []corev1.EnvVar
	// HOSTNAME=0.0.0.0 overrides kubelet's HOSTNAME=<pod-name> so a bare
	// `next start`/server.js entrypoint binds all interfaces instead of the
	// pod IP only (Knative's queue-proxy dials 127.0.0.1:USER_PORT).
	// Verified benign for middleware rewrites (#178): with 0.0.0.0 the
	// router initUrl and the middleware-visible origin match. The knext
	// runtime entry (node-server.ts buildChildEnv) now additionally empties
	// HOSTNAME for its spawned standalone child, making this injection moot
	// there — kept as defense-in-depth for custom images that run server.js
	// directly. Do NOT change this to a loopback IP or hostname.
	//
	// Pod identity for tracing (#184): this override clobbers kubelet's
	// HOSTNAME=<pod-name>, and we can NOT restore it via the downward API —
	// valueFrom.fieldRef in ksvc env is feature-gated on stock Knative
	// (`kubernetes.podspec-fieldref`, Disabled by default: serving
	// pkg/apis/config/features.go; the validation webhook rejects the
	// Service via EnvVarSourceMask, k8s_validation.go). Requiring a
	// cluster-wide config-features edit is not acceptable for a default
	// path. Instead the knext runtime (buildChildEnv) recovers the pod
	// name from the KERNEL hostname (os.hostname() — kubelet sets the
	// pod's OS hostname to the pod name; this env override does not touch
	// it) and exports it as KNEXT_POD_NAME → otel host.name. Do NOT add a
	// fieldRef env here; it would break deploys on stock Knative.
	envVars = append(envVars, corev1.EnvVar{Name: lcHOSTNAME, Value: "0.0.0.0"})
	envVars = append(envVars, corev1.EnvVar{Name: "NODE_ENV", Value: "production"})

	// KNEXT_DB_POOL_MAX (#378, W3, ADR-0029): close the declared-vs-runtime
	// poolMax drift the W2 system-designer flagged. ADR-0028 made
	// spec.scaling.poolMax a VALIDATION-only field — the operator gates
	// maxScale × poolMax ≤ 80 at admission, but the app was never TOLD its
	// per-pod cap, so @getknext/lib's pg Pool could open more than poolMax
	// connections/pod and blow the budget at runtime. We inject the declared
	// cap so getDbPool() enforces the same number the operator gated. Only
	// injected when poolMax is DECLARED (>0): an undeclared poolMax is the
	// documented-only wall (ADR-0028 §3), so no env is stamped — back-compat
	// for every CR that never set poolMax (it keeps its DB_POOL_MAX default).
	if nextApp.Spec.Scaling != nil && nextApp.Spec.Scaling.PoolMax > 0 {
		envVars = append(envVars, corev1.EnvVar{
			Name:  "KNEXT_DB_POOL_MAX",
			Value: strconv.Itoa(int(nextApp.Spec.Scaling.PoolMax)),
		})
	}

	if nextApp.Spec.Storage != nil && nextApp.Spec.Storage.Provider != "" {
		envVars = append(envVars, corev1.EnvVar{Name: "STORAGE_PROVIDER", Value: nextApp.Spec.Storage.Provider})
		envVars = append(envVars, corev1.EnvVar{Name: "GCS_BUCKET_NAME", Value: nextApp.Spec.Storage.Bucket})
		// S3/MinIO provider fields — aligned with CLI knative-manifest.ts storageEnvVarGenerators
		if nextApp.Spec.Storage.Region != "" {
			envVars = append(envVars, corev1.EnvVar{Name: "CACHE_BUCKET_REGION", Value: nextApp.Spec.Storage.Region})
		}
		if nextApp.Spec.Storage.Endpoint != "" {
			envVars = append(envVars, corev1.EnvVar{Name: "S3_ENDPOINT", Value: nextApp.Spec.Storage.Endpoint})
		}
	}
	if nextApp.Spec.Cache != nil && nextApp.Spec.Cache.Provider != "" {
		envVars = append(envVars, corev1.EnvVar{Name: "CACHE_PROVIDER", Value: nextApp.Spec.Cache.Provider})
		envVars = append(envVars, corev1.EnvVar{Name: "REDIS_URL", Value: nextApp.Spec.Cache.URL})
		if nextApp.Spec.Cache.KeyPrefix != "" {
			envVars = append(envVars, corev1.EnvVar{Name: "REDIS_KEY_PREFIX", Value: nextApp.Spec.Cache.KeyPrefix})
		}
	}
	// The operator injects NO code-cache env vars. NODE_COMPILE_CACHE and
	// BUN_RUNTIME_TRANSPILER_CACHE_PATH used to be set here alongside a PVC; both
	// are gone with it (ADR-0035). The V8 compile cache is baked into the image at
	// build time, and an operator-injected NODE_COMPILE_CACHE would BYPASS that
	// baked layer — which is what the runtime shadow-warning (#450) existed to
	// detect. Removing the injection removes the thing being warned about.
	//
	// Do not reintroduce either variable here. A compiled bun-exec image
	// (`bun build --compile --bytecode`) embeds its bytecode and transpiles nothing
	// at runtime, so both would be inert while still costing a volume.
	if nextApp.Spec.Revalidation != nil && nextApp.Spec.Revalidation.Queue != "" {
		envVars = append(envVars, corev1.EnvVar{Name: "KAFKA_BROKER_URL", Value: nextApp.Spec.Revalidation.KafkaBrokerUrl})
		envVars = append(envVars, corev1.EnvVar{Name: "KAFKA_REVALIDATION_TOPIC", Value: fmt.Sprintf("%s-revalidation", nextApp.Name)})
	}

	// Observability env vars — aligned with CLI
	if nextApp.Spec.Observability != nil && nextApp.Spec.Observability.Enabled {
		envVars = append(envVars, corev1.EnvVar{Name: "KN_APP_NAME", Value: nextApp.Name})

		// RUM (#94): activate the client Web Vitals beacon. NEXT_PUBLIC_*
		// vars are baked into the client bundle so the reporter no-ops
		// unless enabled here. Default OFF (only set when Rum.Enabled).
		if rum := nextApp.Spec.Observability.Rum; rum != nil && rum.Enabled {
			envVars = append(envVars, corev1.EnvVar{Name: "NEXT_PUBLIC_RUM_ENABLED", Value: lcTrue})
			if rum.SampleRate != "" {
				envVars = append(envVars, corev1.EnvVar{Name: "NEXT_PUBLIC_RUM_SAMPLE_RATE", Value: rum.SampleRate})
			}
		}

		// Tracing (#30): server-side OTel. Default OFF — only set
		// OTEL_TRACING_ENABLED when Tracing.Enabled, so unconfigured apps
		// initialize no exporter (the runtime hook returns null). The
		// endpoint/sampler args are passed through only when set; the runtime
		// applies a cluster-local default endpoint otherwise (ADR-0012).
		if tracing := nextApp.Spec.Observability.Tracing; tracing != nil && tracing.Enabled {
			envVars = append(envVars, corev1.EnvVar{Name: "OTEL_TRACING_ENABLED", Value: lcTrue})
			if tracing.Endpoint != "" {
				envVars = append(envVars, corev1.EnvVar{Name: "OTEL_EXPORTER_OTLP_ENDPOINT", Value: tracing.Endpoint})
			}
			if tracing.SampleRate != "" {
				envVars = append(envVars, corev1.EnvVar{Name: "OTEL_TRACES_SAMPLER_ARG", Value: tracing.SampleRate})
			}
		}
	}

	// spec.cdn -> KNEXT_CDN_* (ADR-0068). Operator-managed like the rest of this
	// block, so a spec.secrets.envMap entry of the same name can never replace it.
	envVars = append(envVars, cdnEnvVars(nextApp)...)

	var envFrom []corev1.EnvFromSource
	if nextApp.Spec.Secrets != nil {
		// envFrom: inject entire secrets as env vars
		for _, secretName := range nextApp.Spec.Secrets.EnvFrom {
			envFrom = append(envFrom, corev1.EnvFromSource{
				SecretRef: &corev1.SecretEnvSource{
					LocalObjectReference: corev1.LocalObjectReference{Name: secretName},
				},
			})
		}
		// envMap: map specific secret keys to env var names — aligned with CLI
		// Iterate in sorted key order: ranging the map directly reorders the env
		// list on every reconcile, which changes the revision template and makes
		// Knative cut a new revision each time.
		envNames := make([]string, 0, len(nextApp.Spec.Secrets.EnvMap))
		for envName := range nextApp.Spec.Secrets.EnvMap {
			envNames = append(envNames, envName)
		}
		sort.Strings(envNames)

		// #1288/#1391: a name already claimed by operator-injected system env
		// (HOSTNAME, NODE_ENV, STORAGE_PROVIDER, ...) must never be appended
		// a SECOND time. Before #1288 it silently was — Kubernetes/kubelet
		// applies later entries LAST-WINS, so which value actually reached
		// the container depended on append order, an implementation detail
		// no user should have had to reason about, with no Warning naming
		// what happened. Admission now REJECTS any NEW such collision
		// (validation.EnvMapReservedCollisions), so reaching this branch
		// means the CR predates that rule (ratcheting). Snapshotted BEFORE
		// this loop appends anything, so envMap entries can never collide
		// with each other, only with the operator-managed env built above.
		reservedByOperator := make(map[string]struct{}, len(envVars))
		reservedIndex := make(map[string]int, len(envVars))
		for i, ev := range envVars {
			reservedByOperator[ev.Name] = struct{}{}
			reservedIndex[ev.Name] = i
		}
		var report envMapCollisionReport
		for _, envName := range envNames {
			entry := nextApp.Spec.Secrets.EnvMap[envName]
			fromSecret := corev1.EnvVar{
				Name: envName,
				ValueFrom: &corev1.EnvVarSource{
					SecretKeyRef: &corev1.SecretKeySelector{
						LocalObjectReference: corev1.LocalObjectReference{Name: entry.SecretName},
						Key:                  entry.SecretKey,
					},
				},
			}
			if isReservedCDNEnvName(envName) {
				// The KNEXT_CDN_* namespace is reserved unconditionally (ADR-0068 D3):
				// admission rejects the entry, so reaching here means the CR predates
				// that rule. The entry is dropped whether or not the operator renders
				// that name for this app, so a CR cannot choose its own tag prefix,
				// endpoint or token. Reported by the CDNReservedEnvIgnored condition
				// (computeStatusVerdict), not as an EnvMapCollision.
				continue
			}
			if _, collides := reservedByOperator[envName]; collides {
				if _, operatorAlwaysWins := validation.OperatorAlwaysWinsEnvNames[envName]; operatorAlwaysWins {
					// HOSTNAME-class: the operator's own plain entry stays;
					// the envMap entry is dropped outright — correctness
					// (queue-proxy routing), not just precedence, depends on
					// the operator's value.
					report.operatorWins = append(report.operatorWins, envName)
					continue
				}
				// Every other reserved name (whether the collision predates
				// admission rejection, reached us while the webhook was
				// unavailable, or is an always-exempt connection-string name
				// — validation.EnvMapUserAlwaysWinsEnvNames): the envMap
				// value REPLACES the operator's plain entry IN PLACE
				// — deterministic, never an appended duplicate whose winner
				// depends on kubelet's last-wins resolution (the pre-#1288
				// bug). This is also the value that actually reached the
				// container before #1288 shipped (the operator's own entry
				// was built FIRST, so the later envMap append used to win
				// under kubelet's real last-wins semantics) — flipping it to
				// "operator wins" for an existing CR would be an
				// undocumented breaking change on upgrade (e.g. a bound
				// REDIS_URL Secret silently replaced by an empty default).
				envVars[reservedIndex[envName]] = fromSecret
				if _, exempt := validation.EnvMapUserAlwaysWinsEnvNames[envName]; exempt {
					// The documented pattern, not a real collision — kept
					// out of userWinsGrandfathered so computeStatusVerdict
					// can report it as informational (#1391 round 3).
					report.userWinsExempt = append(report.userWinsExempt, envName)
				} else {
					report.userWinsGrandfathered = append(report.userWinsGrandfathered, envName)
				}
				continue
			}
			envVars = append(envVars, fromSecret)
		}
		return r.appendUserEnv(nextApp, envVars), envFrom, report
	}

	return r.appendUserEnv(nextApp, envVars), envFrom, envMapCollisionReport{}
}

// appendUserEnv merges spec.env (#186) into the assembled env. Moved VERBATIM
// out of buildDesiredKsvc (#254 companion move).
func (r *NextAppReconciler) appendUserEnv(nextApp *appsv1alpha1.NextApp, envVars []corev1.EnvVar) []corev1.EnvVar {
	// spec.env (#186): plain NON-SECRET name/value config flags. Appended
	// LAST and de-duplicated so it can never override operator-injected
	// system env (HOSTNAME/NODE_ENV/... — the #178/#184 hazard) or a
	// Secret-backed envMap entry; a colliding name is dropped WITH a
	// Warning event naming the authoritative source (never silently).
	// Reserved names (HOSTNAME, PORT, K_*) are additionally rejected at
	// admission by CRD CEL validation. Sorted for deterministic reconcile
	// output. NOTE: secrets.envFrom collisions cannot be detected here —
	// the referenced Secrets' keys are invisible at reconcile time and
	// kubelet applies envFrom BEFORE env, so a spec.env name matching a
	// key inside an envFrom Secret shadows it at runtime (documented user
	// responsibility, docs/operator/crd-nextapp.md).
	if len(nextApp.Spec.Env) > 0 {
		// name → authoritative source, for the Warning message. Entries
		// with ValueFrom are the spec.secrets.envMap Secret mappings; all
		// plain-Value entries before this point are operator-managed.
		taken := make(map[string]string, len(envVars))
		for _, ev := range envVars {
			if ev.ValueFrom != nil {
				taken[ev.Name] = "spec.secrets.envMap"
			} else {
				taken[ev.Name] = "operator-managed system env"
			}
		}
		names := make([]string, 0, len(nextApp.Spec.Env))
		for name := range nextApp.Spec.Env {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			if dropsEmptyUserRedisKeyPrefix(nextApp, name) {
				// An empty REDIS_KEY_PREFIX is unset: the derived default
				// appended below takes its place (no Warning: nothing the
				// user set is overridden).
				continue
			}
			if isReservedCDNEnvName(name) {
				r.emitEvent(nextApp, corev1.EventTypeWarning, ReasonEnvVarIgnored,
					fmt.Sprintf("spec.env[%s] ignored: the %s* namespace is reserved by the operator (set spec.cdn instead)",
						name, appsv1alpha1.CDNEnvPrefix))
				continue
			}
			if source, exists := taken[name]; exists {
				r.emitEvent(nextApp, corev1.EventTypeWarning, ReasonEnvVarIgnored,
					fmt.Sprintf("spec.env[%s] ignored: name is reserved/managed by %s", name, source))
				continue
			}
			envVars = append(envVars, corev1.EnvVar{Name: name, Value: nextApp.Spec.Env[name]})
		}
	}

	// The derived per-app REDIS_KEY_PREFIX for a Redis cache with no
	// spec.cache.keyPrefix. Not rendered when spec.env / envMap set one, so a
	// user-set REDIS_KEY_PREFIX keeps winning, with no ignored-env Warning and
	// no duplicate entry (see defaultRedisKeyPrefixEnv).
	if ev, ok := defaultRedisKeyPrefixEnv(nextApp); ok {
		envVars = append(envVars, ev)
	}

	// spec.networking.publicHosts -> KNEXT_PUBLIC_ORIGINS. Rendered AFTER the
	// user's spec.env / envMap entries are in place so a user-set value of the
	// same name wins (see publicOriginsEnv), with no ignored-env Warning and no
	// duplicate entry.
	if ev, ok := publicOriginsEnv(nextApp, envVars); ok {
		envVars = append(envVars, ev)
	}

	return envVars
}
