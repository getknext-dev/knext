//go:build e2e_platform
// +build e2e_platform

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

// Package e2e — the PLATFORM LAYER end-to-end suite (build tag `e2e_platform`).
//
// WHAT THIS PROVES (ADR-0064, P0):
//
//	The platform layer (a cluster-scoped KnextPlatform that supplies defaults to
//	every NextApp) has envtest coverage for its decisions. Envtest has no
//	Knative, no admission webhook and no real revision, so it cannot show the
//	thing a user cares about: that a bad platform edit leaves the OLD revision
//	SERVING. This suite runs the real operator bundle on kind with real Knative
//	and asserts, in order:
//
//	  1. BASELINE — with no KnextPlatform, two apps are Ready and serve rev1.
//	  2. ZERO DIFF — creating an EMPTY platform renders the Knative Service
//	     byte-identically: same template, same generation, no new revision.
//	  3. EFFECTIVE VALUES — a platform timeout is inherited by apps that leave it
//	     unset, rolls a new revision, and the rollout limiter paces the apps (the
//	     wait is observed on the limiter metric).
//	  4. HELD — lowering connectionBudget below the apps' footprint HOLDS them:
//	     PlatformDefaultsApplied=False/EffectiveSpecInvalid, the Knative Service is
//	     untouched, the old revision keeps serving, and the held-apps metric and
//	     holds counter move. A developer change made WHILE held reads Ready=False
//	     (a false Ready=True would call a dropped deploy a success) and the old
//	     image still serves.
//	  5. DELETE WHILE OVER BUDGET — an over-budget app is deleted and leaves; it
//	     must not wedge in Terminating (the finalizer-removal patch is an UPDATE
//	     through the budget webhook).
//	  6. RECOVERY — restoring the budget applies the held change and the held
//	     gauge returns to 0.
//	  7. NO SILENT FALLBACK — through all of the above the admission webhook never
//	     fell back to the built-in budget (the fallback counters read 0).
//
// WHAT IT DELIBERATELY DOES NOT DO
//
//	It does not exercise limiter state across a leader failover. The limiter is
//	in memory and documented to reset (it re-spaces from scratch, still bounded
//	by maxAppsPerMinute); the queue-depth gauge resets with it. TODO(#2112):
//	failover drill needs a 2-replica operator and is not part of this lane.
//
//	It is kind-ONLY: the KnextPlatform is a cluster-wide singleton, so running it
//	against a shared cluster would change every app on that cluster.
package e2e

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/test/utils"
)

const (
	// pfOperatorImage is the LOCALLY-built operator image (never a published one).
	pfOperatorImage = "registry.invalid/kn-next-operator:platform-e2e"

	pfOperatorNamespace = "kn-next-operator-system"
	pfOperatorDeploy    = "kn-next-operator-controller-manager"
	pfOperatorSA        = "kn-next-operator-controller-manager"
	pfMetricsService    = "kn-next-operator-controller-manager-metrics-service"
	pfMetricsBinding    = "kn-next-platform-e2e-metrics"

	pfAppA = "platform-e2e-a"
	pfAppB = "platform-e2e-b"

	// pfAppImage is a REAL, SERVABLE, public, digest-pinned multi-arch image that
	// answers "Hello ${TARGET}!" — the same pin the rollback suite uses.
	pfAppImage = "ghcr.io/knative/helloworld-go@sha256:" +
		"c2b7412fbea6f1ef24a0cac60698e88df7ae3c4278e42d0cb34fe7d4b2641bba"

	// 8 x 10 = 80: exactly the built-in connection budget, so valid on its own
	// and over budget only once the platform lowers it.
	pfMaxScale = 8
	pfPoolMax  = 10

	pfHeld    = `knext_nextapp_platform_held_apps{reason="EffectiveSpecInvalid"}`
	pfHolds   = `knext_nextapp_platform_holds_total{reason="EffectiveSpecInvalid"}`
	pfWaitCnt = `knext_platform_rollout_wait_seconds_count`
	pfQueue   = `knext_platform_rollout_queue_depth`

	pfFallbackRead    = `knext_webhook_budget_fallback_total{reason="read_error"}`
	pfFallbackInvalid = `knext_webhook_budget_fallback_total{reason="platform_invalid"}`
)

var pfNamespace = func() string {
	if v := strings.TrimSpace(os.Getenv("KNEXT_E2E_NAMESPACE")); v != "" {
		return v
	}
	return fmt.Sprintf("e2e-platform-%x", time.Now().UnixNano()&0xffffff)
}()

