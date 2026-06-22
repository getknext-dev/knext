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
	"errors"
	"strings"
	"testing"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// fakeCleaner records every scoped delete the reconciler asks for so the test
// can assert (a) the EXACT prefix/keyspace was cleaned and (b) NO other app's
// prefix was ever touched (cross-app safety — data-sovereignty guard).
type fakeCleaner struct {
	storageCalls []storageCall
	cacheCalls   []cacheCall
	storageErr   error
	cacheErr     error
}

type storageCall struct {
	provider string
	bucket   string
	endpoint string
	region   string
	prefix   string
}

type cacheCall struct {
	provider  string
	url       string
	keyPrefix string
}

func (f *fakeCleaner) CleanupStorage(_ context.Context, s StorageTarget) error {
	f.storageCalls = append(f.storageCalls, storageCall{
		provider: s.Provider, bucket: s.Bucket, endpoint: s.Endpoint,
		region: s.Region, prefix: s.Prefix,
	})
	return f.storageErr
}

func (f *fakeCleaner) CleanupCache(_ context.Context, c CacheTarget) error {
	f.cacheCalls = append(f.cacheCalls, cacheCall{
		provider: c.Provider, url: c.URL, keyPrefix: c.KeyPrefix,
	})
	return f.cacheErr
}

func newAppWithExternalState() *appsv1alpha1.NextApp {
	return &appsv1alpha1.NextApp{}
}

func TestCleanupExternalState_ScopedToThisApp(t *testing.T) {
	app := newAppWithExternalState()
	app.Name = "shop"
	app.Namespace = "default"
	app.Spec.Storage = &appsv1alpha1.StorageSpec{
		Provider: "s3",
		Bucket:   "shared-bucket",
		Region:   "us-east-1",
		Endpoint: "https://s3.example.com",
	}
	app.Spec.Cache = &appsv1alpha1.CacheSpec{
		Provider:  "redis",
		URL:       "redis://redis:6379",
		KeyPrefix: "shop",
	}

	fc := &fakeCleaner{}
	r := &NextAppReconciler{Cleaner: fc}

	if err := r.cleanupExternalState(context.Background(), app); err != nil {
		t.Fatalf("cleanupExternalState returned error: %v", err)
	}

	// Storage: exactly one scoped delete, for THIS app's prefix in the bucket.
	if len(fc.storageCalls) != 1 {
		t.Fatalf("expected 1 storage cleanup call, got %d", len(fc.storageCalls))
	}
	sc := fc.storageCalls[0]
	if sc.bucket != "shared-bucket" {
		t.Errorf("storage bucket = %q, want shared-bucket", sc.bucket)
	}
	// CROSS-APP SAFETY: the prefix MUST be non-empty and derived from this app
	// (its name). A bucket-wide / empty-prefix delete would wipe sibling zones.
	if sc.prefix == "" {
		t.Fatalf("storage cleanup prefix is EMPTY — would delete the whole bucket and risk other apps' data")
	}
	if sc.prefix != app.Name+"/" {
		t.Errorf("storage prefix = %q, want %q (this app's namespace only)", sc.prefix, app.Name+"/")
	}

	// Cache: exactly one scoped delete, under THIS app's KeyPrefix.
	if len(fc.cacheCalls) != 1 {
		t.Fatalf("expected 1 cache cleanup call, got %d", len(fc.cacheCalls))
	}
	cc := fc.cacheCalls[0]
	if cc.keyPrefix != "shop" {
		t.Errorf("cache keyPrefix = %q, want shop (this app only)", cc.keyPrefix)
	}
	if cc.keyPrefix == "" {
		t.Fatalf("cache keyPrefix is EMPTY — would risk FLUSHing other apps' keys")
	}
}

// cliUploadKeyScheme mirrors the CLI uploader's key scheme
// (packages/kn-next/src/utils/asset-upload.ts: `appKeyPrefix()` = `<name>/`,
// objects uploaded as `<name>/` + relative path). It is the operator-side mirror
// of that contract so this test FAILS if the two prefixes ever diverge — which
// is exactly the original #74 bug (uploads at bucket root, cleanup under
// `<name>/` → silent no-op). Keep in lock-step with `appKeyPrefix`.
func cliUploadKeyScheme(appName, relPath string) string {
	return appName + "/" + relPath
}

