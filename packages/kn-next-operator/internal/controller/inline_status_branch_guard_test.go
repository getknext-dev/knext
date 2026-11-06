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
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"testing"
)

// setStatusConditionName is the call this guard looks for (a const for goconst).
const setStatusConditionName = "SetStatusCondition"

const nextAppControllerFile = "nextapp_controller.go"

// dynamicKeyPart marks an event argument that is not a literal/identifier.
const dynamicKeyPart = "<dynamic>"

// statusBranchScan is what scanStatusBranches reports.
type statusBranchScan struct {
	offenders       []string
	reachesVerdict  bool           // the validation branch calls computeStatusVerdict
	sawValidation   bool           // the validation branch exists in nextapp_controller.go
	events          map[string]int // "Method|Reason|format" -> occurrences, NextApp reconciler methods
	conditionWrites map[string]int // "file:func" -> SetStatusCondition occurrences
}

// sanctioned is an allowlist entry: the exact number of occurrences permitted and why.
type sanctioned struct {
	count  int
	reason string
}

// sanctionedConditionWriters are the only functions that may call
// SetStatusCondition, keyed "file:func", with the EXACT number of calls each may
// hold (a second write in an exempted function reds). Each is the single writer of
// ONE kind's verdict; a write anywhere else is an inline status branch.
var sanctionedConditionWriters = map[string]sanctioned{
	"nextapp_controller.go:applyStatusVerdict":          {1, "the single writer of a NextApp verdict"},
	"backendservice_controller.go:applyFunctionVerdict": {1, "the single writer of a BackendService verdict (a different kind)"},
	"platform_controller.go:Reconcile":                  {1, "KnextPlatform status (a different kind) is a copy of its computed desired state"},
}

const (
	stepErrorWhy = "step error: returned, precedes the verdict"
	envWarnWhy   = "user-env warning, not a status roll-up"
	cleanupWhy   = "finalizer best-effort cleanup warning"
)

// sanctionedNextAppEvents are the event emissions that already sat in the
// NextApp reconciler's methods before this ratchet, keyed
// "Method|Reason|message format" with the exact count. The Reconcile
// ReconcileFailed entries are hard-error paths (the step's error is also returned,
// which drives the backoff and precedes the verdict), so they cannot move into the
// verdict without changing the observable events. A NEW event in any
// *NextAppReconciler method is not in this map and reds; the right home for a new
// status event is computeStatusVerdict.
var sanctionedNextAppEvents = map[string]sanctioned{
	"Reconcile|ReasonReconcileFailed|Failed to reconcile ServiceAccount: %s":                                                         {1, stepErrorWhy},
	"Reconcile|ReasonReconcileFailed|Failed to reconcile the zone signing key: %s":                                                   {1, stepErrorWhy},
	"Reconcile|ReasonReconcileFailed|Failed to reconcile Knative Service: %s":                                                        {1, stepErrorWhy},
	"Reconcile|ReasonReconcileFailed|Failed to reconcile NetworkPolicy: %s":                                                          {1, stepErrorWhy},
	"Reconcile|ReasonReconcileFailed|Failed to reconcile KafkaSource: %s":                                                            {1, stepErrorWhy},
	"Reconcile|ReasonReconciled|NextApp reconciled successfully (image %s)":                                                          {1, "success event after the verdict is applied; not a status roll-up"},
	"applyStatusVerdict|reason|<dynamic>":                                                                                            {1, "the verdict path emitting the verdict's own events"},
	"emitEvent|reason|<dynamic>":                                                                                                     {1, "the Recorder wrapper itself"},
	"appendUserEnv|ReasonEnvVarIgnored|spec.env[%s] ignored: the %s* namespace is reserved by the operator (set spec.cdn instead)":   {1, envWarnWhy},
	"appendUserEnv|ReasonEnvVarIgnored|spec.env[%s] ignored: name is reserved/managed by %s":                                         {1, envWarnWhy},
	"warnDatabaseEnvOverride|ReasonEnvVarIgnored|spec.secrets.envMap[%s] (secret %q key %q) ignored: %s is managed by spec.database": {1, envWarnWhy},
	"cleanupExternalState|ReasonCleanupFailed|Object-store cleanup failed (best-effort, proceeding): ":                               {1, cleanupWhy},
	"cleanupExternalState|ReasonCleanupFailed|Redis cleanup failed (best-effort, proceeding): ":                                      {1, cleanupWhy},
}

