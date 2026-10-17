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
	"bufio"
	"bytes"
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	utilyaml "k8s.io/apimachinery/pkg/util/yaml"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	"sigs.k8s.io/yaml"
)

// The RELEASE ARTIFACT, not the source, on a real kube-apiserver.
//
// operator_write_policy_envtest_test.go proves what the policy does. This proves
// that what `make build-installer` renders (dist/install.yaml, after kustomize has
// applied the namespace and the name prefix) still does it: the rendered policy
// and binding are accepted by the apiserver, and they confine the identity the
// rendered ClusterRoleBinding grants, which is the one the manager runs as. If the
// rewrite of the operator's identity ever drifted, the policy would match nobody,
// the operator would be unrestricted, and no error would appear anywhere; here the
// operator identity is taken from the ClusterRoleBinding, not from the policy, so
// that drift reds this test.
//
// The bundle is built by `make build-installer`. Like the install tests, a missing
// bundle skips, except under KNEXT_REQUIRE_BUNDLE=1 (CI), where it fails.
func TestRenderedBundlePolicyConfinesTheIdentityTheOperatorRunsAs(t *testing.T) {
	path := filepath.Join("..", "..", "dist", "install.yaml")
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.Getenv("KNEXT_REQUIRE_BUNDLE") == "1" {
			t.Fatalf("dist/install.yaml not generated but KNEXT_REQUIRE_BUNDLE=1: run `make build-installer` first (%v)", err)
		}
		t.Skip("dist/install.yaml not generated (run `make build-installer`)")
	}

	var (
		policy  *admissionregistrationv1.ValidatingAdmissionPolicy
		binding *admissionregistrationv1.ValidatingAdmissionPolicyBinding
		role    *rbacv1.ClusterRole
		subject *rbacv1.Subject
	)
	docs := utilyaml.NewYAMLReader(bufio.NewReader(bytes.NewReader(raw)))
	for {
		doc, err := docs.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		var head struct {
			Kind     string `json:"kind"`
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
		}
		if yaml.Unmarshal(doc, &head) != nil {
			continue
		}
		switch {
		case head.Kind == "ValidatingAdmissionPolicy":
			policy = &admissionregistrationv1.ValidatingAdmissionPolicy{}
			if err := yaml.UnmarshalStrict(doc, policy); err != nil {
				t.Fatal(err)
			}
		case head.Kind == "ValidatingAdmissionPolicyBinding":
			binding = &admissionregistrationv1.ValidatingAdmissionPolicyBinding{}
			if err := yaml.UnmarshalStrict(doc, binding); err != nil {
				t.Fatal(err)
			}
		case head.Kind == "ClusterRole" && strings.HasSuffix(head.Metadata.Name, "-manager-role"):
			role = &rbacv1.ClusterRole{}
			if err := yaml.Unmarshal(doc, role); err != nil {
				t.Fatal(err)
			}
		case head.Kind == "ClusterRoleBinding" && strings.HasSuffix(head.Metadata.Name, "-manager-rolebinding"):
			crb := &rbacv1.ClusterRoleBinding{}
			if err := yaml.Unmarshal(doc, crb); err != nil {
				t.Fatal(err)
			}
			if len(crb.Subjects) == 1 {
				subject = &crb.Subjects[0]
			}
		}
	}
	if policy == nil || binding == nil || role == nil || subject == nil || subject.Kind != rbacv1.ServiceAccountKind {
		t.Fatalf("the rendered bundle lacks the policy, its binding, the manager role or its ServiceAccount binding "+
			"(policy %v, binding %v, role %v, subject %v)", policy != nil, binding != nil, role != nil, subject != nil)
	}
	operatorUser := "system:serviceaccount:" + subject.Namespace + ":" + subject.Name

	env := &envtest.Environment{}
	if dir := getFirstFoundEnvTestBinaryDir(); dir != "" && os.Getenv("KUBEBUILDER_ASSETS") == "" {
		env.BinaryAssetsDirectory = dir
	}
	cfg, err := env.Start()
	if err != nil {
		t.Fatalf("start envtest: %v", err)
	}
	t.Cleanup(func() { _ = env.Stop() })
	logf.SetLogger(zap.New(zap.WriteTo(io.Discard)))

	scheme := runtime.NewScheme()
	if err := clientgoscheme.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	admin, err := client.New(cfg, client.Options{Scheme: scheme})
	if err != nil {
		t.Fatal(err)
	}

	// The operator, bound to the rendered manager role exactly as the bundle binds it.
	cr := &rbacv1.ClusterRole{ObjectMeta: metav1.ObjectMeta{Name: "bundle-manager-role"}, Rules: role.Rules}
	crb := &rbacv1.ClusterRoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: "bundle-manager-role"},
		RoleRef:    rbacv1.RoleRef{APIGroup: rbacv1.GroupName, Kind: "ClusterRole", Name: cr.Name},
		Subjects:   []rbacv1.Subject{*subject},
	}
	for _, o := range []client.Object{cr, crb} {
		if err := admin.Create(ctx, o); err != nil {
			t.Fatal(err)
		}
	}
	user, err := env.AddUser(envtest.User{
		Name:   operatorUser,
		Groups: []string{"system:serviceaccounts", "system:serviceaccounts:" + subject.Namespace},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	operator, err := client.New(user.Config(), client.Options{Scheme: scheme})
	if err != nil {
		t.Fatal(err)
	}
	if err := admin.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "bundle-zone"}}); err != nil {
		t.Fatal(err)
	}

	// The rendered policy and binding exactly as shipped (names prefixed, no namespace).
	if err := admin.Create(ctx, policy); err != nil {
		t.Fatalf("the apiserver rejects the rendered policy: %v", err)
	}
	if err := admin.Create(ctx, binding); err != nil {
		t.Fatalf("the apiserver rejects the rendered binding: %v", err)
	}

	secret := func(name string) *corev1.Secret {
		return &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "bundle-zone"}}
	}
	isPolicyDenial := func(err error) bool {
		return err != nil && apierrors.IsForbidden(err) && strings.Contains(err.Error(), "ValidatingAdmissionPolicy")
	}
	deadline := time.Now().Add(90 * time.Second)
	for {
		err := operator.Create(ctx, secret("not-allowed-probe"), client.DryRunAll)
		if isPolicyDenial(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the rendered policy never refused the identity the operator runs as (%s): it confines %q "+
				"(last error: %v)", operatorUser, policy.Spec.MatchConditions[0].Expression, err)
		}
		time.Sleep(300 * time.Millisecond)
	}

	// Allowed: the two names the operator writes. Refused: anything else.
	if err := operator.Create(ctx, secret(ZoneSigningKeySecretName("zone-a"))); err != nil {
		t.Errorf("the operator was refused its own signing-key Secret: %v", err)
	}
	if err := operator.Create(ctx, &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: ZoneJWKSConfigMapName("zone-a"), Namespace: "bundle-zone"}}); err != nil {
		t.Errorf("the operator was refused its own JWKS ConfigMap: %v", err)
	}
	if err := operator.Create(ctx, secret("evil")); !isPolicyDenial(err) {
		t.Errorf("the operator created a stranger's Secret (want a policy denial): %v", err)
	}
	if err := operator.Create(ctx, &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "evil", Namespace: "bundle-zone"}}); !isPolicyDenial(err) {
		t.Errorf("the operator created a stranger's ConfigMap (want a policy denial): %v", err)
	}
	// Not affected: the cluster admin.
	if err := admin.Create(ctx, secret("admin-free")); err != nil {
		t.Errorf("the cluster admin was refused: %v", err)
	}
}
