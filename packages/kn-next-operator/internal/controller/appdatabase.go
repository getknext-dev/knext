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

// This file implements the unified-config flagship (ADR-0006, #119): a NextApp
// declares its database INLINE (spec.database) and the knext operator delegates
// the database lifecycle to the scale-zero-pg AppDatabase operator. The knext
// operator:
//
//  1. DERIVES a plane-globally-unique appName from the NextApp's own
//     (namespace, name) — never user-supplied (the security seam, §4.4).
//  2. Creates/owns an AppDatabase CR in the scale-zero-pg namespace.
//  3. HARD-GATES the app on the AppDatabase reaching status.phase == Ready
//     (§4.1) — no Knative Service until the DB is provisioned.
//  4. MIRRORS the minted app-db-<appName> Secret from scale-zero-pg into the
//     app's own namespace (k8s SecretKeyRef cannot cross namespaces), ownerRef'd
//     to the NextApp so it is GC'd with the app.
//  5. Injects DATABASE_URL (+ DATABASE_URL_RO when readReplicas) into the app
//     env by extending the existing spec.secrets.envMap wiring.
//  6. On NextApp delete, a finalizer deletes the AppDatabase CR (whose own
//     deprovision finalizer reclaims the Neon timeline) unless keepOnDelete.
//
// scale-zero-pg code is a READ-ONLY contract here — the AppDatabase is driven as
// an unstructured object against the documented external-driver API.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

const (
	// DatabaseCleanupFinalizer drives cross-namespace teardown of the delegated
	// AppDatabase (ADR-0006 §3c). ownerReferences cannot cross namespaces, so the
	// AppDatabase in scale-zero-pg cannot be GC'd by an ownerRef to the NextApp;
	// this finalizer deletes it explicitly on NextApp delete. Added only to
	// NextApps with spec.database.enabled; composes with ExternalCleanupFinalizer.
	DatabaseCleanupFinalizer = "apps.kn-next.dev/db-cleanup"

	// ConditionDatabaseReady surfaces the delegated database's readiness on the
	// NextApp. False+reason=Provisioning while the AppDatabase is not yet Ready
	// (the hard-gate); True once the DSN has been mirrored + injected.
	ConditionDatabaseReady = "DatabaseReady"

	// DefaultDatabaseNamespace is where AppDatabases and their app-db-<app>
	// Secrets live — the shared scale-zero-pg storage-plane namespace.
	DefaultDatabaseNamespace = "scale-zero-pg"

	// databaseSecretHashAnnotation stamps a checksum of the injected DATABASE_URL
	// onto the Knative Service pod template so a credential rotation in the source
	// Secret rolls a NEW Revision (pods read secretKeyRef at START only — a mirror
	// update alone does not restart them; ADR-0006 §4.3).
	databaseSecretHashAnnotation = "apps.kn-next.dev/db-secret-hash"

	// nextAppRefAnnotation back-references the owning NextApp on the (cross-ns)
	// AppDatabase, since an ownerRef cannot span namespaces. Value: "<ns>/<name>".
	nextAppRefAnnotation = "apps.kn-next.dev/nextapp"

	// databaseNotReadyRequeue bounds how often the hard-gate re-checks a
	// not-yet-Ready AppDatabase. cold tier reaches Ready in ~seconds, so this
	// rarely fires more than once or twice.
	databaseNotReadyRequeue = 5 * time.Second

	// databaseDeprovisionTimeout bounds the finalizer's wait for the AppDatabase
	// to disappear. Consistent with the external-cleanup bound: never wedge a
	// NextApp in Terminating on an external dependency (ADR-0006 §3c / §5).
	databaseDeprovisionTimeout = 30 * time.Second
)

// appDatabaseGVK is the scale-zero-pg AppDatabase API — driven as an unstructured
// external-driver contract (we do not import scale-zero-pg Go types).
var appDatabaseGVK = schema.GroupVersionKind{
	Group:   "apps.scale-zero-pg.dev",
	Version: "v1alpha1",
	Kind:    "AppDatabase",
}

