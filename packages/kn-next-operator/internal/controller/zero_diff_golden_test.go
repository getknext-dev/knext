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
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/apiutil"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
	"sigs.k8s.io/yaml"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
	servingv1beta1 "knative.dev/serving/pkg/apis/serving/v1beta1"
)

// ZERO-DIFF GOLDEN (ADR-0064 D3 / P0-3).
//
// The platform layer must be invisible until an admin opts in: with no
// KnextPlatform at all, the rendered objects must be BYTE-IDENTICAL to what the
// operator produced before the layer existed. This file is that proof.
//
// HOW IT WORKS. corpus.yaml holds NextApp specs shaped like real CLI output
// (frozen snapshots, see its header). Each one is driven through the REAL
// Reconcile against a fake client; every object the operator created for it
// (ServiceAccount, caching Image, Knative Service, NetworkPolicy, image-prewarm
// DaemonSet) is serialised with server-assigned metadata stripped, and compared
// byte for byte with golden/<name>.yaml. The goldens were captured from the
// operator as it stood BEFORE the platform layer existed (see the commit that
// introduced them), so they are the "current operator's output" the ADR names,
// not a snapshot of whatever the new code happens to emit.
//
// The corpus is rendered under every platform-state case in platformCases, and
// ALL of them must match the SAME golden file. A mismatch in any one is a
// zero-diff violation.
//
// Regenerating a golden is a deliberate act (KNEXT_UPDATE_GOLDEN=1) that is
// refused under CI, so a red run can never be "fixed" by re-recording it there.

const (
	goldenCorpusFile = "testdata/zero-diff/corpus.yaml"
	goldenDir        = "testdata/zero-diff/golden"
	updateGoldenEnv  = "KNEXT_UPDATE_GOLDEN"
)

// goldenClock pins "now" so the warm-schedule window evaluation is stable:
// Wednesday 2026-01-14 10:00 UTC is inside the 08:00-20:00 weekday window.
var goldenClock = time.Date(2026, time.January, 14, 10, 0, 0, 0, time.UTC)

// loadGoldenCorpus splits corpus.yaml into NextApps, decoding STRICTLY so a
// fixture naming a field the current types do not know fails loudly instead of
// being silently dropped (which would shrink the corpus without anyone noticing).
func loadGoldenCorpus(t *testing.T) []*appsv1alpha1.NextApp {
	t.Helper()
	raw, err := os.ReadFile(goldenCorpusFile)
	if err != nil {
		t.Fatalf("read corpus: %v", err)
	}
	var apps []*appsv1alpha1.NextApp
	for i, doc := range bytes.Split(raw, []byte("\n---\n")) {
		if len(bytes.TrimSpace(stripYAMLComments(doc))) == 0 {
			continue
		}
		app := &appsv1alpha1.NextApp{}
		if err := yaml.UnmarshalStrict(doc, app); err != nil {
			t.Fatalf("corpus document %d does not decode strictly into NextApp: %v", i, err)
		}
		if app.Name == "" {
			t.Fatalf("corpus document %d has no metadata.name", i)
		}
		app.UID = types.UID("uid-" + app.Name)
		app.Generation = 1
		apps = append(apps, app)
	}
	if len(apps) < 20 {
		t.Fatalf("corpus has %d entries; the guard is only meaningful over a representative set (>=20) — "+
			"did a document separator get mangled?", len(apps))
	}
	return apps
}

// stripYAMLComments drops full-line comments so a document that is nothing but
// a header comment block is recognised as empty.
func stripYAMLComments(doc []byte) []byte {
	var out [][]byte
	for _, line := range bytes.Split(doc, []byte("\n")) {
		if bytes.HasPrefix(bytes.TrimSpace(line), []byte("#")) {
			continue
		}
		out = append(out, line)
	}
	return bytes.Join(out, []byte("\n"))
}

func goldenTestScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	s := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{
		clientgoscheme.AddToScheme,
		appsv1alpha1.AddToScheme,
		servingv1.AddToScheme,
		servingv1beta1.AddToScheme,
	} {
		if err := add(s); err != nil {
			t.Fatalf("scheme: %v", err)
		}
	}
	return s
}

// renderedKinds is the fixed render order of the golden; a kind the operator
// starts creating that is not listed here is caught by the "unlisted kind" check.
var renderedKinds = []string{"ServiceAccount", "Image", "Service", "NetworkPolicy", "DaemonSet"}

