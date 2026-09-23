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
//	#39 proves the
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
//	This spec deploys a MINIMAL NextApp — no PVC, no
//	observability sidecar. The activation path does not depend on the PVC wiring
//	(#59); it only needs a ksvc that can scale to zero and serve /api/health. It
//	uses its OWN namespace + app name so it never collides with #38's spec, and
//	the operator deploy is shared once via scale_suite_test.go's BeforeSuite.
package e2e

import (
	"crypto/rand"
	"encoding/hex"
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
	// that serves /api/health, so the nightly workflow injects SCALE_TEST_IMAGE
	// with a real, signed, digest-pinned image. If this default is ever used the
	// ksvc ErrImagePulls and the spec fails at "ksvc not Ready" — the
	// operator-e2e-nightly workflow's `scale-image-preflight` job guards against
	// that by FAILING the lane when no SCALE_TEST_IMAGE resolves, or when the
	// resolved value is this placeholder, or when it is not a digest-pinned
	// @sha256:<64 hex> reference at all (#659; it used to skip, which meant the
	// whole lane reported success having executed nothing).
	// #670: the preflight RESOLVES the newest cosign-signed file-manager digest
	// from GHCR at run time (the image supply-chain.yml pushes + signs) and
	// confirms it is pullable + signed. Because that digest is an OCI *index*
	// (provenance mode=max) that `kind load` cannot make addressable, the scale
	// job `crane copy`s it — digest preserved — into an in-cluster registry and
	// deploys the localhost ref the node resolves via certs.d, proving
	// addressability with `crictl inspecti` before the suite runs. So the nightly
	// runs a real image with no repo variable, no standing write credential, and
	// no pod-level imagePullSecret. Shape is no longer the only check.
	scaleFromZeroImageDefault = "dev.local/file-manager@sha256:0000000000000000000000000000000000000000000000000000000000000000"

	// scaleFromZeroCacheSecret is the Secret that carries the per-run
	// CACHE_INVALIDATE_TOKEN the Profile-A ISR assertion needs (issue #1202). It
	// is created in BeforeAll and referenced by the NextApp CR's
	// spec.secrets.envMap so the operator wires it onto the ksvc as a
	// SecretKeyRef env var — the token is NEVER stored verbatim in the CR
	// (security.md: secrets in K8s Secrets only). The token itself is generated
	// per run (crypto/rand), not a standing credential, and lives only in this
	// throwaway kind namespace.
	scaleFromZeroCacheSecret = "scale-from-zero-cache-token"
	// scaleFromZeroCacheTokenKey is the key inside that Secret.
	scaleFromZeroCacheTokenKey = "token"

	// generousWakeCeiling bounds every woken-pod serve assertion. It is
	// DELIBERATELY GENEROUS: cold wake through the Knative activator is
	// scheduling-bound, so this is a smoke ceiling, not a performance SLO. The
	// observed time is RECORDED to the Ginkgo log on every run. DO NOT RATCHET
	// this down toward observed values — doing so turns the nightly lane into a
	// flake generator (see #1202, and the cold-start scheduling findings).
	//
	// It MUST stay >= the suite's SetDefaultEventuallyTimeout (5m) below: the
	// wake GETs poll inside an Eventually with that timeout, so a legitimate but
	// slow wake that the Eventually still accepts (4–5m) must not then be failed
	// by this ceiling. Kept one minute above the Eventually window for headroom.
	generousWakeCeiling = 6 * time.Minute
)

// cacheInvalidateToken is the per-run Bearer token for the file-manager
// /api/cache/invalidate endpoint. Generated in BeforeAll, mirrored into the
// scaleFromZeroCacheSecret, and sent as the Authorization header by the ISR
// assertion. It is redacted from any command echoed to the log by
// utils.HTTPPostInCluster.
var cacheInvalidateToken string