// Event reasons specific to the delegated-database lifecycle.
const (
	// ReasonDatabaseProvisioning marks the hard-gate: the app is held back until
	// its AppDatabase reports Ready.
	ReasonDatabaseProvisioning = "DatabaseProvisioning"
	// ReasonDatabaseReady marks the DB provisioned + DSN wired.
	ReasonDatabaseReady = "DatabaseReady"
	// ReasonDatabaseCleanup marks a best-effort teardown outcome during finalize.
	ReasonDatabaseCleanup = "DatabaseCleanup"
)

// databaseWiring is the result of a database reconcile pass.
type databaseWiring struct {
	// ready is true only when the AppDatabase is Ready AND the DSN Secret has been
	// mirrored+ready to inject. false => the caller must hard-gate (skip ksvc).
	ready bool
	// phase is the observed AppDatabase.status.phase (for the status message).
	phase string
	// secretName is the same-namespace mirrored Secret carrying DATABASE_URL(_RO).
	secretName string
	// dsnHash is a checksum of DATABASE_URL, stamped on the pod template so a
	// rotation rolls a new Revision.
	dsnHash string
	// injectRO is true when readReplicas is requested AND the source Secret
	// actually carries a DATABASE_URL_RO key (tolerated-absent until scale-zero-pg
	// emits it — the appdb-api lane's in-flight work).
	injectRO bool
}

// databaseEnabled reports whether inline provisioning is on for this NextApp.
func databaseEnabled(app *appsv1alpha1.NextApp) bool {
	return app.Spec.Database != nil && app.Spec.Database.Enabled
}

// databaseNamespace returns the namespace the AppDatabase + its Secret live in,
// defaulting to scale-zero-pg when the reconciler field is unset.
func (r *NextAppReconciler) databaseNamespace() string {
	if r.DatabaseNamespace != "" {
		return r.DatabaseNamespace
	}
	return DefaultDatabaseNamespace
}

// deriveAppName derives the plane-globally-unique, RFC1123, ≤63-char appName for
// a NextApp's delegated database (ADR-0006 §4.4). It is the load-bearing security
// seam: appName is derived from the NextApp's OWN (namespace, name), so a NextApp
// can only ever create/bind the AppDatabase minted for its own identity — never
// an arbitrary DB in another namespace.
//
// Rules:
//   - base = sanitize(lowercase("<namespace>-<name>")) to the RFC1123 label set.
//   - if base fits (≤63) and is not reserved => use it.
//   - otherwise a deterministic namespace-qualified short hash is appended to a
//     truncated prefix, so distinct identities that would collide on truncation
//     stay distinct AND the mapping is stable (same identity → same appName).
//
// The hash input is the RAW "<namespace>/<name>" (not the sanitized base) so two
// different identities that sanitize to the same base still get different hashes.
func deriveAppName(namespace, name string) string {
	base := sanitizeDNS1123Label(strings.ToLower(namespace + "-" + name))

	if len(base) <= 63 && base != "" && !isReservedAppName(base) {
		return base
	}

	sum := sha256.Sum256([]byte(namespace + "/" + name))
	hash := hex.EncodeToString(sum[:])[:8]

	// Reserve room for "-<hash>".
	prefixMax := 63 - 1 - len(hash)
	prefix := base
	if len(prefix) > prefixMax {
		prefix = prefix[:prefixMax]
	}
	prefix = strings.Trim(prefix, "-")
	if prefix == "" {
		// Degenerate base (all-invalid chars): anchor on a stable letter so the
		// result still starts alphanumeric.
		prefix = "app"
	}
	return prefix + "-" + hash
}

