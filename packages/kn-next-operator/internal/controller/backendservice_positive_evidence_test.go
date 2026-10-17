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
	"go/token"
	"testing"

	corev1 "k8s.io/api/core/v1"

	servingv1 "knative.dev/serving/pkg/apis/serving/v1"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// A running-template violation may tear a function down ONLY on positive
// evidence of revocation. A Secret the old template mounts that is NOT FOUND is
// a pruned old version (routine rotation), never evidence.

func TestRunningTemplateViolationNeedsPositiveEvidence(t *testing.T) {
	zone, others := sovFixture()
	bs := sovFunction(appsv1alpha1.BackendServiceSpec{})
	mount := func(secret string) *servingv1.Service {
		return runningKsvc(corev1.PodSpec{Containers: []corev1.Container{{
			Name:    "user",
			EnvFrom: []corev1.EnvFromSource{{SecretRef: &corev1.SecretEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: secret}}}},
		}}})
	}
	cases := []struct {
		name    string
		secret  string
		lookup  secretLookup
		zone    *appsv1alpha1.NextApp
		wantErr bool // a violation is expected
	}{
		{"a pruned old Secret (NotFound) is a routine rotation", "stripe-v1", noSecrets(), zone, false},
		{"a Secret re-marked for another zone", "stripe", sovSecrets(map[string]secretMetadata{"stripe": {labels: map[string]string{ZoneLabel: sovOther}}}), zone, true},
		{"a Secret that exists but lost the zone's mark", "stripe", sovSecrets(map[string]secretMetadata{"stripe": {}}), zone, true},
		{"another zone's database Secret", sovForeignDB, noSecrets(), zone, true},
		{"a zone signing key", ZoneSigningKeySecretName(sovZone), noSecrets(), zone, true},
		{"the zone is gone (NotFound Secret, no zone)", "stripe-v1", noSecrets(), nil, true},
	}
	for _, c := range cases {
		got, _ := checkRunningSovereignty(bs, c.zone, others, c.lookup, mount(c.secret))
		if (len(got) > 0) != c.wantErr {
			t.Errorf("%s: violations=%+v, want violation=%v", c.name, got, c.wantErr)
		}
	}
	// The SAME NotFound Secret in the function's SPEC is still a violation: the
	// exemption is for what is already running, never for what is asked for.
	spec, _ := checkFunctionSovereignty(sovFunction(specEnvFromSecret("stripe-v1")), zone, others, noSecrets())
	if len(spec) != 1 {
		t.Errorf("a NotFound Secret in the spec must still be refused, got %+v", spec)
	}
}

// G2 widening: a bool DERIVED from an error may gate removeRendered only when it
// is ANDed with positive-revocation evidence. The scan finds every bare-identifier
// condition whose body tears down, resolves the assignment that defines it, and
// pins the exact expression, so a weaker one (say `rollErr != nil && ...`) fails.
func TestAnErrorDerivedBoolGatesTeardownOnlyWithPositiveEvidence(t *testing.T) {
	const want = "rollErr != nil && len(runViolations) > 0"
	gates := 0
	for file, f := range parsedReconcilerSources(t) {
		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			defs := map[string]ast.Expr{}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				if as, ok := n.(*ast.AssignStmt); ok && as.Tok == token.DEFINE && len(as.Lhs) == len(as.Rhs) {
					for i, l := range as.Lhs {
						if id, ok := l.(*ast.Ident); ok {
							defs[id.Name] = as.Rhs[i]
						}
					}
				}
				return true
			})
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				ifs, ok := n.(*ast.IfStmt)
				if !ok {
					return true
				}
				id, ok := ifs.Cond.(*ast.Ident)
				if !ok || len(teardownOrVerdictIn(token.NewFileSet(), ifs.Body)) == 0 {
					return true
				}
				def, ok := defs[id.Name]
				if !ok {
					return true
				}
				gates++
				if got := exprString(token.NewFileSet(), def); got != want {
					t.Errorf("%s: %s gates a teardown and is defined as %q; it must be exactly %q "+
						"(a failed rollout AND positive evidence of revocation)", file, id.Name, got, want)
				}
				return true
			})
		}
	}
	if gates == 0 {
		t.Fatal("found no error-derived bool gating a teardown; the scan is not seeing stuckOnRevoked")
	}
}

// The running check and the spec check differ in exactly one argument: whether a
// NotFound Secret is a rotation. Pin both call sites.
func TestRunningCheckAloneToleratesAbsentSecrets(t *testing.T) {
	seen := map[string]string{}
	for _, f := range parsedReconcilerSources(t) {
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
				if id, ok := call.Fun.(*ast.Ident); ok && id.Name == "checkSecretRefs" {
					seen[fn.Name.Name] = exprString(token.NewFileSet(), call.Args[len(call.Args)-1])
				}
				return true
			})
		}
	}
	if seen["checkRunningSovereignty"] != "true" || seen["checkFunctionSovereignty"] != "false" {
		t.Errorf("checkSecretRefs absentIsRotation: running=%q (want true), spec=%q (want false)",
			seen["checkRunningSovereignty"], seen["checkFunctionSovereignty"])
	}
}