// renderApp drives one Reconcile of app and returns the serialised children.
// extraObjects are pre-existing cluster objects (a KnextPlatform in the platform
// cases). A reconcile error is part of the golden (the reject-* entries).
func renderApp(t *testing.T, scheme *runtime.Scheme, app *appsv1alpha1.NextApp, rc reconcilerCase, extraObjects ...client.Object) string {
	t.Helper()
	objs := append([]client.Object{app.DeepCopy()}, extraObjects...)
	// Record every kind the operator CREATES, so an object type that starts
	// being rendered but is missing from renderedKinds fails here instead of
	// silently escaping the golden.
	created := map[string]bool{}
	c := fake.NewClientBuilder().
		WithScheme(scheme).
		WithObjects(objs...).
		WithStatusSubresource(&appsv1alpha1.NextApp{}).
		WithInterceptorFuncs(interceptor.Funcs{
			Create: func(ctx context.Context, cl client.WithWatch, obj client.Object, opts ...client.CreateOption) error {
				gvk, err := apiutil.GVKForObject(obj, scheme)
				if err != nil {
					gvk = obj.GetObjectKind().GroupVersionKind()
				}
				created[gvk.Kind] = true
				return cl.Create(ctx, obj, opts...)
			},
		}).
		Build()
	r := &NextAppReconciler{Client: c, Scheme: scheme, Clock: func() time.Time { return goldenClock }}
	rc.configure(r)

	ctx := context.Background()
	req := reconcile.Request{NamespacedName: types.NamespacedName{Name: app.Name, Namespace: app.Namespace}}
	var buf strings.Builder
	if _, err := r.Reconcile(ctx, req); err != nil {
		fmt.Fprintf(&buf, "# reconcile error\n%s\n", strings.TrimSpace(err.Error()))
	}

	for kind := range created {
		known := false
		for _, k := range renderedKinds {
			known = known || k == kind
		}
		if !known {
			t.Fatalf("the operator created a %s, which the zero-diff golden does not render — add it "+
				"to renderedKinds so it is covered", kind)
		}
	}

	for _, kind := range renderedKinds {
		for _, obj := range listKind(t, ctx, c, scheme, kind, app.Namespace) {
			buf.WriteString("---\n")
			buf.Write(marshalNormalized(t, scheme, obj))
		}
	}

	// KafkaSource: Reconcile never reaches it today (revalidationDeferred is
	// true for every kafka app), so it is rendered through its builder to keep
	// its shape pinned beside the rest. The golden for a non-kafka app has none.
	if app.Spec.Revalidation != nil && app.Spec.Revalidation.Queue == "kafka" {
		buf.WriteString("# KafkaSource (builder output; Reconcile does not create it)\n---\n")
		buf.Write(marshalNormalized(t, scheme, buildKafkaSource(app)))
	}
	return buf.String()
}

func listKind(t *testing.T, ctx context.Context, c client.Client, scheme *runtime.Scheme, kind, ns string) []client.Object {
	t.Helper()
	var out []client.Object
	switch kind {
	case "ServiceAccount":
		l := &corev1.ServiceAccountList{}
		mustList(t, ctx, c, l, ns)
		for i := range l.Items {
			out = append(out, &l.Items[i])
		}
	case "Service":
		l := &servingv1.ServiceList{}
		mustList(t, ctx, c, l, ns)
		for i := range l.Items {
			out = append(out, &l.Items[i])
		}
	case "NetworkPolicy":
		l := &networkingv1.NetworkPolicyList{}
		mustList(t, ctx, c, l, ns)
		for i := range l.Items {
			out = append(out, &l.Items[i])
		}
	case "DaemonSet":
		l := &appsv1.DaemonSetList{}
		mustList(t, ctx, c, l, ns)
		for i := range l.Items {
			out = append(out, &l.Items[i])
		}
	case "Image":
		l := &unstructured.UnstructuredList{}
		l.SetAPIVersion("caching.internal.knative.dev/v1alpha1")
		l.SetKind("ImageList")
		mustList(t, ctx, c, l, ns)
		for i := range l.Items {
			out = append(out, &l.Items[i])
		}
	default:
		t.Fatalf("unknown render kind %q", kind)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].GetName() < out[j].GetName() })
	return out
}