// sanitizeDNS1123Label coerces s into the RFC1123 label alphabet the AppDatabase
// CRD requires (^[a-z0-9]([a-z0-9-]*[a-z0-9])?$): any char outside [a-z0-9-]
// becomes '-', runs are collapsed, and leading/trailing '-' are trimmed.
func sanitizeDNS1123Label(s string) string {
	var b strings.Builder
	prevDash := false
	for _, c := range s {
		switch {
		case (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'):
			b.WriteRune(c)
			prevDash = false
		default:
			if !prevDash {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}

// isReservedAppName rejects the appNames scale-zero-pg reserves for its shared
// template / warm / read-only computes. The "<ns>-<name>" derivation practically
// never hits these (it always contains a hyphen joining two non-empty labels),
// but we guard defensively so a pathological identity can never claim one.
func isReservedAppName(name string) bool {
	switch name {
	case "tmpl", "warm", "ro":
		return true
	}
	return false
}

// newAppDatabase returns an unstructured AppDatabase handle (GVK + name + ns set)
// for CRUD against the scale-zero-pg external-driver API.
func newAppDatabase(name, namespace string) *unstructured.Unstructured {
	u := &unstructured.Unstructured{}
	u.SetGroupVersionKind(appDatabaseGVK)
	u.SetName(name)
	u.SetNamespace(namespace)
	return u
}

// buildAppDatabaseSpec renders the AppDatabase.spec map from the NextApp's
// spec.database. appName is DERIVED (never from the user). Ints are int64 as
// required by unstructured. Only the author-relevant subset is surfaced; the rest
// is defaulted by the AppDatabase CRD.
func buildAppDatabaseSpec(app *appsv1alpha1.NextApp, appName string) map[string]interface{} {
	db := app.Spec.Database
	spec := map[string]interface{}{
		"appName":              appName,
		"keepTimelineOnDelete": db.KeepOnDelete,
	}
	if db.Tier != "" {
		spec["tier"] = db.Tier
	}
	if db.Quotas != nil {
		q := map[string]interface{}{}
		if db.Quotas.CPU != "" {
			q["cpu"] = db.Quotas.CPU
		}
		if db.Quotas.CPURequest != "" {
			q["cpuRequest"] = db.Quotas.CPURequest
		}
		if db.Quotas.Mem != "" {
			q["mem"] = db.Quotas.Mem
		}
		if db.Quotas.MemRequest != "" {
			q["memRequest"] = db.Quotas.MemRequest
		}
		if db.Quotas.MaxConnections > 0 {
			q["maxConnections"] = int64(db.Quotas.MaxConnections)
		}
		if len(q) > 0 {
			spec["quotas"] = q
		}
	}
	if db.ReadReplicas {
		spec["roPool"] = map[string]interface{}{"enabled": true}
	}
	return spec
}

// reconcileDatabase drives the delegated-database pass for a NextApp with
// spec.database.enabled. It creates/updates the AppDatabase, hard-gates on Ready,
// and (when Ready) mirrors the DSN Secret. It records the derived appName +
// mirrored Secret name on status for auditability. The caller injects the env
// wiring and gates ksvc creation on wiring.ready.
func (r *NextAppReconciler) reconcileDatabase(ctx context.Context, app *appsv1alpha1.NextApp) (databaseWiring, ctrl.Result, error) {
	logger := logf.FromContext(ctx)

	appName := deriveAppName(app.Namespace, app.Name)
	app.Status.DatabaseAppName = appName

	adb := newAppDatabase(appName, r.databaseNamespace())
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, adb, func() error {
		// Cross-ns: NO ownerRef (cannot span namespaces). Back-reference via
		// annotation/labels so teardown + orphan reclaim can find the owner.
		annotations := adb.GetAnnotations()
		if annotations == nil {
			annotations = map[string]string{}
		}
		annotations[nextAppRefAnnotation] = app.Namespace + "/" + app.Name
		adb.SetAnnotations(annotations)

		labels := adb.GetLabels()
		if labels == nil {
			labels = map[string]string{}
		}
		labels["app.kubernetes.io/managed-by"] = "kn-next-operator"
		labels["apps.kn-next.dev/nextapp-namespace"] = app.Namespace
		adb.SetLabels(labels)

		adb.Object["spec"] = buildAppDatabaseSpec(app, appName)
		return nil
	})
	if err != nil {
		return databaseWiring{}, ctrl.Result{}, fmt.Errorf("reconcile AppDatabase %q in %s: %w",
			appName, r.databaseNamespace(), err)
	}

	phase, _, _ := unstructured.NestedString(adb.Object, "status", "phase")
	if phase != "Ready" {
		// HARD-GATE (§4.1): the app does not deploy until the DB is Ready.
		logger.Info("Database not yet Ready; gating app deploy",
			"appName", appName, "phase", phase)
		return databaseWiring{ready: false, phase: phase}, ctrl.Result{RequeueAfter: databaseNotReadyRequeue}, nil
	}

	secretName, dsnHash, hasRO, err := r.mirrorDatabaseSecret(ctx, app, appName)
	if err != nil {
		// The AppDatabase is Ready but its Secret is not yet readable (eventual
		// consistency, or the scoped RBAC has not propagated). Gate + requeue
		// rather than deploy an app that would crash-loop on a missing DSN.
		logger.Info("Database Ready but DSN Secret not yet available; gating",
			"appName", appName, "error", err.Error())
		return databaseWiring{ready: false, phase: phase}, ctrl.Result{RequeueAfter: databaseNotReadyRequeue}, nil
	}
	app.Status.DatabaseSecretName = secretName

	return databaseWiring{
		ready:      true,
		phase:      phase,
		secretName: secretName,
		dsnHash:    dsnHash,
		injectRO:   app.Spec.Database.ReadReplicas && hasRO,
	}, ctrl.Result{}, nil
}

// mirrorDatabaseSecret reads the minted app-db-<appName> Secret from the
// scale-zero-pg namespace and writes a same-namespace copy (<name>-db) into the
// app's namespace, ownerRef'd to the NextApp (same-ns ownerRef → clean k8s GC).
// Returns the mirrored Secret name, a checksum of DATABASE_URL (for the
// rotation-roll annotation), and whether a DATABASE_URL_RO key was present.
func (r *NextAppReconciler) mirrorDatabaseSecret(ctx context.Context, app *appsv1alpha1.NextApp, appName string) (string, string, bool, error) {
	srcName := "app-db-" + appName
	var src corev1.Secret
	if err := r.Get(ctx, types.NamespacedName{Namespace: r.databaseNamespace(), Name: srcName}, &src); err != nil {
		return "", "", false, fmt.Errorf("read source DSN Secret %s/%s: %w", r.databaseNamespace(), srcName, err)
	}

	mirroredName := app.Name + "-db"
	mirror := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: mirroredName, Namespace: app.Namespace},
	}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, mirror, func() error {
		if mirror.Labels == nil {
			mirror.Labels = map[string]string{}
		}
		mirror.Labels["app"] = app.Name
		mirror.Labels["generated-by"] = "kn-next-operator"
		mirror.Labels["apps.kn-next.dev/mirrored-from"] = srcName
		// Copy every key verbatim (DATABASE_URL, PGUSER, PGPASSWORD, APP_ROLE_MD5,
		// and DATABASE_URL_RO once scale-zero-pg emits it).
		mirror.Data = make(map[string][]byte, len(src.Data))
		for k, v := range src.Data {
			cp := make([]byte, len(v))
			copy(cp, v)
			mirror.Data[k] = cp
		}
		// Same-namespace ownerRef → the mirror is GC'd when the NextApp is deleted.
		return ctrl.SetControllerReference(app, mirror, r.Scheme)
	})
	if err != nil {
		return "", "", false, fmt.Errorf("mirror DSN Secret into %s/%s: %w", app.Namespace, mirroredName, err)
	}

	var dsnHash string
	if dsn, ok := src.Data["DATABASE_URL"]; ok {
		sum := sha256.Sum256(dsn)
		dsnHash = hex.EncodeToString(sum[:])[:16]
	}
	_, hasRO := src.Data["DATABASE_URL_RO"]
	return mirroredName, dsnHash, hasRO, nil
}

