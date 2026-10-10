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
	"sort"
	"strings"
	"testing"
)

// RBAC contract for the platform layer (ADR-0064 P0-6).
//
// The KnextPlatform is cluster-wide configuration: whoever can write it changes
// the defaults of EVERY app in the cluster, and (in later phases) enables
// privileged cluster components. So the split is deliberate:
//
//   - the operator may READ it (get/list/watch) and write only its STATUS;
//   - a separate knextplatform-admin ClusterRole is the one human grant;
//   - the NextApp admin/editor/viewer roles — what an app developer holds —
//     must never reach it, by name or by wildcard.

const platformGroup = "platform.kn-next.dev"

func grantsPlatformGroup(apiGroups []string) bool {
	for _, g := range apiGroups {
		if g == platformGroup || g == "*" {
			return true
		}
	}
	return false
}

func TestRBAC_OperatorReadsThePlatformAndWritesOnlyItsStatus(t *testing.T) {
	var specVerbs, statusVerbs []string
	for _, r := range loadRBACRules(t) {
		if r.name != "manager-role" || !grantsPlatformGroup(r.rule.APIGroups) {
			continue
		}
		for _, res := range r.rule.Resources {
			switch res {
			case "knextplatforms":
				specVerbs = append(specVerbs, r.rule.Verbs...)
			case "knextplatforms/status":
				statusVerbs = append(statusVerbs, r.rule.Verbs...)
			case "*":
				t.Errorf("manager-role grants %q on the whole platform group; name the resources", r.rule.Verbs)
			}
		}
	}
	sort.Strings(specVerbs)
	if got := strings.Join(specVerbs, ","); got != "get,list,watch" {
		t.Errorf("manager-role verbs on knextplatforms = %q, want exactly get,list,watch — the operator reads "+
			"the platform and must never write its spec (it is the admin's, applied by kubectl or GitOps)", got)
	}
	sort.Strings(statusVerbs)
	if got := strings.Join(statusVerbs, ","); got != "get,patch,update" {
		t.Errorf("manager-role verbs on knextplatforms/status = %q, want exactly get,patch,update", got)
	}
}

func TestRBAC_AppDeveloperRolesCannotReachThePlatform(t *testing.T) {
	appRoles := map[string]bool{}
	for _, r := range loadRBACRules(t) {
		if !strings.HasPrefix(r.name, "nextapp-") {
			continue
		}
		appRoles[r.name] = true
		if grantsPlatformGroup(r.rule.APIGroups) {
			t.Errorf("%s (%s) grants the platform group %v: an app developer role must not reach cluster-wide "+
				"platform configuration", r.name, r.file, r.rule.APIGroups)
		}
	}
	// Both-halves: the guard must have seen the roles it claims to police.
	for _, want := range []string{"nextapp-admin-role", "nextapp-editor-role", "nextapp-viewer-role"} {
		if !appRoles[want] {
			t.Fatalf("role %s not found under config/rbac; this guard would pass vacuously", want)
		}
	}
}

func TestRBAC_PlatformAdminRoleIsThePlatformGroupAndNothingElse(t *testing.T) {
	var found bool
	for _, r := range loadRBACRules(t) {
		if r.name != "knextplatform-admin-role" {
			continue
		}
		found = true
		if r.kind != "ClusterRole" {
			t.Errorf("knextplatform-admin-role is a %s; the platform is cluster-scoped, so it needs a ClusterRole", r.kind)
		}
		if len(r.rule.APIGroups) != 1 || r.rule.APIGroups[0] != platformGroup {
			t.Errorf("knextplatform-admin-role rule spans groups %v; it must be the platform group only", r.rule.APIGroups)
		}
		for _, res := range r.rule.Resources {
			if res != "knextplatforms" && res != "knextplatforms/status" {
				t.Errorf("knextplatform-admin-role grants %q; only knextplatforms and its status", res)
			}
		}
	}
	if !found {
		t.Fatal("ClusterRole knextplatform-admin-role is missing from config/rbac (ADR-0064 P0-6)")
	}
}

func TestRBAC_PlatformAdminRoleIsShippedInTheBundle(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "config", "rbac", "kustomization.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "knextplatform_admin_role.yaml") {
		t.Error("config/rbac/kustomization.yaml does not list knextplatform_admin_role.yaml, so the install " +
			"bundle would ship the CRD with no role for the human who is meant to manage it")
	}
	crd, err := os.ReadFile(filepath.Join("..", "..", "config", "crd", "kustomization.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(crd), "platform.kn-next.dev_knextplatforms.yaml") {
		t.Error("config/crd/kustomization.yaml does not list the KnextPlatform CRD: the bundle ships the CRD " +
			"but no KnextPlatform OBJECT (ADR-0064 D3), so the CRD itself must at least be present")
	}
}