func mustList(t *testing.T, ctx context.Context, c client.Client, l client.ObjectList, ns string) {
	t.Helper()
	if err := c.List(ctx, l, client.InNamespace(ns)); err != nil {
		t.Fatalf("list %T: %v", l, err)
	}
}

// marshalNormalized serialises obj with every server-assigned, run-dependent
// field removed, so two runs of the same operator output compare equal and a
// real rendering change is the ONLY way for the bytes to move.
func marshalNormalized(t *testing.T, scheme *runtime.Scheme, obj client.Object) []byte {
	t.Helper()
	var u *unstructured.Unstructured
	if uo, ok := obj.(*unstructured.Unstructured); ok {
		u = uo.DeepCopy()
	} else {
		raw, err := runtime.DefaultUnstructuredConverter.ToUnstructured(obj)
		if err != nil {
			t.Fatalf("to unstructured: %v", err)
		}
		u = &unstructured.Unstructured{Object: raw}
		// Typed list items come back with an empty TypeMeta; stamp it so every
		// document in the golden names its own apiVersion and kind.
		gvk, err := apiutil.GVKForObject(obj, scheme)
		if err != nil {
			t.Fatalf("gvk for %T: %v", obj, err)
		}
		u.SetGroupVersionKind(gvk)
	}
	u.SetResourceVersion("")
	u.SetUID("")
	u.SetGeneration(0)
	u.SetManagedFields(nil)
	u.SetCreationTimestamp(metav1.Time{})
	unstructured.RemoveNestedField(u.Object, "metadata", "creationTimestamp")
	unstructured.RemoveNestedField(u.Object, "status")
	out, err := yaml.Marshal(u.Object)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return out
}

// reconcilerCase is one platform-state the corpus is rendered under.
type reconcilerCase struct {
	name string
	// configure adjusts the reconciler (e.g. tells it whether the KnextPlatform
	// CRD is installed).
	configure func(r *NextAppReconciler)
}

func goldenPath(app *appsv1alpha1.NextApp) string {
	return filepath.Join(goldenDir, app.Name+".golden.yaml")
}

// platformCases lists every platform state that must render identically.
// TODO(#2034): extended with the CRD-present cases once the platform types
// exist (see zero_diff_platform_cases_test.go).
func platformCases() []reconcilerCase {
	return []reconcilerCase{
		{name: "no-platform-layer", configure: func(*NextAppReconciler) {}},
	}
}

func TestZeroDiffGolden(t *testing.T) {
	scheme := goldenTestScheme(t)
	corpus := loadGoldenCorpus(t)
	updating := os.Getenv(updateGoldenEnv) != ""
	if updating && os.Getenv("CI") != "" {
		t.Fatalf("%s is set under CI: a golden may only be re-recorded locally, deliberately, "+
			"and the diff reviewed — never to turn a red CI run green", updateGoldenEnv)
	}

	seen := map[string]bool{}
	for _, app := range corpus {
		if seen[app.Name] {
			t.Fatalf("duplicate corpus name %q", app.Name)
		}
		seen[app.Name] = true
		path := goldenPath(app)

		for _, rc := range platformCases() {
			t.Run(app.Name+"/"+rc.name, func(t *testing.T) {
				got := renderApp(t, scheme, app, rc)
				if updating {
					if rc.name != platformCases()[0].name {
						return // the first case records; the rest must match it
					}
					if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
						t.Fatalf("write golden: %v", err)
					}
					return
				}
				want, err := os.ReadFile(path)
				if err != nil {
					t.Fatalf("read golden %s: %v (run with %s=1 locally to record one, then review it)",
						path, err, updateGoldenEnv)
				}
				if got != string(want) {
					t.Fatalf("rendered objects differ from %s — the operator no longer renders this "+
						"app byte-identically. If the change is intended it is NOT zero-diff and needs "+
						"its own review.\n--- want\n%s\n--- got\n%s", path, want, got)
				}
			})
		}
	}

	// A golden with no corpus entry is a stale file that proves nothing.
	if !updating {
		entries, err := os.ReadDir(goldenDir)
		if err != nil {
			t.Fatalf("read golden dir: %v", err)
		}
		for _, e := range entries {
			name := strings.TrimSuffix(e.Name(), ".golden.yaml")
			if !seen[name] {
				t.Errorf("stale golden %s has no corpus entry", e.Name())
			}
		}
	}
}
