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
	"os"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/client"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// ZERO-DIFF FOR ZONE FUNCTIONS (ADR-0004 Amendment 2 Decision 3: "a zone with
// no binding renders a template byte-identical to today's, with no new
// revision").
//
// The corpus and its goldens are the ADR-0064 zero-diff harness
// (zero_diff_golden_test.go). The goldens were recorded by the operator BEFORE
// zone functions existed, so rendering every corpus app through the real
// Reconcile with the BackendService kind installed, and with functions living
// in the same namespace, and matching the SAME golden bytes, is the proof that
// no NextApp without spec.backends changes at all on upgrade. No corpus entry
// sets spec.backends (they are frozen CLI snapshots).
//
// The cases cover each way a function can sit next to a zone without being
// bound to it: none at all, one that names the zone without the zone's consent
// (the function half only), and one that belongs to another zone.
func functionNeighbourCases(app *appsv1alpha1.NextApp) []reconcilerCase {
	oneSided := &appsv1alpha1.BackendService{
		ObjectMeta: metav1.ObjectMeta{Name: "names-this-zone", Namespace: app.Namespace},
		Spec: appsv1alpha1.BackendServiceSpec{
			Zone:         app.Name,
			Image:        "registry.example.com/fn@sha256:" + sixtyFourHex,
			ProtoVersion: "1.0.0",
			WakeAhead:    ptr.To(true),
		},
		Status: appsv1alpha1.BackendServiceStatus{ServedProtoVersion: "1.0.0"},
	}
	foreign := oneSided.DeepCopy()
	foreign.Name = "another-zones-function"
	foreign.Spec.Zone = "some-other-zone"
	return []reconcilerCase{
		{name: "backendservice-crd-absent"},
		{name: "backendservice-crd-present-no-functions", backendServiceCRDPresent: true},
		{name: "one-sided-function-names-this-zone", backendServiceCRDPresent: true,
			objects: []client.Object{oneSided}},
		{name: "function-of-another-zone", backendServiceCRDPresent: true,
			objects: []client.Object{foreign}},
	}
}

const sixtyFourHex = "abc123def456abc123def456abc123def456abc123def456abc123def456abc1"

func TestZeroDiffGoldenWithFunctionsInTheNamespace(t *testing.T) {
	if os.Getenv(updateGoldenEnv) != "" {
		t.Skip("goldens are recorded by TestZeroDiffGolden only; this test must match them, never write them")
	}
	corpus := loadGoldenCorpus(t)
	for _, app := range corpus {
		if len(app.Spec.Backends) != 0 {
			t.Fatalf("corpus entry %s sets spec.backends; the zero-diff corpus must be zones without functions", app.Name)
		}
		want, err := os.ReadFile(goldenPath(app))
		if err != nil {
			t.Fatalf("read golden: %v", err)
		}
		for _, rc := range functionNeighbourCases(app) {
			t.Run(app.Name+"/"+rc.name, func(t *testing.T) {
				if got := renderApp(t, app, rc); got != string(want) {
					t.Fatalf("a zone with no spec.backends no longer renders byte-identically when %s.\n"+
						"--- want\n%s\n--- got\n%s", rc.name, want, got)
				}
			})
		}
	}
}
