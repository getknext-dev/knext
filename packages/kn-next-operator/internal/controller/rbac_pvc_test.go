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

	rbacv1 "k8s.io/api/rbac/v1"
	"sigs.k8s.io/yaml"
)

// TestManagerRoleGrantsPersistentVolumeClaims pins the +kubebuilder:rbac marker
// for core persistentvolumeclaims against the generated ClusterRole
// (config/rbac/role.yaml). The controller-runtime cache watches
// *v1.PersistentVolumeClaim; without a cluster-scoped list/watch grant the
// controller logs repeated `persistentvolumeclaims is forbidden` errors on EKS
// (found by #306 EKS validation). This test goes red if the marker is dropped
// and codegen is re-run.
func TestManagerRoleGrantsPersistentVolumeClaims(t *testing.T) {
	// internal/controller -> ../../config/rbac/role.yaml
	rolePath := filepath.Join("..", "..", "config", "rbac", "role.yaml")
	raw, err := os.ReadFile(rolePath)
	if err != nil {
		t.Fatalf("read role.yaml: %v", err)
	}
	var role rbacv1.ClusterRole
	if err := yaml.Unmarshal(raw, &role); err != nil {
		t.Fatalf("unmarshal role.yaml: %v", err)
	}

	verbs := map[string]bool{}
	for _, rule := range role.Rules {
		if !containsString(rule.APIGroups, "") {
			continue
		}
		if !containsString(rule.Resources, "persistentvolumeclaims") {
			continue
		}
		for _, v := range rule.Verbs {
			verbs[v] = true
		}
	}

	if len(verbs) == 0 {
		t.Fatalf("ClusterRole manager-role grants no core persistentvolumeclaims rule; " +
			"the controller-runtime cache watches PVCs and will log `forbidden` errors")
	}
	for _, need := range []string{"get", "list", "watch"} {
		if !verbs[need] {
			t.Errorf("ClusterRole manager-role missing verb %q on persistentvolumeclaims (have %v)", need, keys(verbs))
		}
	}
}

func containsString(hay []string, needle string) bool {
	for _, h := range hay {
		if h == needle {
			return true
		}
	}
	return false
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
