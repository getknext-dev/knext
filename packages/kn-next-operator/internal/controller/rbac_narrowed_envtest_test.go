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

// Proof that the operator still reconciles when it runs with EXACTLY the
// shipped ClusterRole (config/rbac/role.yaml) and nothing else.
//
// Every other envtest spec in this suite talks to the apiserver as the
// system:masters admin, so none of them would notice if the generated RBAC
// were missing a verb the controller needs - or notice a Secrets grant that
// should be gone. This spec closes that: it binds a real (client-cert) user to
// a copy of the generated rules, runs the REAL controller wiring
// (SetupWithManager, informers and all) as that user, and asserts both halves:
//
//  1. the reconcile path still converges - the manager's caches sync (a
//     forbidden informer would block them forever) and a NextApp that
//     references Secrets by name (envMap + envFrom) gets its Knative Service,
//     finalizer and status written;
//  2. the identity is genuinely denied Secrets, cluster-wide AND in the app's
//     namespace, with a positive control (it CAN list NextApps) and a negative
//     control (a resource outside the role IS forbidden) so a harness that
//     denies everything - or allows everything - cannot pass vacuously.

import (
	"context"
	"os"
	"path/filepath"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	ctrlconfig "sigs.k8s.io/controller-runtime/pkg/config"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
	"sigs.k8s.io/yaml"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

var _ = Describe("Operator reconciles under the shipped (narrowed) ClusterRole", func() {
	const (
		rbacNS     = "rbac-narrowed"
		userName   = "knext-narrowed-operator"
		userGroup  = "knext-narrowed-operators"
		roleName   = "knext-narrowed-manager-role"
		validImage = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
	)

	It("converges a NextApp that references Secrets by name, while Secrets stay forbidden", func() {
		ctx := context.Background()

		By("loading the SHIPPED rules from config/rbac/role.yaml (the generated artifact)")
		raw, err := os.ReadFile(filepath.Join("..", "..", "config", "rbac", "role.yaml"))
		Expect(err).NotTo(HaveOccurred())
		var shipped rbacv1.ClusterRole
		Expect(yaml.Unmarshal(raw, &shipped)).To(Succeed())
		Expect(shipped.Rules).NotTo(BeEmpty(), "role.yaml parsed to zero rules; the proof would be vacuous")

		By("binding a real client-cert identity to a copy of those rules")
		cr := &rbacv1.ClusterRole{
			ObjectMeta: metav1.ObjectMeta{Name: roleName},
			Rules:      shipped.Rules,
		}
		Expect(k8sClient.Create(ctx, cr)).To(Succeed())
		crb := &rbacv1.ClusterRoleBinding{
			ObjectMeta: metav1.ObjectMeta{Name: roleName},
			RoleRef:    rbacv1.RoleRef{APIGroup: rbacv1.GroupName, Kind: "ClusterRole", Name: roleName},
			Subjects:   []rbacv1.Subject{{APIGroup: rbacv1.GroupName, Kind: "Group", Name: userGroup}},
		}
		Expect(k8sClient.Create(ctx, crb)).To(Succeed())
		DeferCleanup(func() {
			_ = k8sClient.Delete(ctx, crb)
			_ = k8sClient.Delete(ctx, cr)
		})

		user, err := testEnv.AddUser(envtest.User{Name: userName, Groups: []string{userGroup}}, nil)
		Expect(err).NotTo(HaveOccurred())
		userCfg := user.Config()
		userClient, err := client.New(userCfg, client.Options{Scheme: k8sClient.Scheme()})
		Expect(err).NotTo(HaveOccurred())

		ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: rbacNS}}
		if err := k8sClient.Create(ctx, ns); err != nil {
			Expect(apierrors.IsAlreadyExists(err)).To(BeTrue())
		}

		By("positive control: the identity is authorised for what the controller needs")
		Eventually(func() error {
			return userClient.List(ctx, &appsv1alpha1.NextAppList{})
		}, 10*time.Second, 200*time.Millisecond).Should(Succeed(),
			"RBAC propagation: the bound identity must be able to list NextApps")

		By("negative control: RBAC is genuinely enforced (a resource outside the role is forbidden)")
		err = userClient.List(ctx, &corev1.ConfigMapList{}, client.InNamespace(rbacNS))
		Expect(apierrors.IsForbidden(err)).To(BeTrue(),
			"configmaps are not in the role; if this is allowed, envtest is not enforcing RBAC and the proof is vacuous (err=%v)", err)

		By("Secrets are DENIED: no list/watch/get/create/update/delete, cluster-wide or namespaced")
		for _, namespace := range []string{"", rbacNS} {
			for _, verb := range []string{"get", "list", "watch", "create", "update", "patch", "delete"} {
				sar := &authorizationv1.SubjectAccessReview{
					Spec: authorizationv1.SubjectAccessReviewSpec{
						User:   userName,
						Groups: []string{userGroup},
						ResourceAttributes: &authorizationv1.ResourceAttributes{
							Namespace: namespace, Verb: verb, Resource: "secrets",
						},
					},
				}
				Expect(k8sClient.Create(ctx, sar)).To(Succeed())
				Expect(sar.Status.Allowed).To(BeFalse(),
					"the operator identity must not be allowed %q on secrets (namespace %q): %s", verb, namespace, sar.Status.Reason)
			}
		}
		err = userClient.List(ctx, &corev1.SecretList{})
		Expect(apierrors.IsForbidden(err)).To(BeTrue(), "cluster-wide Secret list must be Forbidden (err=%v)", err)

		By("starting the REAL controller wiring as that identity")
		mgrCtx, mgrCancel := context.WithCancel(ctx)
		mgrDone := make(chan struct{})
		mgrErr := make(chan error, 1)
		mgr, err := ctrl.NewManager(userCfg, ctrl.Options{
			Scheme: k8sClient.Scheme(),
			// Namespaced cache so leftovers from sibling specs don't add noise;
			// the RBAC under test is the cluster-scoped role either way.
			Cache:                  cache.Options{DefaultNamespaces: map[string]cache.Config{rbacNS: {}}},
			Metrics:                metricsserver.Options{BindAddress: "0"},
			HealthProbeBindAddress: "0",
			// Another spec in this process registers the "nextapp" controller.
			Controller: ctrlconfig.Controller{SkipNameValidation: ptr.To(true)},
		})
		Expect(err).NotTo(HaveOccurred())
		Expect((&NextAppReconciler{
			Client:   mgr.GetClient(),
			Scheme:   mgr.GetScheme(),
			Recorder: mgr.GetEventRecorderFor("nextapp-controller"),
		}).SetupWithManager(mgr)).To(Succeed())
		go func() {
			defer close(mgrDone)
			mgrErr <- mgr.Start(mgrCtx)
		}()
		DeferCleanup(func() {
			nn := types.NamespacedName{Name: "rbac-narrowed-app", Namespace: rbacNS}
			mgrCancel()
			<-mgrDone
			deleteAndFinalize(ctx, nn)
		})

		By("creating a NextApp that references Secrets BY NAME (envMap + envFrom) - the kubelet resolves them, not the operator")
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: "rbac-narrowed-app", Namespace: rbacNS},
			Spec: appsv1alpha1.NextAppSpec{
				Image: validImage,
				Secrets: &appsv1alpha1.SecretsSpec{
					EnvFrom: []string{"app-secrets-does-not-exist"},
					EnvMap: map[string]appsv1alpha1.EnvMapEntry{
						"STRIPE_KEY": {SecretName: "payments", SecretKey: "key"},
					},
				},
			},
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		nn := types.NamespacedName{Name: app.Name, Namespace: app.Namespace}

		By("the Knative Service is created, owned, and carries the Secret REFERENCES")
		Eventually(func(g Gomega) {
			ksvc := &servingv1.Service{}
			g.Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
			g.Expect(ksvc.OwnerReferences).NotTo(BeEmpty())
			c := ksvc.Spec.Template.Spec.Containers[0]
			g.Expect(c.EnvFrom).NotTo(BeEmpty(), "envFrom secretRef must be injected")
			found := false
			for _, e := range c.Env {
				if e.Name == "STRIPE_KEY" && e.ValueFrom != nil && e.ValueFrom.SecretKeyRef != nil {
					found = true
				}
			}
			g.Expect(found).To(BeTrue(), "envMap secretKeyRef must be injected")
		}, 30*time.Second, 250*time.Millisecond).Should(Succeed())

		By("the finalizer and status (status subresource write) land - the full write path is permitted")
		Eventually(func(g Gomega) {
			cur := &appsv1alpha1.NextApp{}
			g.Expect(k8sClient.Get(ctx, nn, cur)).To(Succeed())
			g.Expect(cur.Finalizers).To(ContainElement(ExternalCleanupFinalizer))
			g.Expect(cur.Status.Conditions).NotTo(BeEmpty())
		}, 30*time.Second, 250*time.Millisecond).Should(Succeed())

		By("the manager is still healthy (an unauthorised informer would have errored Start)")
		select {
		case err := <-mgrErr:
			Fail("manager.Start returned early: " + func() string {
				if err == nil {
					return "<nil>"
				}
				return err.Error()
			}())
		default:
		}
	})
})
