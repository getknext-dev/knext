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
	"reflect"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// The container command is the operator's only shape-aware decision, and the
// vinext single executable (ADR-0048) is the case that makes it load-bearing:
// that image has NO server.js — its own CMD runs the compiled binary — so a
// forced `bun run server.js` CrashLoops it. The Runtime="bun" command may only
// apply to the standalone shape (spec.build absent or "turbopack").
//
// The vinext+bun row is the one that regresses if anyone re-simplifies the
// branch back to `if Runtime == "bun"`: the CLI's default config now emits
// exactly build="vinext", runtime="bun" into the CR.
func TestBuildDesiredKsvcCommandByArtifactShape(t *testing.T) {
	cases := []struct {
		name    string
		build   string
		runtime string
		want    []string // nil => defer to the image's own CMD
	}{
		{"standalone under bun execs server.js", "", "bun", []string{"bun", "run", "server.js"}},
		{"turbopack under bun execs server.js", "turbopack", "bun", []string{"bun", "run", "server.js"}},
		{"standalone under node defers to the image", "", "node", nil},
		{"vinext defers to the image CMD even with runtime bun", "vinext", "bun", nil},
		{"vinext with runtime unset defers to the image CMD", "vinext", "", nil},
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
					Image:   "registry.example.com/app:v1@sha256:abc123",
					Build:   tc.build,
					Runtime: tc.runtime,
				},
			}
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
			got := containers[0].Command
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("build=%q runtime=%q rendered command %v, want %v", tc.build, tc.runtime, got, tc.want)
			}
		})
	}
}
