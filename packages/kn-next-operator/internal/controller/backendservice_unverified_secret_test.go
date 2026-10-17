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
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// --- an unreadable Secret is NOT a violation (#2498) --------------------------
//
// A Secret lookup that errored (not NotFound) says nothing about the Secret's
// marks: it is reported as unverified, never refused. Only a definitive answer
// refuses a function. The reconciler-level proof (the Knative Service survives)
// is backendservice_transient_secret_envtest_test.go.

func readFails(names ...string) secretLookup {
	return func(name string) secretMetadata {
		for _, n := range names {
			if n == name {
				return secretMetadata{readErr: "simulated apiserver timeout"}
			}
		}
		return secretMetadata{}
	}
}

func TestSovereigntyUnreadableSecretIsUnverifiedNotAViolation(t *testing.T) {
	zone, others := sovFixture()
	for _, src := range secretSources {
		got, unverified := checkFunctionSovereignty(sovFunction(src.spec("stripe-key")), zone, others, readFails("stripe-key"))
		if len(got) != 0 {
			t.Errorf("%s: an unreadable Secret must not be a violation, got %+v", src.name, got)
		}
		if len(unverified) != 1 || unverified[0].name != "stripe-key" || !strings.Contains(unverified[0].err, "timeout") {
			t.Errorf("%s: want exactly stripe-key unverified with the error named, got %+v", src.name, unverified)
		}
	}
}

// Both halves: a NotFound lookup (no readErr) is still the definitive "unmarked".
func TestSovereigntyNotFoundSecretIsStillAViolationNotUnverified(t *testing.T) {
	zone, others := sovFixture()
	got, unverified := checkFunctionSovereignty(sovFunction(specSecretKeyRef("ghost")), zone, others, noSecrets())
	assertOneViolation(t, got, "env[DSN].valueFrom.secretKeyRef", "ghost", "not marked for zone")
	if len(unverified) != 0 {
		t.Errorf("a NotFound Secret is a definitive answer, not unverified: %+v", unverified)
	}
}

// A definitive violation in the same function is still reported alongside an
// unverified Secret: the unknown one never masks the known one.
func TestSovereigntyDefinitiveViolationSurvivesAnUnverifiedNeighbour(t *testing.T) {
	zone, others := sovFixture()
	bs := sovFunction(appsv1alpha1.BackendServiceSpec{
		Env:     specSecretKeyRef(sovForeignDB).Env,
		EnvFrom: specEnvFromSecret("stripe-key").EnvFrom,
	})
	got, unverified := checkFunctionSovereignty(bs, zone, others, readFails("stripe-key"))
	assertOneViolation(t, got, "env[DSN].valueFrom.secretKeyRef", sovForeignDB, "database Secret")
	if len(unverified) != 1 {
		t.Errorf("want the unreadable neighbour unverified, got %+v", unverified)
	}
}

// A decision that needs no read stays a decision: no zone means no Secret is
// allowed, whatever the lookup says.
func TestSovereigntyNoZoneRefusesEvenWhenTheReadFails(t *testing.T) {
	_, others := sovFixture()
	got, unverified := checkFunctionSovereignty(sovFunction(specEnvFromSecret("stripe-key")), nil, others, readFails("stripe-key"))
	assertOneViolation(t, got, "envFrom[0].secretRef", "stripe-key", "does not exist")
	if len(unverified) != 0 {
		t.Errorf("a missing zone refuses regardless of the read: %+v", unverified)
	}
}

func TestUndecidedOnlyWhenOtherwiseAccepted(t *testing.T) {
	zone, _ := sovFixture()
	base := functionObservation{zone: zone, zoneListed: true, unverified: []unverifiedSecret{{name: "s", err: "e"}}}
	if !base.undecided() {
		t.Fatal("an otherwise-accepted function with an unverified Secret is undecided")
	}
	refused := base
	refused.violations = []sovereigntyViolation{{name: "x"}}
	if refused.undecided() {
		t.Error("a definitive violation decides it (refused), however many Secrets were unreadable")
	}
	clean := base
	clean.unverified = nil
	if clean.undecided() {
		t.Error("no unverified Secret means decided")
	}
}

// --- guard: no API error may reach a teardown or a violation (#2498) ----------
//
// SCANS the BackendService reconciler sources (not an enumerated list of call
// sites), so a new path from an API error to removeRendered, or to a
// sovereignty violation, fails here instead of deleting someone's running
// function on an apiserver blip.
//
//	G1  removeRendered is called only from Reconcile, in exactly two places: the
//	    finalizer (deletion) block, and the else of obs.accepted().
//	G2  no branch whose condition mentions an error value (err, readErr, rmErr,
//	    getErr ...) may call removeRendered or build a sovereigntyViolation in
//	    its body: an error is "no answer", never a verdict.
//	G3  Reconcile leaves on obs.undecided() (returning an error) BEFORE the
//	    accepted()/removeRendered fork.

