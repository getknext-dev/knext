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
//
// The fixture's BREADTH is a guard in its own right, and it is the half that was
// wrong first: a curated 59-row sample let 22 live CLI divergences (apimachinery
// accepts a TRAILING-DOT mantissa — "1.", "1.Gi", "+1.e3" — the CLI regex did
// not) sit unnoticed under a test that claimed parity. So the value set is the
// systematic sign × mantissa × suffix cross-product, and
// TestQuantityFixtureCoversTheGrammarCrossProduct rebuilds it here and fails on
// any missing combination. Shrinking the fixture back to a hand-picked sample is
// therefore red, not silent.
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

// quantityGrammarAxes is the fixture's value set, stated as the axes it is the
// cross-product of. Widening an axis here is how you widen the fixture; the
// coverage test below then names every combination that is missing from it.
var quantityGrammarAxes = struct {
	signs, mantissas, suffixes []string
}{
	signs:     []string{"", "+", "-"},
	mantissas: []string{"0", "1", "10", "1.5", "0.5", ".5", "1.", "0.", "1.0", "123456", ""},
	suffixes: []string{
		"", "m", "k", "K", "M", "G", "T", "P", "E", "n", "u",
		"Ki", "Mi", "Gi", "Ti", "Pi", "Ei", "i", "Mib", "GB", "gi", "B",
		"e3", "E3", "e+3", "e-3", "e", "e+", ".e3", "1", " Mi", "Mi ",
	},
}

// quantityGrammarJunk is the non-compositional half of the fixture: strings that
// are not sign+mantissa+suffix at all, but that a user can still type into a CR.
var quantityGrammarJunk = []string{
	"0.5 CPU", " 250m", "250m ", "1..5", "abc", "m", "Mi", "1,5", "0x10",
	"1_000", "١٢٣", "1e3.5", "++1", "--1", "1-", "1+", "Infinity", "NaN",
	"1e999999", "1Gi1", "5e2Mi", "1 Mi", "\t1Gi", "1\n",
}

// TestRegenerateQuantityFixture IS the generator the other tests tell you to
// run. It is a test rather than a `main` so it shares the axes above and the
// module's apimachinery version — a separate tool would be one more thing that
// can drift from what the suite asserts.
//
//	KNEXT_REGEN_QUANTITY_FIXTURE=1 go test ./internal/validation -run TestRegenerateQuantityFixture
//
// It is skipped otherwise, so a normal run never rewrites the file: the fixture
// stays a reviewable artifact, and regenerating it is a deliberate act that
// shows up in the diff.
func TestRegenerateQuantityFixture(t *testing.T) {
	if os.Getenv("KNEXT_REGEN_QUANTITY_FIXTURE") == "" {
		t.Skip("generator; set KNEXT_REGEN_QUANTITY_FIXTURE=1 to rewrite " + quantityFixturePath)
	}

	seen := map[string]bool{}
	var values []string
	add := func(v string) {
		if !seen[v] {
			seen[v] = true
			values = append(values, v)
		}
	}
	for _, s := range quantityGrammarAxes.signs {
		for _, m := range quantityGrammarAxes.mantissas {
			for _, sf := range quantityGrammarAxes.suffixes {
				add(s + m + sf)
			}
		}
	}
	for _, j := range quantityGrammarJunk {
		add(j)
	}

	type genCase struct {
		Value    string `json:"value"`
		Accepted bool   `json:"accepted"`
		Note     string `json:"note"`
	}
	cases := make([]genCase, 0, len(values))
	for _, v := range values {
		q, err := resource.ParseQuantity(v)
		c := genCase{Value: v, Accepted: err == nil && q.Sign() > 0}
		switch {
		case err != nil:
			c.Note = "ParseQuantity rejects it"
		case q.Sign() <= 0:
			c.Note = "parses, but is not strictly positive"
		}
		cases = append(cases, c)
	}

	doc := map[string]any{"$comment": quantityFixtureComment, "cases": cases}
	raw, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	if err := os.WriteFile(quantityFixturePath, append(raw, '\n'), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	t.Logf("regenerated %s with %d cases", quantityFixturePath, len(cases))
}

// quantityFixtureComment is the fixture's self-description, kept here so the
// generator reproduces it byte-for-byte instead of dropping it on every rewrite.
var quantityFixtureComment = []string{
	"SHARED quantity-grammar fixture (#455). The Kubernetes quantity grammar is asserted in",
	"two places: the operator (internal/validation, resource.ParseQuantity -- the single",
	"source of truth per ADR-0001) and the CLI's advisory pre-flight regex in",
	"packages/kn-next/src/cli/validate.ts. This file is the contract that keeps them from",
	"drifting.",
	"'accepted' means: resource.ParseQuantity succeeds AND Quantity.Sign() > 0, i.e. the",
	"operator accepts the string as a positive resource quantity.",
	"PROVENANCE: generated by TestRegenerateQuantityFixture in",
	"internal/validation/quantity_fixture_test.go --",
	"`KNEXT_REGEN_QUANTITY_FIXTURE=1 go test ./internal/validation -run TestRegenerateQuantityFixture`.",
	"The value set is the systematic cross-product of {sign} x {mantissa} x {suffix} plus a",
	"junk list; TestQuantityFixtureCoversTheGrammarCrossProduct fails if a combination is",
	"missing. A CURATED sample is what let 22 live CLI divergences (the trailing-dot",
	"mantissa: '1.', '1.Gi', '1.e3') sit unnoticed under an earlier 59-row version.",
	"Every row's 'accepted' is RE-DERIVED from resource.ParseQuantity on each Go run, so no",
	"row can encode a claim apimachinery does not make -- including after a dep bump.",
}

// TestQuantityFixtureCoversTheGrammarCrossProduct makes the fixture's BREADTH
// scannable instead of a matter of taste. Every sign × mantissa × suffix
// combination must be present; a fixture trimmed back to hand-picked "corners"
// fails here rather than quietly narrowing what parity means.
//
// What this does NOT protect, stated so the guard is not over-read: the axes are
// declared in THIS file, so it is a subset check against a moving target.
// Narrowing `quantityGrammarAxes` *and* the fixture together stays green. No
// in-repo check can close that — the axes are a judgement about which corners of
// the grammar matter — so the real protection is that shrinking the axes is a
// visible, reviewable diff, not a silent omission. Widen them when a new
// divergence class turns up; do not narrow them to make something pass.
func TestQuantityFixtureCoversTheGrammarCrossProduct(t *testing.T) {
	fx := loadQuantityFixture(t)
	present := make(map[string]bool, len(fx.Cases))
	for _, c := range fx.Cases {
		present[c.Value] = true
	}
	missing := []string{}
	for _, s := range quantityGrammarAxes.signs {
		for _, m := range quantityGrammarAxes.mantissas {
			for _, sf := range quantityGrammarAxes.suffixes {
				if v := s + m + sf; !present[v] {
					missing = append(missing, v)
				}
			}
		}
	}
	if len(missing) > 0 {
		shown := missing
		if len(shown) > 10 {
			shown = shown[:10]
		}
		t.Errorf("shared quantity fixture is missing %d grammar combinations, e.g. %q — "+
			"regenerate it rather than curating it: "+
			"`KNEXT_REGEN_QUANTITY_FIXTURE=1 go test ./internal/validation "+
			"-run TestRegenerateQuantityFixture` (see TestRegenerateQuantityFixture in this "+
			"file). A curated sample is what hid the trailing-dot divergence.",
			len(missing), shown)
	}
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
