package install

import (
	"bufio"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	appsv1 "k8s.io/api/apps/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	utilyaml "k8s.io/apimachinery/pkg/util/yaml"
	"sigs.k8s.io/yaml"
)

// The operator's Secret / ConfigMap write policy ships in the bundle.
//
// RBAC cannot name an object on `create`, so the operator's cluster-wide
// create/update on Secrets and ConfigMaps (the per-zone signing key and JWKS) is
// bounded by a ValidatingAdmissionPolicy that confines ONLY the operator's own
// ServiceAccount. These tests pin the three ways that goes wrong without anyone
// noticing:
//
//   - the policy is not in the bundle (a green install with no narrowing);
//   - the policy confines the wrong identity. The bundle's namespace and name
//     prefix are rewritten by kustomize, so a literal ServiceAccount username is
//     rewritten from the real ServiceAccount, and the RENDERED username must equal
//     the identity the manager Deployment and the ClusterRoleBinding actually use.
//     A mismatch is not an error anywhere: the policy simply never matches and the
//     operator is unrestricted;
//   - the policy is quietly weaker than intended (failurePolicy Ignore, a binding
//     that only warns, a scope that skips a verb or a namespace).
//
// What the policy DOES to a request is proved on a real kube-apiserver in
// internal/controller (operator_write_policy_envtest_test.go); its allow-list is
// held in lockstep with the operator's code in the same package.

var celQuoted = regexp.MustCompile(`'([^']*)'`)

// celLiterals joins the single-quoted literals of a CEL expression. The identity
// is spelled 'system:serviceaccount:' + '<namespace>' + ':' + '<name>' so the two
// variable parts are separate literals kustomize can replace.
func celLiterals(expr string) string {
	var b strings.Builder
	for _, m := range celQuoted.FindAllStringSubmatch(expr, -1) {
		b.WriteString(m[1])
	}
	return b.String()
}

func decodeYAMLDocs(t *testing.T, raw []byte, source string) [][]byte {
	t.Helper()
	var out [][]byte
	dec := utilyaml.NewYAMLReader(bufio.NewReader(bytes.NewReader(raw)))
	for {
		doc, err := dec.Read()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatalf("split %s: %v", source, err)
		}
		if len(bytes.TrimSpace(doc)) > 0 {
			out = append(out, doc)
		}
	}
}

type writePolicyObjects struct {
	policy  *admissionregistrationv1.ValidatingAdmissionPolicy
	binding *admissionregistrationv1.ValidatingAdmissionPolicyBinding
	// rolebinding and deployment are filled only for the rendered bundle.
	subjects    []rbacv1.Subject
	deployments []appsv1.Deployment
}

func decodeWritePolicyObjects(t *testing.T, raw []byte, source string) writePolicyObjects {
	t.Helper()
	var out writePolicyObjects
	for _, doc := range decodeYAMLDocs(t, raw, source) {
		var head struct {
			Kind     string `json:"kind"`
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
		}
		if err := yaml.Unmarshal(doc, &head); err != nil {
			// Kustomize patch files are arrays, not objects; they carry no policy.
			continue
		}
		switch head.Kind {
		case "ValidatingAdmissionPolicy":
			if out.policy != nil {
				t.Fatalf("%s carries two ValidatingAdmissionPolicy objects", source)
			}
			out.policy = &admissionregistrationv1.ValidatingAdmissionPolicy{}
			if err := yaml.UnmarshalStrict(doc, out.policy); err != nil {
				t.Fatalf("%s: policy: %v", source, err)
			}
		case "ValidatingAdmissionPolicyBinding":
			if out.binding != nil {
				t.Fatalf("%s carries two ValidatingAdmissionPolicyBinding objects", source)
			}
			out.binding = &admissionregistrationv1.ValidatingAdmissionPolicyBinding{}
			if err := yaml.UnmarshalStrict(doc, out.binding); err != nil {
				t.Fatalf("%s: binding: %v", source, err)
			}
		case "ClusterRoleBinding":
			if strings.HasSuffix(head.Metadata.Name, "manager-rolebinding") {
				var crb rbacv1.ClusterRoleBinding
				if err := yaml.Unmarshal(doc, &crb); err != nil {
					t.Fatalf("%s: %v", source, err)
				}
				out.subjects = append(out.subjects, crb.Subjects...)
			}
		case "Deployment":
			var d appsv1.Deployment
			if err := yaml.Unmarshal(doc, &d); err != nil {
				t.Fatalf("%s: %v", source, err)
			}
			out.deployments = append(out.deployments, d)
		}
	}
	return out
}

