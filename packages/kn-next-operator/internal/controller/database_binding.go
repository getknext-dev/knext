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
	"fmt"

	corev1 "k8s.io/api/core/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// DatabaseCleanupFinalizer is the LEGACY finalizer the removed managed
// scale-to-zero-Postgres mode (ADR-0018, now superseded by ADR-0025) added to
// NextApps that delegated a database. Managed provisioning has been removed for
// the engine-agnostic DB-scope decision, but live NextApps ever provisioned
// under the old operator still carry this string in metadata. The trimmed
// operator NEVER adds it anymore, yet it MUST still DRAIN it on delete for one
// release — a finalizer only clears when a controller removes it, so leaving it
// would wedge those CRs in Terminating forever. See cleanupDatabase (a no-op
// drain: it removes the finalizer, never re-provisions, never reaches
// cross-namespace).
const DatabaseCleanupFinalizer = "apps.kn-next.dev/db-cleanup"

// ConditionDatabaseReady surfaces the app's database binding on the NextApp. In
// BYO mode (spec.database.secretRef, ADR-0019) it is True/Bound once the Secret
// is wired into the env; it is removed when spec.database is absent. (Managed
// provisioning — the old hard-gate — was removed, ADR-0025.)
const ConditionDatabaseReady = "DatabaseReady"

// cleanupDatabase is the (now no-op) db-cleanup finalizer body. The managed
// AppDatabase teardown it once performed is gone (ADR-0025); this remains ONLY
// to DRAIN the legacy DatabaseCleanupFinalizer off any NextApp that still
// carries it (provisioned under the old managed operator), so deletion can
// complete. It provisions nothing and reaches no other namespace — the caller
// removes the finalizer once this returns nil.
func (r *NextAppReconciler) cleanupDatabase(_ context.Context, _ *appsv1alpha1.NextApp) error {
	return nil
}

// ADR-0019 — the BYO database binding: spec.database.secretRef / roSecretRef
// map an EXISTING same-namespace Secret onto DATABASE_URL / DATABASE_URL_RO.
// This is the ONLY database surface — managed provisioning was removed
// (ADR-0025). It is typed sugar over spec.secrets.envMap: the injection below
// mutates the IN-MEMORY envMap, so the existing envMap -> SecretKeyRef wiring
// (and its precedence/dedupe rules) is the single env mechanism. Deliberately
// NO provisioning, NO hard-gate, NO finalizer: the operator does not own the
// bound Secret's lifecycle, and a missing Secret surfaces exactly like a
// missing envMap Secret (CreateContainerConfigError on the pod).

// Default Secret keys for the BYO binding. secretRef defaults to DATABASE_URL
// and roSecretRef to DATABASE_URL_RO so a single Secret carrying both keys
// (the scale-zero-pg mirrored-Secret layout) binds with zero key configuration.
const (
	DefaultDatabaseURLKey   = "DATABASE_URL"
	DefaultDatabaseURLROKey = "DATABASE_URL_RO"
)

// databaseBound reports whether the BYO binding mode is configured. It is the
// only database mode (managed provisioning was removed, ADR-0025).
func databaseBound(app *appsv1alpha1.NextApp) bool {
	return app.Spec.Database != nil && app.Spec.Database.SecretRef != nil
}

// injectBoundDatabaseEnv extends the NextApp's IN-MEMORY spec.secrets.envMap
// with the bound DATABASE_URL (+ DATABASE_URL_RO) entries; it is never
// persisted. Admission rejects a CR that defines DATABASE_URL(_RO) in both
// spec.database and spec.secrets.envMap, but CRs that PREDATE those rules can
// still reach us with both (validation ratcheting) — the binding then wins
// LOUDLY: a Warning event names the ignored envMap entry (#186/#191 collision
// semantics), never a silent override.
func (r *NextAppReconciler) injectBoundDatabaseEnv(app *appsv1alpha1.NextApp) {
	db := app.Spec.Database
	if db == nil || db.SecretRef == nil {
		return
	}
	if app.Spec.Secrets == nil {
		app.Spec.Secrets = &appsv1alpha1.SecretsSpec{}
	}
	if app.Spec.Secrets.EnvMap == nil {
		app.Spec.Secrets.EnvMap = map[string]appsv1alpha1.EnvMapEntry{}
	}

	bind := func(envName string, ref *appsv1alpha1.DatabaseSecretRef, defaultKey string) {
		key := ref.Key
		if key == "" {
			key = defaultKey
		}
		r.warnDatabaseEnvOverride(app, envName)
		app.Spec.Secrets.EnvMap[envName] = appsv1alpha1.EnvMapEntry{
			SecretName: ref.Name, SecretKey: key,
		}
	}

	bind(DefaultDatabaseURLKey, db.SecretRef, DefaultDatabaseURLKey)
	if db.ROSecretRef != nil {
		bind(DefaultDatabaseURLROKey, db.ROSecretRef, DefaultDatabaseURLROKey)
	}
}

// warnDatabaseEnvOverride emits the #186/#191-style Warning when an author
// spec.secrets.envMap entry is about to be overridden by spec.database (either
// mode). Such CRs only exist through validation ratcheting — the webhook
// rejects NEW collisions — so the override must be loud, never silent.
func (r *NextAppReconciler) warnDatabaseEnvOverride(app *appsv1alpha1.NextApp, envName string) {
	if app.Spec.Secrets == nil || app.Spec.Secrets.EnvMap == nil {
		return
	}
	prev, exists := app.Spec.Secrets.EnvMap[envName]
	if !exists {
		return
	}
	r.emitEvent(app, corev1.EventTypeWarning, ReasonEnvVarIgnored,
		fmt.Sprintf("spec.secrets.envMap[%s] (secret %q key %q) ignored: %s is managed by spec.database",
			envName, prev.SecretName, prev.SecretKey, envName))
}
