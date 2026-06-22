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

// Package e2e — Layer 2 of A2-3 (#39): the REAL scale-to-zero ACTIVATION
// invariant on a live kind + Knative cluster.
//
// WHAT THIS PROVES (distinct from #38):
//
//	#38 proves the bytecode cache SURVIVES a scale-to-zero cycle. #39 proves the
//	autoscaler ACTIVATION path: a NextApp with minScale:0 idles down to 0
//	replicas, and a single request through the Knative activator wakes a pod and
//	returns 200. That is the scale-to-zero regression A2-3 asks for: "assert
//	replicas reach 0 then serve a request post-activation".
//
// WHY A SEPARATE BUILD TAG (`e2e_scale`, not `e2e`):
//
//	This needs a persistent kind cluster with Knative Serving (scale-to-zero)
//	whose config-autoscaler is patched to retain pods for 0s — none of which
//	exists in standard per-PR CI, where scale timing also sits within noise. So
//	this runs only on the nightly / workflow_dispatch operator-e2e workflow. The
//	per-PR gate that proves the *mechanism* is the deterministic envtest in
//	internal/controller/reconcile_output_test.go, which asserts the operator
//	renders min-scale:0 / max-scale:1 (scale-to-zero eligibility) onto the ksvc.
//
// DELIBERATELY DECOUPLED FROM #59:
//
//	This spec deploys a MINIMAL NextApp — no bytecode cache, no PVC, no
//	observability sidecar. The activation path does not depend on the PVC wiring
//	(#59); it only needs a ksvc that can scale to zero and serve /api/health. It
//	uses its OWN namespace + app name so it never collides with #38's spec, and
//	the operator deploy is shared once via scale_suite_test.go's BeforeSuite.
package e2e

import (
	"fmt"
	"os"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/test/utils"
)

const (
	// scaleFromZeroNamespace is the dedicated namespace for the #39 spec — kept
	// distinct from #38's so the two Ordered Describes never collide.
	scaleFromZeroNamespace = "kn-next-scalefromzero-test"
	// scaleFromZeroAppName is the NextApp / Knative Service name under test.
	scaleFromZeroAppName = "scale-from-zero-app"
	// scaleFromZeroImageDefault is an all-zeros placeholder digest that is
	// DELIBERATELY UNPULLABLE. The activation spec needs a real file-manager image
	// that serves /api/health, so the nightly workflow MUST set SCALE_TEST_IMAGE to
	// a freshly built+pushed, digest-pinned image. If this default is ever used the
	// ksvc ErrImagePulls and the spec fails at "ksvc not Ready" — the
	// operator-e2e-nightly workflow guards against that by skipping the run when no
	// SCALE_TEST_IMAGE is provided.
	// TODO(#39): wire a publish job that sets vars.SCALE_TEST_IMAGE to the latest
	// file-manager digest so the nightly schedule always has a real image.
	scaleFromZeroImageDefault = "dev.local/file-manager@sha256:0000000000000000000000000000000000000000000000000000000000000000"
)

var _ = Describe("ScaleFromZero activation (A2-3 / #39)", Ordered, func() {
	SetDefaultEventuallyTimeout(5 * time.Minute)
	SetDefaultEventuallyPollingInterval(2 * time.Second)

	BeforeAll(func() {
		// The operator is deployed ONCE for the whole e2e_scale suite by the
		// shared BeforeSuite (scale_suite_test.go); this spec only manages its
		// OWN namespace + minimal NextApp CR.
		By("creating the scale-from-zero namespace")
		_, _ = utils.Kubectl("create", "ns", scaleFromZeroNamespace)

		By("applying a MINIMAL NextApp CR (minScale:0/maxScale:1, no cache/PVC)")
		Expect(applyManifest(scaleFromZeroManifest())).To(Succeed(), "failed to apply NextApp CR")
	})

	AfterAll(func() {
		By("deleting the scale-from-zero namespace")
		_, _ = utils.Kubectl("delete", "ns", scaleFromZeroNamespace, "--ignore-not-found")
	})

	It("idles to zero replicas then serves a 200 on activation", func() {
		By("waiting for the Knative service to become Ready")
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "ksvc", scaleFromZeroAppName, "-n", scaleFromZeroNamespace,
				"-o", "jsonpath={.status.conditions[?(@.type=='Ready')].status}")
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(out).To(Equal("True"), "ksvc not Ready")
		}).Should(Succeed())

		By("waiting for the service to scale to zero (idle -> 0 replicas)")
		Expect(utils.WaitForScaleToZero(scaleFromZeroNamespace, scaleFromZeroAppName)).To(Succeed())

		By("confirming there are 0 Running pods before activation")
		n, err := utils.KnativeReadyPodCount(scaleFromZeroNamespace, scaleFromZeroAppName)
		Expect(err).NotTo(HaveOccurred())
		Expect(n).To(Equal(0), "service was not at zero replicas before activation")

		By("activating via a request to /api/health through the Knative activator")
		var status int
		var body string
		Eventually(func(g Gomega) {
			status, body, err = utils.ActivateAndGet(scaleFromZeroNamespace, scaleFromZeroAppName, "/api/health")
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(status).To(Equal(200), "activation request did not return 200")
		}).Should(Succeed())
		_, _ = fmt.Fprintf(GinkgoWriter, "activation response (%d): %s\n", status, body)

		By("asserting the activator woke at least one pod (scaled up from zero)")
		Expect(utils.WaitForScaleFromZero(scaleFromZeroNamespace, scaleFromZeroAppName)).To(Succeed())
		n, err = utils.KnativeReadyPodCount(scaleFromZeroNamespace, scaleFromZeroAppName)
		Expect(err).NotTo(HaveOccurred())
		Expect(n).To(BeNumerically(">=", 1), "no pod was woken on activation")

		By("asserting the /api/health body carries the deep-health status marker")
		// apps/file-manager/src/app/api/health/route.ts returns
		// JSON.stringify(checkDeepHealth()), whose payload includes a "status"
		// field ("ok"/"degraded" -> 200). The presence of that marker proves the
		// woken pod served the real app route, not an activator/ingress error page.
		Expect(body).To(ContainSubstring(`"status"`),
			"activation response body is not the /api/health payload")
	})
})

// scaleFromZeroManifest renders a MINIMAL NextApp CR for the #39 activation test:
// minScale:0/maxScale:1, no cache/PVC/observability — decoupled from #59.
func scaleFromZeroManifest() string {
	image := scaleFromZeroImageDefault
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
`, scaleFromZeroAppName, scaleFromZeroNamespace, image)
}
