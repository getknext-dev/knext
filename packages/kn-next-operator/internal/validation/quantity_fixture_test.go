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
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

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
//
// #635 amends the model in ONE respect, and it is worth stating plainly because
// "accepted == what apimachinery says" was the fixture's whole premise: the
// operator is now deliberately NARROWER than apimachinery for two bounded
// classes, because apimachinery's parser is not a bounded computation on user
// input (`resource.ParseQuantity("1e2147483648")` does not return). So
// `accepted` means "KNEXT accepts" — the verdict the operator's validator and
// the CLI's regex must BOTH reach — and the new `parser` field records what
// apimachinery itself does whenever the two differ. Nothing silently claims
// apimachinery's blessing for a knext-specific rule.
const quantityFixturePath = "../../test/fixtures/quantity-grammar.json"

// parser classifications for rows where knext and apimachinery differ.
const (
	// parserAgrees (the empty value / absent field) — apimachinery's verdict is
	// the same as `accepted`. True of every row except the #635 additions.
	parserAgrees = ""
	// parserAcceptsBeyondBound — apimachinery parses it to a positive quantity,
	// knext rejects it because it is outside the #635 exponent/length bound.
	parserAcceptsBeyondBound = "acceptsBeyondBound"
	// parserNonTerminating — resource.ParseQuantity does not return on it at
	// all. This is the class the issue is about.
	parserNonTerminating = "nonTerminating"
)

