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
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
	"sigs.k8s.io/yaml"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// ADR-0004 Amendment 2 Decision 1: the BackendService reconciler sets the zone's
// controller ownerReference with blockOwnerDeletion: true, and the apiserver
// admits that only for a subject that may UPDATE the owner's finalizers
// (nextapps/finalizers). This runs the REAL reconciler as an identity bound to
// the SHIPPED ClusterRole (config/rbac/role.yaml), on an apiserver with the
// OwnerReferencesPermissionEnforcement admission plugin on (the default envtest
// apiserver does not enable it, which would make the proof vacuous), and asserts
// both halves: accepted with the shipped role, refused without the grant.
func TestFunctionOwnerReferenceNeedsTheNextAppFinalizersGrant(t *testing.T) {
	env := &envtest.Environment{
		CRDDirectoryPaths: []string{
			filepath.Join("..", "..", "config", "crd", "bases"),
			filepath.Join("..", "..", "config", "testdata", "crds"),
		},
		ErrorIfCRDPathMissing: true,
	}
	if dir := getFirstFoundEnvTestBinaryDir(); dir != "" && os.Getenv("KUBEBUILDER_ASSETS") == "" {
		env.BinaryAssetsDirectory = dir
	}
	env.ControlPlane.GetAPIServer().Configure().Append("enable-admission-plugins", "OwnerReferencesPermissionEnforcement")
	cfg, err := env.Start()
	if err != nil {
		t.Fatalf("start envtest: %v", err)
	}
	t.Cleanup(func() { _ = env.Stop() })

	scheme := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{clientgoscheme.AddToScheme, appsv1alpha1.AddToScheme, servingv1.AddToScheme} {
		if err := add(scheme); err != nil {
			t.Fatal(err)
		}
	}
	admin, err := client.New(cfg, client.Options{Scheme: scheme})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	raw, err := os.ReadFile(filepath.Join("..", "..", "config", "rbac", "role.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var shipped rbacv1.ClusterRole
	if err := yaml.Unmarshal(raw, &shipped); err != nil || len(shipped.Rules) == 0 {
		t.Fatalf("role.yaml parsed to %d rules (err %v); the proof would be vacuous", len(shipped.Rules), err)
	}

	// run binds a fresh identity to rules and reconciles one function as it.
	run := func(name string, rules []rbacv1.PolicyRule) error {
		group := "knext-ownerref-" + name
		cr := &rbacv1.ClusterRole{ObjectMeta: metav1.ObjectMeta{Name: group}, Rules: rules}
		crb := &rbacv1.ClusterRoleBinding{
			ObjectMeta: metav1.ObjectMeta{Name: group},
			RoleRef:    rbacv1.RoleRef{APIGroup: rbacv1.GroupName, Kind: "ClusterRole", Name: group},
			Subjects:   []rbacv1.Subject{{APIGroup: rbacv1.GroupName, Kind: "Group", Name: group}},
		}
		for _, o := range []client.Object{cr, crb} {
			if err := admin.Create(ctx, o); err != nil {
				t.Fatal(err)
			}
		}
		user, err := env.AddUser(envtest.User{Name: group, Groups: []string{group}}, nil)
		if err != nil {
			t.Fatal(err)
		}
		as, err := client.New(user.Config(), client.Options{Scheme: scheme})
		if err != nil {
			t.Fatal(err)
		}
		ns := name
		if err := admin.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}}); err != nil {
			t.Fatal(err)
		}
		zone := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: "orders", Namespace: ns},
			Spec: appsv1alpha1.NextAppSpec{
				Image:    validImageForBS(),
				Backends: []appsv1alpha1.BackendBinding{{Name: "pricing", Service: "pricing"}},
			},
		}
		bs := &appsv1alpha1.BackendService{
			ObjectMeta: metav1.ObjectMeta{Name: "pricing", Namespace: ns},
			Spec:       appsv1alpha1.BackendServiceSpec{Zone: "orders", Image: bsImage},
		}
		for _, o := range []client.Object{zone, bs} {
			if err := admin.Create(ctx, o); err != nil {
				t.Fatal(err)
			}
		}
		// RBAC is eventually consistent: wait until the identity can read.
		deadline := time.Now().Add(10 * time.Second)
		for as.Get(ctx, client.ObjectKeyFromObject(bs), &appsv1alpha1.BackendService{}) != nil {
			if time.Now().After(deadline) {
				t.Fatalf("identity %s never became able to read BackendServices", group)
			}
			time.Sleep(200 * time.Millisecond)
		}
		r := &BackendServiceReconciler{Client: as, Scheme: scheme, APIReader: as, Recorder: record.NewFakeRecorder(64)}
		_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Namespace: ns, Name: "pricing"}})
		return err
	}

	// 1. The shipped role: the ownerReference (blockOwnerDeletion) is accepted
	//    and the function renders.
	if err := run("shipped", shipped.Rules); err != nil {
		t.Fatalf("the reconciler failed under the SHIPPED ClusterRole: %v", err)
	}
	got := &appsv1alpha1.BackendService{}
	if err := admin.Get(ctx, types.NamespacedName{Namespace: "shipped", Name: "pricing"}, got); err != nil {
		t.Fatal(err)
	}
	if ref := metav1.GetControllerOf(got); ref == nil || ref.Name != "orders" || ref.BlockOwnerDeletion == nil || !*ref.BlockOwnerDeletion {
		t.Fatalf("want the zone's controller ownerReference with blockOwnerDeletion, got %+v", got.OwnerReferences)
	}
	if err := admin.Get(ctx, types.NamespacedName{Namespace: "shipped", Name: "pricing"}, &servingv1.Service{}); err != nil {
		t.Fatalf("the function was not rendered under the shipped role: %v", err)
	}

	// 2. The same role WITHOUT nextapps/finalizers: the apiserver refuses the
	//    ownerReference. If this passes, the plugin is off and step 1 proved nothing.
	var withoutGrant []rbacv1.PolicyRule
	removed := false
	for _, rule := range shipped.Rules {
		rule = *rule.DeepCopy()
		var keep []string
		for _, res := range rule.Resources {
			if res == "nextapps/finalizers" {
				removed = true
				continue
			}
			keep = append(keep, res)
		}
		if len(keep) > 0 {
			rule.Resources = keep
			withoutGrant = append(withoutGrant, rule)
		}
	}
	if !removed {
		t.Fatalf("the shipped role has no nextapps/finalizers grant; blockOwnerDeletion on the zone's " +
			"ownerReference cannot be admitted (ADR-0004 Amendment 2 Decision 1)")
	}
	err = run("nofinalizers", withoutGrant)
	if err == nil || !strings.Contains(err.Error(), "blockOwnerDeletion") {
		t.Fatalf("without nextapps/finalizers the ownerReference must be refused, got err=%v", err)
	}
}
