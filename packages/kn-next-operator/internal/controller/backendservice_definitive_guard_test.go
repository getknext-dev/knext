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
	"strings"
	"testing"
)

// G6: only a NAME problem or a NotFound can reach a definitive verdict from a
// lookup. A failed read has no definitive class: classifyReadError may return
// only readTransient or readDenied, and no identifier in the reconciler sources
// may reintroduce a "rejected" or "definitive" read state. (TestAFailedReadHasNo
// DefinitiveState pins the other half: secretMetadata has no field to put one in.)
func TestOnlyNameProblemsAndNotFoundReachADefinitiveVerdict(t *testing.T) {
	returned := map[string]bool{}
	for file, f := range parsedReconcilerSources(t) {
		ast.Inspect(f, func(n ast.Node) bool {
			id, ok := n.(*ast.Ident)
			if !ok {
				return true
			}
			switch strings.ToLower(id.Name) {
			case "readdefinitive", "rejected", "readrejected":
				t.Errorf("%s: identifier %q reintroduces a definitive state for a failed read; a failed read is held, never a verdict", file, id.Name)
			}
			return true
		})
		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Name.Name != "classifyReadError" {
				continue
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				if r, ok := n.(*ast.ReturnStmt); ok {
					for _, res := range r.Results {
						if id, ok := res.(*ast.Ident); ok {
							returned[id.Name] = true
						}
					}
				}
				return true
			})
		}
	}
	if !returned["readTransient"] || !returned["readDenied"] || len(returned) != 2 {
		t.Errorf("classifyReadError must return exactly readTransient and readDenied, returns %v", returned)
	}
}
