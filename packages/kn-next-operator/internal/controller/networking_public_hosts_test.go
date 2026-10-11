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
	"fmt"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// spec.networking.publicHosts renders KNEXT_PUBLIC_ORIGINS (the allowlist the
// standalone runtime's public-origin preload reads) through the REAL Reconcile
// loop against the real envtest apiserver, so the CEL admission rules and the
// rendered ksvc env are both exercised end to end.
//
// Contract under test:
//  1. each host becomes `https://<host>`, comma-joined, in list order (the
//     FIRST entry is the preload's fallback, so order is load-bearing);
//  2. an empty / unset list renders NO env var at all (byte-identical to every
//     CR written before the field existed);
//  3. a user-set KNEXT_PUBLIC_ORIGINS in spec.env (or spec.secrets.envMap) WINS:
//     setups that adopted the env route before this field existed keep working
//     and are never silently overridden;
//  4. an invalid host is rejected at ADMISSION by CEL.
var _ = Describe("NextApp spec.networking.publicHosts", func() {
	const (
		namespace  = "default"
		validImage = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
		envName    = "KNEXT_PUBLIC_ORIGINS"
	)
	ctx := context.Background()

	reconcileApp := func(name string, spec appsv1alpha1.NextAppSpec) (corev1.Container, *record.FakeRecorder) {
		nn := types.NamespacedName{Name: name, Namespace: namespace}
		spec.Image = validImage
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
			Spec:       spec,
		}
		Expect(k8sClient.Create(ctx, app)).To(Succeed())
		DeferCleanup(func() { deleteAndFinalize(ctx, nn) })

		recorder := record.NewFakeRecorder(64)
		r := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Recorder: recorder}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())

		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		Expect(ksvc.Spec.Template.Spec.Containers).To(HaveLen(1))
		return ksvc.Spec.Template.Spec.Containers[0], recorder
	}

	envValues := func(env []corev1.EnvVar, name string) []corev1.EnvVar {
		var out []corev1.EnvVar
		for _, e := range env {
			if e.Name == name {
				out = append(out, e)
			}
		}
		return out
	}

	It("renders KNEXT_PUBLIC_ORIGINS as comma-joined https:// origins in list order", func() {
		container, _ := reconcileApp("public-hosts-render", appsv1alpha1.NextAppSpec{
			Networking: &appsv1alpha1.NetworkingSpec{
				PublicHosts: []string{"www.example.com", "app.example.org"},
			},
		})
		Expect(envValues(container.Env, envName)).To(Equal([]corev1.EnvVar{
			{Name: envName, Value: "https://www.example.com,https://app.example.org"},
		}))
	})

	It("renders NO KNEXT_PUBLIC_ORIGINS when publicHosts is empty", func() {
		container, _ := reconcileApp("public-hosts-empty", appsv1alpha1.NextAppSpec{
			Networking: &appsv1alpha1.NetworkingSpec{PublicHosts: []string{}},
		})
		Expect(envValues(container.Env, envName)).To(BeEmpty())
	})

	It("renders NO KNEXT_PUBLIC_ORIGINS when spec.networking is unset", func() {
		container, _ := reconcileApp("public-hosts-unset", appsv1alpha1.NextAppSpec{})
		Expect(envValues(container.Env, envName)).To(BeEmpty())
	})

	It("lets a user-set spec.env KNEXT_PUBLIC_ORIGINS win, with exactly one entry and no ignored-env warning", func() {
		container, recorder := reconcileApp("public-hosts-user-env-wins", appsv1alpha1.NextAppSpec{
			Env: map[string]string{envName: "custom.example.net"},
			Networking: &appsv1alpha1.NetworkingSpec{
				PublicHosts: []string{"www.example.com"},
			},
		})
		Expect(envValues(container.Env, envName)).To(Equal([]corev1.EnvVar{
			{Name: envName, Value: "custom.example.net"},
		}))
		for _, ev := range drainEvents(recorder) {
			Expect(ev).NotTo(ContainSubstring(ReasonEnvVarIgnored))
		}
	})

	It("lets a Secret-backed envMap KNEXT_PUBLIC_ORIGINS win over publicHosts", func() {
		container, _ := reconcileApp("public-hosts-envmap-wins", appsv1alpha1.NextAppSpec{
			Secrets: &appsv1alpha1.SecretsSpec{
				EnvMap: map[string]appsv1alpha1.EnvMapEntry{
					envName: {SecretName: "origins", SecretKey: "value"},
				},
			},
			Networking: &appsv1alpha1.NetworkingSpec{
				PublicHosts: []string{"www.example.com"},
			},
		})
		got := envValues(container.Env, envName)
		Expect(got).To(HaveLen(1))
		Expect(got[0].ValueFrom).NotTo(BeNil())
		Expect(got[0].Value).To(BeEmpty())
	})

	DescribeTable("CEL admission",
		func(host string, accepted bool) {
			// Per-iteration name: the table body runs once per Entry, and the
			// objects are created in the shared envtest apiserver.
			name := fmt.Sprintf("public-hosts-cel-%d", GinkgoParallelProcess()*1000+CurrentSpecReport().LeafNodeLocation.LineNumber)
			app := &appsv1alpha1.NextApp{
				ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
				Spec: appsv1alpha1.NextAppSpec{
					Image:      validImage,
					Networking: &appsv1alpha1.NetworkingSpec{PublicHosts: []string{host}},
				},
			}
			err := k8sClient.Create(ctx, app)
			if accepted {
				Expect(err).NotTo(HaveOccurred())
				DeferCleanup(func() {
					deleteAndFinalize(ctx, types.NamespacedName{Name: name, Namespace: namespace})
				})
				return
			}
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("publicHosts"))
		},
		Entry("accepts a plain DNS name", "www.example.com", true),
		Entry("accepts a single-label name", "localhost", true),
		Entry("rejects a scheme prefix", "https://example.com", false),
		Entry("rejects a path", "example.com/x", false),
		Entry("rejects a port", "example.com:8080", false),
		Entry("rejects userinfo", "user@example.com", false),
		Entry("rejects a wildcard", "*.example.com", false),
		Entry("rejects whitespace", "exa mple.com", false),
		Entry("rejects an empty entry", "", false),
		Entry("rejects a label ending in a hyphen", "example-.com", false),
		Entry("rejects the wildcard bind address", "0.0.0.0", false),
		Entry("rejects a comma smuggled into one entry", "a.example.com,b.example.com", false),
	)
})
