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

package validation

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"k8s.io/apimachinery/pkg/api/resource"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// #455 (2): the CLI hand-mirrors the Kubernetes quantity grammar as a regex for
// fast `kn-next deploy` feedback (packages/kn-next/src/cli/validate.ts). That is
// the third mirrored rule (#431/#433/#435) and the mirror can silently drift
// from the operator, which stays the source of truth (ADR-0001).
//
// test/fixtures/quantity-grammar.json is the shared contract between the two.
// This file pins the fixture to the REAL parser: every row's `accepted` is
// re-derived from resource.ParseQuantity + Sign() on each run, so the fixture
// cannot encode a claim apimachinery does not make (including after a
// dependency bump). The CLI-side half of the contract lives in
// packages/kn-next/src/__tests__/validate-quantity-grammar-parity.test.ts,
// which asserts the CLI's verdict on the SAME rows.
const quantityFixturePath = "../../test/fixtures/quantity-grammar.json"

type quantityFixture struct {
	Cases []struct {
		Value    string `json:"value"`
		Accepted bool   `json:"accepted"`
		Note     string `json:"note"`
	} `json:"cases"`
}

func loadQuantityFixture(t *testing.T) quantityFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Clean(quantityFixturePath))
	if err != nil {
		t.Fatalf("shared quantity fixture unreadable: %v", err)
	}
	var fx quantityFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("shared quantity fixture is not valid JSON: %v", err)
	}
	if len(fx.Cases) < 20 {
		t.Fatalf("shared quantity fixture has only %d cases; it is meant to cover the "+
			"grammar's corners (suffixes, exponents, sign, whitespace, junk)", len(fx.Cases))
	}
	return fx
}

// TestQuantityFixtureMatchesApimachinery is the oracle half: the fixture is only
// a usable contract for the CLI if it is itself true of resource.ParseQuantity.
func TestQuantityFixtureMatchesApimachinery(t *testing.T) {
	fx := loadQuantityFixture(t)
	for _, c := range fx.Cases {
		q, err := resource.ParseQuantity(c.Value)
		accepted := err == nil && q.Sign() > 0
		if accepted != c.Accepted {
			t.Errorf("fixture disagrees with resource.ParseQuantity for %q: fixture says accepted=%v, apimachinery says %v (err=%v)",
				c.Value, c.Accepted, accepted, err)
		}
	}
}

// TestQuantityFixtureMatchesValidator closes the loop on the operator side: the
// fixture's verdict must also be the verdict ValidateNextAppSpec reaches for a
// spec.resources field, so "the CLI agrees with the fixture" really does mean
// "the CLI agrees with the operator".
func TestQuantityFixtureMatchesValidator(t *testing.T) {
	fx := loadQuantityFixture(t)
	for _, c := range fx.Cases {
		if c.Value == "" {
			continue // empty == field unset == "use the reconciler default"
		}
		spec := &appsv1alpha1.NextAppSpec{
			Image:     "registry.example.com/app@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
			Resources: &appsv1alpha1.ResourcesSpec{CPURequest: c.Value},
		}
		err := ValidateNextAppSpec(spec)
		if c.Accepted && err != nil {
			t.Errorf("fixture says %q is accepted, but ValidateNextAppSpec rejected it: %v", c.Value, err)
		}
		if !c.Accepted && err == nil {
			t.Errorf("fixture says %q is rejected, but ValidateNextAppSpec accepted it", c.Value)
		}
	}
}

// TestEveryResourcesFieldIsQuantityChecked SCANS the ResourcesSpec struct rather
// than enumerating its fields: for every string field, a malformed quantity must
// be rejected. Adding a fifth resource field and forgetting to wire it into
// validateResources turns this red — an enumerated list is exactly how the next
// field gets missed, and the reconciler parses whatever the CR carries.
func TestEveryResourcesFieldIsQuantityChecked(t *testing.T) {
	const malformed = "0.5 CPU"
	rt := reflect.TypeOf(appsv1alpha1.ResourcesSpec{})
	checked := 0
	for i := 0; i < rt.NumField(); i++ {
		field := rt.Field(i)
		if field.Type.Kind() != reflect.String {
			t.Errorf("ResourcesSpec.%s is not a string field; this scan only understands "+
				"string quantities — extend it rather than leaving the field unguarded", field.Name)
			continue
		}
		resources := &appsv1alpha1.ResourcesSpec{}
		reflect.ValueOf(resources).Elem().Field(i).SetString(malformed)
		spec := &appsv1alpha1.NextAppSpec{
			Image:     "registry.example.com/app@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
			Resources: resources,
		}
		if err := ValidateNextAppSpec(spec); err == nil {
			t.Errorf("spec.resources.%s accepts the malformed quantity %q — every quantity "+
				"field must go through the shared parse-and-positive check", field.Name, malformed)
		}
		checked++
	}
	if checked == 0 {
		t.Fatal("scanned no ResourcesSpec fields; the scan itself is broken")
	}
}
