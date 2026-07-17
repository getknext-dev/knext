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
	"path/filepath"
	"testing"

	apiextv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	"sigs.k8s.io/yaml"
)

// TestNextAppPrinterColumns asserts that the generated CRD carries the health-at-
// a-glance printer columns (#312) so `kubectl get nextapp` / `-o wide` surfaces
// readiness, degraded state, the observed revision, scale-to-zero, and the last
// successful deploy without spelunking Knative + pod state. This pins the
// +kubebuilder:printcolumn markers on nextapp_types.go against the committed CRD.
func TestNextAppPrinterColumns(t *testing.T) {
	// internal/controller -> ../../config/crd/bases/...
	crdPath := filepath.Join("..", "..", "config", "crd", "bases", "apps.kn-next.dev_nextapps.yaml")
	raw, err := os.ReadFile(crdPath)
	if err != nil {
		t.Fatalf("read CRD: %v", err)
	}
	var crd apiextv1.CustomResourceDefinition
	if err := yaml.Unmarshal(raw, &crd); err != nil {
		t.Fatalf("unmarshal CRD: %v", err)
	}

	// Locate the served/storage version's printer columns.
	var cols []apiextv1.CustomResourceColumnDefinition
	for _, v := range crd.Spec.Versions {
		if v.Name == "v1alpha1" {
			cols = v.AdditionalPrinterColumns
		}
	}
	if len(cols) == 0 {
		t.Fatal("no additionalPrinterColumns on v1alpha1")
	}

	byName := map[string]apiextv1.CustomResourceColumnDefinition{}
	for _, c := range cols {
		byName[c.Name] = c
	}

	// jsonPath asserts a named column exists, resolves the expected JSONPath, and
	// carries the expected -o wide priority (0 = always shown, 1 = wide only).
	assertCol := func(name, wantPath string, wantPriority int32) {
		t.Helper()
		c, ok := byName[name]
		if !ok {
			t.Fatalf("printer column %q missing (have %v)", name, keysOf(byName))
		}
		if c.JSONPath != wantPath {
			t.Fatalf("column %q JSONPath: got %q, want %q", name, c.JSONPath, wantPath)
		}
		if c.Priority != wantPriority {
			t.Fatalf("column %q priority: got %d, want %d", name, c.Priority, wantPriority)
		}
	}

	// Pre-existing always-visible columns stay.
	assertCol("URL", ".status.url", 0)
	assertCol("Ready", ".status.conditions[?(@.type=='Ready')].status", 0)

	// New -o wide (priority=1) health columns (#312).
	assertCol("Revision", ".status.observedRevision", 1)
	assertCol("ScaledToZero", ".status.scaledToZero", 1)
	assertCol("Degraded", ".status.conditions[?(@.type=='Degraded')].status", 1)
	assertCol("LastDeploy", ".status.lastSuccessfulDeployTime", 1)
}

func keysOf(m map[string]apiextv1.CustomResourceColumnDefinition) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
