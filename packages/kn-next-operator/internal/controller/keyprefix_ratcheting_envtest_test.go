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
	"strconv"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/discovery"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	"sigs.k8s.io/yaml"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// ratchetingFloorMinor is the first Kubernetes minor on which CRD validation
// ratcheting is on by default (KEP-4008: beta in 1.30, GA in 1.33; alpha and
// off in 1.28/1.29). knext's documented server floor is 1.30 for this reason.
const ratchetingFloorMinor = 30

// loosenKeyPrefix strips the keyPrefix constraints the narrowing added, giving
// the CRD as it was before: an unconstrained optional string.
func loosenKeyPrefix(crd *apiextensionsv1.CustomResourceDefinition) {
	for i := range crd.Spec.Versions {
		spec := crd.Spec.Versions[i].Schema.OpenAPIV3Schema.Properties["spec"]
		cache := spec.Properties["cache"]
		kp := cache.Properties["keyPrefix"]
		kp.Pattern = ""
		kp.MaxLength = nil
		kp.XValidations = nil
		cache.Properties["keyPrefix"] = kp
		spec.Properties["cache"] = cache
		crd.Spec.Versions[i].Schema.OpenAPIV3Schema.Properties["spec"] = spec
	}
}

// keyPrefix narrowing vs. existing objects (#2398). The narrowing rejects new
// values, but an app stored BEFORE the operator/CRD upgrade may already carry a
// prefix the new rules refuse. CRD validation ratcheting lets such an object
// keep taking updates that leave keyPrefix unchanged. This probe installs the
// pre-narrowing schema, stores an app with a now-invalid prefix, swaps in the
// real generated CRD, and then edits an UNRELATED field.
//
// On the server floor (>= 1.30, ratcheting on by default) the unrelated edit
// must succeed. Below it the edit is refused, which is the documented gap; the
// probe asserts that too, so running it on a 1.29 envtest records the real
// behaviour rather than skipping.
var _ = Describe("keyPrefix narrowing ratchets for existing NextApps (#2398)", func() {
	It("lets an app stored with a now-invalid keyPrefix take unrelated updates, and refuses a new invalid value", func() {
		ctx, cancel := context.WithCancel(context.Background())
		DeferCleanup(cancel)

		crdPath := filepath.Join("..", "..", "config", "crd", "bases", "apps.kn-next.dev_nextapps.yaml")
		raw, err := os.ReadFile(crdPath)
		Expect(err).NotTo(HaveOccurred())
		narrowed := &apiextensionsv1.CustomResourceDefinition{}
		Expect(yaml.Unmarshal(raw, narrowed)).To(Succeed())
		kp := narrowed.Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["spec"].Properties["cache"].Properties["keyPrefix"]
		Expect(kp.Pattern).NotTo(BeEmpty(), "the generated CRD carries no keyPrefix pattern — nothing is narrowed")
		Expect(kp.MaxLength).NotTo(BeNil(), "the generated CRD carries no keyPrefix maxLength")
		Expect(kp.XValidations).NotTo(BeEmpty(), "the generated CRD carries no keyPrefix CEL rule")

		loose := narrowed.DeepCopy()
		loosenKeyPrefix(loose)

		By("an API server holding the PRE-narrowing NextApp CRD")
		env := &envtest.Environment{
			CRDs:                  []*apiextensionsv1.CustomResourceDefinition{loose},
			ErrorIfCRDPathMissing: true,
		}
		if dir := getFirstFoundEnvTestBinaryDir(); dir != "" {
			env.BinaryAssetsDirectory = dir
		}
		cfg2, err := env.Start()
		Expect(err).NotTo(HaveOccurred())
		DeferCleanup(func() { _ = env.Stop() })

		disco, err := discovery.NewDiscoveryClientForConfig(cfg2)
		Expect(err).NotTo(HaveOccurred())
		sv, err := disco.ServerVersion()
		Expect(err).NotTo(HaveOccurred())
		minor, err := strconv.Atoi(strings.TrimSuffix(sv.Minor, "+"))
		Expect(err).NotTo(HaveOccurred())
		GinkgoWriter.Printf("keyPrefix ratcheting probe: server %s\n", sv.GitVersion)

		s := runtime.NewScheme()
		Expect(appsv1alpha1.AddToScheme(s)).To(Succeed())
		Expect(apiextensionsv1.AddToScheme(s)).To(Succeed())
		c, err := client.New(cfg2, client.Options{Scheme: s})
		Expect(err).NotTo(HaveOccurred())

		const ns = "default"
		image := "registry.example.com/app:v1@sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
		mk := func(name, prefix string) *appsv1alpha1.NextApp {
			return &appsv1alpha1.NextApp{
				ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
				Spec: appsv1alpha1.NextAppSpec{
					Image: image,
					Cache: &appsv1alpha1.CacheSpec{Provider: "redis", URL: "redis://redis:6379", KeyPrefix: prefix},
				},
			}
		}
		// One stored app per rule class: a glob metacharacter, whitespace, an
		// over-long value (pattern / maxLength), and the reserved keyspace (CEL).
		legacy := map[string]string{
			"legacy-glob":     "shop*",
			"legacy-space":    "my shop",
			"legacy-long":     strings.Repeat("a", 64),
			"legacy-reserved": "kn-next",
		}
		for name, prefix := range legacy {
			Expect(c.Create(ctx, mk(name, prefix))).To(Succeed(), "the PRE-narrowing schema must admit %q", prefix)
		}

		By("upgrading the CRD to the real, narrowed schema")
		Eventually(func() error {
			cur := &apiextensionsv1.CustomResourceDefinition{}
			if err := c.Get(ctx, client.ObjectKey{Name: narrowed.Name}, cur); err != nil {
				return err
			}
			cur.Spec.Versions = narrowed.Spec.Versions
			return c.Update(ctx, cur)
		}, 10*time.Second, 200*time.Millisecond).Should(Succeed())
		// The new schema is live once a fresh invalid object is refused.
		Eventually(func() bool {
			err := c.Create(ctx, mk("probe-new-invalid", "probe*"))
			if err == nil {
				_ = c.Delete(ctx, mk("probe-new-invalid", ""))
				return false
			}
			return errors.IsInvalid(err)
		}, 20*time.Second, 200*time.Millisecond).Should(BeTrue(), "the narrowed schema never took effect")

		By("editing an unrelated field of each stored app")
		for name := range legacy {
			cur := &appsv1alpha1.NextApp{}
			Expect(c.Get(ctx, client.ObjectKey{Namespace: ns, Name: name}, cur)).To(Succeed())
			cur.Spec.Env = map[string]string{"FEATURE_FLAG": "on"}
			err := c.Update(ctx, cur)
			if minor >= ratchetingFloorMinor {
				Expect(err).NotTo(HaveOccurred(),
					"Kubernetes %s ratchets CRD validation, so an unchanged keyPrefix must not block an unrelated edit of %s", sv.GitVersion, name)
			} else {
				Expect(err).To(HaveOccurred(),
					"below 1.%d ratcheting is off by default; the docs say the next spec change is refused — %s was admitted", ratchetingFloorMinor, name)
				Expect(errors.IsInvalid(err)).To(BeTrue())
				GinkgoWriter.Printf("keyPrefix ratcheting probe: %s refused on %s (expected below the floor): %v\n", name, sv.GitVersion, err)
			}
		}

		By("changing a stored keyPrefix to another invalid value is refused on every version")
		cur := &appsv1alpha1.NextApp{}
		Expect(c.Get(ctx, client.ObjectKey{Namespace: ns, Name: "legacy-glob"}, cur)).To(Succeed())
		cur.Spec.Cache.KeyPrefix = "shop?"
		err = c.Update(ctx, cur)
		Expect(err).To(HaveOccurred(), "ratcheting must not admit a CHANGED invalid keyPrefix")
		Expect(errors.IsInvalid(err)).To(BeTrue())

		By("fixing the prefix is always admitted")
		Expect(c.Get(ctx, client.ObjectKey{Namespace: ns, Name: "legacy-glob"}, cur)).To(Succeed())
		cur.Spec.Cache.KeyPrefix = "shop"
		Expect(c.Update(ctx, cur)).To(Succeed())
	})
})
