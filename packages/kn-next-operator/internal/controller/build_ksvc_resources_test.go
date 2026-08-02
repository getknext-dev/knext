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
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// #435 defense-in-depth: a STORED CR whose spec.resources carries a malformed
// quantity (one that predates the admission check, so the webhook never
// rejected it) must NOT panic buildDesiredKsvc — which runs inside the SHARED
// reconcile loop. A panic there stops EVERY NextApp on the cluster from
// reconciling. The reconcile site must instead return an error the caller
// surfaces as a Warning event + requeue. This is a plain unit test on
// buildDesiredKsvc (no envtest) so it runs even without the API-server binaries.
func TestBuildDesiredKsvcRejectsMalformedResourceQuantity(t *testing.T) {
	cases := []struct {
		name  string
		res   *appsv1alpha1.ResourcesSpec
		field string
	}{
		{"cpu request", &appsv1alpha1.ResourcesSpec{CPURequest: "0.5 CPU"}, "cpuRequest"},
		{"memory request", &appsv1alpha1.ResourcesSpec{MemoryRequest: "1GB"}, "memoryRequest"},
		{"cpu limit", &appsv1alpha1.ResourcesSpec{CPULimit: "abc"}, "cpuLimit"},
		{"memory limit", &appsv1alpha1.ResourcesSpec{MemoryLimit: "12MB"}, "memoryLimit"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := &NextAppReconciler{}
			app := &appsv1alpha1.NextApp{
				ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
				Spec: appsv1alpha1.NextAppSpec{
					Image:     "registry.example.com/app:v1@sha256:abc123",
					Resources: tc.res,
				},
			}
			ksvc := &servingv1.Service{}

			var err error
			func() {
				defer func() {
					if rec := recover(); rec != nil {
						t.Fatalf("buildDesiredKsvc PANICKED on malformed %s (would crash the shared reconcile loop): %v", tc.field, rec)
					}
				}()
				err = r.buildDesiredKsvc(app, ksvc)
			}()

			if err == nil {
				t.Fatalf("expected an error for malformed %s, got nil", tc.field)
			}
			if !strings.Contains(err.Error(), tc.field) {
				t.Fatalf("error %q does not name the offending field %q", err, tc.field)
			}
		})
	}
}