var _ = Describe("ScaleFromZero activation (A2-3 / #39)", Ordered, func() {
	SetDefaultEventuallyTimeout(5 * time.Minute)
	SetDefaultEventuallyPollingInterval(2 * time.Second)

	BeforeAll(func() {
		// The operator is deployed ONCE for the whole e2e_scale suite by the
		// shared BeforeSuite (scale_suite_test.go); this spec only manages its
		// OWN namespace + minimal NextApp CR.
		By("creating the scale-from-zero namespace")
		_, _ = utils.Kubectl("create", "ns", scaleFromZeroNamespace)

		By("generating a per-run CACHE_INVALIDATE_TOKEN and storing it in a Secret")
		buf := make([]byte, 32)
		_, err := rand.Read(buf)
		Expect(err).NotTo(HaveOccurred(), "failed to generate cache-invalidate token")
		cacheInvalidateToken = hex.EncodeToString(buf)
		// Applied via stdin (applyManifest), so the token is NOT echoed to the log
		// as a kubectl arg (Run logs cmd.Args, never stdin).
		Expect(applyManifest(scaleFromZeroCacheSecretManifest(cacheInvalidateToken))).
			To(Succeed(), "failed to create cache-invalidate Secret")

		By("applying a MINIMAL NextApp CR (minScale:0/maxScale:1, no cache/PVC) with the invalidate-token Secret wired via spec.secrets.envMap")
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

	// --- Profile-A deeper assertions on the WOKEN pod (issue #1202) ---------
	// The activation It above proves a pod came up. These prove the woken pod
	// actually SERVES the real app: the App Router home page, a force-dynamic
	// SSR route, and the authenticated ISR invalidation loop. Each re-activates
	// through the in-cluster HTTP probe (idempotent — wakes the pod if it idled
	// back to zero between specs) and RECORDS its observed wake time against the
	// generous, never-ratcheted ceiling.

	It("serves the App Router home page with a stable marker on the woken pod", func() {
		var status int
		var body string
		By("GET / through the activator")
		started := time.Now()
		Eventually(func(g Gomega) {
			var err error
			status, body, err = utils.ActivateAndGet(scaleFromZeroNamespace, scaleFromZeroAppName, "/")
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(status).To(Equal(200), "home page did not return 200 on the woken pod")
		}).Should(Succeed())
		observed := time.Since(started)
		_, _ = fmt.Fprintf(GinkgoWriter,
			"[timing] home page served %d in %s (generous ceiling %s — NOT ratcheted)\n",
			status, observed.Round(time.Millisecond), generousWakeCeiling)
		Expect(observed).To(BeNumerically("<", generousWakeCeiling),
			"home page wake exceeded the generous ceiling")
		Expect(bodyServesHomePage(body)).To(BeTrue(),
			"home page body missing the stable marker %q — the woken pod did not render the real / route", homePageMarker)
	})

	It("serves the force-dynamic on-demand route (SSR per request) on the woken pod", func() {
		var status int
		var body string
		By("GET /cache-tests/on-demand through the activator")
		started := time.Now()
		Eventually(func(g Gomega) {
			var err error
			status, body, err = utils.ActivateAndGet(scaleFromZeroNamespace, scaleFromZeroAppName, "/cache-tests/on-demand")
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(status).To(Equal(200), "on-demand route did not return 200 on the woken pod")
		}).Should(Succeed())
		observed := time.Since(started)
		_, _ = fmt.Fprintf(GinkgoWriter,
			"[timing] on-demand route served %d in %s (generous ceiling %s — NOT ratcheted)\n",
			status, observed.Round(time.Millisecond), generousWakeCeiling)
		Expect(observed).To(BeNumerically("<", generousWakeCeiling),
			"on-demand route wake exceeded the generous ceiling")
		Expect(body).To(ContainSubstring(onDemandPageMarker),
			"on-demand route body missing marker %q — the woken pod did not SSR-render it", onDemandPageMarker)
		_, ok := extractGeneratedAt(body, productsGeneratedAtClass)
		Expect(ok).To(BeTrue(),
			"on-demand route did not render a products generatedAt timestamp — cannot anchor the ISR assertion")
	})

	It("enforces invalidation auth and revalidates the products cache on the woken pod", func() {
		// 1. Unauthenticated POST MUST be rejected — the security invariant
		//    (security.md: no unauthenticated mutating endpoint). A 200 here
		//    means the auth check was removed; the lane MUST red.
		//    The status assertion lives INSIDE the Eventually so a transient
		//    activator 503 retries rather than hard-failing on the first hit.
		By("POST /api/cache/invalidate WITHOUT a Bearer token — expect 401")
		Eventually(func(g Gomega) {
			status, _, err := utils.HTTPPostInCluster(
				scaleFromZeroNamespace, scaleFromZeroAppName,
				"/api/cache/invalidate", `{"tag":"products"}`, nil, "")
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(status).To(Equal(401),
				"unauthenticated POST /api/cache/invalidate returned %d, expected 401 — endpoint is not fail-closed", status)
		}).Should(Succeed())

		// 2. Capture the PRODUCTS generatedAt (busted by the invalidation) AND
		//    the ORDERS generatedAt (the control — tagged `orders` only, so a
		//    products invalidation must leave it unchanged) in the SAME read.
		By("reading the products + orders generatedAt before invalidation")
		var before, ordersBefore string
		Eventually(func(g Gomega) {
			_, body, err := utils.ActivateAndGet(scaleFromZeroNamespace, scaleFromZeroAppName, "/cache-tests/on-demand")
			g.Expect(err).NotTo(HaveOccurred())
			ts, ok := extractGeneratedAt(body, productsGeneratedAtClass)
			g.Expect(ok).To(BeTrue(), "no products generatedAt to fingerprint")
			ots, ook := extractGeneratedAt(body, ordersGeneratedAtClass)
			g.Expect(ook).To(BeTrue(), "no orders generatedAt to fingerprint (control)")
			before, ordersBefore = ts, ots
		}).Should(Succeed())

		// 3. Authenticated POST MUST be 200 (asserted inside Eventually so a
		//    transient failure retries). The token is redacted from the log by
		//    HTTPPostInCluster.
		By("POST /api/cache/invalidate WITH the Bearer token — expect 200")
		Eventually(func(g Gomega) {
			status, _, err := utils.HTTPPostInCluster(
				scaleFromZeroNamespace, scaleFromZeroAppName,
				"/api/cache/invalidate", `{"tag":"products"}`,
				[]string{"Authorization: Bearer " + cacheInvalidateToken}, cacheInvalidateToken)
			g.Expect(err).NotTo(HaveOccurred())
			g.Expect(status).To(Equal(200),
				"authenticated POST /api/cache/invalidate returned %d, expected 200", status)
		}).Should(Succeed())

		// 4. The revalidation took effect — and it was the INVALIDATION, not a
		//    pod recycle. This CR has no shared cache handler, so unstable_cache
		//    is pod-process memory: if the pod idled to zero between reads, a
		//    fresh pod would refresh EVERY card's generatedAt, falsely "proving"
		//    revalidation even if revalidateTag were broken. The orders control
		//    closes that hole: revalidateTag('products') must change products
		//    (green) while leaving orders (blue, tagged `orders` only) UNCHANGED.
		//    A pod recycle would change both; products-changed + orders-unchanged
		//    can only come from the tag invalidation. SWR ('max') may serve stale
		//    once, so poll generously rather than asserting on the first read.
		By("re-reading until products changes AND orders is unchanged (invalidation, not recycle)")
		var after, ordersAfter string
		Eventually(func(g Gomega) {
			_, body, err := utils.ActivateAndGet(scaleFromZeroNamespace, scaleFromZeroAppName, "/cache-tests/on-demand")
			g.Expect(err).NotTo(HaveOccurred())
			ts, ok := extractGeneratedAt(body, productsGeneratedAtClass)
			g.Expect(ok).To(BeTrue())
			ots, ook := extractGeneratedAt(body, ordersGeneratedAtClass)
			g.Expect(ook).To(BeTrue())
			g.Expect(ts).NotTo(Equal(before), "products generatedAt did not change after invalidation")
			g.Expect(ots).To(Equal(ordersBefore),
				"orders generatedAt CHANGED — the products change came from a pod recycle, not revalidateTag('products')")
			after, ordersAfter = ts, ots
		}).Should(Succeed())
		_, _ = fmt.Fprintf(GinkgoWriter,
			"[isr] products %s -> %s (busted); orders %s -> %s (control, unchanged) after authenticated invalidation\n",
			before, after, ordersBefore, ordersAfter)
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
  secrets:
    envMap:
      CACHE_INVALIDATE_TOKEN:
        secretName: %s
        secretKey: %s
`, scaleFromZeroAppName, scaleFromZeroNamespace, image, scaleFromZeroCacheSecret, scaleFromZeroCacheTokenKey)
}

// scaleFromZeroCacheSecretManifest renders the Opaque Secret holding the
// per-run CACHE_INVALIDATE_TOKEN. Applied via stdin so the token never appears
// as a kubectl command-line arg (and thus never in the Ginkgo/CI log).
func scaleFromZeroCacheSecretManifest(token string) string {
	return fmt.Sprintf(`apiVersion: v1
kind: Secret
metadata:
  name: %s
  namespace: %s
type: Opaque
stringData:
  %s: %q
`, scaleFromZeroCacheSecret, scaleFromZeroNamespace, scaleFromZeroCacheTokenKey, token)
}
