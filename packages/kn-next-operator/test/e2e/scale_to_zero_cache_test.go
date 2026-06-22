//go:build e2e_scale
// +build e2e_scale

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

// Package e2e — Layer 2 of A2-2 (#38): the REAL scale-to-zero bytecode-cache
// invariant on a live kind + Knative cluster with a persistent PVC.
//
// WHY A SEPARATE BUILD TAG (`e2e_scale`, not `e2e`):
//
//	This spec deploys a NextApp, drives it through a real scale-to-zero cycle, and
//	reactivates it from cold. That needs a persistent kind cluster with Knative
//	Serving (scale-to-zero) AND an RWO PVC bound across the scale cycle — none of
//	which exists in standard per-PR CI, where timing also sits within noise. So
//	this runs only on the nightly / workflow_dispatch operator-e2e workflow, never
//	in `ci.yml`. The per-PR gate that proves the *mechanism* is the deterministic
//	vitest test `apps/file-manager/bytecode-cache-reuse.test.ts` (Layer 1).
//
// DEPENDENCY — #59 (config-features PVC flags):
//
//	The deploy step below sets `cache.enableBytecodeCache=true`, which the operator
//	must translate into a PVC mounted at NODE_COMPILE_CACHE on the Knative revision,
//	and `observability.enabled=true`, which exposes the app `/api/metrics` route.
//	The PVC wiring lands in #59. Until #59 merges this spec will deploy but the
//	cache will not survive scale-to-zero — that is expected and does NOT block
//	landing #38, because this spec never runs in PR CI. The TODO(#59) markers note
//	exactly where the behaviour depends on it.
//
// Shares the kind+Knative bootstrap helpers in test/utils with the scale-to-zero
// regression spec (#39); those helpers are intentionally generic so #39 can reuse
// them without depending on this file.
package e2e

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/test/utils"
)

const (
	// scaleAppNamespace is where the NextApp under test is deployed.
	scaleAppNamespace = "kn-next-scale-test"
	// scaleAppName is the NextApp / Knative Service name under test.
	scaleAppName = "bytecode-reuse-app"
	// scaleAppImage is the file-manager image (digest-pinned in real runs; the
	// operator rejects :latest). Overridable via the SCALE_TEST_IMAGE env var
	// in the nightly workflow so it can point at a freshly built+pushed digest.
	scaleAppImageDefault = "dev.local/file-manager@sha256:0000000000000000000000000000000000000000000000000000000000000000"
)

var _ = Describe("ScaleToZero bytecode cache (A2-2 / #38)", Ordered, func() {
	SetDefaultEventuallyTimeout(5 * time.Minute)
	SetDefaultEventuallyPollingInterval(2 * time.Second)

	BeforeAll(func() {
		// The operator is deployed ONCE for the whole e2e_scale suite by the
		// shared BeforeSuite (scale_suite_test.go); this spec only manages its
		// OWN namespace + NextApp CR so it can coexist with the #39 spec.
		By("creating the scale-test namespace")
		_, _ = utils.Kubectl("create", "ns", scaleAppNamespace)

		By("applying a NextApp CR with bytecode cache + observability + minScale:0/maxScale:1")
		manifest := nextAppManifest()
		Expect(applyManifest(manifest)).To(Succeed(), "failed to apply NextApp CR")
	})

	AfterAll(func() {
		By("deleting the scale-test namespace")
		_, _ = utils.Kubectl("delete", "ns", scaleAppNamespace, "--ignore-not-found")
	})

	It("reuses the bytecode cache across a scale-to-zero cold start", func() {
		By("waiting for the Knative service to become Ready (initial cold compile)")
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "ksvc", scaleAppName, "-n", scaleAppNamespace,
				"-o", "jsonpath={.status.conditions[?(@.type=='Ready')].status}")
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(out).To(Equal("True"), "ksvc not Ready")
		}).Should(Succeed())

		By("warming up: scraping app /api/metrics to populate + observe the cache")
		var warmupFileCount string
		Eventually(func(g Gomega) {
			metrics, err := utils.ScrapeAppMetrics(scaleAppNamespace, scaleAppName)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(metrics).To(ContainSubstring("kn_next_bytecode_cache_files_total"))
			count, ok := utils.ScrapeAppMetricValue(metrics, "kn_next_bytecode_cache_files_total")
			g.Expect(ok).To(BeTrue(), "cache_files_total metric missing")
			// TODO(#59): with the PVC mounted, this is > 0 after the first request.
			warmupFileCount = count
		}).Should(Succeed())
		_, _ = fmt.Fprintf(GinkgoWriter, "warm-up cache files: %s\n", warmupFileCount)

		By("waiting for the service to scale to zero")
		Expect(utils.WaitForScaleToZero(scaleAppNamespace, scaleAppName)).To(Succeed())

		By("reactivating from cold and scraping the app metrics again")
		var warmStart, coldStartFileCount string
		Eventually(func(g Gomega) {
			metrics, err := utils.ScrapeAppMetrics(scaleAppNamespace, scaleAppName)
			g.Expect(err).NotTo(HaveOccurred())
			ws, ok := utils.ScrapeAppMetricValue(metrics, "kn_next_bytecode_cache_warm_start")
			g.Expect(ok).To(BeTrue(), "warm_start metric missing")
			warmStart = ws
			fc, ok := utils.ScrapeAppMetricValue(metrics, "kn_next_bytecode_cache_files_total")
			g.Expect(ok).To(BeTrue(), "cache_files_total metric missing")
			coldStartFileCount = fc
		}).Should(Succeed())

		By("asserting the reactivated pod started WARM (cache survived on the PVC)")
		// TODO(#59): once the PVC is wired, the second cold start MUST read the
		// cache the first run wrote — warm_start == 1 and the file count must be
		// stable (no recompile bloat). These are the load-bearing assertions.
		Expect(warmStart).To(Equal("1"),
			"reactivated pod was cold — bytecode cache did NOT survive scale-to-zero")
		Expect(coldStartFileCount).To(Equal(warmupFileCount),
			"cache file count changed across cold start — recompilation occurred")
	})
})

// nextAppManifest renders the NextApp CR YAML for the scale-to-zero cache test.
func nextAppManifest() string {
	image := scaleAppImageDefault
	if v := os.Getenv("SCALE_TEST_IMAGE"); v != "" {
		image = v
	}
	return fmt.Sprintf(`apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: %s
  namespace: %s
spec:
  image: %q
  scaling:
    minScale: 0
    maxScale: 1
  cache:
    provider: redis
    enableBytecodeCache: true
    bytecodeCacheSize: 64Mi
  observability:
    enabled: true
`, scaleAppName, scaleAppNamespace, image)
}

// applyManifest pipes a YAML manifest into `kubectl apply -f -`.
func applyManifest(manifest string) error {
	cmd := exec.Command("kubectl", "apply", "-f", "-")
	cmd.Stdin = strings.NewReader(manifest)
	_, err := utils.Run(cmd)
	return err
}