// The operator's rendered app container carries CPU+memory requests AND limits
// UNCONDITIONALLY — spec.resources only OVERRIDES the per-field defaults seeded
// at nextapp_controller.go:888-895, it does not gate whether resources are set
// at all (they are applied at :972-974 regardless). Nothing asserted this until
// now, and a cold-start conclusion rests on it: a knext app is Burstable, while
// a raw Knative Service with no requests is BestEffort. On a saturated node
// (both cluster nodes sit at ~84% CPU-requested with limits ~4x overcommitted)
// a container with no CPU request competes at ~2 CFS shares against 1024. If
// anyone deletes these defaults or makes them conditional on spec.resources
// being non-nil, cold start degrades silently. This is the guard.
//
// Same argument the DB path already settled: every workload in
// packages/scale-zero-pg/deploy/ hardcodes a CPU request, and
// compute-app.template.yaml:136-144 documents the CPU limit added under #89 to
// stop one app starving its neighbours.
func TestBuildDesiredKsvcAppliesDefaultResources(t *testing.T) {
	// Note on expected strings: Kubernetes canonicalises quantities, so the
	// 1000m CPU limit in the source normalises to "1". Compare with
	// resource.Quantity.Equal, not string equality, so the assertion is on the
	// VALUE rather than its formatting.
	const (
		defaultCPURequest    = "250m"
		defaultMemoryRequest = "512Mi"
		defaultCPULimit      = "1000m"
		defaultMemoryLimit   = "1Gi"
	)

	cases := []struct {
		name string
		res  *appsv1alpha1.ResourcesSpec
		// wantX is the expected rendered value for each of the four fields.
		wantCPURequest    string
		wantMemoryRequest string
		wantCPULimit      string
		wantMemoryLimit   string
	}{
		{
			// The load-bearing case: spec.resources entirely unset.
			name:              "spec.resources unset gets all four defaults",
			res:               nil,
			wantCPURequest:    defaultCPURequest,
			wantMemoryRequest: defaultMemoryRequest,
			wantCPULimit:      defaultCPULimit,
			wantMemoryLimit:   defaultMemoryLimit,
		},
		{
			// An empty (but non-nil) struct must behave exactly like nil — the
			// override is per-field and keyed on the empty string, so every
			// field falls through to its default.
			name:              "spec.resources present but empty gets all four defaults",
			res:               &appsv1alpha1.ResourcesSpec{},
			wantCPURequest:    defaultCPURequest,
			wantMemoryRequest: defaultMemoryRequest,
			wantCPULimit:      defaultCPULimit,
			wantMemoryLimit:   defaultMemoryLimit,
		},
		// The four partial cases below are the ones most likely to regress: the
		// override is per-field rather than all-or-nothing, so setting ONE
		// field must leave the OTHER THREE at their defaults. An
		// all-or-nothing rewrite (`if Resources != nil { requests = ... }`)
		// would zero the unset three and pass any test that only checked the
		// field it set.
		{
			name:              "only cpuRequest set: it wins, other three keep defaults",
			res:               &appsv1alpha1.ResourcesSpec{CPURequest: "100m"},
			wantCPURequest:    "100m",
			wantMemoryRequest: defaultMemoryRequest,
			wantCPULimit:      defaultCPULimit,
			wantMemoryLimit:   defaultMemoryLimit,
		},
		{
			name:              "only memoryRequest set: it wins, other three keep defaults",
			res:               &appsv1alpha1.ResourcesSpec{MemoryRequest: "256Mi"},
			wantCPURequest:    defaultCPURequest,
			wantMemoryRequest: "256Mi",
			wantCPULimit:      defaultCPULimit,
			wantMemoryLimit:   defaultMemoryLimit,
		},
		{
			name:              "only cpuLimit set: it wins, other three keep defaults",
			res:               &appsv1alpha1.ResourcesSpec{CPULimit: "2"},
			wantCPURequest:    defaultCPURequest,
			wantMemoryRequest: defaultMemoryRequest,
			wantCPULimit:      "2",
			wantMemoryLimit:   defaultMemoryLimit,
		},
		{
			name:              "only memoryLimit set: it wins, other three keep defaults",
			res:               &appsv1alpha1.ResourcesSpec{MemoryLimit: "2Gi"},
			wantCPURequest:    defaultCPURequest,
			wantMemoryRequest: defaultMemoryRequest,
			wantCPULimit:      defaultCPULimit,
			wantMemoryLimit:   "2Gi",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// buildDesiredKsvc ends in ctrl.SetControllerReference, so it needs
			// a Scheme that knows both types. Build one locally rather than
			// leaning on the Ginkgo suite's global registration — this test
			// must run without the envtest API-server binaries.
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
					Image:     "registry.example.com/app:v1@sha256:abc123",
					Resources: tc.res,
				},
			}
			// Name/Namespace mirror what Reconcile seeds before the
			// CreateOrUpdate mutate (nextapp_controller.go:419-423); the
			// namespace is required for the owner reference to be valid.
			ksvc := &servingv1.Service{
				ObjectMeta: metav1.ObjectMeta{Name: app.Name, Namespace: app.Namespace},
			}

			if err := r.buildDesiredKsvc(app, ksvc); err != nil {
				t.Fatalf("buildDesiredKsvc returned an unexpected error: %v", err)
			}

			containers := ksvc.Spec.Template.Spec.Containers
			if len(containers) != 1 {
				t.Fatalf("expected exactly 1 rendered container, got %d", len(containers))
			}
			got := containers[0].Resources

			checks := []struct {
				kind string
				list corev1.ResourceList
				name corev1.ResourceName
				want string
			}{
				{"requests", got.Requests, corev1.ResourceCPU, tc.wantCPURequest},
				{"requests", got.Requests, corev1.ResourceMemory, tc.wantMemoryRequest},
				{"limits", got.Limits, corev1.ResourceCPU, tc.wantCPULimit},
				{"limits", got.Limits, corev1.ResourceMemory, tc.wantMemoryLimit},
			}
			for _, c := range checks {
				q, ok := c.list[c.name]
				if !ok {
					t.Fatalf("rendered container has NO %s.%s — an app container without one is not Burstable and gets no CFS share floor on a saturated node", c.kind, c.name)
				}
				want := resource.MustParse(c.want)
				if !q.Equal(want) {
					t.Fatalf("%s.%s = %s, want %s", c.kind, c.name, q.String(), want.String())
				}
			}
		})
	}
}
