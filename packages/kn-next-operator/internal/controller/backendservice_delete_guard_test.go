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

// removeFunctionNetworkPolicyName is the one function, besides removeRendered,
// that may Delete: the spec.security.networkPolicy opt-out's teardown.
const removeFunctionNetworkPolicyName = "removeFunctionNetworkPolicy"

// deleteViolations scans parsed reconciler sources for Delete/DeleteAllOf calls
// and returns how many it saw plus every one that is not sanctioned. Sanctioned:
// anything inside removeRendered (it takes the whole function down, see G1), and
// a Delete inside removeFunctionNetworkPolicy ONLY when its argument is that
// function's own parameter declared as a NetworkPolicy. The function name alone
// would let a Knative Service Delete hide in it, so the object TYPE is checked:
// the Go compiler then guarantees nothing else can be passed through the
// parameter.
func deleteViolations(files map[string]*ast.File) (int, []string) {
	deletes := 0
	var bad []string
	for file, f := range files {
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
				if !ok || (sel.Sel.Name != "Delete" && sel.Sel.Name != "DeleteAllOf") {
					return true
				}
				deletes++
				switch {
				case fn.Name.Name == lcRemoveRendered:
				case fn.Name.Name == removeFunctionNetworkPolicyName && sel.Sel.Name == "Delete" &&
					len(call.Args) >= 2 && argIsNetworkPolicyParam(fn, call.Args[1]):
				default:
					bad = append(bad, file+": "+fn.Name.Name+" calls "+sel.Sel.Name+
						"; a function is torn down only through removeRendered (see G1), and "+
						removeFunctionNetworkPolicyName+" may Delete only its *networkingv1.NetworkPolicy parameter")
				}
				return true
			})
		}
	}
	return deletes, bad
}

// argIsNetworkPolicyParam reports whether arg is an identifier naming one of
// fn's parameters whose declared type is *networkingv1.NetworkPolicy.
func argIsNetworkPolicyParam(fn *ast.FuncDecl, arg ast.Expr) bool {
	id, ok := arg.(*ast.Ident)
	if !ok || fn.Type.Params == nil {
		return false
	}
	for _, field := range fn.Type.Params.List {
		star, ok := field.Type.(*ast.StarExpr)
		if !ok {
			continue
		}
		sel, ok := star.X.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != "NetworkPolicy" {
			continue
		}
		if pkg, ok := sel.X.(*ast.Ident); !ok || pkg.Name != "networkingv1" {
			continue
		}
		for _, name := range field.Names {
			if name.Name == id.Name {
				return true
			}
		}
	}
	return false
}

// G4 is not blind to the object type: a Knative Service Delete hidden inside
// removeFunctionNetworkPolicy is flagged, and so is any other Delete shape.
func TestDeleteGuardIsNotBlindToObjectType(t *testing.T) {
	parse := func(body string) map[string]*ast.File {
		t.Helper()
		f, err := parser.ParseFile(token.NewFileSet(), "synthetic.go", "package p\n"+body, 0)
		if err != nil {
			t.Fatalf("parse synthetic source: %v", err)
		}
		return map[string]*ast.File{"synthetic.go": f}
	}
	cases := []struct {
		name    string
		src     string
		flagged bool
	}{
		{"NetworkPolicy parameter is sanctioned", `
func (r *R) removeFunctionNetworkPolicy(ctx C, bs *B, np *networkingv1.NetworkPolicy) error { return r.Delete(ctx, np) }`, false},
		{"a Knative Service built inside is flagged", `
func (r *R) removeFunctionNetworkPolicy(ctx C, bs *B, np *networkingv1.NetworkPolicy) error {
	ksvc := &servingv1.Service{}
	return r.Delete(ctx, ksvc)
}`, true},
		{"a Knative Service parameter is flagged", `
func (r *R) removeFunctionNetworkPolicy(ctx C, bs *B, ksvc *servingv1.Service) error { return r.Delete(ctx, ksvc) }`, true},
		{"a NetworkPolicy of another package is flagged", `
func (r *R) removeFunctionNetworkPolicy(ctx C, bs *B, np *other.NetworkPolicy) error { return r.Delete(ctx, np) }`, true},
		{"DeleteAllOf is flagged", `
func (r *R) removeFunctionNetworkPolicy(ctx C, bs *B, np *networkingv1.NetworkPolicy) error { return r.DeleteAllOf(ctx, np) }`, true},
		{"a Delete anywhere else is flagged", `
func (r *R) somethingElse(ctx C, np *networkingv1.NetworkPolicy) error { return r.Delete(ctx, np) }`, true},
		{"removeRendered stays sanctioned", `
func (r *R) removeRendered(ctx C, bs *B) error { return r.Delete(ctx, bs) }`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			deletes, bad := deleteViolations(parse(tc.src))
			if deletes == 0 {
				t.Fatal("the synthetic source has a Delete the scan did not see")
			}
			if got := len(bad) > 0; got != tc.flagged {
				t.Fatalf("flagged=%v, want %v (%v)", got, tc.flagged, bad)
			}
		})
	}
}