type quantityFixture struct {
	Cases []struct {
		Value    string `json:"value"`
		Accepted bool   `json:"accepted"`
		Parser   string `json:"parser,omitempty"`
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
	// #635 — the absurd-exponent class. The first seven make
	// resource.ParseQuantity run unbounded (MEASURED: still running after 45 s);
	// the rest sit above the knext bound while apimachinery still parses them
	// fast, which is exactly the pair of behaviours the `parser` field exists to
	// keep honest. "1e9999" / "1e0000009" are the just-inside neighbours: the
	// bound must not eat them.
	"1e2147483648", "1E2147483648", "1e+2147483648", "-1e2147483648",
	"1e-2147483648", "1e00000002147483648", "1e4000000000",
	"1e10000", "1e123456", "1e2147483648Mi",
	"1e9999", "1e0000009",
	// The other cost axis: a string too long to parse cheaply. 65 characters,
	// one past the bound — the shortest possible proof that the bound exists.
	strings.Repeat("9", 65),
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
		Parser   string `json:"parser,omitempty"`
		Note     string `json:"note"`
	}
	cases := make([]genCase, 0, len(values))
	for _, v := range values {
		outcome := parseQuantityOutcome(t, v)
		bounded := checkQuantityBounds(v)
		c := genCase{
			Value:    v,
			Accepted: bounded == nil && outcome.returned && outcome.err == nil && outcome.sign > 0,
		}
		switch {
		case !outcome.returned:
			c.Parser = parserNonTerminating
			c.Note = "resource.ParseQuantity DOES NOT RETURN on it (#635); knext rejects it on the bound, before parsing"
		case bounded != nil && outcome.err == nil && outcome.sign > 0:
			c.Parser = parserAcceptsBeyondBound
			c.Note = "apimachinery parses it, but it is outside the knext quantity bound (#635)"
		case bounded != nil:
			c.Note = "outside the knext quantity bound (#635), and ParseQuantity would reject it anyway"
		case outcome.err != nil:
			c.Note = "ParseQuantity rejects it"
		case outcome.sign <= 0:
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
	"'accepted' means: KNEXT accepts the string as a positive resource quantity -- the verdict",
	"the operator's validator AND the CLI's regex must both reach. For almost every row that is",
	"exactly 'resource.ParseQuantity succeeds AND Quantity.Sign() > 0'.",
	"'parser' is present only where knext is deliberately NARROWER than apimachinery (#635):",
	"  'acceptsBeyondBound' -- apimachinery parses it to a positive quantity, but its decimal",
	"                          exponent or its length is outside the knext bound;",
	"  'nonTerminating'     -- resource.ParseQuantity DOES NOT RETURN on it (e.g. '1e2147483648'),",
	"                          which is why the bound is checked BEFORE parsing: this value",
	"                          otherwise parks a reconcile worker forever.",
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
	// The junk list is not compositional, so the cross-product above cannot
	// cover it — and it is where the #635 absurd-exponent rows live. Dropping
	// one of those rows would quietly stop the CLI mirror being checked against
	// the class that wedges a reconcile worker.
	for _, j := range quantityGrammarJunk {
		if !present[j] {
			missing = append(missing, j)
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
// a usable contract for the CLI if it is itself true of the real parser.
//
// Since #635 the fixture's `accepted` is the KNEXT verdict, which is
// apimachinery's verdict AND the quantity bound. So every row is checked against
// apimachinery, and the `parser` field says which of the three relationships is
// being asserted — including "does not return", which is a real, verified claim
// here rather than a comment.
func TestQuantityFixtureMatchesApimachinery(t *testing.T) {
	fx := loadQuantityFixture(t)
	sawNonTerminating, sawBeyondBound := 0, 0
	for _, c := range fx.Cases {
		outcome := parseQuantityOutcome(t, c.Value)
		switch c.Parser {
		case parserNonTerminating:
			sawNonTerminating++
			if outcome.returned {
				t.Errorf("fixture claims resource.ParseQuantity does not return for %q, but it "+
					"returned (err=%v). Either apimachinery fixed the unbounded parse — in which "+
					"case regenerate the fixture — or the row is wrong.", c.Value, outcome.err)
			}
			if c.Accepted {
				t.Errorf("%q: a value the parser never finishes cannot be accepted", c.Value)
			}
		case parserAcceptsBeyondBound:
			sawBeyondBound++
			if !outcome.returned || outcome.err != nil || outcome.sign <= 0 {
				t.Errorf("fixture claims apimachinery accepts %q (knext rejects it on the bound), "+
					"but apimachinery does not: returned=%v err=%v sign=%d",
					c.Value, outcome.returned, outcome.err, outcome.sign)
			}
			if c.Accepted {
				t.Errorf("%q is marked %q, so knext must reject it", c.Value, parserAcceptsBeyondBound)
			}
			if checkQuantityBounds(c.Value) == nil {
				t.Errorf("%q is marked %q, but it is INSIDE the knext bound — the row and the "+
					"bound disagree", c.Value, parserAcceptsBeyondBound)
			}
		case parserAgrees:
			accepted := outcome.returned && outcome.err == nil && outcome.sign > 0
			if accepted != c.Accepted {
				t.Errorf("fixture disagrees with resource.ParseQuantity for %q: fixture says accepted=%v, apimachinery says %v (err=%v)",
					c.Value, c.Accepted, accepted, outcome.err)
			}
		default:
			t.Errorf("%q carries an unknown parser classification %q", c.Value, c.Parser)
		}
	}
	// Both halves of the scan: the classifications above only mean something if
	// the fixture actually carries rows in each class. A fixture that quietly
	// lost the #635 rows would otherwise pass this test by having nothing to
	// check.
	if sawNonTerminating == 0 {
		t.Error("fixture carries no " + parserNonTerminating + " row — the class this guard exists " +
			"for (#635) is not represented, so the test proves nothing")
	}
	if sawBeyondBound == 0 {
		t.Error("fixture carries no " + parserAcceptsBeyondBound + " row — nothing pins the fact " +
			"that knext is deliberately narrower than apimachinery (#635)")
	}
}

// quantityParseOutcome is what resource.ParseQuantity did with a value —
// including "nothing, it is still running".
type quantityParseOutcome struct {
	returned bool
	err      error
	sign     int
}

// parseQuantityOutcomeBudget is how long a parse gets before it is called
// non-terminating. MEASURED: every in-bounds value parses in under 1 ms, and the
// pathological ones were still running after 45 s — there is nothing in between
// to be sensitive to.
const parseQuantityOutcomeBudget = 2 * time.Second

// parseQuantityOutcome runs resource.ParseQuantity on a value SAFELY.
//
// In-bounds values are parsed in-process: that is what the bound guarantees.
// Out-of-bounds values are parsed in a SUBPROCESS which is killed at the budget
// — a goroutine cannot be killed, and a leaked one parsing "1e2147483648" keeps
// allocating (MEASURED: ~440 MiB across five leaked parses in 25 s), so an
// in-process timeout here would slowly poison the rest of the suite.
func parseQuantityOutcome(t *testing.T, value string) quantityParseOutcome {
	t.Helper()
	if checkQuantityBounds(value) == nil {
		q, err := resource.ParseQuantity(value)
		return quantityParseOutcome{returned: true, err: err, sign: signOf(q, err)}
	}
	return parseQuantityInSubprocess(t, value)
}

func signOf(q resource.Quantity, err error) int {
	if err != nil {
		return 0
	}
	return q.Sign()
}

const quantityParseValueEnv = "KNEXT_QUANTITY_PARSE_VALUE_B64"

// TestQuantityParseSubprocess is the child half of parseQuantityInSubprocess.
// It is a no-op unless the parent re-execs the test binary with the env var set.
func TestQuantityParseSubprocess(t *testing.T) {
	encoded, ok := os.LookupEnv(quantityParseValueEnv)
	if !ok {
		t.Skip("child-process helper for parseQuantityInSubprocess")
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("undecodable %s: %v", quantityParseValueEnv, err)
	}
	q, perr := resource.ParseQuantity(string(raw))
	if perr != nil {
		fmt.Printf("KNEXT_PARSE_RESULT err\n")
		return
	}
	fmt.Printf("KNEXT_PARSE_RESULT ok %d\n", q.Sign())
}

func parseQuantityInSubprocess(t *testing.T, value string) quantityParseOutcome {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), parseQuantityOutcomeBudget)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestQuantityParseSubprocess$", "-test.v")
	cmd.Env = append(os.Environ(),
		quantityParseValueEnv+"="+base64.StdEncoding.EncodeToString([]byte(value)))
	out, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return quantityParseOutcome{returned: false}
	}
	if err != nil {
		t.Fatalf("child parse process for %q failed (%v): %s", value, err, out)
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "KNEXT_PARSE_RESULT") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) >= 3 && fields[1] == "ok" {
			sign, convErr := strconv.Atoi(fields[2])
			if convErr != nil {
				t.Fatalf("child reported an unparseable sign for %q: %q", value, line)
			}
			return quantityParseOutcome{returned: true, sign: sign}
		}
		return quantityParseOutcome{returned: true, err: errors.New("ParseQuantity rejected it")}
	}
	t.Fatalf("child parse process for %q reported nothing: %s", value, out)
	return quantityParseOutcome{}
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
