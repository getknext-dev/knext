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

package writepolicy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
)

// verdictFixture is testdata/verdict-cases.json, which `knext doctor` reads too
// (packages/kn-next/src/__tests__/doctor-write-policy.test.ts): the operator's
// self-check and the CLI must reach the same verdict on the same objects.
type verdictFixture struct {
	OperatorUsername string         `json:"operatorUsername"`
	Policy           map[string]any `json:"policy"`
	Binding          map[string]any `json:"binding"`
	Cases            []verdictCase  `json:"cases"`
}

type verdictCase struct {
	Name     string      `json:"name"`
	Ops      []verdictOp `json:"ops"`
	Enforced bool        `json:"enforced"`
	Reason   string      `json:"reason"`
}

type verdictOp struct {
	Op     string `json:"op"`
	Target string `json:"target"`
	Path   string `json:"path"`
	Value  any    `json:"value"`
}

func loadVerdictFixture(t *testing.T) verdictFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "verdict-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f verdictFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Cases) < 10 {
		t.Fatalf("only %d verdict cases; the table would prove little", len(f.Cases))
	}
	return f
}

// deepCopy round-trips through JSON so a case never mutates the shared base.
func deepCopy(t *testing.T, in map[string]any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func setPath(t *testing.T, obj map[string]any, path string, value any) {
	t.Helper()
	parts := strings.Split(path, ".")
	cur := obj
	for _, p := range parts[:len(parts)-1] {
		next, ok := cur[p].(map[string]any)
		if !ok {
			next = map[string]any{}
			cur[p] = next
		}
		cur = next
	}
	cur[parts[len(parts)-1]] = value
}

// objectsFor applies a case's ops to the fixture's base objects.
func objectsFor(t *testing.T, f verdictFixture, c verdictCase) (*admissionregistrationv1.ValidatingAdmissionPolicy, *admissionregistrationv1.ValidatingAdmissionPolicyBinding, string) {
	t.Helper()
	policy, binding := deepCopy(t, f.Policy), deepCopy(t, f.Binding)
	removePolicy, removeBinding := false, false
	username := f.OperatorUsername
	for _, op := range c.Ops {
		switch op.Op {
		case "remove-policy":
			removePolicy = true
		case "remove-binding":
			removeBinding = true
		case "identity":
			username, _ = op.Value.(string)
		case "set":
			target := policy
			if op.Target == "binding" {
				target = binding
			}
			setPath(t, target, op.Path, op.Value)
		default:
			t.Fatalf("case %q: unknown op %q", c.Name, op.Op)
		}
	}
	decode := func(in map[string]any, out any) {
		raw, err := json.Marshal(in)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("case %q: %v", c.Name, err)
		}
	}
	var p *admissionregistrationv1.ValidatingAdmissionPolicy
	var b *admissionregistrationv1.ValidatingAdmissionPolicyBinding
	if !removePolicy {
		p = &admissionregistrationv1.ValidatingAdmissionPolicy{}
		decode(policy, p)
	}
	if !removeBinding {
		b = &admissionregistrationv1.ValidatingAdmissionPolicyBinding{}
		decode(binding, b)
	}
	return p, b, username
}

func TestEvaluateMatchesTheSharedVerdictTable(t *testing.T) {
	f := loadVerdictFixture(t)
	seenEnforced, seenNot := false, false
	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			p, b, username := objectsFor(t, f, c)
			got := Evaluate(p, b, username)
			if got.Enforced != c.Enforced || string(got.Reason) != c.Reason {
				t.Fatalf("Evaluate = {enforced %v, reason %s (%s)}, want {enforced %v, reason %s}",
					got.Enforced, got.Reason, got.Detail, c.Enforced, c.Reason)
			}
			if !got.Enforced && got.Detail == "" {
				t.Errorf("an unenforced verdict must say why in words, got an empty Detail")
			}
		})
		seenEnforced = seenEnforced || c.Enforced
		seenNot = seenNot || !c.Enforced
	}
	// Both halves: a table of only 0s (or only 1s) cannot tell a real check
	// from a constant.
	if !seenEnforced || !seenNot {
		t.Fatalf("the verdict table must hold both outcomes (enforced %v, not-enforced %v)", seenEnforced, seenNot)
	}
}