// injectDatabaseEnv extends the NextApp's in-memory spec.secrets.envMap with the
// DATABASE_URL (+ DATABASE_URL_RO when requested+present) entries pointing at the
// mirrored Secret. Mutating the in-memory spec reuses the reconciler's existing
// envMap → SecretKeyRef wiring; it is never persisted (only status is written).
// Any operator-injected entry overrides a same-named author entry so the two
// cannot conflict.
func injectDatabaseEnv(app *appsv1alpha1.NextApp, wiring databaseWiring) {
	if app.Spec.Secrets == nil {
		app.Spec.Secrets = &appsv1alpha1.SecretsSpec{}
	}
	if app.Spec.Secrets.EnvMap == nil {
		app.Spec.Secrets.EnvMap = map[string]appsv1alpha1.EnvMapEntry{}
	}
	app.Spec.Secrets.EnvMap["DATABASE_URL"] = appsv1alpha1.EnvMapEntry{
		SecretName: wiring.secretName, SecretKey: "DATABASE_URL",
	}
	if wiring.injectRO {
		app.Spec.Secrets.EnvMap["DATABASE_URL_RO"] = appsv1alpha1.EnvMapEntry{
			SecretName: wiring.secretName, SecretKey: "DATABASE_URL_RO",
		}
	}
}

