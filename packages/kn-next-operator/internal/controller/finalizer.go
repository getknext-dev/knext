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
	"time"

	corev1 "k8s.io/api/core/v1"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// ExternalCleanupFinalizer is the finalizer placed on every NextApp so the
// operator can clear the app's EXTERNAL state (object-store prefix + Redis
// keyspace) before Kubernetes garbage-collects the object. Owned in-cluster
// children (ksvc / ServiceAccount / PVC) are removed by ownerRef GC and need no
// finalizer — this finalizer exists ONLY for state that lives outside the
// cluster and therefore has no ownerRef.
const ExternalCleanupFinalizer = "apps.kn-next.dev/external-cleanup"

// externalCleanupTimeout bounds the whole external-cleanup attempt. External
// stores (S3/GCS/Redis) live outside the cluster and may be unreachable; we
// MUST NOT wedge a CR in `Terminating` waiting on them. After this bound the
// routine gives up, records a Warning, and lets the finalizer be removed
// (best-effort cleanup — see cleanupExternalState).
const externalCleanupTimeout = 30 * time.Second

// StorageTarget describes the SINGLE object-store prefix to delete for one app.
// Prefix is always non-empty and namespaced to the app — the cleaner must never
// be asked for a bucket-wide or wildcard delete.
type StorageTarget struct {
	Provider string
	Bucket   string
	Region   string
	Endpoint string
	// Prefix is the app-scoped key namespace inside Bucket (e.g. "shop/").
	// CROSS-APP SAFETY: deletes are restricted to keys under this prefix; a
	// sibling app/zone in the same bucket is never touched.
	Prefix string
}

// CacheTarget describes the SINGLE Redis keyspace to delete for one app.
type CacheTarget struct {
	Provider string
	URL      string
	// KeyPrefix scopes the delete to this app's keys (SCAN MATCH "<KeyPrefix>:*"
	// + DEL in batches). CROSS-APP SAFETY: never FLUSHDB, never another app's
	// prefix.
	KeyPrefix string
}

// ExternalCleaner abstracts the object-store and cache so the finalizer logic is
// unit-testable with fakes (assert the EXACT scoped delete, assert a sibling
// prefix is never touched) and the real client wiring can evolve independently.
type ExternalCleaner interface {
	// CleanupStorage deletes only the object-store keys under s.Prefix in
	// s.Bucket. Returns an error if the store is unreachable; the caller treats
	// that error as best-effort (logs + proceeds).
	CleanupStorage(ctx context.Context, s StorageTarget) error
	// CleanupCache deletes only the Redis keys under c.KeyPrefix.
	CleanupCache(ctx context.Context, c CacheTarget) error
}

// appStoragePrefix derives the app-scoped object-store key namespace. It MUST be
// non-empty so a delete can never degrade to a bucket-wide wipe. The app name is
// a DNS-1123 label (k8s-validated), safe to use as a prefix segment.
//
// CONTRACT (#74): this MUST stay in lock-step with the CLI uploader's
// `appKeyPrefix()` (packages/kn-next/src/utils/asset-upload.ts), which uploads
// every asset under `<name>/...` and serves it via `assetPrefix=<publicUrl>/<name>`.
// If the two diverge, storage cleanup silently deletes nothing (the original
// #74 bug: uploads went to the bucket root, so this `<name>/` prefix matched no
// keys). The shared key scheme is: object key == `<app.Name>/` + relative asset
// path (e.g. `shop/_next/static/chunks/main.js`).
//
// AUTHORITY SPLIT (#93, ADR-0011): this `<app>/` prefix delete is TEARDOWN-ONLY —
// it runs solely from the deletion finalizer when the whole NextApp is removed.
// It is NOT, and must never become, a deploy-time prune. Build-id retention
// (reaping old `<app>/_next/static/<buildId>/` prefixes after a new deploy, while
// keeping any build still in Status.CurrentTraffic) is owned EXCLUSIVELY by the
// CLI's pruneOldBuilds (packages/kn-next/src/utils/asset-gc.ts +
// asset-upload.ts). Keep the two authorities separate so a deploy can never wipe
// the bare `<app>/` namespace.
func appStoragePrefix(app *appsv1alpha1.NextApp) string {
	return app.Name + "/"
}

// cleanupExternalState clears the app's external object-store prefix and Redis
// keyspace. It is **best-effort and bounded**:
//
//   - Scope is STRICTLY this app — the object-store prefix is appStoragePrefix()
//     (never the whole bucket) and the Redis scope is Spec.Cache.KeyPrefix
//     (never FLUSHDB, never another app's prefix). This is the data-sovereignty
//     guard (.claude/rules/scs-zones.md): a wildcard delete could wipe a sibling
//     zone's data.
//   - If the store/Redis is unreachable we log + emit a Warning Event and
//     RETURN nil so the finalizer is still removed. We never block CR deletion
//     indefinitely on an external dependency that may be down.
//   - The attempt is bounded by externalCleanupTimeout.
//
// It is a no-op (returns nil) when neither Storage nor Cache is configured, or
// when no Cleaner is wired (unit tests of unrelated paths).
func (r *NextAppReconciler) cleanupExternalState(ctx context.Context, app *appsv1alpha1.NextApp) error {
	logger := logf.FromContext(ctx)

	if r.Cleaner == nil {
		logger.Info("No ExternalCleaner wired; skipping external cleanup", "name", app.Name)
		return nil
	}

	ctx, cancel := context.WithTimeout(ctx, externalCleanupTimeout)
	defer cancel()

	if app.Spec.Storage != nil && app.Spec.Storage.Provider != "" && app.Spec.Storage.Bucket != "" {
		target := StorageTarget{
			Provider: app.Spec.Storage.Provider,
			Bucket:   app.Spec.Storage.Bucket,
			Region:   app.Spec.Storage.Region,
			Endpoint: app.Spec.Storage.Endpoint,
			Prefix:   appStoragePrefix(app),
		}
		if err := r.Cleaner.CleanupStorage(ctx, target); err != nil {
			// Best-effort: log + Warning, but do NOT fail — deletion proceeds.
			logger.Error(err, "External object-store cleanup failed; proceeding with deletion (best-effort)",
				"bucket", target.Bucket, "prefix", target.Prefix)
			r.emitEvent(app, corev1.EventTypeWarning, ReasonCleanupFailed,
				"Object-store cleanup failed (best-effort, proceeding): "+err.Error())
		} else {
			logger.Info("Cleared object-store prefix", "bucket", target.Bucket, "prefix", target.Prefix)
		}
	}

	if app.Spec.Cache != nil && app.Spec.Cache.Provider == "redis" && app.Spec.Cache.KeyPrefix != "" {
		target := CacheTarget{
			Provider:  app.Spec.Cache.Provider,
			URL:       app.Spec.Cache.URL,
			KeyPrefix: app.Spec.Cache.KeyPrefix,
		}
		if err := r.Cleaner.CleanupCache(ctx, target); err != nil {
			logger.Error(err, "Redis keyspace cleanup failed; proceeding with deletion (best-effort)",
				"keyPrefix", target.KeyPrefix)
			r.emitEvent(app, corev1.EventTypeWarning, ReasonCleanupFailed,
				"Redis cleanup failed (best-effort, proceeding): "+err.Error())
		} else {
			logger.Info("Cleared Redis keyspace", "keyPrefix", target.KeyPrefix)
		}
	}

	return nil
}