// TestStorageCleanupPrefixMatchesRealUploadKeys ties the finalizer's storage
// cleanup prefix to ACTUAL uploaded object keys, not just the prefix string.
// The earlier assertion (prefix == "<app>/") was tautological: it never proved
// the prefix matches a real key, so a uploader writing to the bucket root passed
// green while deleting nothing. Here we construct keys exactly as the CLI
// uploader does and assert every one of THIS app's keys is selected by the
// cleanup prefix (and a sibling app's keys are NOT).
func TestStorageCleanupPrefixMatchesRealUploadKeys(t *testing.T) {
	app := newAppWithExternalState()
	app.Name = "shop"
	app.Spec.Storage = &appsv1alpha1.StorageSpec{Provider: "s3", Bucket: "shared"}
	app.Spec.Cache = &appsv1alpha1.CacheSpec{Provider: "redis", URL: "redis://r:6379", KeyPrefix: "shop"}

	fc := &fakeCleaner{}
	r := &NextAppReconciler{Cleaner: fc}
	if err := r.cleanupExternalState(context.Background(), app); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(fc.storageCalls) != 1 {
		t.Fatalf("expected 1 storage cleanup call, got %d", len(fc.storageCalls))
	}
	prefix := fc.storageCalls[0].prefix

	// Representative objects the CLI uploader actually writes for THIS app.
	ownKeys := []string{
		cliUploadKeyScheme(app.Name, "_next/static/chunks/main.js"),
		cliUploadKeyScheme(app.Name, "_next/static/css/app.css"),
		cliUploadKeyScheme(app.Name, "favicon.ico"),
	}
	for _, k := range ownKeys {
		if !strings.HasPrefix(k, prefix) {
			t.Errorf("uploaded key %q is NOT under cleanup prefix %q — storage cleanup would be a no-op (the #74 bug)", k, prefix)
		}
	}

	// A sibling app's keys live under "blog/" and must NOT match this prefix.
	siblingKey := cliUploadKeyScheme("blog", "_next/static/chunks/main.js")
	if strings.HasPrefix(siblingKey, prefix) {
		t.Errorf("sibling key %q matches prefix %q — cross-app data-sovereignty violation", siblingKey, prefix)
	}
}

// TestCleanupExternalState_NeverTouchesOtherPrefix is the explicit cross-app
// guard: whatever prefixes the cleaner is handed, none may belong to a sibling
// app. We assert the only prefix used is derived from THIS app.
func TestCleanupExternalState_NeverTouchesOtherPrefix(t *testing.T) {
	app := newAppWithExternalState()
	app.Name = "blog"
	app.Spec.Storage = &appsv1alpha1.StorageSpec{Provider: "s3", Bucket: "shared"}
	app.Spec.Cache = &appsv1alpha1.CacheSpec{Provider: "redis", URL: "redis://r:6379", KeyPrefix: "blog"}

	fc := &fakeCleaner{}
	r := &NextAppReconciler{Cleaner: fc}
	if err := r.cleanupExternalState(context.Background(), app); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	const sibling = "shop"
	for _, sc := range fc.storageCalls {
		if sc.prefix == sibling+"/" || sc.prefix == "" || sc.prefix == sibling {
			t.Fatalf("storage cleanup touched a sibling/empty prefix %q — cross-app data-sovereignty violation", sc.prefix)
		}
	}
	for _, cc := range fc.cacheCalls {
		if cc.keyPrefix == sibling || cc.keyPrefix == "" {
			t.Fatalf("cache cleanup touched a sibling/empty keyPrefix %q — cross-app violation", cc.keyPrefix)
		}
	}
}

// TestCleanupExternalState_NoStorageOrCache: an app with neither Storage nor
// Cache configured must perform NO external deletes and must not error.
func TestCleanupExternalState_NoStorageOrCache(t *testing.T) {
	app := newAppWithExternalState()
	app.Name = "static"

	fc := &fakeCleaner{}
	r := &NextAppReconciler{Cleaner: fc}
	if err := r.cleanupExternalState(context.Background(), app); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(fc.storageCalls) != 0 || len(fc.cacheCalls) != 0 {
		t.Fatalf("expected no cleanup calls for app without storage/cache, got storage=%d cache=%d",
			len(fc.storageCalls), len(fc.cacheCalls))
	}
}

// TestCleanupExternalState_BestEffortOnUnreachable: when the store/redis is
// unreachable the routine must NOT propagate a hard error that would wedge the
// CR in Terminating — it logs/records and returns nil (best-effort, bounded).
func TestCleanupExternalState_BestEffortOnUnreachable(t *testing.T) {
	app := newAppWithExternalState()
	app.Name = "shop"
	app.Spec.Storage = &appsv1alpha1.StorageSpec{Provider: "s3", Bucket: "b"}
	app.Spec.Cache = &appsv1alpha1.CacheSpec{Provider: "redis", URL: "redis://down:6379", KeyPrefix: "shop"}

	fc := &fakeCleaner{
		storageErr: errors.New("dial tcp: connection refused"),
		cacheErr:   errors.New("dial tcp: connection refused"),
	}
	r := &NextAppReconciler{Cleaner: fc}

	// Must NOT return an error — deletion must proceed even when external
	// stores are unreachable (documented best-effort/bounded behavior).
	if err := r.cleanupExternalState(context.Background(), app); err != nil {
		t.Fatalf("cleanupExternalState should be best-effort (return nil) on unreachable store, got: %v", err)
	}
}