// cleanupDatabase is the db-cleanup finalizer body (ADR-0006 §3c). It deletes the
// delegated AppDatabase in scale-zero-pg (whose own deprovision finalizer runs
// the safe two-sided Neon timeline reclaim) unless keepOnDelete. The mirrored
// Secret is GC'd automatically by its same-ns ownerRef. Best-effort + bounded:
// if scale-zero-pg is unreachable it records a Warning and returns nil so the
// NextApp never wedges in Terminating on an external dependency (§5 named
// trade-off — backstopped by scale-zero-pg's reclaim-orphans).
func (r *NextAppReconciler) cleanupDatabase(ctx context.Context, app *appsv1alpha1.NextApp) error {
	logger := logf.FromContext(ctx)

	appName := app.Status.DatabaseAppName
	if appName == "" {
		// Never recorded (e.g. the app was never Ready) — derive it so we still
		// attempt teardown of any AppDatabase that was created.
		appName = deriveAppName(app.Namespace, app.Name)
	}

	if app.Spec.Database != nil && app.Spec.Database.KeepOnDelete {
		logger.Info("keepOnDelete set; retaining AppDatabase + Neon timeline", "appName", appName)
		r.emitEvent(app, corev1.EventTypeNormal, ReasonDatabaseCleanup,
			fmt.Sprintf("Retaining database %q (keepOnDelete=true)", appName))
		return nil
	}

	ctx, cancel := context.WithTimeout(ctx, databaseDeprovisionTimeout)
	defer cancel()

	adb := newAppDatabase(appName, r.databaseNamespace())
	if err := r.Delete(ctx, adb); err != nil {
		if errors.IsNotFound(err) {
			// Already gone — teardown complete.
			return nil
		}
		// Unreachable / RBAC denied: best-effort. Warn + proceed (do not wedge).
		logger.Error(err, "AppDatabase delete failed; proceeding with NextApp teardown (best-effort)",
			"appName", appName)
		r.emitEvent(app, corev1.EventTypeWarning, ReasonDatabaseCleanup,
			fmt.Sprintf("AppDatabase %q delete failed (best-effort, proceeding): %s", appName, err.Error()))
		return nil
	}

	logger.Info("Requested AppDatabase deprovision", "appName", appName)
	r.emitEvent(app, corev1.EventTypeNormal, ReasonDatabaseCleanup,
		fmt.Sprintf("Deleted AppDatabase %q (Neon timeline reclaim runs via its deprovision finalizer)", appName))
	return nil
}