var bsReconcilerSources = []string{
	"backendservice_controller.go",
	"backendservice_render.go",
	"backendservice_sovereignty.go",
	"backendservice_verdict.go",
}

func exprString(fset *token.FileSet, n ast.Node) string {
	var b bytes.Buffer
	_ = printer.Fprint(&b, fset, n)
	return b.String()
}

// condMentionsError reports whether a branch condition reads an error value.
func condMentionsError(e ast.Expr) bool {
	found := false
	ast.Inspect(e, func(n ast.Node) bool {
		var name string
		switch x := n.(type) {
		case *ast.Ident:
			name = x.Name
		case *ast.SelectorExpr:
			name = x.Sel.Name
		default:
			return true
		}
		if l := strings.ToLower(name); l == "err" || strings.HasSuffix(l, "err") {
			found = true
		}
		return true
	})
	return found
}

// teardownOrVerdictIn returns the position of the first removeRendered call or
// sovereigntyViolation literal inside body.
func teardownOrVerdictIn(fset *token.FileSet, body ast.Node) []string {
	var hits []string
	ast.Inspect(body, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.CallExpr:
			if sel, ok := x.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "removeRendered" {
				hits = append(hits, fset.Position(x.Pos()).String()+": removeRendered")
			}
		case *ast.CompositeLit:
			if id, ok := x.Type.(*ast.Ident); ok && id.Name == "sovereigntyViolation" {
				hits = append(hits, fset.Position(x.Pos()).String()+": sovereigntyViolation")
			}
		}
		return true
	})
	return hits
}

func TestNoAPIErrorReachesTeardownOrAViolation(t *testing.T) {
	errBranches := 0
	for _, file := range bsReconcilerSources {
		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, file, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", file, err)
		}
		ast.Inspect(f, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.IfStmt:
				if condMentionsError(x.Cond) {
					errBranches++
					for _, h := range teardownOrVerdictIn(fset, x.Body) {
						t.Errorf("%s: a branch on an error value reaches %s (an error is no answer: return it and requeue)", file, h)
					}
					if x.Else != nil && !strings.Contains(exprString(fset, x.Cond), "!= nil") {
						// `if err == nil {...} else {teardown}`: the else IS the error branch.
						for _, h := range teardownOrVerdictIn(fset, x.Else) {
							t.Errorf("%s: the error arm of a branch reaches %s", file, h)
						}
					}
				}
			case *ast.CaseClause:
				for _, e := range x.List {
					if condMentionsError(e) {
						errBranches++
						for _, stmt := range x.Body {
							for _, h := range teardownOrVerdictIn(fset, stmt) {
								t.Errorf("%s: a case on an error value reaches %s (an error is no answer: return it and requeue)", file, h)
							}
						}
					}
				}
			}
			return true
		})
	}
	// Both halves: a scan that sees no error branch proves nothing.
	if errBranches < 10 {
		t.Fatalf("scanned only %d error-conditioned branches; the scan is not seeing the code", errBranches)
	}
}

func TestRemoveRenderedHasTwoSanctionedCallSites(t *testing.T) {
	sanctioned := map[string]bool{}
	for _, file := range bsReconcilerSources {
		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, file, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", file, err)
		}
		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			var stack []ast.Node
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				if n == nil {
					stack = stack[:len(stack)-1]
					return true
				}
				stack = append(stack, n)
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok || sel.Sel.Name != "removeRendered" {
					return true
				}
				pos := fset.Position(call.Pos()).String()
				if fn.Name.Name != "Reconcile" {
					t.Errorf("%s: removeRendered is called from %s; only Reconcile may tear a function down", pos, fn.Name.Name)
					return true
				}
				// Which sanctioned fork is it in? Walk the enclosing statements.
				for i := len(stack) - 2; i >= 0; i-- {
					ifs, ok := stack[i].(*ast.IfStmt)
					if !ok {
						continue
					}
					cond := exprString(fset, ifs.Cond)
					inElse := ifs.Else != nil && ifs.Else.Pos() <= call.Pos() && call.End() <= ifs.Else.End()
					switch {
					case strings.Contains(cond, "ContainsFinalizer") && !inElse:
						sanctioned["finalizer"] = true
						return true
					case cond == "obs.accepted()" && inElse:
						sanctioned["refused"] = true
						return true
					}
				}
				t.Errorf("%s: removeRendered is outside the two sanctioned forks (the finalizer block, "+
					"the else of obs.accepted()): a function may be torn down only by deletion or a definitive refusal", pos)
				return true
			})
		}
	}
	if !sanctioned["finalizer"] || !sanctioned["refused"] {
		t.Fatalf("the scan must see both sanctioned call sites, saw %v", sanctioned)
	}
}

