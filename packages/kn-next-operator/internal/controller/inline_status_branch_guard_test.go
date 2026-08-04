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

// The hard rule (`.claude/rules/architecture.md`) is absolute: NEW honest-status
// conditions/events/requeues go in computeStatusVerdict, never as new branches
// in Reconcile. Exactly one inline branch predates that rule — the spec-validation
// gate (#85, 2b1de76; the rule landed a month later in #274, 35c259b) — and it
// stays where it is because it is a PRECONDITION, not a verdict: it runs before
// any child state has been observed, so routing it through computeStatusVerdict
// would force that pure function to short-circuit every other input, which is
// exactly the contract the #254 extraction exists to protect. See ADR-0040.
//
// That "exactly one" is the whole invariant, and until now it was prose. Prose
// degrades unobservably: a second inline branch would read as consistent with
// the first, and nothing would go red. So the count is asserted here.
//
// This SCANS rather than enumerating: it walks the AST for every
// SetStatusCondition call in nextapp_controller.go and checks WHICH function
// each one sits in, so a third call site anywhere in the file fails — including
// in a helper nobody thought to add to a list.
func TestInlineStatusConditionBranchesStayExactlyOne(t *testing.T) {
	const file = "nextapp_controller.go"

	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, file, nil, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", file, err)
	}

	// Where the ONE sanctioned inline branch lives: the body of the
	// `if err := validation.ValidateNextAppSpec(...); err != nil { ... }`
	// statement. Located by its content, not by line number, so the guard
	// survives edits above it.
	var validationBranch *ast.BlockStmt
	ast.Inspect(f, func(n ast.Node) bool {
		ifStmt, ok := n.(*ast.IfStmt)
		if !ok || ifStmt.Init == nil {
			return true
		}
		found := false
		ast.Inspect(ifStmt.Init, func(m ast.Node) bool {
			if sel, ok := m.(*ast.SelectorExpr); ok && sel.Sel.Name == "ValidateNextAppSpec" {
				found = true
			}
			return true
		})
		if found {
			validationBranch = ifStmt.Body
		}
		return true
	})
	if validationBranch == nil {
		t.Fatalf("could not find the spec-validation branch in %s — this guard is only "+
			"meaningful while that branch exists; if it moved, move the guard with it", file)
	}

	type site struct {
		fn            string
		line          int
		inValidation  bool
		enclosingFunc string
	}
	var sites []site
	for _, decl := range f.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "SetStatusCondition" {
				return true
			}
			pos := call.Pos()
			sites = append(sites, site{
				fn:            fn.Name.Name,
				line:          fset.Position(pos).Line,
				inValidation:  pos > validationBranch.Lbrace && pos < validationBranch.Rbrace,
				enclosingFunc: fn.Name.Name,
			})
			return true
		})
	}

	if len(sites) == 0 {
		t.Fatalf("found no SetStatusCondition calls in %s — the scan is broken "+
			"(or the status write moved), so it is proving nothing", file)
	}

	// The sanctioned shape: every call is either inside applyStatusVerdict (the
	// single writer of the computeStatusVerdict result) or inside the
	// pre-existing validation branch. Anything else is a NEW inline branch.
	var offenders []site
	inValidation, inApply := 0, 0
	for _, s := range sites {
		switch {
		case s.enclosingFunc == "applyStatusVerdict":
			inApply++
		case s.enclosingFunc == "Reconcile" && s.inValidation:
			inValidation++
		default:
			offenders = append(offenders, s)
		}
	}

	for _, s := range offenders {
		t.Errorf("%s:%d — SetStatusCondition in %s() is a NEW inline status branch. "+
			"Per .claude/rules/architecture.md and ADR-0040 it belongs in computeStatusVerdict "+
			"(status_verdict.go); if it is a spec PRECONDITION, put the rule in "+
			"validation.ValidateNextAppSpec and reuse the one existing branch.",
			file, s.line, s.fn)
	}
	if inApply == 0 {
		t.Errorf("no SetStatusCondition inside applyStatusVerdict — the verdict path is " +
			"supposed to be the only general writer of conditions")
	}
	if inValidation == 0 {
		t.Errorf("no SetStatusCondition inside the spec-validation branch — if that branch " +
			"stopped setting conditions, delete this guard's exemption rather than leaving it")
	}
}