// eventCallArgs maps each Recorder-style emitter to the index of its reason
// argument; the format/message follows it. Recorder.Event/Eventf and the
// reconciler's emitEvent take (obj, type, reason, msg, ...); AnnotatedEventf takes
// (obj, annotations, type, reason, fmt, ...), so everything shifts by one.
var eventCallArgs = map[string]int{
	"emitEvent":       2,
	"Event":           2,
	"Eventf":          2,
	"AnnotatedEventf": 3,
}

// eventKey names an event call by its enclosing method, reason and message format.
func eventKey(method, name string, call *ast.CallExpr) string {
	ri := eventCallArgs[name]
	if len(call.Args) <= ri+1 {
		return method + "|<unparseable>"
	}
	reason := dynamicKeyPart
	switch r := call.Args[ri].(type) {
	case *ast.Ident:
		reason = r.Name
	case *ast.SelectorExpr:
		reason = r.Sel.Name
	}
	msg := dynamicKeyPart
	ast.Inspect(call.Args[ri+1], func(n ast.Node) bool {
		if lit, ok := n.(*ast.BasicLit); ok && lit.Kind == token.STRING && msg == dynamicKeyPart {
			msg = strings.Trim(lit.Value, "\"")
		}
		return true
	})
	return method + "|" + reason + "|" + msg
}

// isNextAppReconcilerMethod reports whether fn has a *NextAppReconciler receiver.
func isNextAppReconcilerMethod(fn *ast.FuncDecl) bool {
	if fn.Recv == nil || len(fn.Recv.List) != 1 {
		return false
	}
	star, ok := fn.Recv.List[0].Type.(*ast.StarExpr)
	if !ok {
		return false
	}
	id, ok := star.X.(*ast.Ident)
	return ok && id.Name == "NextAppReconciler"
}

// findValidationBranch locates the body of the
// `if err := validation.ValidateNextAppSpec...(...); err != nil && ... { ... }`
// statement by its content, not by line number.
func findValidationBranch(f *ast.File) *ast.BlockStmt {
	var branch *ast.BlockStmt
	ast.Inspect(f, func(n ast.Node) bool {
		ifStmt, ok := n.(*ast.IfStmt)
		if !ok || ifStmt.Init == nil {
			return true
		}
		found := false
		ast.Inspect(ifStmt.Init, func(m ast.Node) bool {
			if sel, ok := m.(*ast.SelectorExpr); ok && strings.HasPrefix(sel.Sel.Name, "ValidateNextAppSpec") {
				found = true
			}
			return true
		})
		if found {
			branch = ifStmt.Body
		}
		return true
	})
	return branch
}

// scanStatusBranches scans the given non-test sources (name -> content).
// It is per-function LEXICAL, not a call graph: an event or condition write is
// attributed to the function whose body contains it.
func scanStatusBranches(t *testing.T, files map[string]string) statusBranchScan {
	t.Helper()
	res := statusBranchScan{events: map[string]int{}, conditionWrites: map[string]int{}}
	fset := token.NewFileSet()
	for file, src := range files {
		f, err := parser.ParseFile(fset, file, src, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", file, err)
		}
		var validationBranch *ast.BlockStmt
		if file == nextAppControllerFile {
			validationBranch = findValidationBranch(f)
			res.sawValidation = validationBranch != nil
		}
		inValidation := func(p token.Pos) bool {
			return validationBranch != nil && p > validationBranch.Lbrace && p < validationBranch.Rbrace
		}
		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			nextAppMethod := isNextAppReconcilerMethod(fn)
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				name := ""
				switch fun := call.Fun.(type) {
				case *ast.SelectorExpr:
					name = fun.Sel.Name
				case *ast.Ident:
					name = fun.Name
				}
				line := fset.Position(call.Pos()).Line

				if name == setStatusConditionName {
					key := file + ":" + fn.Name.Name
					res.conditionWrites[key]++
					if _, ok := sanctionedConditionWriters[key]; !ok {
						res.offenders = append(res.offenders, fmt.Sprintf(
							"%s:%d — SetStatusCondition in %s() is an inline status branch", file, line, fn.Name.Name))
					}
				}
				if !nextAppMethod {
					return true
				}
				if _, isEvent := eventCallArgs[name]; isEvent {
					k := eventKey(fn.Name.Name, name, call)
					res.events[k]++
					if inValidation(call.Pos()) {
						res.offenders = append(res.offenders, fmt.Sprintf(
							"%s:%d — event %q in the spec-validation branch of Reconcile; the outcome belongs in the verdict",
							file, line, k))
					} else if _, ok := sanctionedNextAppEvents[k]; !ok {
						res.offenders = append(res.offenders, fmt.Sprintf(
							"%s:%d — unsanctioned event %q in a NextApp reconciler method; the outcome belongs in the verdict",
							file, line, k))
					}
				}
				if fn.Name.Name == lcReconcile && file == nextAppControllerFile && inValidation(call.Pos()) {
					switch name {
					case "computeStatusVerdict":
						res.reachesVerdict = true
					case setStatusConditionName:
						res.offenders = append(res.offenders, fmt.Sprintf(
							"%s:%d — %s in the spec-validation branch of Reconcile; the outcome belongs in the verdict",
							file, line, name))
					}
				}
				return true
			})
		}
	}
	// Exact counts: a second write/emission inside an exempted function reds.
	for k, want := range sanctionedConditionWriters {
		if got := res.conditionWrites[k]; got > want.count {
			res.offenders = append(res.offenders, fmt.Sprintf(
				"%s has %d SetStatusCondition calls, only %d sanctioned (%s)", k, got, want.count, want.reason))
		}
	}
	for k, want := range sanctionedNextAppEvents {
		if got := res.events[k]; got > want.count {
			res.offenders = append(res.offenders, fmt.Sprintf(
				"event %q occurs %d times, only %d sanctioned (%s)", k, got, want.count, want.reason))
		}
	}
	return res
}

