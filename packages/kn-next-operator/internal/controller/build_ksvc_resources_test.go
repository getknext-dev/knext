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

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
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
