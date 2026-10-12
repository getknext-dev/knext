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
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// ADR-0068 D3 against a real apiserver: the CRD schema + CEL for spec.cdn, the
// unconditional KNEXT_CDN_* reservation, the CRD default, and the rendered ksvc
// through the REAL Reconcile.
var _ = Describe("NextApp spec.cdn", func() {
	const (
		namespace  = "default"
		validImage = "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
	)
	ctx := context.Background()

	create := func(name string, spec appsv1alpha1.NextAppSpec) error {
		spec.Image = validImage
		app := &appsv1alpha1.NextApp{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
			Spec:       spec,
		}
		err := k8sClient.Create(ctx, app)
		if err == nil {
			DeferCleanup(func() { deleteAndFinalize(ctx, types.NamespacedName{Name: name, Namespace: namespace}) })
		}
		return err
	}

	reconcile1 := func(name string) (*servingv1.Service, *record.FakeRecorder) {
		nn := types.NamespacedName{Name: name, Namespace: namespace}
		recorder := record.NewFakeRecorder(64)
		r := &NextAppReconciler{Client: k8sClient, Scheme: k8sClient.Scheme(), Recorder: recorder}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: nn})
		Expect(err).NotTo(HaveOccurred())
		ksvc := &servingv1.Service{}
		Expect(k8sClient.Get(ctx, nn, ksvc)).To(Succeed())
		return ksvc, recorder
	}

	cdnEnv := func(ksvc *servingv1.Service) map[string]corev1.EnvVar {
		return cdnEnvOf(ksvc.Spec.Template.Spec.Containers[0].Env)
	}

	It("renders spec.cdn into the ksvc, with the token as a secretKeyRef and the derived prefix", func() {
		Expect(create("cdn-render", appsv1alpha1.NextAppSpec{CDN: &appsv1alpha1.CDNSpec{
			Provider:     "cloudflare",
			ExcludePaths: []string{"/account"},
			Purge: &appsv1alpha1.CDNPurgeSpec{
				SecretRef: appsv1alpha1.CDNSecretRef{Name: "cdn-purge", Key: "token"},
				Target:    "0123456789abcdef0123456789abcdef",
			},
		}})).To(Succeed())
		ksvc, _ := reconcile1("cdn-render")
		// The CRD default is applied by the apiserver: read the stored object back.
		stored := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "cdn-render", Namespace: namespace}, stored)).To(Succeed())
		Expect(stored.Spec.CDN.HTMLTTLSeconds).To(Equal(int32(30)))
		env := cdnEnv(ksvc)
		Expect(env["KNEXT_CDN_PROVIDER"].Value).To(Equal("cloudflare"))
		// The CRD default (30) was applied by the apiserver, not by the Go code.
		Expect(env["KNEXT_CDN_HTML_TTL_SECONDS"].Value).To(Equal("30"))
		Expect(env["KNEXT_CDN_TAG_PREFIX"].Value).To(HaveLen(12))
		Expect(env["KNEXT_CDN_EXCLUDE_PATHS"].Value).To(Equal("/account"))
		tok := env["KNEXT_CDN_PURGE_TOKEN"]
		Expect(tok.Value).To(BeEmpty())
		Expect(tok.ValueFrom.SecretKeyRef.Name).To(Equal("cdn-purge"))
	})

	It("renders NO KNEXT_CDN_* env and no CDNAdvisory without spec.cdn (zero diff)", func() {
		Expect(create("cdn-absent", appsv1alpha1.NextAppSpec{})).To(Succeed())
		ksvc, _ := reconcile1("cdn-absent")
		Expect(cdnEnv(ksvc)).To(BeEmpty())
		got := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "cdn-absent", Namespace: namespace}, got)).To(Succeed())
		Expect(apimeta.FindStatusCondition(got.Status.Conditions, ConditionCDNAdvisory)).To(BeNil())
	})

	It("a second reconcile does not change the revision template", func() {
		Expect(create("cdn-stable", appsv1alpha1.NextAppSpec{CDN: &appsv1alpha1.CDNSpec{Provider: "cloudflare"}})).To(Succeed())
		first, _ := reconcile1("cdn-stable")
		second, _ := reconcile1("cdn-stable")
		Expect(second.Spec.Template.Spec.Containers[0].Env).To(Equal(first.Spec.Template.Spec.Containers[0].Env))
		Expect(second.Generation).To(Equal(first.Generation))
	})

	It("on build vinext renders nothing and reports the CDNAdvisory condition", func() {
		Expect(create("cdn-vinext", appsv1alpha1.NextAppSpec{
			Build: "vinext",
			CDN:   &appsv1alpha1.CDNSpec{Provider: "cloudflare"},
		})).To(Succeed())
		ksvc, _ := reconcile1("cdn-vinext")
		Expect(cdnEnv(ksvc)).To(BeEmpty())
		got := &appsv1alpha1.NextApp{}
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "cdn-vinext", Namespace: namespace}, got)).To(Succeed())
		c := apimeta.FindStatusCondition(got.Status.Conditions, ConditionCDNAdvisory)
		Expect(c).NotTo(BeNil())
		Expect(c.Reason).To(Equal(ReasonCDNInertOnVinext))
	})

	// ---- admission: CRD schema + CEL ----

	rejects := func(name string, spec appsv1alpha1.NextAppSpec, substr string) {
		err := create(name, spec)
		Expect(err).To(HaveOccurred(), "%s must be rejected at admission", name)
		Expect(err.Error()).To(ContainSubstring(substr))
	}
	cdn := func(mutate func(*appsv1alpha1.CDNSpec)) appsv1alpha1.NextAppSpec {
		c := &appsv1alpha1.CDNSpec{Provider: "cloudflare"}
		mutate(c)
		return appsv1alpha1.NextAppSpec{CDN: c}
	}
	emu := "http://cdn-emulator.e2e.svc.cluster.local:8080"

	It("rejects an unknown provider", func() {
		rejects("cdn-bad-provider", cdn(func(c *appsv1alpha1.CDNSpec) { c.Provider = "fastly" }), "provider")
	})
	It("rejects emulatorEndpoint on a real provider", func() {
		rejects("cdn-endpoint-on-cf", cdn(func(c *appsv1alpha1.CDNSpec) { c.EmulatorEndpoint = emu }),
			"only allowed with provider: emulator")
	})
	It("rejects provider emulator without an endpoint", func() {
		rejects("cdn-emu-no-endpoint", cdn(func(c *appsv1alpha1.CDNSpec) { c.Provider = "emulator" }),
			"requires spec.cdn.emulatorEndpoint")
	})
	for i, bad := range []string{
		"http://example.com",
		"http://cdn.e2e.svc.cluster.local/path",
		"http://user:pw@cdn.e2e.svc.cluster.local",
		"http://cdn.e2e.svc.cluster.local?x=1",
		"http://cdn.e2e.svc.cluster.local.evil.com",
		"ftp://cdn.e2e.svc.cluster.local",
		"http://127.0.0.1:8080",
	} {
		bad := bad
		It(fmt.Sprintf("rejects emulatorEndpoint %q", bad), func() {
			rejects(fmt.Sprintf("cdn-bad-endpoint-%d", i), cdn(func(c *appsv1alpha1.CDNSpec) {
				c.Provider, c.EmulatorEndpoint = "emulator", bad
			}), "emulatorEndpoint")
		})
	}
	It("accepts a *.svc.cluster.local emulator endpoint with and without a port", func() {
		Expect(create("cdn-emu-ok", cdn(func(c *appsv1alpha1.CDNSpec) {
			c.Provider, c.EmulatorEndpoint = "emulator", emu
		}))).To(Succeed())
		Expect(create("cdn-emu-ok-noport", cdn(func(c *appsv1alpha1.CDNSpec) {
			c.Provider, c.EmulatorEndpoint = "emulator", "https://cdn-emulator.e2e.svc.cluster.local"
		}))).To(Succeed())
	})
	It("rejects htmlTTLSeconds outside 1..3600 (0 is the apiserver default, 3601 is over)", func() {
		rejects("cdn-ttl-high", cdn(func(c *appsv1alpha1.CDNSpec) { c.HTMLTTLSeconds = 3601 }), "htmlTTLSeconds")
	})
	It("rejects staleWhileRevalidateSeconds over 3600", func() {
		rejects("cdn-swr-high", cdn(func(c *appsv1alpha1.CDNSpec) { c.StaleWhileRevalidateSeconds = 3601 }),
			"staleWhileRevalidateSeconds")
	})
	It("rejects path prefixes without a leading slash, with a comma or whitespace", func() {
		rejects("cdn-path-noslash", cdn(func(c *appsv1alpha1.CDNSpec) { c.ExcludePaths = []string{"account"} }), "excludePaths")
		rejects("cdn-path-comma", cdn(func(c *appsv1alpha1.CDNSpec) { c.IncludePaths = []string{"/a,/b"} }), "includePaths")
		rejects("cdn-path-space", cdn(func(c *appsv1alpha1.CDNSpec) { c.ExcludePaths = []string{"/a b"} }), "excludePaths")
	})
	It("rejects a purge block without a target or with a malformed one", func() {
		rejects("cdn-purge-target", cdn(func(c *appsv1alpha1.CDNSpec) {
			c.Purge = &appsv1alpha1.CDNPurgeSpec{SecretRef: appsv1alpha1.CDNSecretRef{Name: "s", Key: "k"}, Target: "a/../b"}
		}), "target")
	})
	It("rejects requestsPerMinute over 6000", func() {
		rejects("cdn-rpm", cdn(func(c *appsv1alpha1.CDNSpec) {
			c.Purge = &appsv1alpha1.CDNPurgeSpec{
				SecretRef: appsv1alpha1.CDNSecretRef{Name: "s", Key: "k"}, Target: "t", RequestsPerMinute: 6001,
			}
		}), "requestsPerMinute")
	})

	// The boundary table is ONE shared fixture, also read by the CLI's
	// validate-cdn.test.ts, so the CRD's schema + CEL and the CLI's local
	// validation cannot disagree about a bound. An unreadable or hollow table
	// fails the suite (it must never silently become an empty one).
	for i, c := range loadCDNCases() {
		c := c
		i := i
		verb := "rejects"
		if c.Valid {
			verb = "accepts"
		}
		It(fmt.Sprintf("shared table %s: %s", verb, c.Name), func() {
			name := fmt.Sprintf("cdn-table-%d", i)
			err := create(name, appsv1alpha1.NextAppSpec{CDN: &c.CDN})
			if c.Valid {
				Expect(err).NotTo(HaveOccurred())
				return
			}
			Expect(err).To(HaveOccurred())
			Expect(err.Error()).To(ContainSubstring("cdn"))
		})
	}

	// ---- admission: a CR cannot set its own prefix (D3, D5.3) ----

	It("rejects a spec.cdn.tagPrefix field: there is none, and strict decoding says so", func() {
		u := &unstructured.Unstructured{Object: map[string]interface{}{
			"apiVersion": "apps.kn-next.dev/v1alpha1",
			"kind":       "NextApp",
			"metadata":   map[string]interface{}{"name": "cdn-own-prefix", "namespace": namespace},
			"spec": map[string]interface{}{
				"image": validImage,
				"cdn":   map[string]interface{}{"provider": "cloudflare", "tagPrefix": "victim"},
			},
		}}
		err := k8sClient.Create(ctx, u, client.FieldValidation("Strict"))
		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("tagPrefix"))
	})

	reservedCases := []string{"KNEXT_CDN_TAG_PREFIX", "KNEXT_CDN_EMULATOR_ENDPOINT", "KNEXT_CDN_PURGE_TOKEN", "KNEXT_CDN_ANYTHING"}
	for i, name := range reservedCases {
		name := name
		i := i
		It(fmt.Sprintf("rejects spec.env %s, with and without spec.cdn", name), func() {
			rejects(fmt.Sprintf("cdn-env-%d", i),
				appsv1alpha1.NextAppSpec{Env: map[string]string{name: "x"}}, "KNEXT_CDN_")
			rejects(fmt.Sprintf("cdn-env-with-%d", i),
				appsv1alpha1.NextAppSpec{
					CDN: &appsv1alpha1.CDNSpec{Provider: "cloudflare"},
					Env: map[string]string{name: "x"},
				}, "KNEXT_CDN_")
		})
		It(fmt.Sprintf("rejects spec.secrets.envMap %s, with and without spec.cdn", name), func() {
			sec := &appsv1alpha1.SecretsSpec{EnvMap: map[string]appsv1alpha1.EnvMapEntry{
				name: {SecretName: "s", SecretKey: "k"},
			}}
			rejects(fmt.Sprintf("cdn-envmap-%d", i), appsv1alpha1.NextAppSpec{Secrets: sec}, "KNEXT_CDN_")
			rejects(fmt.Sprintf("cdn-envmap-with-%d", i), appsv1alpha1.NextAppSpec{
				CDN: &appsv1alpha1.CDNSpec{Provider: "cloudflare"}, Secrets: sec,
			}, "KNEXT_CDN_")
		})
	}
	It("still accepts names that merely resemble the prefix", func() {
		Expect(create("cdn-env-lookalike", appsv1alpha1.NextAppSpec{
			Env: map[string]string{"KNEXT_CDNX": "1", "MY_KNEXT_CDN_X": "1"},
		})).To(Succeed())
	})
})
