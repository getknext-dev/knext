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
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// #635: resource.ParseQuantity does not return for some user-typable values.
//
// MEASURED on this module's apimachinery (see the PR body for the full table):
//
//	"1e999999"            -> returns in ~1 µs, accepted
//	"1e2147483647"        -> returns in ~1 µs, accepted
//	"1e2147483648"        -> DOES NOT RETURN within 45 s, heap climbing
//	"1e00000002147483648" -> same (leading zeros do not help)
//	"-1e2147483648"       -> same
//	1_000_000-digit mantissa -> ~1.2 s
//
// ValidateNextAppSpec is called from Reconcile (nextapp_controller.go), so a
// stored NextApp carrying such a value wedges a workqueue worker forever —
// silently, with no panic, event or condition. And such a CR IS storable:
// MEASURED against a real apiserver (envtest), a NextApp with
// spec.resources.cpuRequest="1e2147483648" is persisted verbatim, because the
// CRD types every quantity field as a plain `string` with no pattern, so the
// apiserver never parses it. The webhook is the only thing that would have
// stopped it — and it is not always in the path (not installed, an older
// operator, a CR that predates the guard; the same premise as the #455
// blast-radius envtest).
//
// The guard is therefore in the SHARED validator, not admission-only, and this
// is not a narrowing of the accepted domain in the sense ADR-0017 §2.1 protects:
// a stored CR in this class does not reconcile TODAY (the worker hangs before
// producing any ksvc/PVC/NetworkPolicy). The change turns an unbounded hang into
// a prompt, field-named rejection. Nothing that reconciles stops reconciling.

// quantityValidationBudget is the wall-clock budget a SINGLE validation of a
// single quantity must fit in, accepted or rejected.
//
// Why 1 s: the slowest legitimate value measured here is ~0.2 ms (a cold first
// ParseQuantity call), so the budget carries >1000× headroom for a loaded CI
// runner and cannot flake on scheduling noise. It is also >45× BELOW the
// unguarded pathological case, which was still running after 45 s — i.e. the
// gap between "fits the budget" and "wedges the worker" is not a close call in
// either direction.
const quantityValidationBudget = time.Second

// validateWithin runs ValidateNextAppSpec on a goroutine and reports whether it
// returned within the budget. It deliberately does NOT wait for a straggler:
// the failure mode under test is non-termination, so a leaked goroutine on the
// failure path is the point, not an oversight.
func validateWithin(t *testing.T, spec *appsv1alpha1.NextAppSpec, budget time.Duration) (returned bool, err error, elapsed time.Duration) {
	t.Helper()
	done := make(chan error, 1)
	start := time.Now()
	go func() { done <- ValidateNextAppSpec(spec) }()
	select {
	case err = <-done:
		return true, err, time.Since(start)
	case <-time.After(budget):
		return false, nil, time.Since(start)
	}
}

func specWithResourceField(t *testing.T, fieldIndex int, value string) *appsv1alpha1.NextAppSpec {
	t.Helper()
	resources := &appsv1alpha1.ResourcesSpec{}
	reflect.ValueOf(resources).Elem().Field(fieldIndex).SetString(value)
	return &appsv1alpha1.NextAppSpec{
		Image:     "registry.example.com/app@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
		Resources: resources,
	}
}

// pathologicalQuantities is the class this issue is about: values a user can
// type into a CR that make resource.ParseQuantity run unbounded.
var pathologicalQuantities = []string{
	"1e2147483648",
	"1E2147483648",
	"1e+2147483648",
	"-1e2147483648",
	"1e-2147483648",
	"1e00000002147483648", // leading zeros: a raw digit-count bound would not catch the magnitude
	"1e4000000000",
}

// TestPathologicalExponentIsRejectedPromptlyOnEveryResourceField SCANS
// ResourcesSpec rather than enumerating its four fields — a fifth quantity
// field added without the bound is exactly how this class comes back.
func TestPathologicalExponentIsRejectedPromptlyOnEveryResourceField(t *testing.T) {
	rt := reflect.TypeOf(appsv1alpha1.ResourcesSpec{})
	if rt.NumField() == 0 {
		t.Fatal("scanned no ResourcesSpec fields; the scan itself is broken")
	}
	for i := 0; i < rt.NumField(); i++ {
		field := rt.Field(i)
		for _, value := range pathologicalQuantities {
			spec := specWithResourceField(t, i, value)
			returned, err, elapsed := validateWithin(t, spec, quantityValidationBudget)
			if !returned {
				t.Errorf("spec.resources.%s=%q: ValidateNextAppSpec did NOT return within %v — "+
					"this is the #635 wedge: a reconcile worker parked forever on user-controlled input",
					field.Name, value, quantityValidationBudget)
				continue
			}
			if err == nil {
				t.Errorf("spec.resources.%s=%q: accepted, but a quantity with an absurd exponent "+
					"must be rejected (it can never size a container, and parsing it is unbounded)",
					field.Name, value)
			}
			if elapsed > quantityValidationBudget {
				t.Errorf("spec.resources.%s=%q: rejected but took %v (budget %v)",
					field.Name, value, elapsed, quantityValidationBudget)
			}
		}
	}
}

