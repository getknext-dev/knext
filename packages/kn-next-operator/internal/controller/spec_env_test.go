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
	"k8s.io/client-go/tools/record"
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
//     a colliding spec.env entry is dropped WITH a Warning event naming the
//     dropped variable and its authoritative source (system-env-last is unsafe
//     under kubelet last-wins semantics, so spec.env is appended last but
//     SKIPPED on collision — never silently: the user must be able to see why
//     their flag didn't land via `kubectl describe nextapp`).
//  3. secrets.envFrom is the one collision the reconciler CANNOT protect: it
//     references whole Secrets whose keys are invisible at reconcile time, and
//     kubelet applies envFrom BEFORE env — so a spec.env name matching a key
//     inside an envFrom Secret shadows the secret value at runtime. That is
//     documented user responsibility, not operator dedup (see the envFrom spec
//     below).
var _ = Describe("NextApp spec.env (plain, non-secret env vars)", func() {
	const (
		namespace  = "default"
		validImage = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
	)

	ctx := context.Background()

	// reconcileEnvApp creates a NextApp with the given spec, reconciles once
	// (with a FakeRecorder so specs can assert emitted Events), and returns the
	// ksvc container plus the recorder. Cleanup mirrors reconcile_output_test.
	reconcileEnvApp := func(name string, spec appsv1alpha1.NextAppSpec) (corev1.Container, *record.FakeRecorder) {
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

		recorder := record.NewFakeRecorder(64)
		reconciler := &NextAppReconciler{
			Client:   k8sClient,
			Scheme:   k8sClient.Scheme(),
			Recorder: recorder,
		}
		_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		containers := ksvc.Spec.Template.Spec.Containers
		Expect(containers).To(HaveLen(1))
		return containers[0], recorder
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
		container, recorder := reconcileEnvApp("env-app-basic", appsv1alpha1.NextAppSpec{
			Env: map[string]string{
				"KNEXT_CACHE_CONTROL_NORMALIZE": "0",
				"FEATURE_FLAG_BETA":             "on",
			},
		})

		Expect(container.Env).To(ContainElement(corev1.EnvVar{Name: "KNEXT_CACHE_CONTROL_NORMALIZE", Value: "0"}))
		Expect(container.Env).To(ContainElement(corev1.EnvVar{Name: "FEATURE_FLAG_BETA", Value: "on"}))

		By("emitting no EnvVarIgnored warnings when nothing collides")
		for _, ev := range drainEvents(recorder) {
			Expect(ev).NotTo(ContainSubstring(ReasonEnvVarIgnored))
		}
	})

	It("does not let spec.env override operator-injected system env, and emits a Warning naming the dropped var", func() {
		container, recorder := reconcileEnvApp("env-app-sysenv", appsv1alpha1.NextAppSpec{
			Env: map[string]string{
				"NODE_ENV": "development", // must NOT take effect
				"SAFE_VAR": "yes",
			},
		})
		env := container.Env

		Expect(countByName(env, "NODE_ENV")).To(Equal(1), "no duplicate NODE_ENV entries (kubelet last-wins would let the user override)")
		Expect(env).To(ContainElement(corev1.EnvVar{Name: "NODE_ENV", Value: "production"}))
		Expect(env).NotTo(ContainElement(corev1.EnvVar{Name: "NODE_ENV", Value: "development"}))
		Expect(env).To(ContainElement(corev1.EnvVar{Name: "SAFE_VAR", Value: "yes"}))

		By("surfacing the drop as a Warning event (never a silent drop)")
		events := drainEvents(recorder)
		Expect(events).To(ContainElement(SatisfyAll(
			ContainSubstring(corev1.EventTypeWarning),
			ContainSubstring(ReasonEnvVarIgnored),
			ContainSubstring("spec.env[NODE_ENV]"),
			ContainSubstring("system"),
		)))
		for _, ev := range events {
			Expect(ev).NotTo(ContainSubstring("SAFE_VAR"), "non-colliding vars must not be reported")
		}
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

	It("lets spec.secrets.envMap win over a colliding spec.env entry, with a Warning naming the source", func() {
		container, recorder := reconcileEnvApp("env-app-secret-collision", appsv1alpha1.NextAppSpec{
			Env: map[string]string{"API_MODE": "plain-value"},
			Secrets: &appsv1alpha1.SecretsSpec{
				EnvMap: map[string]appsv1alpha1.EnvMapEntry{
					"API_MODE": {SecretName: "app-secrets", SecretKey: "apiMode"},
				},
			},
		})
		env := container.Env

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

		By("surfacing the drop as a Warning event naming spec.secrets.envMap as the winner")
		Expect(drainEvents(recorder)).To(ContainElement(SatisfyAll(
			ContainSubstring(corev1.EventTypeWarning),
			ContainSubstring(ReasonEnvVarIgnored),
			ContainSubstring("spec.env[API_MODE]"),
			ContainSubstring("spec.secrets.envMap"),
		)))
	})

	// The one collision the reconciler CANNOT dedup: secrets.envFrom references
	// whole Secrets whose KEYS are not visible in the NextApp spec (and may not
	// even exist at reconcile time). At the emitted ksvc-spec level both sides
	// are present — the envFrom secretRef AND the explicit env entry. What
	// happens at runtime is decided by KUBELET, not by us: kubelet expands
	// envFrom first, then applies the container's explicit `env` on top, so an
	// explicit env var SHADOWS a same-named key from an envFrom Secret (kubelet
	// pod env construction order — envFrom before env). envtest has no kubelet,
	// so this spec pins the emitted spec (both present, no dedup attempted);
	// the runtime consequence is documented user responsibility in
	// docs/operator/crd-nextapp.md.
	It("emits both the envFrom secretRef and a same-named spec.env var (envFrom keys are invisible — no dedup possible)", func() {
		container, _ := reconcileEnvApp("env-app-envfrom-shadow", appsv1alpha1.NextAppSpec{
			Env: map[string]string{"RUNTIME_FLAG": "from-spec-env"},
			Secrets: &appsv1alpha1.SecretsSpec{
				// The Secret "runtime-flags" may itself contain a RUNTIME_FLAG
				// key — the reconciler has no way to know.
				EnvFrom: []string{"runtime-flags"},
			},
		})

		By("keeping the envFrom secretRef on the container")
		Expect(container.EnvFrom).To(HaveLen(1))
		Expect(container.EnvFrom[0].SecretRef.Name).To(Equal("runtime-flags"))

		By("still emitting the explicit spec.env entry (kubelet applies envFrom BEFORE env → this entry wins at runtime)")
		Expect(container.Env).To(ContainElement(corev1.EnvVar{Name: "RUNTIME_FLAG", Value: "from-spec-env"}))
	})

	It("emits spec.env entries in deterministic (sorted) order", func() {
		container, _ := reconcileEnvApp("env-app-sorted", appsv1alpha1.NextAppSpec{
			Env: map[string]string{
				"ZZZ_LAST":  "z",
				"AAA_FIRST": "a",
				"MMM_MID":   "m",
			},
		})

		positions := map[string]int{}
		for i, e := range container.Env {
			positions[e.Name] = i
		}
		Expect(positions["AAA_FIRST"]).To(BeNumerically("<", positions["MMM_MID"]))
		Expect(positions["MMM_MID"]).To(BeNumerically("<", positions["ZZZ_LAST"]))
	})

	It("reconciles fine with an empty spec.env map", func() {
		container, _ := reconcileEnvApp("env-app-empty", appsv1alpha1.NextAppSpec{
			Env: map[string]string{},
		})
		Expect(container.Env).To(ContainElement(corev1.EnvVar{Name: "NODE_ENV", Value: "production"}))
	})
})
