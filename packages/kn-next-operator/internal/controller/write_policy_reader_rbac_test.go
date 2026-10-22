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
	"strings"
	"testing"
)

// The operator checks that its own Secret/ConfigMap write policy is in force
// (internal/writepolicy). The only RBAC that costs is a read of the policy and
// its binding. This pins it to exactly that: `get`, by name, on those two kinds,
// and nowhere else: not on manager-role, not by wildcard, not list/watch (which
// would expose every admission policy in the cluster), and not under any name
// but the shipped policy's.
//
// TestOperatorCannotEditItsOwnWritePolicy already forbids any WRITE verb on the
// policy kinds; this is the other half, that the read is not widened.
func TestWritePolicyReaderRoleIsExactlyGetOnTheTwoNamedObjects(t *testing.T) {
	policy, binding := loadShippedWritePolicy(t)
	if policy.Name != binding.Name {
		t.Fatalf("the check reads the policy and its binding by one name; they are %q and %q", policy.Name, binding.Name)
	}

	policyKinds := map[string]bool{"validatingadmissionpolicies": true, "validatingadmissionpolicybindings": true}
	var grants []rbacRuleRef
	for _, r := range loadRBACRules(t) {
		hit := false
		for _, g := range r.rule.APIGroups {
			if g == "admissionregistration.k8s.io" || g == "*" {
				for _, res := range r.rule.Resources {
					hit = hit || policyKinds[res] || res == "*"
				}
			}
		}
		if hit {
			grants = append(grants, r)
		}
	}

	// Both halves: a scan that finds no grant would pass the assertions below
	// vacuously, and the operator could not read its own policy.
	if len(grants) != 1 {
		t.Fatalf("want exactly one RBAC rule touching the admission policy kinds, found %d: %+v", len(grants), grants)
	}
	g := grants[0]
	if g.kind != "ClusterRole" || g.name != "write-policy-reader" {
		t.Errorf("the grant must be the dedicated write-policy-reader ClusterRole, found %s/%s (%s)", g.kind, g.name, g.file)
	}
	if got := sortedVerbs(g.rule); got != "get" {
		t.Errorf("the grant must be exactly [get], got [%s]", got)
	}
	if strings.Join(g.rule.ResourceNames, ",") != policy.Name {
		t.Errorf("the grant must be limited to the shipped policy's name %q by resourceNames, got %v", policy.Name, g.rule.ResourceNames)
	}
	got := map[string]bool{}
	for _, res := range g.rule.Resources {
		got[res] = true
	}
	if len(got) != 2 || !got["validatingadmissionpolicies"] || !got["validatingadmissionpolicybindings"] {
		t.Errorf("the grant must cover exactly the policy and its binding, got %v", g.rule.Resources)
	}
	if len(g.rule.APIGroups) != 1 || g.rule.APIGroups[0] != "admissionregistration.k8s.io" {
		t.Errorf("the grant must name the admissionregistration.k8s.io group only, got %v", g.rule.APIGroups)
	}
}