func TestPlatformE2E(t *testing.T) {
	RegisterFailHandler(Fail)
	_, _ = fmt.Fprintf(GinkgoWriter, "Starting kn-next platform-layer e2e suite (ADR-0064)\n")
	RunSpecs(t, "platform e2e suite")
}

// pfNextApp renders a NextApp. TARGET is both the revision-forcing env lever and
// the HTTP marker.
func pfNextApp(name, target string) string {
	return fmt.Sprintf(`apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: %s
  namespace: %s
spec:
  image: %q
  healthCheckPath: /
  env:
    TARGET: %q
  scaling:
    minScale: 0
    maxScale: %d
    poolMax: %d
`, name, pfNamespace, pfAppImage, target, pfMaxScale, pfPoolMax)
}

// pfPlatform renders the singleton KnextPlatform with the given spec body
// (already indented two spaces under `spec:`; empty means `spec: {}`).
func pfPlatform(specBody string) string {
	spec := "spec: {}\n"
	if strings.TrimSpace(specBody) != "" {
		spec = "spec:\n" + specBody
	}
	return "apiVersion: platform.kn-next.dev/v1alpha1\nkind: KnextPlatform\nmetadata:\n  name: default\n" + spec
}

func pfJSONPath(args []string, path string) func(Gomega) string {
	return func(g Gomega) string {
		full := append(append([]string{}, args...), "-o", "jsonpath="+path)
		out, err := utils.Kubectl(full...)
		g.Expect(err).NotTo(HaveOccurred(), out)
		return strings.TrimSpace(out)
	}
}

func pfCondField(app, condType, field string) func(Gomega) string {
	return pfJSONPath([]string{"get", "nextapp", app, "-n", pfNamespace},
		fmt.Sprintf("{.status.conditions[?(@.type=='%s')].%s}", condType, field))
}

func pfKsvc(app, path string) func(Gomega) string {
	return pfJSONPath([]string{"get", "ksvc", app, "-n", pfNamespace}, path)
}

// pfTemplate is the Knative Service's revision template exactly as stored.
func pfTemplate(app string) string {
	var out string
	Eventually(func(g Gomega) {
		out = pfKsvc(app, "{.spec.template}")(g)
		g.Expect(out).NotTo(BeEmpty())
	}).Should(Succeed())
	return out
}

func pfExpectBody(app, marker string) {
	Eventually(func(g Gomega) {
		status, body, err := utils.ActivateAndGet(pfNamespace, app, "/")
		g.Expect(err).NotTo(HaveOccurred(), body)
		g.Expect(status).To(Equal(200), "request did not return 200 (body: %s)", body)
		g.Expect(body).To(ContainSubstring(marker), "the wrong revision answered")
	}, 5*time.Minute, 3*time.Second).Should(Succeed())
}

func pfWaitReady(app string) {
	Eventually(pfKsvc(app, "{.status.conditions[?(@.type=='Ready')].status}"),
		10*time.Minute, 5*time.Second).Should(Equal("True"), "ksvc %s not Ready", app)
	Eventually(pfCondField(app, "Ready", "status"), 2*time.Minute, 2*time.Second).Should(Equal("True"),
		"NextApp %s not Ready", app)
}

var pfScrapes int

// pfMetric scrapes the operator's protected /metrics endpoint and returns one
// series. A series that is absent fails the spec: absent is not zero.
func pfMetric(series string) float64 {
	GinkgoHelper()
	token, err := utils.Kubectl("create", "token", pfOperatorSA, "-n", pfOperatorNamespace, "--duration=30m")
	Expect(err).NotTo(HaveOccurred(), "could not mint a metrics token")
	token = strings.TrimSpace(token)

	pfScrapes++
	url := fmt.Sprintf("https://%s.%s.svc.cluster.local:8443/metrics", pfMetricsService, pfOperatorNamespace)
	var value float64
	Eventually(func(g Gomega) {
		out, err := utils.ScrapeWithBearer(pfNamespace, fmt.Sprintf("platform-e2e-scrape-%d", pfScrapes), url, token)
		g.Expect(err).NotTo(HaveOccurred(), out)
		v, ok := utils.MetricValue(out, series)
		g.Expect(ok).To(BeTrue(), "series %s is not exported by the operator", series)
		value = v
	}, 2*time.Minute, 5*time.Second).Should(Succeed())
	return value
}

