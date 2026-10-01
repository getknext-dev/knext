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
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/utils/ptr"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// #1332: the rendered APP (serving) container gets readOnlyRootFilesystem:
// true by DEFAULT (nil spec.security.readOnlyRootFilesystem and an explicit
// true both render enabled), matching the default-on posture the sibling
// NetworkPolicy field already uses. An explicit false disables it, preserving
// a writable root for an app whose own runtime write path this default does
// not yet cover.
func TestBuildDesiredKsvcReadOnlyRootFilesystem(t *testing.T) {
	cases := []struct {
		name     string
		build    string
		security *appsv1alpha1.SecuritySpec
		want     bool
	}{
		{"nil security defaults ON", "", nil, true},
		{"nil field defaults ON", "", &appsv1alpha1.SecuritySpec{}, true},
		{"explicit true stays ON", "", &appsv1alpha1.SecuritySpec{ReadOnlyRootFilesystem: ptr.To(true)}, true},
		{"explicit false disables it", "", &appsv1alpha1.SecuritySpec{ReadOnlyRootFilesystem: ptr.To(false)}, false},
		{"vinext build defaults ON too", "vinext", nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sch := runtime.NewScheme()
			if err := appsv1alpha1.AddToScheme(sch); err != nil {
				t.Fatalf("AddToScheme(apps): %v", err)
			}
			if err := servingv1.AddToScheme(sch); err != nil {
				t.Fatalf("AddToScheme(serving): %v", err)
			}

			r := &NextAppReconciler{Scheme: sch}
			app := &appsv1alpha1.NextApp{
				ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
				Spec: appsv1alpha1.NextAppSpec{
					Image:    "registry.example.com/app:v1@sha256:abc123",
					Build:    tc.build,
					Security: tc.security,
				},
			}
			ksvc := &servingv1.Service{
				ObjectMeta: metav1.ObjectMeta{Name: app.Name, Namespace: app.Namespace},
			}

			if _, err := r.buildDesiredKsvc(app, ksvc); err != nil {
				t.Fatalf("buildDesiredKsvc returned an unexpected error: %v", err)
			}

			containers := ksvc.Spec.Template.Spec.Containers
			if len(containers) != 1 {
				t.Fatalf("expected exactly 1 rendered container, got %d", len(containers))
			}
			sc := containers[0].SecurityContext
			if sc == nil {
				t.Fatalf("expected a rendered SecurityContext, got nil")
			}
			if sc.ReadOnlyRootFilesystem == nil {
				t.Fatalf("expected ReadOnlyRootFilesystem to be set, got nil")
			}
			if *sc.ReadOnlyRootFilesystem != tc.want {
				t.Fatalf("ReadOnlyRootFilesystem = %v, want %v", *sc.ReadOnlyRootFilesystem, tc.want)
			}
		})
	}
}