func readControllerSources(t *testing.T) map[string]string {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	files := map[string]string{}
	for _, e := range entries {
		n := e.Name()
		if e.IsDir() || !strings.HasSuffix(n, ".go") || strings.HasSuffix(n, "_test.go") {
			continue
		}
		b, err := os.ReadFile(n)
		if err != nil {
			t.Fatalf("read %s: %v", n, err)
		}
		files[n] = string(b)
	}
	return files
}

// The hard rule (`.claude/rules/architecture.md`) is absolute: honest-status
// conditions/events/requeues go in computeStatusVerdict, never as branches in
// Reconcile. This SCANS rather than enumerating, over EVERY non-test .go file in
// the package. It is per-function LEXICAL, not a call graph: a call is attributed
// to the function whose body contains it, so an emission reached only through a
// free function (no *NextAppReconciler receiver) is out of scope.
//
//   - every SetStatusCondition call must sit in a sanctioned verdict writer
//     (sanctionedConditionWriters, with reasons and exact counts);
//   - every Event/Eventf/AnnotatedEventf/emitEvent in ANY *NextAppReconciler
//     method must be in sanctionedNextAppEvents (reason + format, exact counts) —
//     a new event, in Reconcile or in a helper method, reds;
//   - the spec-validation branch must reach the verdict and write nothing itself.
//
// Both halves are asserted: the negative (no stray writes) and the positive (the
// verdict path is wired, the validation branch exists, every allowlist entry is
// still live), so deleting the subject cannot leave the guard green.
func TestNoInlineStatusBranchesInReconcile(t *testing.T) {
	res := scanStatusBranches(t, readControllerSources(t))

	for _, o := range res.offenders {
		t.Errorf("%s. Per .claude/rules/architecture.md and ADR-0040 it belongs in "+
			"computeStatusVerdict (status_verdict.go).", o)
	}
	if !res.sawValidation {
		t.Fatalf("could not find the spec-validation branch in %s — this guard is only "+
			"meaningful while that branch exists; if it moved, move the guard with it", nextAppControllerFile)
	}
	if !res.reachesVerdict {
		t.Errorf("the spec-validation branch no longer calls computeStatusVerdict — the " +
			"invalid-spec outcome must come from the verdict, not be dropped")
	}
	for k, want := range sanctionedConditionWriters {
		if res.conditionWrites[k] != want.count {
			t.Errorf("sanctioned condition writer %q has %d SetStatusCondition calls, want exactly %d — "+
				"fix the stale allowlist entry", k, res.conditionWrites[k], want.count)
		}
	}
	for k, want := range sanctionedNextAppEvents {
		if res.events[k] != want.count {
			t.Errorf("sanctioned event %q occurs %d times, want exactly %d — "+
				"remove or fix the stale allowlist entry", k, res.events[k], want.count)
		}
	}
}

