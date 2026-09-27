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
//
// #1522 added a SECOND way to reach the same "no server.js in this image"
// property without setting Build to "vinext": the self-contained standalone
// shape (spec.selfContained=true on the standalone bundlers). Its rows below
// are what regress if that guard's `!nextApp.Spec.SelfContained` is dropped.
func TestBuildDesiredKsvcCommandByArtifactShape(t *testing.T) {
	cases := []struct {
		name          string
		build         string
		runtime       string
		selfContained bool
		want          []string // nil => defer to the image's own CMD
	}{
		{"standalone under bun execs server.js", "", "bun", false, []string{"bun", "run", "server.js"}},
		{"turbopack under bun execs server.js", "turbopack", "bun", false, []string{"bun", "run", "server.js"}},
		{"standalone under node defers to the image", "", "node", false, nil},
		{"vinext defers to the image CMD even with runtime bun", "vinext", "bun", false, nil},
		{"vinext with runtime unset defers to the image CMD", "vinext", "", false, nil},
		// #1219: webpack is a SECOND spelling of the standalone shape (same
		// `.next/standalone` artifact turbopack emits, just a different `next
		// build` bundler flag). Nothing distinguishes it from "turbopack" in
		// this decision — the branch tests `!= "vinext"`, not `== "turbopack"`
		// — so these two rows exist to catch the regression where someone
		// narrows that to an enumerated allow-list.
		//
		// Mutation-proved SURGICALLY, not just broadly: narrowing the branch
		// to `(Build == "turbopack" || Build == "") && Runtime == "bun"` keeps
		// EVERY pre-existing row in this table green — including the
		// `standalone under bun` (build="") row, which a cruder `== "turbopack"`
		// mutation also breaks, hiding whether these two rows add anything.
		// With the allow-list mutation, only `webpack under bun` reds. That is
		// the row these two exist for.
		{"webpack under bun execs server.js", "webpack", "bun", false, []string{"bun", "run", "server.js"}},
		{"webpack under node defers to the image", "webpack", "node", false, nil},

		// #1522 — the self-contained standalone shape (N2 follow-up #1457):
		// SelfContained:true gets the SAME nil-Command treatment as vinext,
		// on the exact rows that would otherwise force `bun run server.js`.
		// This is the row that regresses if the new guard is ever narrowed
		// back to `Build != "vinext" && Runtime == "bun"` — the mutation this
		// row mutation-proves against.
		{"self-contained standalone under bun defers to the image", "", "bun", true, nil},
		{"self-contained turbopack under bun defers to the image", "turbopack", "bun", true, nil},
		{"self-contained webpack under bun defers to the image", "webpack", "bun", true, nil},
		// selfContained is a no-op off the bun cell — the node row was
		// already nil, and stays nil.
		{"self-contained standalone under node still defers to the image", "", "node", true, nil},
		// selfContained is meaningless for vinext (already always nil,
		// regardless) — this row proves the new field cannot FLIP a vinext
		// row to a forced command by some accidental precedence bug.
		{"self-contained vinext defers to the image CMD (field is a no-op here)", "vinext", "bun", true, nil},
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
					Runtime:       tc.runtime,
					SelfContained: tc.selfContained,
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
			got := containers[0].Command
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("build=%q runtime=%q selfContained=%v rendered command %v, want %v", tc.build, tc.runtime, tc.selfContained, got, tc.want)
			}
		})
	}
}
