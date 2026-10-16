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
	servingv1beta1 "knative.dev/serving/pkg/apis/serving/v1beta1"
)

// The zone signing key under the SHIPPED ClusterRole (config/rbac/role.yaml),
// on an apiserver with OwnerReferencesPermissionEnforcement on: the real
// NextApp reconciler, running as an identity bound to exactly those rules,
// creates the key Secret and the JWKS ConfigMap with the zone's controller
// ownerReference (blockOwnerDeletion included) and rotates the key. Both halves:
// the same role without the Secrets write verbs, or without the ConfigMap
// verbs, fails the pass, so the grant is load-bearing and not decoration.
func TestZoneSigningKeyReconcilesUnderTheShippedRole(t *testing.T) {
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
	for _, add := range []func(*runtime.Scheme) error{
		clientgoscheme.AddToScheme, appsv1alpha1.AddToScheme, servingv1.AddToScheme, servingv1beta1.AddToScheme,
	} {
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

	// without returns the shipped rules minus the given verbs on one core resource.
	without := func(resource string, verbs ...string) []rbacv1.PolicyRule {
		drop := map[string]bool{}
		for _, v := range verbs {
			drop[v] = true
		}
		var out []rbacv1.PolicyRule
		removed := false
		for _, rule := range shipped.Rules {
			rule = *rule.DeepCopy()
			hit := false
			for _, res := range rule.Resources {
				hit = hit || res == resource
			}
			if !hit {
				out = append(out, rule)
				continue
			}
			// Split the rule: the resource keeps only the surviving verbs.
			var others []string
			for _, res := range rule.Resources {
				if res != resource {
					others = append(others, res)
				}
			}
			if len(others) > 0 {
				o := *rule.DeepCopy()
				o.Resources = others
				out = append(out, o)
			}
			var keep []string
			for _, v := range rule.Verbs {
				if drop[v] {
					removed = true
					continue
				}
				keep = append(keep, v)
			}
			if len(keep) > 0 {
				r := *rule.DeepCopy()
				r.Resources, r.Verbs = []string{resource}, keep
				out = append(out, r)
			}
		}
		if !removed {
			t.Fatalf("the shipped role grants none of %v on %s; this half proves nothing", verbs, resource)
		}
		return out
	}

	clock := &zoneClock{now: time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)}
	// run binds a fresh identity to rules, creates a bound zone as the admin,
	// and reconciles the zone as that identity (twice when rotate is set: once
	// to create, once to start a rotation).
	run := func(name string, rules []rbacv1.PolicyRule, rotate bool) error {
		group := "knext-zonekey-" + name
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
		deadline := time.Now().Add(10 * time.Second)
		for as.Get(ctx, client.ObjectKeyFromObject(zone), &appsv1alpha1.NextApp{}) != nil {
			if time.Now().After(deadline) {
				t.Fatalf("identity %s never became able to read NextApps", group)
			}
			time.Sleep(200 * time.Millisecond)
		}
		r := &NextAppReconciler{
			Client: as, APIReader: as, Scheme: scheme, Recorder: record.NewFakeRecorder(256),
			BackendServiceCRDPresent: true, Clock: clock.Now,
		}
		req := reconcile.Request{NamespacedName: types.NamespacedName{Namespace: ns, Name: "orders"}}
		if _, err := r.Reconcile(ctx, req); err != nil {
			return err
		}
		if rotate {
			cur := &appsv1alpha1.NextApp{}
			if err := admin.Get(ctx, req.NamespacedName, cur); err != nil {
				t.Fatal(err)
			}
			cur.Annotations = map[string]string{RotateSigningKeyAnnotation: "rbac"}
			if err := admin.Update(ctx, cur); err != nil {
				t.Fatal(err)
			}
			if _, err := r.Reconcile(ctx, req); err != nil {
				return err
			}
		}
		return nil
	}

	// 1. The shipped role: created, owned (blockOwnerDeletion admitted), rotated.
	if err := run("shipped", shipped.Rules, true); err != nil {
		t.Fatalf("the zone signing key failed under the SHIPPED ClusterRole: %v", err)
	}
	sec := &corev1.Secret{}
	if err := admin.Get(ctx, types.NamespacedName{Namespace: "shipped", Name: ZoneSigningKeySecretName("orders")}, sec); err != nil {
		t.Fatalf("no key Secret under the shipped role: %v", err)
	}
	if ref := metav1.GetControllerOf(sec); ref == nil || ref.Name != "orders" || ref.BlockOwnerDeletion == nil || !*ref.BlockOwnerDeletion {
		t.Fatalf("want the zone's controller ownerReference with blockOwnerDeletion on the key, got %+v", sec.OwnerReferences)
	}
	keys, err := readSigningKeySecret(sec)
	if err != nil || keys.next == nil {
		t.Fatalf("the rotation request did not stage a key under the shipped role (err %v)", err)
	}
	cm := &corev1.ConfigMap{}
	if err := admin.Get(ctx, types.NamespacedName{Namespace: "shipped", Name: ZoneJWKSConfigMapName("orders")}, cm); err != nil {
		t.Fatalf("no JWKS under the shipped role: %v", err)
	}
	if ref := metav1.GetControllerOf(cm); ref == nil || ref.Name != "orders" {
		t.Fatalf("want the zone's controller ownerReference on the JWKS, got %+v", cm.OwnerReferences)
	}
	if !jwksHasKid(cm.Data[ZoneJWKSFileName], keys.next.kid) {
		t.Fatalf("the staged key was not published under the shipped role")
	}

	// 2. Without the Secrets write verbs the pass fails: the grant is needed. The
	//    returned error is redacted (it keeps no type), so match its message.
	if err := run("nosecretcreate", without("secrets", "create"), false); err == nil || !strings.Contains(err.Error(), "forbidden") {
		t.Fatalf("without create on secrets the key cannot be created; got err=%v", err)
	}
	if err := run("nosecretupdate", without("secrets", "update"), true); err == nil || !strings.Contains(err.Error(), "forbidden") {
		t.Fatalf("without update on secrets the key cannot be rotated; got err=%v", err)
	}
	// 3. Without the ConfigMap verbs the JWKS cannot be published.
	if err := run("noconfigmaps", without("configmaps", "get", "create", "update"), false); err == nil || !strings.Contains(err.Error(), "forbidden") {
		t.Fatalf("without the ConfigMap grant the JWKS cannot be published; got err=%v", err)
	}
}
