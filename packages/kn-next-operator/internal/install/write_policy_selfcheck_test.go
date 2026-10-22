package install

import (
	"os"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"sigs.k8s.io/yaml"
)

// The operator's write-policy self-check (internal/writepolicy) reads the policy
// and its binding BY NAME, and its role grants `get` on exactly that name. Both
// names are literals in the base manifests; the bundle prefixes every
// cluster-scoped name, and kustomize's name references do not reach a
// Deployment env value or a rule's resourceNames. If either is left as the base
// name, the check reads an object that does not exist and reports the policy
// off while it is on, or (with the role right and the env wrong) the reverse.
// These tests prove the three agree after the prefix is applied.

func TestRenderedBundleGivesTheSelfCheckTheRenderedPolicyName(t *testing.T) {
	raw, err := os.ReadFile(requireBundle(t))
	if err != nil {
		t.Fatal(err)
	}
	o := decodeWritePolicyObjects(t, raw, "dist/install.yaml")
	if o.policy == nil || o.binding == nil {
		t.Fatal("the rendered bundle carries no write policy and binding")
	}
	if o.policy.Name != o.binding.Name {
		t.Fatalf("the self-check reads the policy and its binding by one name; they render as %q and %q", o.policy.Name, o.binding.Name)
	}
	var manager *appsv1.Deployment
	for i := range o.deployments {
		for _, c := range o.deployments[i].Spec.Template.Spec.Containers {
			if c.Name == "manager" {
				manager = &o.deployments[i]
			}
		}
	}
	if manager == nil {
		t.Fatal("no manager Deployment in the rendered bundle")
	}
	var envName string
	for _, c := range manager.Spec.Template.Spec.Containers {
		if c.Name != "manager" {
			continue
		}
		for _, e := range c.Env {
			if e.Name == "WRITE_POLICY_NAME" {
				envName = e.Value
			}
		}
	}
	if envName != o.policy.Name {
		t.Errorf("the manager's WRITE_POLICY_NAME is %q but the policy renders as %q: the self-check would read an object that is not there",
			envName, o.policy.Name)
	}

	var role *rbacv1.ClusterRole
	var binding *rbacv1.ClusterRoleBinding
	for _, doc := range decodeYAMLDocs(t, raw, "dist/install.yaml") {
		var head struct {
			Kind     string `json:"kind"`
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
		}
		if err := yaml.Unmarshal(doc, &head); err != nil {
			continue
		}
		switch {
		case head.Kind == "ClusterRole" && strings.HasSuffix(head.Metadata.Name, "write-policy-reader"):
			role = &rbacv1.ClusterRole{}
			if err := yaml.Unmarshal(doc, role); err != nil {
				t.Fatal(err)
			}
		case head.Kind == "ClusterRoleBinding" && strings.HasSuffix(head.Metadata.Name, "write-policy-reader-rolebinding"):
			binding = &rbacv1.ClusterRoleBinding{}
			if err := yaml.Unmarshal(doc, binding); err != nil {
				t.Fatal(err)
			}
		}
	}
	if role == nil || binding == nil {
		t.Fatalf("the rendered bundle must carry the write-policy-reader role and binding (role %v, binding %v)", role != nil, binding != nil)
	}
	if len(role.Rules) != 1 {
		t.Fatalf("want one rule on the write-policy-reader role, got %d", len(role.Rules))
	}
	rule := role.Rules[0]
	if strings.Join(rule.ResourceNames, ",") != o.policy.Name {
		t.Errorf("the role grants get on %v but the policy renders as %q: the check would be forbidden from reading it", rule.ResourceNames, o.policy.Name)
	}
	if strings.Join(rule.Verbs, ",") != "get" {
		t.Errorf("the rendered role must grant exactly get, got %v", rule.Verbs)
	}
	if binding.RoleRef.Name != role.Name {
		t.Errorf("the binding points at ClusterRole %q, the bundle names it %q", binding.RoleRef.Name, role.Name)
	}
	if len(binding.Subjects) != 1 || binding.Subjects[0].Kind != rbacv1.ServiceAccountKind ||
		binding.Subjects[0].Name != manager.Spec.Template.Spec.ServiceAccountName ||
		binding.Subjects[0].Namespace != manager.Namespace {
		t.Errorf("the binding must grant the manager's own ServiceAccount (%s/%s), got %+v",
			manager.Namespace, manager.Spec.Template.Spec.ServiceAccountName, binding.Subjects)
	}
}

// The policy's own name is what both of the above are rewritten from, so the
// base manifests must keep the policy and its binding under the one name the
// base role and the base env default name.
func TestBaseManifestsNameThePolicyConsistently(t *testing.T) {
	o := shippedWritePolicy(t)
	if o.policy.Name != "secret-configmap-writes" || o.binding.Name != o.policy.Name {
		t.Fatalf("base policy/binding are %q/%q; the self-check's default name is secret-configmap-writes", o.policy.Name, o.binding.Name)
	}
	var role rbacv1.ClusterRole
	if err := yaml.Unmarshal([]byte(repoFile(t, "config/rbac/write_policy_reader_role.yaml")), &role); err != nil {
		t.Fatal(err)
	}
	if len(role.Rules) != 1 || strings.Join(role.Rules[0].ResourceNames, ",") != o.policy.Name {
		t.Errorf("the base role must grant get on %q, got %+v", o.policy.Name, role.Rules)
	}
}
