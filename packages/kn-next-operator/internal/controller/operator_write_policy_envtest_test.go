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
		// The zone's controller ownerReference, as the reconciler sets it at create.
		s := secret(allowedSecret)
		s.OwnerReferences = []metav1.OwnerReference{zoneOwnerRef("zone-a")}
		if err := operator.Create(ctx, s); err != nil {
			t.Fatalf("create Secret %s: %v", allowedSecret, err)
		}
		s.Data = map[string][]byte{"k2": []byte("v2")}
		if err := operator.Update(ctx, s); err != nil {
			t.Fatalf("update Secret %s: %v", allowedSecret, err)
		}
		c := cm(allowedCM)
		c.OwnerReferences = []metav1.OwnerReference{zoneOwnerRef("zone-a")}
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

	t.Run("the operator may write only Opaque Secrets, even under an allowed name", func(t *testing.T) {
		// The name is allowed; the type is not. A service-account-token Secret is
		// filled in by the tokens controller with a credential for the ServiceAccount
		// its annotation names, and the operator can read the Secret it wrote, so
		// without a type check the operator could become any ServiceAccount.
		const policyMessage = "may write only Opaque Secrets"
		typed := func(name string, secretType corev1.SecretType, data map[string][]byte) *corev1.Secret {
			s := secret(name)
			// Owned by its own zone, so the refusal below is the type's, not the owner's.
			s.OwnerReferences = []metav1.OwnerReference{zoneOwnerRef(strings.TrimSuffix(name, "-knext-signing-key"))}
			s.Type = secretType
			s.StringData = nil
			s.Data = data
			if secretType == corev1.SecretTypeServiceAccountToken {
				s.Annotations = map[string]string{corev1.ServiceAccountNameKey: "privileged"}
			}
			return s
		}
		typeDenial := func(err error) bool { return isPolicyDenial(err) && strings.Contains(err.Error(), policyMessage) }

		for _, c := range []struct {
			what string
			s    *corev1.Secret
		}{
			{"service-account-token", typed(ZoneSigningKeySecretName("kube-system"), corev1.SecretTypeServiceAccountToken, nil)},
			{"dockerconfigjson", typed(ZoneSigningKeySecretName("docker"), corev1.SecretTypeDockerConfigJson, map[string][]byte{corev1.DockerConfigJsonKey: []byte("{}")})},
			{"tls", typed(ZoneSigningKeySecretName("tls"), corev1.SecretTypeTLS, map[string][]byte{corev1.TLSCertKey: []byte("c"), corev1.TLSPrivateKeyKey: []byte("k")})},
		} {
			if err := operator.Create(ctx, c.s); !typeDenial(err) {
				t.Errorf("the operator created a %s Secret under the allowed name %s (want the policy's type denial): %v", c.what, c.s.Name, err)
			}
			if err := admin.Get(ctx, client.ObjectKeyFromObject(c.s), &corev1.Secret{}); !apierrors.IsNotFound(err) {
				t.Errorf("the refused %s Secret was stored anyway: %v", c.what, err)
			}
		}

		// Controls: explicit Opaque under an allowed name is fine, so the denial
		// above is the type and not the name.
		ok := typed(ZoneSigningKeySecretName("opaque"), corev1.SecretTypeOpaque, map[string][]byte{"k": []byte("v")})
		if err := operator.Create(ctx, ok); err != nil {
			t.Errorf("the operator was refused an explicit Opaque Secret under an allowed name: %v", err)
		}

		// A token Secret somebody else created under an allowed name: the operator may
		// neither update it (the type is immutable, and it is not Opaque) nor turn it
		// into something else. The refusal is the policy's type check.
		foreign := typed(ZoneSigningKeySecretName("foreign-token"), corev1.SecretTypeServiceAccountToken, nil)
		if err := admin.Create(ctx, foreign); err != nil {
			t.Fatal(err)
		}
		foreign.Labels = map[string]string{"touched": "by-the-operator"}
		if err := operator.Update(ctx, foreign); !typeDenial(err) {
			t.Errorf("the operator updated a foreign service-account-token Secret under an allowed name (want the type denial): %v", err)
		}
	})

	// Ownership: the name and the type are right in every case below, and only the
	// owner is wrong. Each refusal is attributed to an ownership check by its
	// message, so a refusal by any other check cannot pass for one of these.
	t.Run("the operator writes only objects its zone's NextApp controls", func(t *testing.T) {
		ownerDenial := func(err error) bool {
			return isPolicyDenial(err) && strings.Contains(err.Error(), "controller ownerReference to that NextApp")
		}
		changedDenial := func(err error) bool {
			return isPolicyDenial(err) && strings.Contains(err.Error(), "may not change an object's ownerReferences")
		}
		// Existing objects under the allowed names, owned in each wrong way. Each
		// zone's name is its own, so the cases do not share an object.
		wrongKind := zoneOwnerRef("zone-kind")
		wrongKind.Kind, wrongKind.APIVersion = "ConfigMap", "v1"
		wrongGroup := zoneOwnerRef("zone-group")
		wrongGroup.APIVersion = "example.com/v1"
		// A near miss on the group: the check must anchor on the trailing slash.
		lookalikeGroup := zoneOwnerRef("zone-lookalike")
		lookalikeGroup.APIVersion = "apps.kn-next.dev.evil/v1"
		notController := zoneOwnerRef("zone-noctl")
		notController.Controller = nil
		for _, c := range []struct {
			what  string
			zone  string
			owner []metav1.OwnerReference
		}{
			{"no owner", "zone-unowned", nil},
			{"another zone's NextApp", "zone-wrong", []metav1.OwnerReference{zoneOwnerRef("zone-other")}},
			{"a ConfigMap of the same name", "zone-kind", []metav1.OwnerReference{wrongKind}},
			{"an object of another API group", "zone-group", []metav1.OwnerReference{wrongGroup}},
			{"a look-alike API group", "zone-lookalike", []metav1.OwnerReference{lookalikeGroup}},
			{"a reference that is not the controller", "zone-noctl", []metav1.OwnerReference{notController}},
		} {
			sec := secret(ZoneSigningKeySecretName(c.zone))
			sec.OwnerReferences = c.owner
			cmo := cm(ZoneJWKSConfigMapName(c.zone))
			cmo.OwnerReferences = c.owner
			for _, o := range []client.Object{sec, cmo} {
				if err := admin.Create(ctx, o); err != nil {
					t.Fatal(err)
				}
			}
			sec.Data = map[string][]byte{"k": []byte("changed")}
			if err := operator.Update(ctx, sec); !ownerDenial(err) {
				t.Errorf("%s: the operator updated Secret %s (want the ownership denial): %v", c.what, sec.Name, err)
			}
			cmo.Data = map[string]string{"k": "changed"}
			if err := operator.Update(ctx, cmo); !ownerDenial(err) {
				t.Errorf("%s: the operator updated ConfigMap %s (want the ownership denial): %v", c.what, cmo.Name, err)
			}
			if err := operator.Delete(ctx, sec); !ownerDenial(err) {
				t.Errorf("%s: the operator deleted Secret %s (want the ownership denial): %v", c.what, sec.Name, err)
			}
			if err := operator.Delete(ctx, cmo); !ownerDenial(err) {
				t.Errorf("%s: the operator deleted ConfigMap %s (want the ownership denial): %v", c.what, cmo.Name, err)
			}
			// Controls: refused, so both still stand, unchanged.
			if err := admin.Get(ctx, client.ObjectKeyFromObject(sec), &corev1.Secret{}); err != nil {
				t.Errorf("%s: the refused Secret %s is gone: %v", c.what, sec.Name, err)
			}
			if err := admin.Get(ctx, client.ObjectKeyFromObject(cmo), &corev1.ConfigMap{}); err != nil {
				t.Errorf("%s: the refused ConfigMap %s is gone: %v", c.what, cmo.Name, err)
			}
		}

		// Create: an allowed name with no owner, or with another zone's, is refused.
		for _, owner := range [][]metav1.OwnerReference{nil, {zoneOwnerRef("zone-other")}} {
			s := secret(ZoneSigningKeySecretName("zone-new"))
			s.OwnerReferences = owner
			if err := operator.Create(ctx, s); !ownerDenial(err) {
				t.Errorf("the operator created Secret %s with owners %v (want the ownership denial): %v", s.Name, owner, err)
			}
			c := cm(ZoneJWKSConfigMapName("zone-new"))
			c.OwnerReferences = owner
			if err := operator.Create(ctx, c); !ownerDenial(err) {
				t.Errorf("the operator created ConfigMap %s with owners %v (want the ownership denial): %v", c.Name, owner, err)
			}
		}
		if err := admin.Get(ctx, types.NamespacedName{Namespace: ns, Name: ZoneSigningKeySecretName("zone-new")}, &corev1.Secret{}); !apierrors.IsNotFound(err) {
			t.Errorf("a refused create left a Secret behind: %v", err)
		}

		// Update: the owner an object has is kept. A write may not drop it, swap it for
		// another zone's, or forge its UID, and the stored owner is unchanged after.
		held := zoneOwnerRef("zone-held")
		heldSecret := secret(ZoneSigningKeySecretName("zone-held"))
		heldSecret.OwnerReferences = []metav1.OwnerReference{held}
		heldCM := cm(ZoneJWKSConfigMapName("zone-held"))
		heldCM.OwnerReferences = []metav1.OwnerReference{held}
		for _, o := range []client.Object{heldSecret, heldCM} {
			if err := admin.Create(ctx, o); err != nil {
				t.Fatal(err)
			}
		}
		forged := zoneOwnerRef("zone-held")
		forged.UID = "forged-uid"
		for _, c := range []struct {
			what  string
			owner []metav1.OwnerReference
		}{
			{"dropped", nil},
			{"swapped for another zone's NextApp", []metav1.OwnerReference{zoneOwnerRef("zone-other")}},
			{"given a forged UID", []metav1.OwnerReference{forged}},
		} {
			// A fresh read each time, so each write carries the stored resourceVersion.
			sec := &corev1.Secret{}
			if err := operator.Get(ctx, client.ObjectKeyFromObject(heldSecret), sec); err != nil {
				t.Fatal(err)
			}
			sec.OwnerReferences = c.owner
			if err := operator.Update(ctx, sec); !changedDenial(err) {
				t.Errorf("the operator's Secret update %s (want the owner-change denial): %v", c.what, err)
			}
			obj := &corev1.ConfigMap{}
			if err := operator.Get(ctx, client.ObjectKeyFromObject(heldCM), obj); err != nil {
				t.Fatal(err)
			}
			obj.OwnerReferences = c.owner
			if err := operator.Update(ctx, obj); !changedDenial(err) {
				t.Errorf("the operator's ConfigMap update %s (want the owner-change denial): %v", c.what, err)
			}
		}
		for _, o := range []client.Object{&corev1.Secret{}, &corev1.ConfigMap{}} {
			name := heldSecret.Name
			if _, ok := o.(*corev1.ConfigMap); ok {
				name = heldCM.Name
			}
			if err := admin.Get(ctx, types.NamespacedName{Namespace: ns, Name: name}, o); err != nil {
				t.Fatalf("held object %s vanished: %v", name, err)
			}
			refs := o.GetOwnerReferences()
			if len(refs) != 1 || refs[0].UID != held.UID || refs[0].Name != held.Name {
				t.Errorf("a refused write changed %s's owner: %+v", name, refs)
			}
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

// zoneOwnerRef is the controller ownerReference the operator sets on a zone's key
// Secret and JWKS ConfigMap at create (ctrl.SetControllerReference on the NextApp).
// The UID is a stand-in: the policy cannot see UIDs, and the reconciler's own
// controlledByZone check is what compares them.
func zoneOwnerRef(zone string) metav1.OwnerReference {
	controller := true
	return metav1.OwnerReference{
		APIVersion: appsv1alpha1.GroupVersion.String(),
		Kind:       "NextApp",
		Name:       zone,
		UID:        types.UID("uid-" + zone),
		Controller: &controller,
	}
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