func TestReconcileLeavesOnUndecidedBeforeTheAcceptedFork(t *testing.T) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "backendservice_controller.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var undecided, accepted token.Pos
	var undecidedBody *ast.BlockStmt
	var verdictApplied, heldReturned token.Pos
	for _, decl := range f.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Name.Name != "Reconcile" {
			continue
		}
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.IfStmt:
				switch exprString(fset, x.Cond) {
				case "obs.undecided()":
					undecided, undecidedBody = x.Pos(), x.Body
				case "obs.accepted()":
					accepted = x.Pos()
				}
			case *ast.CallExpr:
				if sel, ok := x.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "applyFunctionVerdict" {
					verdictApplied = x.Pos()
				}
			case *ast.ReturnStmt:
				if len(x.Results) == 2 {
					if id, ok := x.Results[1].(*ast.Ident); ok && id.Name == "heldErr" {
						heldReturned = x.Pos()
					}
				}
			}
			return true
		})
	}
	if undecided == token.NoPos || accepted == token.NoPos {
		t.Fatalf("Reconcile must contain both `if obs.undecided()` and `if obs.accepted()` (undecided=%v accepted=%v)", undecided, accepted)
	}
	if undecided > accepted {
		t.Error("the obs.undecided() branch must come BEFORE the obs.accepted() fork, or an unknown answer reaches the teardown")
	}
	// The undecided branch neither renders nor removes: it only observes.
	ast.Inspect(undecidedBody, func(n ast.Node) bool {
		if call, ok := n.(*ast.CallExpr); ok {
			if sel, ok := call.Fun.(*ast.SelectorExpr); ok && (sel.Sel.Name == "removeRendered" || sel.Sel.Name == "render") {
				t.Errorf("%s: the obs.undecided() branch calls %s; an unknown answer must neither render nor remove", fset.Position(call.Pos()), sel.Sel.Name)
			}
		}
		return true
	})
	// The error is held and returned AFTER the verdict is applied, so the requeue
	// carries the SecretsUnverified status.
	if heldReturned == token.NoPos {
		t.Error("Reconcile must return the held error (`return ctrl.Result{}, heldErr`) so the reconcile requeues with backoff")
	} else if verdictApplied == token.NoPos || heldReturned < verdictApplied {
		t.Error("the held error must be returned AFTER applyFunctionVerdict, so the status says SecretsUnverified")
	}
}

// The verdict for an undecided pass: Unknown, never a violation, and a function
// that was never rendered is not Ready.
func TestVerdictForAnUndecidedFunctionIsUnverifiedNotAViolation(t *testing.T) {
	zone, _ := sovFixture()
	bs := sovFunction(appsv1alpha1.BackendServiceSpec{})
	o := functionObservation{zone: zone, zoneListed: true, unverified: []unverifiedSecret{{name: "stripe", err: "boom"}}}
	v := computeBackendServiceVerdict(bs, o)
	byType := map[string]metav1.Condition{}
	for _, c := range v.conditions {
		byType[c.Type] = c
	}
	sov := byType[ConditionSovereigntyCompliant]
	if sov.Status != metav1.ConditionUnknown || sov.Reason != ReasonSecretsUnverified || !strings.Contains(sov.Message, `"stripe"`) {
		t.Errorf("SovereigntyCompliant = %+v; want Unknown/SecretsUnverified naming the Secret", sov)
	}
	if strings.Contains(sov.Message, "boom") {
		t.Error("the condition message must not carry the transient error text (it would churn status)")
	}
	ready := byType[ConditionReady]
	if ready.Status != metav1.ConditionFalse || ready.Reason != ReasonSecretsUnverified {
		t.Errorf("Ready = %+v; want False/SecretsUnverified for a never-rendered function", ready)
	}
	if v.refusal != "" {
		t.Errorf("an unknown answer is not a refusal; the refusals metric got %q", v.refusal)
	}
	if len(v.events) != 1 || v.events[0].reason != ReasonSecretsUnverified {
		t.Errorf("want one SecretsUnverified event, got %+v", v.events)
	}
	for _, c := range v.conditions {
		if c.Reason == ReasonSovereigntyViolation || c.Reason == ReasonSecretNotAllowed {
			t.Errorf("%s carries the violation reason %s for an unknown answer", c.Type, c.Reason)
		}
	}
}
