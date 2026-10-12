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
	"os"
	"strings"
	"testing"
)

// ADR-0017 Amendment 2: inside v1alpha1 a CRD change must be additive-only, and a
// new CEL rule on an EXISTING field (spec.env, spec.secrets.envMap) is not (the CI
// guard scripts/crd-schema-diff.mjs reds on it). The KNEXT_CDN_* reservation is
// therefore the operator's, not the schema's: the generated CRD must carry no
// validation rule about it.
func TestReservationIsNotACRDValidationRule(t *testing.T) {
	raw, err := os.ReadFile("../../config/crd/bases/apps.kn-next.dev_nextapps.yaml")
	if err != nil {
		t.Fatal(err)
	}
	for _, banned := range []string{
		"startsWith('KNEXT_CDN_')",
		"reserved for the operator (set spec.cdn instead)",
	} {
		if strings.Contains(string(raw), banned) {
			t.Fatalf("the generated CRD carries a validation rule on the KNEXT_CDN_* reservation (%q): "+
				"that is not additive within v1alpha1; enforce it in the operator", banned)
		}
	}
}
