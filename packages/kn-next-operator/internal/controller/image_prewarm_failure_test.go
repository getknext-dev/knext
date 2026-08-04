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
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// Review finding 1 — the decoupling (#471 item 4) removed the ONLY alerting
// surface for a persistent prewarm failure.
//
// Reconcile's deferred hook increments knext_nextapp_reconcile_errors_total
// only when the pass returns an error, and prometheusrule.yaml pages
// (severity: critical) on that counter. Now that a prewarm failure no longer
// returns, it increments nothing: what is left is a transition-gated Warning
// (which expires with event TTL) and a condition nothing scrapes. "Loud rather
// than swallowed" was true only for someone already reading
// `kubectl get nextapp -o yaml`.
//
// So the failure gets its OWN counter, incremented at the point of failure, and
// its own (warning, not critical — the app is healthy) alert. These tests drive
// a REAL failure through a fake client rather than asserting on source text.

func prewarmTestScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	s := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(s); err != nil {
		t.Fatalf("add client-go scheme: %v", err)
	}
	if err := appsv1alpha1.AddToScheme(s); err != nil {
		t.Fatalf("add nextapp scheme: %v", err)
	}
	return s
}

// forbiddenOn returns an interceptor that fails writes to DaemonSets with a
// Forbidden — the exact shape of "operator upgraded without its new
// ClusterRole", which is the scenario the ADR amendment cites as motivation.
func forbiddenOnDaemonSetWrites() interceptor.Funcs {
	forbidden := func(obj client.Object) error {
		if _, ok := obj.(*appsv1.DaemonSet); ok {
			return apierrors.NewForbidden(
				schema.GroupResource{Group: "apps", Resource: "daemonsets"},
				obj.GetName(),
				context.Canceled)
		}
		return nil
	}
	return interceptor.Funcs{
		Create: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.CreateOption) error {
			if err := forbidden(obj); err != nil {
				return err
			}
			return c.Create(ctx, obj, opts...)
		},
		Update: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.UpdateOption) error {
			if err := forbidden(obj); err != nil {
				return err
			}
			return c.Update(ctx, obj, opts...)
		},
		Delete: func(ctx context.Context, c client.WithWatch, obj client.Object, opts ...client.DeleteOption) error {
			if err := forbidden(obj); err != nil {
				return err
			}
			return c.Delete(ctx, obj, opts...)
		},
	}
}

func TestReconcileImagePrewarm_FailureIncrementsItsOwnMetric(t *testing.T) {
	scheme := prewarmTestScheme(t)
	app := prewarmApp()

	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(app).
		WithInterceptorFuncs(forbiddenOnDaemonSetWrites()).
		Build()
	r := &NextAppReconciler{Client: c, Scheme: scheme}

	before := testutil.ToFloat64(imagePrewarmErrors)
	err := r.reconcileImagePrewarmDaemonSet(context.Background(), app)
	if err == nil {
		t.Fatalf("expected the forbidden DaemonSet write to surface as an error")
	}
	if got := testutil.ToFloat64(imagePrewarmErrors) - before; got != 1 {
		t.Fatalf("knext_nextapp_image_prewarm_errors_total delta = %v, want 1 — a persistent "+
			"prewarm failure now returns no error out of Reconcile, so this counter is the "+
			"ONLY thing an alert can key on", got)
	}
}

// The other half: a SUCCESSFUL reconcile must not touch the counter, or the
// alert fires forever on healthy clusters and gets muted.
func TestReconcileImagePrewarm_SuccessLeavesMetricAlone(t *testing.T) {
	scheme := prewarmTestScheme(t)
	app := prewarmApp()

	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app).Build()
	r := &NextAppReconciler{Client: c, Scheme: scheme}

	before := testutil.ToFloat64(imagePrewarmErrors)
	if err := r.reconcileImagePrewarmDaemonSet(context.Background(), app); err != nil {
		t.Fatalf("expected a clean reconcile, got %v", err)
	}
	if got := testutil.ToFloat64(imagePrewarmErrors) - before; got != 0 {
		t.Fatalf("counter moved by %v on a SUCCESSFUL reconcile — the alert would never clear", got)
	}
	// Sanity: the DaemonSet really was created, so the success path is real and
	// this assertion is not passing because nothing happened.
	ds := &appsv1.DaemonSet{}
	key := client.ObjectKey{Namespace: app.Namespace, Name: app.Name + "-imgcache"}
	if err := c.Get(context.Background(), key, ds); err != nil {
		t.Fatalf("expected the imgcache DaemonSet to exist after a clean reconcile: %v", err)
	}
	if ds.Spec.Template.Spec.Containers[0].Image != app.Spec.Image {
		t.Fatalf("pin container image = %q, want the app image", ds.Spec.Template.Spec.Containers[0].Image)
	}
}

// Review finding 2 — the DELETE issued when prewarm is disabled is
// unconditional, so a Forbidden (not NotFound) on the very upgrade path the ADR
// cites made EVERY NextApp in the cluster — including every app that never
// opted in — report CleanupFailed for a DaemonSet that never existed, with a
// Warning and a forced 2-minute poll. It also broke the invariant stated two
// lines above it: a never-prewarmed app's conditions stay byte-identical.
func TestReconcileImagePrewarm_DisabledDeleteFailureIsRecordedButNotFatal(t *testing.T) {
	scheme := prewarmTestScheme(t)
	app := prewarmApp()
	app.Spec.Scaling.ImagePrewarm = false

	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(app).
		WithInterceptorFuncs(forbiddenOnDaemonSetWrites()).
		Build()
	r := &NextAppReconciler{Client: c, Scheme: scheme}

	if err := r.reconcileImagePrewarmDaemonSet(context.Background(), app); err == nil {
		t.Fatalf("a Forbidden delete must still surface as an error to the caller")
	}
}

// Guards the shape of the pull-secret plumbing against the same fake client, so
// the success path above is exercising the real builder rather than a stub.
func TestReconcileImagePrewarm_ThreadsServiceAccountPullSecrets(t *testing.T) {
	scheme := prewarmTestScheme(t)
	app := prewarmApp()
	sa := &corev1.ServiceAccount{}
	sa.Name = app.Name + "-sa"
	sa.Namespace = app.Namespace
	sa.ImagePullSecrets = []corev1.LocalObjectReference{{Name: "ocir-creds"}}

	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app, sa).Build()
	r := &NextAppReconciler{Client: c, Scheme: scheme}

	if err := r.reconcileImagePrewarmDaemonSet(context.Background(), app); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	ds := &appsv1.DaemonSet{}
	key := client.ObjectKey{Namespace: app.Namespace, Name: app.Name + "-imgcache"}
	if err := c.Get(context.Background(), key, ds); err != nil {
		t.Fatalf("get daemonset: %v", err)
	}
	secrets := ds.Spec.Template.Spec.ImagePullSecrets
	if len(secrets) != 1 || secrets[0].Name != "ocir-creds" {
		t.Fatalf("imagePullSecrets = %+v, want the app ServiceAccount's", secrets)
	}
}
