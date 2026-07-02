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
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// Issue #186 — spec.env: plain (NON-SECRET) name/value env vars on the NextApp
// CR, so config flags like KNEXT_CACHE_CONTROL_NORMALIZE=0 no longer have to
// ride the Secrets mechanism.
//
// Precedence contract under test (the #178/#184 outage class must stay dead):
//  1. Reserved names (HOSTNAME, PORT, K_SERVICE, K_REVISION, K_CONFIGURATION)
//     are rejected at ADMISSION (CRD CEL validation).
//  2. Operator-injected system env and spec.secrets.envMap entries always win:
//     a colliding spec.env entry is silently dropped (system-env-last is
//     unsafe under kubelet last-wins semantics, so spec.env is appended last
//     but SKIPPED on collision).
var _ = Describe("NextApp spec.env (plain, non-secret env vars)", func() {
	const (
		namespace  = "default"
		validImage = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
	)

	ctx := context.Background()

	// reconcileEnvApp creates a NextApp with the given spec, reconciles once,
	// and returns the ksvc container env. Cleanup mirrors reconcile_output_test.
	reconcileEnvApp := func(name string, spec appsv1alpha1.NextAppSpec) []corev1.EnvVar {
		nn := types.NamespacedName{Name: name, Namespace: namespace}
		spec.Image = orDefault(spec.Image, validImage)
		nextApp := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
			Spec:       spec,
		}
		Expect(k8sClient.Create(ctx, nextApp)).To(Succeed())

		DeferCleanup(func() {
			cur := &appsv1alpha1.NextApp{}
			if err := k8sClient.Get(ctx, nn, cur); err == nil {
				Expect(k8sClient.Delete(ctx, cur)).To(Succeed())
				cleanupReconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
				Eventually(func() bool {
					_, _ = cleanupReconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
					return errors.IsNotFound(k8sClient.Get(ctx, nn, &appsv1alpha1.NextApp{}))
				}, 10*time.Second, 100*time.Millisecond).Should(BeTrue())
			}
		})

		reconciler := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		containers := ksvc.Spec.Template.Spec.Containers
		Expect(containers).To(HaveLen(1))
		return containers[0].Env
	}

	countByName := func(env []corev1.EnvVar, name string) int {
		n := 0
		for _, e := range env {
			if e.Name == name {
				n++
			}
		}
		return n
	}

	It("injects spec.env entries as plain name/value env vars on the ksvc container", func() {
		env := reconcileEnvApp("env-app-basic", appsv1alpha1.NextAppSpec{
			Env: map[string]string{
				"KNEXT_CACHE_CONTROL_NORMALIZE": "0",
				"FEATURE_FLAG_BETA":             "on",
			},
		})

		Expect(env).To(ContainElement(corev1.EnvVar{Name: "KNEXT_CACHE_CONTROL_NORMALIZE", Value: "0"}))
		Expect(env).To(ContainElement(corev1.EnvVar{Name: "FEATURE_FLAG_BETA", Value: "on"}))
	})

	It("does not let spec.env override operator-injected system env (NODE_ENV stays production, no duplicates)", func() {
		env := reconcileEnvApp("env-app-sysenv", appsv1alpha1.NextAppSpec{
			Env: map[string]string{
				"NODE_ENV": "development", // must NOT take effect
				"SAFE_VAR": "yes",
			},
		})

		Expect(countByName(env, "NODE_ENV")).To(Equal(1), "no duplicate NODE_ENV entries (kubelet last-wins would let the user override)")
		Expect(env).To(ContainElement(corev1.EnvVar{Name: "NODE_ENV", Value: "production"}))
		Expect(env).NotTo(ContainElement(corev1.EnvVar{Name: "NODE_ENV", Value: "development"}))
		Expect(env).To(ContainElement(corev1.EnvVar{Name: "SAFE_VAR", Value: "yes"}))
	})

	It("rejects the reserved name HOSTNAME at admission (the #178/#184 hazard)", func() {
		nextApp := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: "env-app-hostname", Namespace: namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image: validImage,
				Env:   map[string]string{"HOSTNAME": "evil.example.com"},
			},
		}
		err := k8sClient.Create(ctx, nextApp)
		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("reserved"))
	})

	It("rejects the Knative-reserved name PORT at admission", func() {
		nextApp := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: "env-app-port", Namespace: namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image: validImage,
				Env:   map[string]string{"PORT": "8080"},
			},
		}
		err := k8sClient.Create(ctx, nextApp)
		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("reserved"))
	})

	It("rejects env var names that are not C_IDENTIFIERs at admission", func() {
		nextApp := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: "env-app-badname", Namespace: namespace},
			Spec: appsv1alpha1.NextAppSpec{
				Image: validImage,
				Env:   map[string]string{"1BAD-NAME": "x"},
			},
		}
		err := k8sClient.Create(ctx, nextApp)
		Expect(err).To(HaveOccurred())
	})

	It("lets spec.secrets.envMap win over a colliding spec.env entry (secrets are authoritative)", func() {
		env := reconcileEnvApp("env-app-secret-collision", appsv1alpha1.NextAppSpec{
			Env: map[string]string{"API_MODE": "plain-value"},
			Secrets: &appsv1alpha1.SecretsSpec{
				EnvMap: map[string]appsv1alpha1.EnvMapEntry{
					"API_MODE": {SecretName: "app-secrets", SecretKey: "apiMode"},
				},
			},
		})

		Expect(countByName(env, "API_MODE")).To(Equal(1), "collision must not produce duplicate env entries")
		var got corev1.EnvVar
		for _, e := range env {
			if e.Name == "API_MODE" {
				got = e
			}
		}
		Expect(got.ValueFrom).NotTo(BeNil(), "the Secret-backed mapping must win")
		Expect(got.ValueFrom.SecretKeyRef.Name).To(Equal("app-secrets"))
		Expect(got.Value).To(BeEmpty())
	})

	It("emits spec.env entries in deterministic (sorted) order", func() {
		env := reconcileEnvApp("env-app-sorted", appsv1alpha1.NextAppSpec{
			Env: map[string]string{
				"ZZZ_LAST":  "z",
				"AAA_FIRST": "a",
				"MMM_MID":   "m",
			},
		})

		positions := map[string]int{}
		for i, e := range env {
			positions[e.Name] = i
		}
		Expect(positions["AAA_FIRST"]).To(BeNumerically("<", positions["MMM_MID"]))
		Expect(positions["MMM_MID"]).To(BeNumerically("<", positions["ZZZ_LAST"]))
	})

	It("reconciles fine with an empty spec.env map", func() {
		env := reconcileEnvApp("env-app-empty", appsv1alpha1.NextAppSpec{
			Env: map[string]string{},
		})
		Expect(env).To(ContainElement(corev1.EnvVar{Name: "NODE_ENV", Value: "production"}))
	})
})
