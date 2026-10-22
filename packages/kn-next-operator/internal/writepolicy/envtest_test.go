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
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-logr/logr"
	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	"sigs.k8s.io/yaml"
)

// The self-check against a real kube-apiserver: the shipped policy and binding,
// the shipped read-only role, and SelfSubjectReview for the operator's identity.
// Each unenforced case is arranged on the live cluster the way it happens in
// production (a deleted object, a policy for another identity, an audit-only
// binding) and must drop the gauge to 0; the matching case must raise it to 1.

const policyName = "secret-configmap-writes"

func startEnvtest(t *testing.T) (*rest.Config, *envtest.Environment) {
	t.Helper()
	env := &envtest.Environment{}
	if os.Getenv("KUBEBUILDER_ASSETS") == "" {
		base := filepath.Join("..", "..", "bin", "k8s")
		if entries, err := os.ReadDir(base); err == nil {
			for _, e := range entries {
				if e.IsDir() {
					env.BinaryAssetsDirectory = filepath.Join(base, e.Name())
					break
				}
			}
		}
	}
	cfg, err := env.Start()
	if err != nil {
		t.Fatalf("start envtest: %v", err)
	}
	t.Cleanup(func() { _ = env.Stop() })
	return cfg, env
}

// shippedObjects loads the policy and binding exactly as config/admission ships
// them, with the policy's identity replaced by username (the shipped literals
// are the unprefixed bundle's).
func shippedObjects(t *testing.T, username string) (*admissionregistrationv1.ValidatingAdmissionPolicy, *admissionregistrationv1.ValidatingAdmissionPolicyBinding) {
	t.Helper()
	read := func(name string, into any) {
		raw, err := os.ReadFile(filepath.Join("..", "..", "config", "admission", name))
		if err != nil {
			t.Fatal(err)
		}
		if err := yaml.UnmarshalStrict(raw, into); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	p := &admissionregistrationv1.ValidatingAdmissionPolicy{}
	b := &admissionregistrationv1.ValidatingAdmissionPolicyBinding{}
	read("secret-configmap-writes.yaml", p)
	read("secret-configmap-writes-binding.yaml", b)
	if len(p.Spec.MatchConditions) != 1 {
		t.Fatalf("the shipped policy must carry one matchCondition, has %d", len(p.Spec.MatchConditions))
	}
	p.Spec.MatchConditions[0].Expression = "request.userInfo.username == '" + username + "'"
	return p, b
}

func TestSelfCheckAgainstARealApiserver(t *testing.T) {
	cfg, env := startEnvtest(t)
	ctx := context.Background()
	admin, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	src, err := NewClientSource(cfg)
	if err != nil {
		t.Fatal(err)
	}
	// SelfSubjectReview is how the operator learns the username the apiserver
	// sees; the policy below confines exactly that.
	self, err := src.OperatorUsername(ctx)
	if err != nil || self == "" {
		t.Fatalf("SelfSubjectReview returned %q, %v", self, err)
	}

	install := func(t *testing.T, username string, mutateBinding func(*admissionregistrationv1.ValidatingAdmissionPolicyBinding)) {
		t.Helper()
		p, b := shippedObjects(t, username)
		if mutateBinding != nil {
			mutateBinding(b)
		}
		if _, err := admin.AdmissionregistrationV1().ValidatingAdmissionPolicies().Create(ctx, p, metav1.CreateOptions{}); err != nil {
			t.Fatalf("the shipped policy is not accepted: %v", err)
		}
		if _, err := admin.AdmissionregistrationV1().ValidatingAdmissionPolicyBindings().Create(ctx, b, metav1.CreateOptions{}); err != nil {
			t.Fatalf("the shipped binding is not accepted: %v", err)
		}
		t.Cleanup(func() {
			_ = admin.AdmissionregistrationV1().ValidatingAdmissionPolicyBindings().Delete(ctx, policyName, metav1.DeleteOptions{})
			_ = admin.AdmissionregistrationV1().ValidatingAdmissionPolicies().Delete(ctx, policyName, metav1.DeleteOptions{})
		})
	}
	check := func(t *testing.T) Verdict {
		t.Helper()
		m := &Monitor{Source: src, Name: policyName, Log: logr.Discard()}
		return m.CheckOnce(ctx)
	}

	t.Run("the policy present and matching: gauge 1", func(t *testing.T) {
		install(t, self, nil)
		v := check(t)
		if !v.Enforced || gaugeValue(t) != 1 {
			t.Fatalf("verdict %+v, gauge %v: want enforced and 1", v, gaugeValue(t))
		}
	})

	t.Run("the policy deleted: gauge 0", func(t *testing.T) {
		install(t, self, nil)
		if err := admin.AdmissionregistrationV1().ValidatingAdmissionPolicies().Delete(ctx, policyName, metav1.DeleteOptions{}); err != nil {
			t.Fatal(err)
		}
		v := check(t)
		if v.Enforced || v.Reason != ReasonPolicyMissing || gaugeValue(t) != 0 {
			t.Fatalf("verdict %+v, gauge %v: want PolicyMissing and 0", v, gaugeValue(t))
		}
	})

	t.Run("the binding deleted: gauge 0", func(t *testing.T) {
		install(t, self, nil)
		if err := admin.AdmissionregistrationV1().ValidatingAdmissionPolicyBindings().Delete(ctx, policyName, metav1.DeleteOptions{}); err != nil {
			t.Fatal(err)
		}
		v := check(t)
		if v.Enforced || v.Reason != ReasonBindingMissing || gaugeValue(t) != 0 {
			t.Fatalf("verdict %+v, gauge %v: want BindingMissing and 0", v, gaugeValue(t))
		}
	})

	t.Run("the policy confines another username: gauge 0", func(t *testing.T) {
		install(t, "system:serviceaccount:somewhere-else:not-the-operator", nil)
		v := check(t)
		if v.Enforced || v.Reason != ReasonIdentityMismatch || gaugeValue(t) != 0 {
			t.Fatalf("verdict %+v, gauge %v: want IdentityMismatch and 0", v, gaugeValue(t))
		}
	})

	t.Run("the binding only audits: gauge 0", func(t *testing.T) {
		install(t, self, func(b *admissionregistrationv1.ValidatingAdmissionPolicyBinding) {
			b.Spec.ValidationActions = []admissionregistrationv1.ValidationAction{admissionregistrationv1.Audit}
		})
		v := check(t)
		if v.Enforced || v.Reason != ReasonBindingNotDeny || gaugeValue(t) != 0 {
			t.Fatalf("verdict %+v, gauge %v: want BindingNotDeny and 0", v, gaugeValue(t))
		}
	})

	// The RBAC the operator is given for this is `get` on the two named
	// objects. Prove it is sufficient, and no wider, on a real apiserver: an
	// identity holding exactly the shipped role runs the whole check.
	t.Run("the shipped read-only role is enough, and no more", func(t *testing.T) {
		raw, err := os.ReadFile(filepath.Join("..", "..", "config", "rbac", "write_policy_reader_role.yaml"))
		if err != nil {
			t.Fatal(err)
		}
		var role rbacv1.ClusterRole
		if err := yaml.Unmarshal(raw, &role); err != nil || len(role.Rules) == 0 {
			t.Fatalf("write_policy_reader_role.yaml parsed to %d rules (err %v)", len(role.Rules), err)
		}
		if strings.Join(role.Rules[0].ResourceNames, ",") != policyName {
			t.Fatalf("the shipped role names %v, this proof installs %q", role.Rules[0].ResourceNames, policyName)
		}
		role.Name = "knext-write-policy-reader-proof"
		const reader = "system:serviceaccount:kn-next-operator-system:proof-operator"
		if _, err := admin.RbacV1().ClusterRoles().Create(ctx, &role, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
		crb := &rbacv1.ClusterRoleBinding{
			ObjectMeta: metav1.ObjectMeta{Name: role.Name},
			RoleRef:    rbacv1.RoleRef{APIGroup: rbacv1.GroupName, Kind: "ClusterRole", Name: role.Name},
			Subjects:   []rbacv1.Subject{{Kind: rbacv1.ServiceAccountKind, Namespace: "kn-next-operator-system", Name: "proof-operator"}},
		}
		if _, err := admin.RbacV1().ClusterRoleBindings().Create(ctx, crb, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
		u, err := env.AddUser(envtest.User{Name: reader, Groups: []string{"system:serviceaccounts", "system:serviceaccounts:kn-next-operator-system"}}, nil)
		if err != nil {
			t.Fatal(err)
		}
		readerSrc, err := NewClientSource(u.Config())
		if err != nil {
			t.Fatal(err)
		}
		install(t, reader, nil)
		m := &Monitor{Source: readerSrc, Name: policyName, Log: logr.Discard()}
		if v := m.CheckOnce(ctx); !v.Enforced || gaugeValue(t) != 1 {
			t.Fatalf("with exactly the shipped role the check must succeed, got %+v (gauge %v)", v, gaugeValue(t))
		}
		rc, err := kubernetes.NewForConfig(u.Config())
		if err != nil {
			t.Fatal(err)
		}
		if _, err := rc.AdmissionregistrationV1().ValidatingAdmissionPolicies().List(ctx, metav1.ListOptions{}); !apierrors.IsForbidden(err) {
			t.Errorf("the role must not allow listing policies, got %v", err)
		}
		if _, err := rc.AdmissionregistrationV1().ValidatingAdmissionPolicies().Get(ctx, "some-other-policy", metav1.GetOptions{}); !apierrors.IsForbidden(err) {
			t.Errorf("the role must not allow reading any other policy, got %v", err)
		}
		if err := rc.AdmissionregistrationV1().ValidatingAdmissionPolicies().Delete(ctx, policyName, metav1.DeleteOptions{}); !apierrors.IsForbidden(err) {
			t.Errorf("the role must not allow deleting the policy, got %v", err)
		}
		// A read the role does not permit is reported as not enforced, not as enforced.
		other := &Monitor{Source: readerSrc, Name: "not-in-the-role", Log: logr.Discard()}
		if v := other.CheckOnce(ctx); v.Enforced || v.Reason != ReasonUnverifiable || gaugeValue(t) != 0 {
			t.Errorf("a forbidden read must be Unverifiable and 0, got %+v (gauge %v)", v, gaugeValue(t))
		}
	})

}
