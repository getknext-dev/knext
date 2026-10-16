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

// architecture.md §4: honest-status conditions, events and requeues are
// computed in ONE pure verdict function, never as branches in Reconcile. For the
// BackendService reconciler that function is computeBackendServiceVerdict, and
// the only place allowed to SET a condition is applyFunctionVerdict, which
// applies the verdict verbatim. This SCANS every BackendService source file for
// SetStatusCondition / RemoveStatusCondition / Recorder.Event calls and fails on
// any outside applyFunctionVerdict, so a new inline branch cannot slip in.
func TestBackendServiceStatusIsSetOnlyFromTheVerdict(t *testing.T) {
	files := []string{
		"backendservice_controller.go",
		"backendservice_render.go",
		"backendservice_sovereignty.go",
		"backendservice_verdict.go",
	}
	sanctioned := 0
	for _, file := range files {
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
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				switch sel.Sel.Name {
				case "SetStatusCondition", "RemoveStatusCondition", "Event", "Eventf":
				default:
					return true
				}
				if fn.Name.Name == "applyFunctionVerdict" {
					sanctioned++
					return true
				}
				t.Errorf("%s: %s is called in %s, outside applyFunctionVerdict — compute it in "+
					"computeBackendServiceVerdict instead (architecture.md §4)",
					fset.Position(call.Pos()), sel.Sel.Name, fn.Name.Name)
				return true
			})
		}
	}
	// Both halves: the scan must actually see the sanctioned call sites, or it
	// proves nothing.
	if sanctioned < 2 {
		t.Fatalf("found %d sanctioned status/event calls in applyFunctionVerdict; the scan is not seeing the code", sanctioned)
	}
}