func shippedWritePolicy(t *testing.T) writePolicyObjects {
	t.Helper()
	dir := filepath.Join("..", "..", "config", "admission")
	files, err := filepath.Glob(filepath.Join(dir, "*.yaml"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no manifests under config/admission (err %v): the bundle ships no write policy", err)
	}
	var merged writePolicyObjects
	for _, f := range files {
		if filepath.Base(f) == "kustomization.yaml" {
			continue
		}
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		got := decodeWritePolicyObjects(t, raw, f)
		if got.policy != nil {
			merged.policy = got.policy
		}
		if got.binding != nil {
			merged.binding = got.binding
		}
	}
	if merged.policy == nil || merged.binding == nil {
		t.Fatalf("config/admission must hold both the policy and its binding (policy %v, binding %v)", merged.policy != nil, merged.binding != nil)
	}
	return merged
}

// assertPolicyIsStrict holds a policy and its binding (source or rendered) to the
// properties that make the narrowing real.
func assertPolicyIsStrict(t *testing.T, o writePolicyObjects, where string) {
	t.Helper()
	p, b := o.policy, o.binding

	// Fail closed. The policy confines only the operator's ServiceAccount (the
	// matchCondition is a plain equality that cannot error), so Fail can only
	// ever refuse the operator itself, and Ignore would turn any evaluation
	// error into an unrestricted operator.
	if p.Spec.FailurePolicy == nil || *p.Spec.FailurePolicy != admissionregistrationv1.Fail {
		t.Errorf("%s: failurePolicy must be Fail (a security narrowing must not fail open), got %v", where, p.Spec.FailurePolicy)
	}

	rules := p.Spec.MatchConstraints
	if rules == nil || len(rules.ResourceRules) != 1 {
		t.Fatalf("%s: want exactly one resource rule, got %+v", where, rules)
	}
	r := rules.ResourceRules[0]
	if strings.Join(r.APIGroups, ",") != "" || strings.Join(r.APIVersions, ",") != "v1" {
		t.Errorf("%s: the rule must match core v1, got groups %v versions %v", where, r.APIGroups, r.APIVersions)
	}
	res := append([]string(nil), r.Resources...)
	sort.Strings(res)
	if strings.Join(res, ",") != "configmaps,secrets" {
		t.Errorf("%s: the rule must cover exactly secrets and configmaps, got %v", where, res)
	}
	ops := map[string]bool{}
	for _, op := range r.Operations {
		ops[string(op)] = true
	}
	for _, want := range []string{"CREATE", "UPDATE", "DELETE"} {
		if !ops[want] && !ops["*"] {
			t.Errorf("%s: the rule skips %s, so the operator could do it unchecked", where, want)
		}
	}
	if rules.NamespaceSelector != nil || rules.ObjectSelector != nil {
		t.Errorf("%s: matchConstraints must not narrow by namespace or object selector (the operator writes in every app namespace)", where)
	}
	if rules.MatchPolicy != nil && *rules.MatchPolicy != admissionregistrationv1.Equivalent {
		t.Errorf("%s: matchPolicy must stay Equivalent, got %v", where, *rules.MatchPolicy)
	}

	// The confinement is ONE exact identity: a plain equality on the username.
	if len(p.Spec.MatchConditions) != 1 {
		t.Fatalf("%s: want one matchCondition (the operator identity), got %d", where, len(p.Spec.MatchConditions))
	}
	expr := p.Spec.MatchConditions[0].Expression
	if !strings.HasPrefix(strings.TrimSpace(expr), "request.userInfo.username == ") {
		t.Errorf("%s: the matchCondition must be an exact equality on request.userInfo.username, got %q", where, expr)
	}
	for _, loose := range []string{"startsWith", "endsWith", "matches", "contains", " in ", "||", "!="} {
		if strings.Contains(expr, loose) {
			t.Errorf("%s: the matchCondition uses %q; a loose match confines other principals (or skips the operator): %q", where, loose, expr)
		}
	}
	if len(p.Spec.Validations) == 0 {
		t.Errorf("%s: the policy has no validation", where)
	}
	// The name is not enough. A service-account-token Secret under an allowed name
	// is filled in with a credential for the ServiceAccount its annotation names,
	// which the operator could read; the policy must also pin the Secret's type.
	typeDeclared, typeEnforced := false, false
	for _, v := range p.Spec.Variables {
		typeDeclared = typeDeclared || v.Name == "allowedSecretType"
	}
	for _, v := range p.Spec.Validations {
		typeEnforced = typeEnforced || strings.Contains(v.Expression, "variables.allowedSecretType")
	}
	if !typeDeclared || !typeEnforced {
		t.Errorf("%s: the policy must pin the Secret type (variable allowedSecretType, used by a validation), "+
			"or a service-account-token Secret under an allowed name lets the operator mint a credential (declared %v, enforced %v)",
			where, typeDeclared, typeEnforced)
	}

	// The binding enforces, everywhere.
	if b.Spec.PolicyName != p.Name {
		t.Errorf("%s: the binding names policy %q, the policy is %q", where, b.Spec.PolicyName, p.Name)
	}
	deny := false
	for _, a := range b.Spec.ValidationActions {
		deny = deny || a == admissionregistrationv1.Deny
	}
	if !deny {
		t.Errorf("%s: the binding must include the Deny action (Warn/Audit alone enforce nothing), got %v", where, b.Spec.ValidationActions)
	}
	if mr := b.Spec.MatchResources; mr != nil && (mr.NamespaceSelector != nil || mr.ObjectSelector != nil || len(mr.ResourceRules) > 0 || len(mr.ExcludeResourceRules) > 0) {
		t.Errorf("%s: the binding must not narrow the policy's scope: %+v", where, mr)
	}
	if b.Spec.ParamRef != nil {
		t.Errorf("%s: the policy takes no parameters, the binding names one", where)
	}
}

func TestOperatorWritePolicySourceIsStrict(t *testing.T) {
	assertPolicyIsStrict(t, shippedWritePolicy(t), "config/admission")
}

// TestDefaultOverlayShipsTheWritePolicy: the policy is part of what
// `make build-installer` renders, and the identity it confines is wired from the
// real ServiceAccount rather than restated.
func TestDefaultOverlayShipsTheWritePolicy(t *testing.T) {
	c := repoFile(t, "config/default/kustomization.yaml")
	if !regexp.MustCompile(`(?m)^- \.\./admission\s*$`).MatchString(c) {
		t.Error("config/default/kustomization.yaml does not include ../admission: the bundle would ship no write policy")
	}
	for _, want := range []string{
		"kind: ServiceAccount",
		"name: controller-manager",
		"kind: ValidatingAdmissionPolicy",
		"[name=request-is-from-the-operator]",
		"admission_clusterscoped.yaml",
	} {
		if !strings.Contains(c, want) {
			t.Errorf("config/default/kustomization.yaml lacks %q: the operator identity in the policy is not rewritten from the ServiceAccount", want)
		}
	}
	k := repoFile(t, "config/admission/kustomization.yaml")
	for _, f := range []string{"secret-configmap-writes.yaml", "secret-configmap-writes-binding.yaml"} {
		if !strings.Contains(k, f) {
			t.Errorf("config/admission/kustomization.yaml does not list %s", f)
		}
	}
}

// TestRenderedBundleShipsTheWritePolicyForTheOperatorsOwnIdentity is the
// install-bundle half: dist/install.yaml carries the policy and binding, the
// binding resolves to the policy, and the identity the policy confines is
// EXACTLY the one the ClusterRoleBinding grants and the manager Deployment runs
// as, after the namespace and name prefix have been applied.
func TestRenderedBundleShipsTheWritePolicyForTheOperatorsOwnIdentity(t *testing.T) {
	raw, err := os.ReadFile(requireBundle(t))
	if err != nil {
		t.Fatal(err)
	}
	o := decodeWritePolicyObjects(t, raw, "dist/install.yaml")
	if o.policy == nil || o.binding == nil {
		t.Fatalf("the rendered bundle must carry the write policy and its binding (policy %v, binding %v)", o.policy != nil, o.binding != nil)
	}
	assertPolicyIsStrict(t, o, "dist/install.yaml")

	if len(o.subjects) != 1 || o.subjects[0].Kind != rbacv1.ServiceAccountKind {
		t.Fatalf("want one ServiceAccount subject on the manager ClusterRoleBinding, got %+v", o.subjects)
	}
	granted := "system:serviceaccount:" + o.subjects[0].Namespace + ":" + o.subjects[0].Name
	confined := celLiterals(o.policy.Spec.MatchConditions[0].Expression)
	if confined != granted {
		t.Errorf("the policy confines %q but the operator runs as %q: the policy would never match the operator "+
			"(namespace or name prefix drifted from the ServiceAccount)", confined, granted)
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
	running := "system:serviceaccount:" + manager.Namespace + ":" + manager.Spec.Template.Spec.ServiceAccountName
	if confined != running {
		t.Errorf("the policy confines %q but the manager Deployment runs as %q", confined, running)
	}
	// Both objects are cluster-scoped: kustomize's namespace transformer does not
	// know the kinds and would stamp a namespace on them, which a GitOps diff
	// then reports forever.
	if o.policy.Namespace != "" || o.binding.Namespace != "" {
		t.Errorf("the cluster-scoped policy and binding carry a namespace (%q, %q); admission_clusterscoped.yaml must remove it",
			o.policy.Namespace, o.binding.Namespace)
	}
	// Cluster-scoped names must be prefixed like every other cluster-scoped object
	// in the bundle, so two installs cannot collide.
	for _, n := range []string{o.policy.Name, o.binding.Name} {
		if !strings.HasPrefix(n, "kn-next-operator-") {
			t.Errorf("cluster-scoped %q is not prefixed with the bundle's name prefix", n)
		}
	}
}
