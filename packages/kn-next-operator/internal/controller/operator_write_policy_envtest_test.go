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
	"k8s.io/apimachinery/pkg/types"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
	"sigs.k8s.io/yaml"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
	servingv1beta1 "knative.dev/serving/pkg/apis/serving/v1beta1"
)

// The shipped ValidatingAdmissionPolicy (config/admission) on a real
// kube-apiserver. RBAC cannot restrict `create` by name, so the operator's
// cluster-wide create/update on Secrets and ConfigMaps is bounded here instead:
// its ServiceAccount may touch only the objects it writes (the zone signing key
// and JWKS), and everyone else is untouched.
//
// What this proves, each half against its control:
//   - the operator identity, bound to the SHIPPED ClusterRole (so RBAC allows
//     every write below), is refused by the POLICY for any other name, on
//     create, update and delete, and allowed for the names it writes;
//   - the real NextApp reconciler still creates and rotates the zone's key and
//     JWKS with the policy in force (the existing reconcilers do not break);
//   - a different principal, a ServiceAccount of the same name in another
//     namespace, and the cluster admin are not affected;
//   - the proof is sensitive to the policy: with the ConfigMap allow-list
//     emptied, the same reconciler pass is refused by the policy.
//
// envtest runs no kube-controller-manager, so the apiserver's asynchronous CEL
// type-check (the policy's status.typeChecking) is never populated here. The
// matrix below runs every branch of the expressions on the real admission path
// instead: create, update and delete, both resources, allowed and refused names.
func TestOperatorWritePolicyNarrowsSecretAndConfigMapWrites(t *testing.T) {
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
	// The shipped role sets blockOwnerDeletion on the zone's objects; the real
	// cluster enforces the finalizers grant it needs, so the proof does too.
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
	logf.SetLogger(zap.New(zap.WriteTo(io.Discard)))
	ctx := context.Background()
	admin, err := client.New(cfg, client.Options{Scheme: scheme})
	if err != nil {
		t.Fatal(err)
	}

	policy, binding := loadShippedWritePolicy(t)
	operatorUser := policyOperatorUsername(t, policy)
	if !strings.HasPrefix(operatorUser, "system:serviceaccount:") || strings.Count(operatorUser, ":") != 3 {
		t.Fatalf("the policy's operator identity %q is not a ServiceAccount username", operatorUser)
	}
	opNamespace, opSA := splitSAUsername(t, operatorUser)

	// --- identities ---------------------------------------------------------
	roleFor := func(name string, rules []rbacv1.PolicyRule, subject rbacv1.Subject) {
		t.Helper()
		cr := &rbacv1.ClusterRole{ObjectMeta: metav1.ObjectMeta{Name: name}, Rules: rules}
		crb := &rbacv1.ClusterRoleBinding{
			ObjectMeta: metav1.ObjectMeta{Name: name},
			RoleRef:    rbacv1.RoleRef{APIGroup: rbacv1.GroupName, Kind: "ClusterRole", Name: name},
			Subjects:   []rbacv1.Subject{subject},
		}
		for _, o := range []client.Object{cr, crb} {
			if err := admin.Create(ctx, o); err != nil {
				t.Fatal(err)
			}
		}
	}
	identity := func(username string) client.Client {
		t.Helper()
		parts := strings.Split(username, ":")
		groups := []string{"system:serviceaccounts", "system:serviceaccounts:" + parts[2]}
		u, err := env.AddUser(envtest.User{Name: username, Groups: groups}, nil)
		if err != nil {
			t.Fatal(err)
		}
		c, err := client.New(u.Config(), client.Options{Scheme: scheme})
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	saSubject := func(namespace, name string) rbacv1.Subject {
		return rbacv1.Subject{Kind: rbacv1.ServiceAccountKind, Namespace: namespace, Name: name}
	}

	raw, err := os.ReadFile(filepath.Join("..", "..", "config", "rbac", "role.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var shipped rbacv1.ClusterRole
	if err := yaml.Unmarshal(raw, &shipped); err != nil || len(shipped.Rules) == 0 {
		t.Fatalf("role.yaml parsed to %d rules (err %v); the proof would be vacuous", len(shipped.Rules), err)
	}
	// RBAC allows the operator every write below. Delete is not in the shipped
	// role (the operator never deletes); granting it here, to the test identity
	// only, makes a refused DELETE attributable to the policy and not to RBAC.
	opRules := append(append([]rbacv1.PolicyRule{}, shipped.Rules...), rbacv1.PolicyRule{
		APIGroups: []string{""}, Resources: []string{"secrets", "configmaps"}, Verbs: []string{"delete", "list"},
	})
	roleFor("knext-vap-operator", opRules, saSubject(opNamespace, opSA))
	everything := []rbacv1.PolicyRule{{APIGroups: []string{""}, Resources: []string{"secrets", "configmaps"}, Verbs: []string{"*"}}}
	const otherNS = "team-a"
	roleFor("knext-vap-tenant", everything, saSubject(otherNS, "builder"))
	roleFor("knext-vap-lookalike", everything, saSubject(otherNS, opSA))

	operator := identity(operatorUser)
	tenant := identity("system:serviceaccount:" + otherNS + ":builder")
	lookalike := identity("system:serviceaccount:" + otherNS + ":" + opSA)

	ns := "vap-writes"
	for _, n := range []string{ns, otherNS} {
		if err := admin.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: n}}); err != nil {
			t.Fatal(err)
		}
	}

	// --- install the shipped policy and its binding -------------------------
	if err := admin.Create(ctx, policy); err != nil {
		t.Fatalf("the shipped policy is not accepted by the apiserver: %v", err)
	}
	if err := admin.Create(ctx, binding); err != nil {
		t.Fatalf("the shipped binding is not accepted by the apiserver: %v", err)
	}
	// isPolicyDenial: Forbidden, by the policy (not by RBAC, which words it
	// differently), naming the object the operator may not touch.
	isPolicyDenial := func(err error) bool {
		return err != nil && apierrors.IsForbidden(err) && strings.Contains(err.Error(), "ValidatingAdmissionPolicy")
	}
	secret := func(name string) *corev1.Secret {
		return &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}, StringData: map[string]string{"k": "v"}}
	}
	cm := func(name string) *corev1.ConfigMap {
		return &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns}, Data: map[string]string{"k": "v"}}
	}

	// The policy takes a moment to be compiled and bound: wait until a write the
	// policy must refuse is refused, with a dry run so nothing is stored.
	deadline := time.Now().Add(90 * time.Second)
	for {
		err := operator.Create(ctx, secret("not-allowed-probe"), client.DryRunAll)
		if isPolicyDenial(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the policy never began to refuse the operator (last error: %v)", err)
		}
		time.Sleep(300 * time.Millisecond)
	}

	// The names the operator writes come from the same helpers the code uses
	// (the inventory test ties these to the scan of the source).
	allowedSecret := ZoneSigningKeySecretName("zone-a")
	allowedCM := ZoneJWKSConfigMapName("zone-a")

	t.Run("the operator writes the names it owns", func(t *testing.T) {
		s := secret(allowedSecret)
		if err := operator.Create(ctx, s); err != nil {
			t.Fatalf("create Secret %s: %v", allowedSecret, err)
		}
		s.Data = map[string][]byte{"k2": []byte("v2")}
		if err := operator.Update(ctx, s); err != nil {
			t.Fatalf("update Secret %s: %v", allowedSecret, err)
		}
		c := cm(allowedCM)
		if err := operator.Create(ctx, c); err != nil {
			t.Fatalf("create ConfigMap %s: %v", allowedCM, err)
		}
		c.Data["k2"] = "v2"
		if err := operator.Update(ctx, c); err != nil {
			t.Fatalf("update ConfigMap %s: %v", allowedCM, err)
		}
		// Delete is outside the operator's role; the policy still allows the
		// names, so with RBAC granted to this identity the delete goes through.
		if err := operator.Delete(ctx, s); err != nil {
			t.Fatalf("delete Secret %s: %v", allowedSecret, err)
		}
		if err := operator.Delete(ctx, c); err != nil {
			t.Fatalf("delete ConfigMap %s: %v", allowedCM, err)
		}
	})

	t.Run("the operator is refused any other name, on every verb", func(t *testing.T) {
		// Create: a stranger's name, the other kind's suffix, a bare suffix with no
		// zone, and a name that merely contains the suffix.
		for _, name := range []string{"evil", "zone-a-knext-jwks", "knext-signing-key", allowedSecret + "-copy", "kube-root-ca.crt"} {
			if err := operator.Create(ctx, secret(name)); !isPolicyDenial(err) {
				t.Errorf("operator created Secret %q (want a policy denial): %v", name, err)
			}
		}
		for _, name := range []string{"evil", "zone-a-knext-signing-key", "knext-jwks", allowedCM + "-copy", "kube-root-ca.crt"} {
			if err := operator.Create(ctx, cm(name)); !isPolicyDenial(err) {
				t.Errorf("operator created ConfigMap %q (want a policy denial): %v", name, err)
			}
		}
		// generateName: the generated name decides, and it ends in random characters.
		gen := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{GenerateName: allowedSecret, Namespace: ns}}
		if err := operator.Create(ctx, gen); !isPolicyDenial(err) {
			t.Errorf("operator created a generateName Secret (want a policy denial): %v", err)
		}

		// Update and delete of an object somebody else made.
		victimSecret, victimCM := secret("victim"), cm("victim")
		for _, o := range []client.Object{victimSecret, victimCM} {
			if err := admin.Create(ctx, o); err != nil {
				t.Fatal(err)
			}
		}
		victimSecret.Data = map[string][]byte{"x": []byte("y")}
		if err := operator.Update(ctx, victimSecret); !isPolicyDenial(err) {
			t.Errorf("operator updated a foreign Secret (want a policy denial): %v", err)
		}
		victimCM.Data["x"] = "y"
		if err := operator.Update(ctx, victimCM); !isPolicyDenial(err) {
			t.Errorf("operator updated a foreign ConfigMap (want a policy denial): %v", err)
		}
		if err := operator.Delete(ctx, victimSecret); !isPolicyDenial(err) {
			t.Errorf("operator deleted a foreign Secret (want a policy denial): %v", err)
		}
		if err := operator.Delete(ctx, victimCM); !isPolicyDenial(err) {
			t.Errorf("operator deleted a foreign ConfigMap (want a policy denial): %v", err)
		}
		// Controls: the objects are intact, and the refusal is the policy's, not a
		// missing grant (the operator read them fine).
		for _, o := range []client.Object{&corev1.Secret{}, &corev1.ConfigMap{}} {
			if err := admin.Get(ctx, types.NamespacedName{Namespace: ns, Name: "victim"}, o); err != nil {
				t.Errorf("foreign object vanished: %v", err)
			}
		}
		readBack := victimSecret.DeepCopy()
		if err := operator.Get(ctx, client.ObjectKeyFromObject(readBack), readBack); err != nil {
			t.Errorf("RBAC control: the operator cannot read what it was refused to change: %v", err)
		}
	})

	t.Run("the operator cannot lift its own restriction", func(t *testing.T) {
		// RBAC, not the policy: the shipped role holds nothing on the policy kinds.
		isRBACDenial := func(err error) bool {
			return err != nil && apierrors.IsForbidden(err) && !strings.Contains(err.Error(), "ValidatingAdmissionPolicy '")
		}
		b := binding.DeepCopy()
		if err := operator.Delete(ctx, b); !isRBACDenial(err) {
			t.Errorf("the operator deleted (or was not RBAC-refused deleting) its own policy binding: %v", err)
		}
		p := policy.DeepCopy()
		p.Spec.FailurePolicy = nil
		if err := operator.Update(ctx, p); !isRBACDenial(err) {
			t.Errorf("the operator edited (or was not RBAC-refused editing) its own policy: %v", err)
		}
		// Control: the binding is still there, so the denial above bit something real.
		if err := admin.Get(ctx, client.ObjectKeyFromObject(binding), &admissionregistrationv1.ValidatingAdmissionPolicyBinding{}); err != nil {
			t.Errorf("the policy binding is gone: %v", err)
		}
	})

	t.Run("other principals are not affected", func(t *testing.T) {
		for _, who := range []struct {
			name   string
			c      client.Client
			prefix string
		}{
			{"the cluster admin", admin, "admin"},
			{"a ServiceAccount in another namespace", tenant, "tenant"},
			{"a same-named ServiceAccount in another namespace", lookalike, "lookalike"},
		} {
			for _, o := range []client.Object{
				secret("free-" + who.prefix), cm("free-" + who.prefix),
				secret(allowedSecret + "-" + who.prefix), cm("kube-" + who.prefix),
			} {
				if err := who.c.Create(ctx, o); err != nil {
					t.Errorf("%s was refused creating %T %s: %v", who.name, o, o.GetName(), err)
					continue
				}
				if err := who.c.Delete(ctx, o); err != nil {
					t.Errorf("%s was refused deleting %T %s: %v", who.name, o, o.GetName(), err)
				}
			}
		}
	})

	// --- the real reconciler under the policy -------------------------------
	reconcileZone := func(t *testing.T, zoneNS string, rotate bool) error {
		t.Helper()
		if err := admin.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: zoneNS}}); err != nil {
			t.Fatal(err)
		}
		zone := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: "orders", Namespace: zoneNS},
			Spec: appsv1alpha1.NextAppSpec{
				Image:    validImageForBS(),
				Backends: []appsv1alpha1.BackendBinding{{Name: "pricing", Service: "pricing"}},
			},
		}
		bs := &appsv1alpha1.BackendService{
			ObjectMeta: metav1.ObjectMeta{Name: "pricing", Namespace: zoneNS},
			Spec:       appsv1alpha1.BackendServiceSpec{Zone: "orders", Image: bsImage},
		}
		for _, o := range []client.Object{zone, bs} {
			if err := admin.Create(ctx, o); err != nil {
				t.Fatal(err)
			}
		}
		deadline := time.Now().Add(15 * time.Second)
		for operator.Get(ctx, client.ObjectKeyFromObject(zone), &appsv1alpha1.NextApp{}) != nil {
			if time.Now().After(deadline) {
				t.Fatal("the operator identity never became able to read NextApps")
			}
			time.Sleep(200 * time.Millisecond)
		}
		clock := &zoneClock{now: time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)}
		r := &NextAppReconciler{
			Client: operator, APIReader: operator, Scheme: scheme, Recorder: record.NewFakeRecorder(256),
			BackendServiceCRDPresent: true, Clock: clock.Now,
		}
		req := reconcile.Request{NamespacedName: types.NamespacedName{Namespace: zoneNS, Name: "orders"}}
		if _, err := r.Reconcile(ctx, req); err != nil {
			return err
		}
		if rotate {
			cur := &appsv1alpha1.NextApp{}
			if err := admin.Get(ctx, req.NamespacedName, cur); err != nil {
				t.Fatal(err)
			}
			cur.Annotations = map[string]string{RotateSigningKeyAnnotation: "vap"}
			if err := admin.Update(ctx, cur); err != nil {
				t.Fatal(err)
			}
			if _, err := r.Reconcile(ctx, req); err != nil {
				return err
			}
		}
		return nil
	}

	t.Run("the zone reconciler creates and rotates its key and JWKS under the policy", func(t *testing.T) {
		if err := reconcileZone(t, "zone-ok", true); err != nil {
			t.Fatalf("the reconciler broke under the shipped policy: %v", err)
		}
		sec := &corev1.Secret{}
		if err := admin.Get(ctx, types.NamespacedName{Namespace: "zone-ok", Name: ZoneSigningKeySecretName("orders")}, sec); err != nil {
			t.Fatalf("no key Secret under the policy: %v", err)
		}
		keys, err := readSigningKeySecret(sec)
		if err != nil || keys.next == nil {
			t.Fatalf("the rotation did not stage a key under the policy (err %v)", err)
		}
		got := &corev1.ConfigMap{}
		if err := admin.Get(ctx, types.NamespacedName{Namespace: "zone-ok", Name: ZoneJWKSConfigMapName("orders")}, got); err != nil {
			t.Fatalf("no JWKS under the policy: %v", err)
		}
		if !jwksHasKid(got.Data[ZoneJWKSFileName], keys.next.kid) {
			t.Fatal("the staged key was not published under the policy")
		}
	})

	t.Run("the proof is sensitive to the policy: an allow-list without the JWKS name refuses the reconciler", func(t *testing.T) {
		live := &admissionregistrationv1.ValidatingAdmissionPolicy{}
		if err := admin.Get(ctx, client.ObjectKeyFromObject(policy), live); err != nil {
			t.Fatal(err)
		}
		var edited bool
		for i := range live.Spec.Variables {
			if live.Spec.Variables[i].Name == "allowedConfigMapSuffixes" {
				live.Spec.Variables[i].Expression = "['-not-the-jwks']"
				edited = true
			}
		}
		if !edited {
			t.Fatal("the policy has no allowedConfigMapSuffixes variable to narrow")
		}
		if err := admin.Update(ctx, live); err != nil {
			t.Fatal(err)
		}
		var lastErr error
		deadline := time.Now().Add(90 * time.Second)
		for n := 0; ; n++ {
			// A fresh zone each attempt: the policy takes a moment to recompile.
			lastErr = reconcileZone(t, "zone-narrowed-"+string(rune('a'+n)), false)
			if lastErr != nil && strings.Contains(lastErr.Error(), "ValidatingAdmissionPolicy") {
				return
			}
			if time.Now().After(deadline) || n >= 20 {
				t.Fatalf("with the JWKS name removed from the allow-list the reconciler should be refused by the policy; got %v", lastErr)
			}
			time.Sleep(500 * time.Millisecond)
		}
	})
}

// policyOperatorUsername reads the identity the policy confines: the string
// literals of the operator matchCondition, joined (the namespace and the
// ServiceAccount name are separate literals so kustomize can rewrite them).
func policyOperatorUsername(t *testing.T, policy *admissionregistrationv1.ValidatingAdmissionPolicy) string {
	t.Helper()
	if len(policy.Spec.MatchConditions) != 1 {
		t.Fatalf("the policy must confine itself with exactly one matchCondition (the operator identity); found %d", len(policy.Spec.MatchConditions))
	}
	var b strings.Builder
	for _, m := range quotedCEL.FindAllStringSubmatch(policy.Spec.MatchConditions[0].Expression, -1) {
		b.WriteString(m[1])
	}
	return b.String()
}

func splitSAUsername(t *testing.T, username string) (namespace, name string) {
	t.Helper()
	parts := strings.Split(username, ":")
	if len(parts) != 4 {
		t.Fatalf("%q is not system:serviceaccount:<namespace>:<name>", username)
	}
	return parts[2], parts[3]
}