// #1778/#1786 round 2: by DEFAULT (writableCache unset/false), no emptyDir is
// mounted for a plain standalone app with no storage configured —
// provisioning the volume cost ~300-360ms of pod-sandbox setup on every cold
// wake (measured OKE + GKE) whether or not the app ever wrote to it. BUT an
// adversarial review of the first round caught two write paths that are
// unconditional, not behind `writableCache`:
//
//   - /tmp, whenever the app is a self-contained-compiled single executable
//     (`build: vinext`, or `selfContained: true` on any other build) — the
//     binary unpacks sharp's native libraries there on the first
//     image-optimization request and dlopen()s them.
//   - `.next/standalone/.next/cache` (standalone shape only), whenever
//     `spec.storage` is configured — the built-in image optimizer writes
//     there before the object-store sync (image-cache-sync.ts) can run.
//
// `spec.security.writableCache: true` additionally provisions BOTH mounts
// unconditionally (the pre-#1778 behaviour), for an app that wants guaranteed
// local writes outside the two cases above.
func TestBuildDesiredKsvcReadOnlyRootFilesystemMounts(t *testing.T) {
	cases := []struct {
		name           string
		build          string
		selfContained  bool
		storage        *appsv1alpha1.StorageSpec
		writableCache  *bool
		wantTmp        bool
		wantImageCache bool
	}{
		{name: "default standalone, no storage, not self-contained: no mounts at all", build: "turbopack"},
		{name: "default vinext (self-contained by build): /tmp only, for sharp unpack", build: "vinext", wantTmp: true},
		{name: "default standalone + selfContained:true: /tmp only, for sharp unpack", build: "turbopack", selfContained: true, wantTmp: true},
		{name: "default standalone + spec.storage set: image-cache mount only", build: "turbopack", storage: &appsv1alpha1.StorageSpec{Provider: "gcs", Bucket: "b"}, wantImageCache: true},
		{name: "vinext + spec.storage set: still /tmp only — vinext has no .next/cache tree", build: "vinext", storage: &appsv1alpha1.StorageSpec{Provider: "gcs", Bucket: "b"}, wantTmp: true},
		{name: "writableCache explicitly false: no mounts, standalone, no storage", build: "turbopack", writableCache: ptr.To(false)},
		{name: "writableCache true + standalone (turbopack): mounts /tmp and the image cache", build: "turbopack", writableCache: ptr.To(true), wantTmp: true, wantImageCache: true},
		{name: "writableCache true + standalone (unset build): mounts /tmp and the image cache", build: "", writableCache: ptr.To(true), wantTmp: true, wantImageCache: true},
		{name: "writableCache true + webpack: mounts /tmp and the image cache", build: "webpack", writableCache: ptr.To(true), wantTmp: true, wantImageCache: true},
		{name: "writableCache true + vinext: mounts only /tmp", build: "vinext", writableCache: ptr.To(true), wantTmp: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sch := runtime.NewScheme()
			if err := appsv1alpha1.AddToScheme(sch); err != nil {
				t.Fatalf("AddToScheme(apps): %v", err)
			}
			if err := servingv1.AddToScheme(sch); err != nil {
				t.Fatalf("AddToScheme(serving): %v", err)
			}

			r := &NextAppReconciler{Scheme: sch}
			app := &appsv1alpha1.NextApp{
				ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
				Spec: appsv1alpha1.NextAppSpec{
					Image:         "registry.example.com/app:v1@sha256:abc123",
					Build:         tc.build,
					SelfContained: tc.selfContained,
					Storage:       tc.storage,
				},
			}
			if tc.writableCache != nil {
				app.Spec.Security = &appsv1alpha1.SecuritySpec{WritableCache: tc.writableCache}
			}
			ksvc := &servingv1.Service{
				ObjectMeta: metav1.ObjectMeta{Name: app.Name, Namespace: app.Namespace},
			}

			if _, err := r.buildDesiredKsvc(app, ksvc); err != nil {
				t.Fatalf("buildDesiredKsvc returned an unexpected error: %v", err)
			}

			containers := ksvc.Spec.Template.Spec.Containers
			if len(containers) != 1 {
				t.Fatalf("expected exactly 1 rendered container, got %d", len(containers))
			}
			mounts := containers[0].VolumeMounts

			foundTmp := false
			foundImageCache := false
			for _, m := range mounts {
				if m.MountPath == "/tmp" {
					foundTmp = true
				}
				if m.MountPath == "/app/.next/standalone/.next/cache" {
					foundImageCache = true
				}
			}
			if foundTmp != tc.wantTmp {
				t.Fatalf("build=%q: /tmp mount present=%v, want %v (mounts=%+v)", tc.build, foundTmp, tc.wantTmp, mounts)
			}
			if foundImageCache != tc.wantImageCache {
				t.Fatalf("build=%q: image-cache mount present=%v, want %v (mounts=%+v)", tc.build, foundImageCache, tc.wantImageCache, mounts)
			}
			if !tc.wantTmp && !tc.wantImageCache {
				if len(ksvc.Spec.Template.Spec.Volumes) != 0 {
					t.Fatalf("build=%q: expected NO volumes at all by default, got %+v", tc.build, ksvc.Spec.Template.Spec.Volumes)
				}
			}

			// Every VolumeMount must resolve to a declared Volume — a dangling
			// mount is a CrashLoop (ConfigError), not a soft failure.
			volNames := map[string]bool{}
			for _, v := range ksvc.Spec.Template.Spec.Volumes {
				volNames[v.Name] = true
			}
			for _, m := range mounts {
				if !volNames[m.Name] {
					t.Fatalf("VolumeMount %q references undeclared volume (volumes=%+v)", m.Name, ksvc.Spec.Template.Spec.Volumes)
				}
			}
		})
	}
}