// The scan itself must bite: prove it on synthetic sources, so a regression in
// the scan (not only in the controller) turns a test red.
func TestScanStatusBranches_Bites(t *testing.T) {
	const base = `package controller
func (r *NextAppReconciler) Reconcile() {
	if err := validation.ValidateNextAppSpec(x); err != nil {
		computeStatusVerdict()
	}
%s}
func (r *NextAppReconciler) applyStatusVerdict() { apimeta.SetStatusCondition(a, b)%s }
%s`
	mk := func(inReconcile, inApply, extra string) string {
		return fmt.Sprintf(base, inReconcile, inApply, extra)
	}
	clean := mk("", "", "")
	scan := func(t *testing.T, src string, more ...string) statusBranchScan {
		files := map[string]string{nextAppControllerFile: src}
		for i, m := range more {
			files[fmt.Sprintf("extra_%d.go", i)] = m
		}
		return scanStatusBranches(t, files)
	}
	wantOne := func(t *testing.T, res statusBranchScan, substr string) {
		t.Helper()
		if len(res.offenders) != 1 || !strings.Contains(res.offenders[0], substr) {
			t.Fatalf("offenders = %v, want exactly one containing %q", res.offenders, substr)
		}
	}

	t.Run("clean", func(t *testing.T) {
		res := scan(t, clean)
		if len(res.offenders) != 0 || !res.reachesVerdict || !res.sawValidation {
			t.Fatalf("clean source flagged: %+v", res)
		}
	})
	t.Run("new inline emitEvent in Reconcile", func(t *testing.T) {
		wantOne(t, scan(t, mk("\tr.emitEvent(a, w, ReasonReconcileFailed, fmt.Sprintf(\"brand new %s\", e))\n", "", "")), "brand new")
	})
	t.Run("new inline Event in Reconcile", func(t *testing.T) {
		wantOne(t, scan(t, mk("\tr.Recorder.Event(a, w, ReasonReconcileFailed, \"brand new event\")\n", "", "")), "brand new event")
	})
	t.Run("new inline Eventf in Reconcile", func(t *testing.T) {
		wantOne(t, scan(t, mk("\tr.Recorder.Eventf(a, w, ReasonReconcileFailed, \"brand new eventf %s\", e)\n", "", "")), "brand new eventf")
	})
	t.Run("new inline AnnotatedEventf in Reconcile (reason and format shift by one)", func(t *testing.T) {
		res := scan(t, mk("\tr.Recorder.AnnotatedEventf(a, ann, w, ReasonReconcileFailed, \"brand new annotated %s\", e)\n", "", ""))
		wantOne(t, res, "Reconcile|ReasonReconcileFailed|brand new annotated %s")
	})
	t.Run("event in a helper method of the NextApp reconciler", func(t *testing.T) {
		helper := "func (r *NextAppReconciler) helper() { r.emitEvent(a, w, ReasonReconcileFailed, \"from helper\") }\n"
		wantOne(t, scan(t, mk("", "", helper)), "helper|ReasonReconcileFailed|from helper")
	})
	t.Run("event in another reconciler's method is out of scope", func(t *testing.T) {
		other := "func (r *OtherReconciler) helper() { r.emitEvent(a, w, ReasonReconcileFailed, \"other kind\") }\n"
		if res := scan(t, mk("", "", other)); len(res.offenders) != 0 {
			t.Fatalf("offenders = %v, want none", res.offenders)
		}
	})
	t.Run("sanctioned event moved into the validation branch", func(t *testing.T) {
		src := strings.Replace(clean, "computeStatusVerdict()",
			"computeStatusVerdict()\n\t\tr.emitEvent(a, w, ReasonReconciled, fmt.Sprintf(\"NextApp reconciled successfully (image %s)\", i))", 1)
		wantOne(t, scan(t, src), "spec-validation branch")
	})
	t.Run("condition write in a helper in another file", func(t *testing.T) {
		other := "package controller\nfunc helper() { apimeta.SetStatusCondition(a, b) }\n"
		wantOne(t, scan(t, clean, other), "extra_0.go")
	})
	t.Run("condition write in Reconcile", func(t *testing.T) {
		wantOne(t, scan(t, mk("\tapimeta.SetStatusCondition(a, b)\n", "", "")), "Reconcile()")
	})
	t.Run("second condition write inside a sanctioned writer", func(t *testing.T) {
		wantOne(t, scan(t, mk("", "; apimeta.SetStatusCondition(a, c)", "")), "only 1 sanctioned")
	})
	t.Run("second condition write inside the exempted platform Reconcile", func(t *testing.T) {
		plat := "package controller\nfunc (r *KnextPlatformReconciler) Reconcile() { apimeta.SetStatusCondition(a, b); apimeta.SetStatusCondition(a, c) }\n"
		res := scanStatusBranches(t, map[string]string{nextAppControllerFile: clean, "platform_controller.go": plat})
		wantOne(t, res, "platform_controller.go:Reconcile has 2")
	})
}