var _ = Describe("platform layer against a live cluster (ADR-0064)", Ordered, func() {
	SetDefaultEventuallyTimeout(5 * time.Minute)
	SetDefaultEventuallyPollingInterval(2 * time.Second)

	var renderedBundle string

	// Captured as the specs progress.
	var baselineTemplate, baselineGeneration, baselineRevision string

	BeforeAll(func() {
		By("pinning the kind kube context (#271 — never an ambient cluster; the platform is cluster-wide)")
		Expect(utils.EnsureKindContext(GinkgoT().TempDir())).To(Succeed(),
			"refusing to run — no cluster operation was attempted")

		By("building the operator image LOCALLY and loading it into kind")
		_, err := utils.Run(exec.Command("make", "docker-build", fmt.Sprintf("IMG=%s", pfOperatorImage)))
		Expect(err).NotTo(HaveOccurred(), "failed to build the operator image")
		Expect(utils.LoadImageToKindClusterWithName(pfOperatorImage)).To(Succeed())

		By("rendering the install bundle (it carries the KnextPlatform CRD) and applying it")
		_, err = utils.Run(exec.Command("make", "build-installer"))
		Expect(err).NotTo(HaveOccurred(), "failed to render dist/install.yaml")
		renderedBundle, err = utils.OverrideManagerImage(pfOperatorImage, "install.platform-e2e.yaml")
		Expect(err).NotTo(HaveOccurred())
		Expect(utils.ApplyOrDeleteBundle("apply", renderedBundle)).To(Succeed())

		By("waiting for the operator Deployment to be Available")
		Eventually(pfJSONPath([]string{"get", "deployment", pfOperatorDeploy, "-n", pfOperatorNamespace},
			"{.status.conditions[?(@.type=='Available')].status}")).Should(Equal("True"))

		By("confirming the KnextPlatform CRD is installed and NO platform exists yet")
		out, err := utils.Kubectl("get", "crd", "knextplatforms.platform.kn-next.dev")
		Expect(err).NotTo(HaveOccurred(), out)
		out, err = utils.Kubectl("get", "knextplatform", "-o", "name")
		Expect(err).NotTo(HaveOccurred(), out)
		Expect(strings.TrimSpace(out)).To(BeEmpty(), "the suite needs a cluster with no platform to start from")

		By("granting the operator's own ServiceAccount read access to /metrics (scrape identity)")
		Expect(utils.KubectlCreateIgnoreExists("create", "clusterrolebinding", pfMetricsBinding,
			"--clusterrole=kn-next-operator-metrics-reader",
			fmt.Sprintf("--serviceaccount=%s:%s", pfOperatorNamespace, pfOperatorSA))).To(Succeed())

		By(fmt.Sprintf("creating the fresh, owned app namespace %q", pfNamespace))
		Eventually(func(g Gomega) {
			err := utils.CreateOwnedNamespace(pfNamespace)
			if errors.Is(err, utils.ErrForeignNamespace) {
				StopTrying("ownership guard refused a pre-existing, unowned namespace").Wrap(err).Now()
			}
			g.Expect(err).NotTo(HaveOccurred())
		}, 2*time.Minute, 10*time.Second).Should(Succeed())

		By("waiting for the validating webhook to actually serve (Available ≠ webhook ready)")
		Expect(utils.WaitForWebhookReady(pfNamespace)).To(Succeed())
	})

	AfterAll(func() {
		// Remove the platform FIRST so any app still over a lowered budget is back
		// under the built-in one before the namespace is torn down.
		By("removing the platform (own kind cluster)")
		_, _ = utils.Kubectl("delete", "knextplatform", "default", "--ignore-not-found", "--wait=false")

		By(fmt.Sprintf("deleting the app namespace %q (ownership-guarded, confirmed)", pfNamespace))
		Eventually(func(g Gomega) {
			err := utils.NamespaceDeletedConfirmed(pfNamespace)
			if errors.Is(err, utils.ErrTeardownRefused) {
				StopTrying("teardown ownership guard refused the namespace deletion").Wrap(err).Now()
			}
			g.Expect(err).NotTo(HaveOccurred())
		}, 10*time.Minute, 5*time.Second).Should(Succeed())

		_, _ = utils.Kubectl("delete", "clusterrolebinding", pfMetricsBinding, "--ignore-not-found")
		By("deleting the rendered bundle")
		_ = utils.ApplyOrDeleteBundle("delete", renderedBundle)
		if renderedBundle != "" {
			_ = os.Remove(renderedBundle)
		}
	})

	It("baseline: with NO platform two apps are Ready, report NoPlatform and serve rev1", func() {
		for _, app := range []string{pfAppA, pfAppB} {
			Eventually(func(g Gomega) {
				g.Expect(utils.ApplyManifest(pfNextApp(app, "rev1"))).To(Succeed())
			}, 2*time.Minute, 10*time.Second).Should(Succeed())
		}
		for _, app := range []string{pfAppA, pfAppB} {
			pfWaitReady(app)
		}
		Eventually(pfCondField(pfAppA, "PlatformDefaultsApplied", "reason")).Should(Equal("NoPlatform"))
		pfExpectBody(pfAppA, "Hello rev1!")

		baselineTemplate = pfTemplate(pfAppA)
		baselineGeneration = pfKsvc(pfAppA, "{.metadata.generation}")(Default)
		baselineRevision = pfKsvc(pfAppA, "{.status.latestReadyRevisionName}")(Default)
		Expect(baselineRevision).NotTo(BeEmpty())

		By("the held-apps series is exported at 0 before anything is held")
		Expect(pfMetric(pfHeld)).To(Equal(0.0))
	})

	It("zero diff: an EMPTY platform renders the Knative Service byte-identically", func() {
		Expect(utils.ApplyManifest(pfPlatform(""))).To(Succeed())

		By("the operator accepts the platform and every app is re-evaluated against it")
		Eventually(pfJSONPath([]string{"get", "knextplatform", "default"},
			"{.status.conditions[?(@.type=='Accepted')].status}")).Should(Equal("True"))
		Eventually(pfJSONPath([]string{"get", "nextapp", pfAppA, "-n", pfNamespace}, "{.status.platform.specHash}")).
			ShouldNot(BeEmpty(), "the app was never reconciled against the platform")
		Eventually(pfCondField(pfAppA, "PlatformDefaultsApplied", "reason")).ShouldNot(Equal("NoPlatform"))

		By("…and the Service is exactly what it was without a platform")
		Consistently(func(g Gomega) {
			g.Expect(pfKsvc(pfAppA, "{.spec.template}")(g)).To(Equal(baselineTemplate),
				"an empty platform changed the rendered revision template")
			g.Expect(pfKsvc(pfAppA, "{.metadata.generation}")(g)).To(Equal(baselineGeneration),
				"an empty platform bumped the Service generation")
			g.Expect(pfKsvc(pfAppA, "{.status.latestCreatedRevisionName}")(g)).To(Equal(baselineRevision),
				"an empty platform rolled a new revision")
		}, 15*time.Second, 3*time.Second).Should(Succeed())
		pfExpectBody(pfAppA, "Hello rev1!")
	})

	It("effective values: a platform timeout is inherited, rolls a revision, and the limiter paces the apps", func() {
		waitsBefore := pfMetric(pfWaitCnt)

		// 6 per minute spaces the two apps ~10s apart, so the second one is queued.
		Expect(utils.ApplyManifest(pfPlatform("  limits:\n    timeoutSeconds: 123\n  rollout:\n    maxAppsPerMinute: 6\n"))).
			To(Succeed())

		for _, app := range []string{pfAppA, pfAppB} {
			Eventually(pfKsvc(app, "{.spec.template.spec.timeoutSeconds}"), 5*time.Minute, 3*time.Second).
				Should(Equal("123"), "%s never inherited the platform timeout", app)
		}
		Eventually(pfJSONPath([]string{"get", "nextapp", pfAppA, "-n", pfNamespace},
			"{.status.platform.inheritedFields}")).Should(ContainSubstring("spec.timeoutSeconds"))

		By("a new revision was rolled for the changed effective value, and it serves")
		for _, app := range []string{pfAppA, pfAppB} {
			pfWaitReady(app)
		}
		Eventually(pfKsvc(pfAppA, "{.status.latestReadyRevisionName}")).ShouldNot(Equal(baselineRevision))
		pfExpectBody(pfAppA, "Hello rev1!")

		By("the limiter observed at least one queued re-render")
		Expect(pfMetric(pfWaitCnt)).To(BeNumerically(">", waitsBefore),
			"two apps re-rendered at 6/minute but the limiter never queued one")
		Expect(pfMetric(pfQueue)).To(BeNumerically(">=", 0))

		baselineTemplate = pfTemplate(pfAppA)
		baselineRevision = pfKsvc(pfAppA, "{.status.latestReadyRevisionName}")(Default)
	})

	It("held: lowering connectionBudget below the footprint holds the apps and the old revision keeps serving", func() {
		holdsBefore := pfMetric(pfHolds)

		Expect(utils.ApplyManifest(pfPlatform(
			"  limits:\n    timeoutSeconds: 123\n  rollout:\n    maxAppsPerMinute: 6\n  database:\n    connectionBudget: 40\n"))).
			To(Succeed())

		By("both apps are held: PlatformDefaultsApplied=False/EffectiveSpecInvalid")
		for _, app := range []string{pfAppA, pfAppB} {
			Eventually(pfCondField(app, "PlatformDefaultsApplied", "status")).Should(Equal("False"), app)
			Eventually(pfCondField(app, "PlatformDefaultsApplied", "reason")).Should(Equal("EffectiveSpecInvalid"), app)
		}

		By("the Knative Service is untouched: same template, same latest-ready revision, still serving")
		Consistently(func(g Gomega) {
			g.Expect(pfKsvc(pfAppA, "{.spec.template}")(g)).To(Equal(baselineTemplate),
				"a held app's Knative Service must be left exactly as it was")
			g.Expect(pfKsvc(pfAppA, "{.status.latestReadyRevisionName}")(g)).To(Equal(baselineRevision))
		}, 15*time.Second, 3*time.Second).Should(Succeed())
		pfExpectBody(pfAppA, "Hello rev1!")

		By("the held metric moved: two apps held now, two holds counted")
		Eventually(func() float64 { return pfMetric(pfHeld) }, 2*time.Minute, 5*time.Second).Should(Equal(2.0))
		Expect(pfMetric(pfHolds) - holdsBefore).To(BeNumerically(">=", 2))

		By("the platform reports the hold")
		Eventually(pfJSONPath([]string{"get", "knextplatform", "default"}, "{.status.rollout.held}")).Should(Equal("2"))

		By("a developer change made WHILE held is not applied and reads Ready=False, never a false green")
		// Footprint unchanged (still 80), so the ratcheted webhook admits the edit.
		Eventually(func(g Gomega) {
			g.Expect(utils.ApplyManifest(pfNextApp(pfAppA, "rev2"))).To(Succeed())
		}, 2*time.Minute, 10*time.Second).Should(Succeed())
		Eventually(pfCondField(pfAppA, "Ready", "status")).Should(Equal("False"))
		Eventually(pfCondField(pfAppA, "Ready", "reason")).Should(Equal("EffectiveSpecInvalid"))
		Consistently(func(g Gomega) {
			g.Expect(pfKsvc(pfAppA, "{.spec.template}")(g)).To(Equal(baselineTemplate),
				"the held change must not reach the Knative Service")
		}, 10*time.Second, 3*time.Second).Should(Succeed())
		pfExpectBody(pfAppA, "Hello rev1!")
	})

	It("delete while over budget: the app leaves and does not hang in Terminating", func() {
		_, err := utils.Kubectl("delete", "nextapp", pfAppB, "-n", pfNamespace, "--wait=false")
		Expect(err).NotTo(HaveOccurred())

		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "nextapp", pfAppB, "-n", pfNamespace, "-o", "name")
			g.Expect(err).To(HaveOccurred(), "the app is still there (Terminating?): %s", out)
			g.Expect(err.Error()).To(ContainSubstring("NotFound"), "unexpected error reading the app: %s", out)
		}, 2*time.Minute, 3*time.Second).Should(Succeed(),
			"an over-budget app wedged in Terminating: the finalizer-removal update was rejected by the budget webhook")

		By("it left the held gauge with it")
		Eventually(func() float64 { return pfMetric(pfHeld) }, 2*time.Minute, 5*time.Second).Should(Equal(1.0))
	})

	It("recovery: restoring the budget applies the held change and clears the hold", func() {
		Expect(utils.ApplyManifest(pfPlatform(
			"  limits:\n    timeoutSeconds: 123\n  rollout:\n    maxAppsPerMinute: 6\n  database:\n    connectionBudget: 100\n"))).
			To(Succeed())

		Eventually(pfCondField(pfAppA, "PlatformDefaultsApplied", "status"), 5*time.Minute, 3*time.Second).
			Should(Equal("True"))
		Eventually(pfCondField(pfAppA, "Ready", "status"), 10*time.Minute, 5*time.Second).Should(Equal("True"))
		pfExpectBody(pfAppA, "Hello rev2!")

		Eventually(func() float64 { return pfMetric(pfHeld) }, 2*time.Minute, 5*time.Second).Should(Equal(0.0))
		Eventually(pfJSONPath([]string{"get", "knextplatform", "default"}, "{.status.rollout.held}")).
			Should(Or(Equal("0"), BeEmpty()))
	})

	It("no silent fallback: the admission webhook never ignored the platform's budget during the run", func() {
		Expect(pfMetric(pfFallbackRead)).To(Equal(0.0),
			"the webhook could not read the KnextPlatform at least once and admitted against the built-in budget")
		Expect(pfMetric(pfFallbackInvalid)).To(Equal(0.0))
	})
})