// TestPathologicalExponentIsRejectedPromptlyOnBytecodeCacheSize covers the
// OTHER user-supplied quantity in the spec — the PVC size — through the same
// shared validator.
func TestPathologicalExponentIsRejectedPromptlyOnBytecodeCacheSize(t *testing.T) {
	for _, value := range pathologicalQuantities {
		spec := &appsv1alpha1.NextAppSpec{
			Image: "registry.example.com/app@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
			Cache: &appsv1alpha1.CacheSpec{BytecodeCacheSize: value},
		}
		returned, err, elapsed := validateWithin(t, spec, quantityValidationBudget)
		if !returned {
			t.Errorf("spec.cache.bytecodeCacheSize=%q: ValidateNextAppSpec did NOT return within %v",
				value, quantityValidationBudget)
			continue
		}
		if err == nil {
			t.Errorf("spec.cache.bytecodeCacheSize=%q: accepted, but the absurd-exponent class must be rejected", value)
		}
		if elapsed > quantityValidationBudget {
			t.Errorf("spec.cache.bytecodeCacheSize=%q: rejected but took %v (budget %v)", value, elapsed, quantityValidationBudget)
		}
	}
}

// TestOversizedQuantityStringIsRejectedPromptly covers the second cost axis the
// exponent bound does not touch: a mantissa long enough that big-int parsing
// alone is slow. MEASURED: a 1,000,000-digit mantissa parses in ~1.2 s, which
// on its own breaches the budget above with no absurd exponent in sight.
func TestOversizedQuantityStringIsRejectedPromptly(t *testing.T) {
	huge := strings.Repeat("9", 1_000_000)
	for _, value := range []string{huge, huge + "Mi"} {
		spec := specWithResourceField(t, 0, value)
		returned, err, elapsed := validateWithin(t, spec, quantityValidationBudget)
		if !returned {
			t.Fatalf("a %d-character quantity did not validate within %v", len(value), quantityValidationBudget)
		}
		if err == nil {
			t.Errorf("a %d-character quantity was accepted; no Kubernetes quantity is that long", len(value))
		}
		if elapsed > quantityValidationBudget {
			t.Errorf("a %d-character quantity took %v to reject (budget %v)", len(value), elapsed, quantityValidationBudget)
		}
	}
}

// TestLegitimateQuantitiesStayAcceptedAndPrompt is the other half: the bound
// must not cost any value a real deployment uses. Every one of these is a
// quantity someone plausibly writes for CPU, memory or a PVC.
func TestLegitimateQuantitiesStayAcceptedAndPrompt(t *testing.T) {
	legitimate := []string{
		"1", "250m", "0.5", "1.5", "100m", "2", "1000m",
		"512Mi", "1Gi", "64Mi", "8Gi", "1Ti", "500k", "1M", "1G", "1E", "1Ei",
		"1e3", "1e9", "1E3", "1e+3", "1.5e3", "+1e3", "1e9999", "1e0000009",
	}
	for _, value := range legitimate {
		spec := specWithResourceField(t, 0, value)
		returned, err, elapsed := validateWithin(t, spec, quantityValidationBudget)
		if !returned {
			t.Errorf("legitimate quantity %q did not validate within %v", value, quantityValidationBudget)
			continue
		}
		if err != nil {
			t.Errorf("legitimate quantity %q was rejected: %v — the exponent/length bound must not "+
				"cost expressiveness anyone uses", value, err)
		}
		if elapsed > quantityValidationBudget {
			t.Errorf("legitimate quantity %q took %v to validate (budget %v)", value, elapsed, quantityValidationBudget)
		}
	}
}

// TestEveryQuantityParseOfCRInputGoesThroughTheBoundedHelper SCANS the
// operator's own source instead of enumerating the parse sites. Any
// resource.ParseQuantity / resource.MustParse call whose argument is NOT a
// string literal is parsing something that can come from a CR, and must go
// through validation.ParseQuantityBounded — the #635 hang is in the parser, so
// a second, unbounded call site reintroduces it whatever the validator does.
//
// Literal-argument calls (resource.MustParse("250m") for the operator's own
// defaults) are allowed and are also what proves the scanner is looking at real
// call expressions rather than finding nothing.
func TestEveryQuantityParseOfCRInputGoesThroughTheBoundedHelper(t *testing.T) {
	root := filepath.Join("..", "..")
	var offenders []string
	literalCalls, filesScanned := 0, 0

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case "bin", "vendor", "node_modules", "test", "tmpmeasure", "dist":
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		// The bounded helper itself is the one place that MUST call the raw parser.
		if filepath.Base(path) == "quantity.go" && strings.Contains(path, filepath.Join("internal", "validation")) {
			return nil
		}
		fset := token.NewFileSet()
		file, perr := parser.ParseFile(fset, path, nil, 0)
		if perr != nil {
			return perr
		}
		filesScanned++
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			pkg, ok := sel.X.(*ast.Ident)
			if !ok || pkg.Name != "resource" {
				return true
			}
			if sel.Sel.Name != "ParseQuantity" && sel.Sel.Name != "MustParse" {
				return true
			}
			if len(call.Args) == 1 {
				if lit, isLit := call.Args[0].(*ast.BasicLit); isLit && lit.Kind == token.STRING {
					literalCalls++
					return true
				}
			}
			offenders = append(offenders, fmt.Sprintf("%s:%d resource.%s",
				filepath.ToSlash(path), fset.Position(call.Pos()).Line, sel.Sel.Name))
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatalf("walking operator sources: %v", err)
	}
	if filesScanned == 0 {
		t.Fatal("scanned no Go files; the scan itself is broken, not passing")
	}
	if literalCalls == 0 {
		t.Fatal("scan found no resource.MustParse(\"literal\") call at all — it is not actually " +
			"recognising quantity parse calls, so its silence proves nothing")
	}
	if len(offenders) > 0 {
		t.Errorf("these call resource.ParseQuantity/MustParse on non-literal (CR-derived) input "+
			"instead of validation.ParseQuantityBounded, reintroducing the #635 unbounded parse: %v",
			offenders)
	}
}
