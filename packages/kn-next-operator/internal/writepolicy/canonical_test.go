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
	"os"
	"path/filepath"
	"reflect"
	"testing"

	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	"sigs.k8s.io/yaml"
)

// The check compares a live policy's variables and validations with the ones
// this operator ships. Those are a copy in verdict.go (canonicalVariables,
// canonicalValidations); this is what keeps the copy from drifting. Change the
// CEL in config/admission without updating the copy (and the shared table's base
// policy) and this goes red, instead of the gauge reporting 0 on a correct,
// freshly installed policy, or 1 on one that no longer enforces what it should.

func shippedPolicy(t *testing.T) *admissionregistrationv1.ValidatingAdmissionPolicy {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "config", "admission", "secret-configmap-writes.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var p admissionregistrationv1.ValidatingAdmissionPolicy
	if err := yaml.UnmarshalStrict(raw, &p); err != nil {
		t.Fatal(err)
	}
	// Both halves: an empty shipped policy would make the equality below vacuous.
	if len(p.Spec.Variables) == 0 || len(p.Spec.Validations) == 0 {
		t.Fatalf("the shipped policy parsed to %d variables and %d validations", len(p.Spec.Variables), len(p.Spec.Validations))
	}
	return &p
}

func TestCanonicalPolicyCELEqualsTheShippedPolicy(t *testing.T) {
	p := shippedPolicy(t)
	got, want := policyCEL(p), canonicalCEL()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("config/admission/secret-configmap-writes.yaml differs from the canonical copy in verdict.go.\nshipped   %#v\ncanonical %#v\n"+
			"Update canonicalVariables/canonicalValidations, the base policy in testdata/verdict-cases.json and the TS copy in "+
			"packages/kn-next/src/cli/doctor/checks/write-policy.ts together.", got, want)
	}
}

// "Enforced" in the shared table must be proved against the CEL that ships.
func TestSharedTableBasePolicyCarriesTheShippedCEL(t *testing.T) {
	f := loadVerdictFixture(t)
	p, _, _ := objectsFor(t, f, verdictCase{Name: "base"})
	if got, want := policyCEL(p), policyCEL(shippedPolicy(t)); !reflect.DeepEqual(got, want) {
		t.Errorf("testdata/verdict-cases.json's base policy CEL differs from the shipped policy:\n%#v\n%#v", got, want)
	}
}
