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
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// #471 item 4 — WHICH child reconcilers may fail the whole pass, and which may
// only degrade a condition.
//
// A child reconciler that returns its error out of Reconcile makes the whole
// app's status convergence hostage to that child. That is correct for the
// mandatory children (the ksvc IS the app; the NetworkPolicy is a security
// control). It is NOT correct for `imagePrewarm`, an OPT-IN cold-start
// optimisation: a persistent RBAC failure there used to abort the pass before
// the status verdict was even computed, so `Ready` went unwritten and the
// object sat in controller-runtime's exponential backoff — an optimisation
// taking the app down with it. Its failure now flows into imageCacheState and
// surfaces on ImageCacheReady alone.
//
// This is an ALLOWLIST that FAILS CLOSED, and it asserts BOTH halves:
//
//	(a) reconcileImagePrewarmDaemonSet's error must NOT reach a return; and
//	(b) every OTHER r.reconcile*/r.ensure* child call in Reconcile MUST return
//	    on error.
//
// So a newly-added child reconciler that quietly swallows its error fails here
// (it is not on the allowlist), and re-coupling the prewarmer fails here too.
// Scanning rather than enumerating is deliberate: the call sites are found in
// the AST, never listed.
func TestReconcileChildFatalityMatchesAllowlist(t *testing.T) {
	const file = "nextapp_controller.go"

	// The ONLY child reconcilers whose failure may be non-fatal to the pass.
	// Adding an entry here is a deliberate architectural statement: the child is
	// optional AND its failure is surfaced honestly by computeStatusVerdict.
	nonFatalAllowlist := map[string]bool{
		"reconcileImagePrewarmDaemonSet": true,
	}

	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, file, nil, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", file, err)
	}

	var reconcileFn *ast.FuncDecl
	for _, decl := range f.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if ok && fn.Name.Name == "Reconcile" && fn.Body != nil {
			reconcileFn = fn
		}
	}
	if reconcileFn == nil {
		t.Fatalf("no Reconcile function in %s — this guard is proving nothing", file)
	}

	// A child-reconciler call is any method call on the receiver whose name
	// starts with reconcile/ensure. Found by scan, not by list.
	isChildCall := func(call *ast.CallExpr) (string, bool) {
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return "", false
		}
		ident, ok := sel.X.(*ast.Ident)
		if !ok || ident.Name != "r" {
			return "", false
		}
		name := sel.Sel.Name
		if len(name) >= 9 && name[:9] == "reconcile" {
			return name, true
		}
		if len(name) >= 6 && name[:6] == "ensure" {
			return name, true
		}
		return "", false
	}

	containsCall := func(n ast.Node, want string) bool {
		found := false
		ast.Inspect(n, func(m ast.Node) bool {
			call, ok := m.(*ast.CallExpr)
			if !ok {
				return true
			}
			if name, is := isChildCall(call); is && name == want {
				found = true
			}
			return true
		})
		return found
	}

	hasReturn := func(n ast.Node) bool {
		found := false
		ast.Inspect(n, func(m ast.Node) bool {
			// Do not descend into nested function literals: a return inside a
			// CreateOrUpdate mutate-func is not a Reconcile return.
			if _, ok := m.(*ast.FuncLit); ok {
				return false
			}
			if _, ok := m.(*ast.ReturnStmt); ok {
				found = true
			}
			return true
		})
		return found
	}

	// Collect every distinct child-reconciler call in Reconcile.
	seen := map[string]bool{}
	ast.Inspect(reconcileFn.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if name, is := isChildCall(call); is {
			seen[name] = true
		}
		return true
	})
	if len(seen) == 0 {
		t.Fatalf("found no r.reconcile*/r.ensure* calls in Reconcile — the scan is broken " +
			"(the call shape changed), so it is proving nothing")
	}

	// Classify: fatal iff the error is guarded by an `if ... != nil { ... return ... }`.
	fatal := map[string]bool{}
	ast.Inspect(reconcileFn.Body, func(n ast.Node) bool {
		ifStmt, ok := n.(*ast.IfStmt)
		if !ok {
			return true
		}
		for name := range seen {
			inHead := (ifStmt.Init != nil && containsCall(ifStmt.Init, name)) ||
				containsCall(ifStmt.Cond, name)
			if inHead && hasReturn(ifStmt.Body) {
				fatal[name] = true
			}
		}
		return true
	})

	for name := range seen {
		switch {
		case nonFatalAllowlist[name] && fatal[name]:
			t.Errorf("%s: its error still returns out of Reconcile. %s is an OPT-IN "+
				"optimisation (#471): a persistent failure must degrade ImageCacheReady via "+
				"computeStatusVerdict, not abort the pass before the app's status is written.",
				name, name)
		case !nonFatalAllowlist[name] && !fatal[name]:
			t.Errorf("%s: its error does NOT return out of Reconcile, and it is not on the "+
				"non-fatal allowlist. Either return the error (mandatory child) or add it to "+
				"the allowlist AND surface its failure honestly in computeStatusVerdict.", name)
		}
	}

	// Both halves must actually have a member, or the guard is half-decorative.
	var sawFatal, sawNonFatal bool
	for name := range seen {
		if fatal[name] {
			sawFatal = true
		} else {
			sawNonFatal = true
		}
	}
	if !sawFatal {
		t.Errorf("no fatal child reconciler found — the ksvc/NetworkPolicy path must still " +
			"fail the pass; a scan where everything is non-fatal is not asserting anything")
	}
	if !sawNonFatal {
		t.Errorf("no non-fatal child reconciler found — reconcileImagePrewarmDaemonSet is " +
			"supposed to be decoupled (#471)")
	}
}
