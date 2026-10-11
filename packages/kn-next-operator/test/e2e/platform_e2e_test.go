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
//	Knative, no admission webhook, no real revision and no second operator
//	replica, so it cannot show what a user relies on: that a bad platform edit
//	leaves the OLD revision SERVING, and that a paced rollout survives a leader
//	change. This suite runs the real operator bundle (2 replicas, leader
//	election) on kind with real Knative, five apps, and asserts in order:
//
//	  1. BASELINE — with no KnextPlatform, five apps are Ready and serve rev1.
//	  2. ZERO DIFF — creating an EMPTY platform renders the Knative Service
//	     byte-identically: same template, same generation, no new revision.
//	  3. PACED ROLLOUT — a platform timeout is inherited by all five apps at
//	     maxAppsPerMinute=2: the new revisions are spaced ~30s apart, every app
//	     has exactly ONE new revision (nothing renders twice), and the limiter
//	     metrics show the backlog and the waits.
//	  4. LEADER FAILOVER MID-ROLLOUT — the lease holder is killed while apps are
//	     still queued; the standby takes over, the rollout completes, and still no
//	     app renders twice (the limiter's in-memory state is lost by design).
//	  5. HELD — lowering connectionBudget below the apps' footprint HOLDS them:
//	     PlatformDefaultsApplied=False/EffectiveSpecInvalid, the Knative Service is
//	     untouched, the old revision keeps serving, and the held-apps metric and
//	     holds counter move. A developer change made WHILE held reads Ready=False
//	     (a false Ready=True would call a dropped deploy a success) and the old
//	     image still serves.
//	  6. DELETE WHILE OVER BUDGET — an over-budget app is deleted and leaves; it
//	     must not wedge in Terminating (the finalizer-removal patch is an UPDATE
//	     through the budget webhook).
//	  7. RECOVERY — restoring the budget applies the held change (one new revision
//	     for the app that changed, none for the others) and the held gauge returns
//	     to 0.
//	  8. NO SILENT FALLBACK — through all of the above the admission webhook never
//	     fell back to the built-in budget (the fallback counter reads 0).
//
// METRICS ARE READ FROM EVERY OPERATOR POD AND SUMMED. Only the lease holder
// reconciles, so the held-apps and limiter series live on the leader, while the
// admission webhook (and so the fallback counter) runs on both replicas. A scrape
// through the Service would land on either one.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
//	It is kind-ONLY: the KnextPlatform is a cluster-wide singleton, so running it
//	against a shared cluster would change every app on that cluster.
package e2e

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
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
	pfOperatorLabel     = "control-plane=controller-manager"
	pfLeaseName         = "2dd0b3e2.kn-next.dev"
	pfMetricsBinding    = "kn-next-platform-e2e-metrics"

	// pfAppImage is a REAL, SERVABLE, public, digest-pinned multi-arch image that
	// answers "Hello ${TARGET}!" — the same pin the rollback suite uses.
	pfAppImage = "ghcr.io/knative/helloworld-go@sha256:" +
		"c2b7412fbea6f1ef24a0cac60698e88df7ae3c4278e42d0cb34fe7d4b2641bba"

	// 8 x 10 = 80: exactly the built-in connection budget, so valid on its own
	// and over budget only once the platform lowers it.
	pfMaxScale = 8
	pfPoolMax  = 10

	// maxAppsPerMinute=2 spaces slots 30s apart; five apps therefore take ~2 min
	// to roll, a window wide enough to observe a backlog and to kill the leader in.
	pfPerMinute   = 2
	pfSlotSeconds = 60 / pfPerMinute

	pfHeld    = `knext_platform_apps_held{reason="EffectiveSpecInvalid"}`
	pfHolds   = `knext_platform_holds_total{reason="EffectiveSpecInvalid"}`
	pfWaitCnt = `knext_platform_rollout_wait_seconds_count`
	pfPending = `knext_platform_rollout_pending`

	pfFallbackRead    = `knext_platform_budget_fallback_total{cause="read_error"}`
	pfFallbackInvalid = `knext_platform_budget_fallback_total{cause="platform_invalid"}`
)

// pfApps are the five apps under one platform. pfApps[0] is the one a developer
// changes while held; the last is the one deleted while over budget.
var pfApps = []string{"platform-e2e-1", "platform-e2e-2", "platform-e2e-3", "platform-e2e-4", "platform-e2e-5"}

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

// pfPlatform renders the singleton KnextPlatform. timeout and budget of 0 mean
// "leave unset"; perMinute of 0 leaves the rollout block out. An all-zero call is
// the EMPTY platform (`spec: {}`).
func pfPlatform(timeout, perMinute, budget int) string {
	var b strings.Builder
	if timeout > 0 {
		fmt.Fprintf(&b, "  limits:\n    timeoutSeconds: %d\n", timeout)
	}
	if perMinute > 0 {
		fmt.Fprintf(&b, "  rollout:\n    maxAppsPerMinute: %d\n", perMinute)
	}
	if budget > 0 {
		fmt.Fprintf(&b, "  database:\n    connectionBudget: %d\n", budget)
	}
	spec := "spec: {}\n"
	if b.Len() > 0 {
		spec = "spec:\n" + b.String()
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

// pfRevisions lists the app's Knative revisions.
func pfRevisions(g Gomega, app string) []string {
	out, err := utils.Kubectl("get", "revisions.serving.knative.dev", "-n", pfNamespace,
		"-l", "serving.knative.dev/service="+app, "-o", "jsonpath={.items[*].metadata.name}")
	g.Expect(err).NotTo(HaveOccurred(), out)
	return strings.Fields(out)
}

// pfExpectRevisionCount asserts every named app has EXACTLY n revisions: the
// strongest available statement that nothing rendered twice.
func pfExpectRevisionCount(n int, apps ...string) {
	GinkgoHelper()
	Eventually(func(g Gomega) {
		for _, app := range apps {
			g.Expect(pfRevisions(g, app)).To(HaveLen(n), "%s: revisions %v", app, pfRevisions(g, app))
		}
	}, 3*time.Minute, 5*time.Second).Should(Succeed())
}

// pfLatestRevisionCreated is when the app's newest revision was created.
func pfLatestRevisionCreated(g Gomega, app string) time.Time {
	rev := pfKsvc(app, "{.status.latestCreatedRevisionName}")(g)
	g.Expect(rev).NotTo(BeEmpty())
	ts := pfJSONPath([]string{"get", "revisions.serving.knative.dev", rev, "-n", pfNamespace},
		"{.metadata.creationTimestamp}")(g)
	t, err := time.Parse(time.RFC3339, ts)
	g.Expect(err).NotTo(HaveOccurred())
	return t
}

// pfInheritedTimeout counts the apps whose Knative Service already carries the
// platform timeout.
func pfInheritedTimeout(timeout string) int {
	n := 0
	for _, app := range pfApps {
		out, err := utils.Kubectl("get", "ksvc", app, "-n", pfNamespace,
			"-o", "jsonpath={.spec.template.spec.timeoutSeconds}")
		if err == nil && strings.TrimSpace(out) == timeout {
			n++
		}
	}
	return n
}

// pfOperatorPodIPs returns the IP of every Running operator pod.
func pfOperatorPodIPs(g Gomega) []string {
	out, err := utils.Kubectl("get", "pods", "-n", pfOperatorNamespace, "-l", pfOperatorLabel,
		"--field-selector=status.phase=Running", "-o", `jsonpath={range .items[*]}{.status.podIP}{"\n"}{end}`)
	g.Expect(err).NotTo(HaveOccurred(), out)
	var ips []string
	for _, ip := range strings.Fields(out) {
		ips = append(ips, ip)
	}
	g.Expect(ips).NotTo(BeEmpty(), "no Running operator pod")
	return ips
}

var pfScrapes int

// pfMetric scrapes the operator's protected /metrics endpoint on EVERY operator
// pod and sums the series (see the file header for why). A series that is absent
// from a pod fails the spec: absent is not zero.
func pfMetric(series string) float64 {
	GinkgoHelper()
	token, err := utils.Kubectl("create", "token", pfOperatorSA, "-n", pfOperatorNamespace, "--duration=30m")
	Expect(err).NotTo(HaveOccurred(), "could not mint a metrics token")
	token = strings.TrimSpace(token)

	var total float64
	Eventually(func(g Gomega) {
		total = 0
		for _, ip := range pfOperatorPodIPs(g) {
			pfScrapes++
			out, err := utils.ScrapeWithBearer(pfNamespace, fmt.Sprintf("platform-e2e-scrape-%d", pfScrapes),
				fmt.Sprintf("https://%s:8443/metrics", ip), token)
			g.Expect(err).NotTo(HaveOccurred(), out)
			v, ok := utils.MetricValue(out, series)
			g.Expect(ok).To(BeTrue(), "series %s is not exported by operator pod %s", series, ip)
			total += v
		}
	}, 2*time.Minute, 5*time.Second).Should(Succeed())
	return total
}

var _ = Describe("platform layer against a live cluster (ADR-0064)", Ordered, func() {
	SetDefaultEventuallyTimeout(5 * time.Minute)
	SetDefaultEventuallyPollingInterval(2 * time.Second)

	var renderedBundle string
	app1 := pfApps[0]
	last := pfApps[len(pfApps)-1]

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

	// A failed spec dumps what the operator was doing WHILE the cluster is still
	// up. The workflow's own log step runs after the suite has torn everything
	// down, so by then there is nothing left to read.
	JustAfterEach(func() {
		if !CurrentSpecReport().Failed() {
			return
		}
		logs, _ := utils.Kubectl("logs", "-n", pfOperatorNamespace, "-l", "control-plane=controller-manager",
			"--tail=400", "--prefix", "--all-containers")
		_, _ = fmt.Fprintf(GinkgoWriter, "\n--- operator logs (both replicas) at failure ---\n%s\n", logs)
		apps, _ := utils.Kubectl("get", "nextapp", "-n", pfNamespace, "-o",
			"custom-columns=NAME:.metadata.name,SPEC:.status.platform.specHash,REASON:.status.conditions[?(@.type=='PlatformDefaultsApplied')].reason")
		_, _ = fmt.Fprintf(GinkgoWriter, "\n--- apps at failure ---\n%s\n", apps)
		lease, _ := utils.Kubectl("get", "lease", pfLeaseName, "-n", pfOperatorNamespace, "-o",
			"jsonpath={.spec.holderIdentity}")
		_, _ = fmt.Fprintf(GinkgoWriter, "\n--- lease holder at failure ---\n%s\n", lease)
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

	It("baseline: with NO platform five apps are Ready, report NoPlatform and serve rev1", func() {
		for _, app := range pfApps {
			Eventually(func(g Gomega) {
				g.Expect(utils.ApplyManifest(pfNextApp(app, "rev1"))).To(Succeed())
			}, 2*time.Minute, 10*time.Second).Should(Succeed())
		}
		for _, app := range pfApps {
			pfWaitReady(app)
		}
		Eventually(pfCondField(app1, "PlatformDefaultsApplied", "reason")).Should(Equal("NoPlatform"))
		pfExpectBody(app1, "Hello rev1!")
		pfExpectRevisionCount(1, pfApps...)

		baselineTemplate = pfTemplate(app1)
		baselineGeneration = pfKsvc(app1, "{.metadata.generation}")(Default)
		baselineRevision = pfKsvc(app1, "{.status.latestReadyRevisionName}")(Default)
		Expect(baselineRevision).NotTo(BeEmpty())

		By("the platform series are exported at 0 before anything is held or queued")
		Expect(pfMetric(pfHeld)).To(Equal(0.0))
		Expect(pfMetric(pfPending)).To(Equal(0.0))
	})

	It("zero diff: an EMPTY platform renders the Knative Service byte-identically", func() {
		Expect(utils.ApplyManifest(pfPlatform(0, 0, 0))).To(Succeed())

		By("the operator accepts the platform and every app is re-evaluated against it")
		Eventually(pfJSONPath([]string{"get", "knextplatform", "default"},
			"{.status.conditions[?(@.type=='Accepted')].status}")).Should(Equal("True"))
		for _, app := range pfApps {
			Eventually(pfJSONPath([]string{"get", "nextapp", app, "-n", pfNamespace}, "{.status.platform.specHash}")).
				ShouldNot(BeEmpty(), "%s was never reconciled against the platform", app)
		}
		Eventually(pfCondField(app1, "PlatformDefaultsApplied", "reason")).ShouldNot(Equal("NoPlatform"))

		By("…and the Service is exactly what it was without a platform")
		Consistently(func(g Gomega) {
			g.Expect(pfKsvc(app1, "{.spec.template}")(g)).To(Equal(baselineTemplate),
				"an empty platform changed the rendered revision template")
			g.Expect(pfKsvc(app1, "{.metadata.generation}")(g)).To(Equal(baselineGeneration),
				"an empty platform bumped the Service generation")
			g.Expect(pfKsvc(app1, "{.status.latestCreatedRevisionName}")(g)).To(Equal(baselineRevision),
				"an empty platform rolled a new revision")
		}, 15*time.Second, 3*time.Second).Should(Succeed())
		pfExpectRevisionCount(1, pfApps...)
		pfExpectBody(app1, "Hello rev1!")
	})

	It("paced rollout: five apps inherit a platform value at 2/minute, spaced, each rendering exactly once", func() {
		waitsBefore := pfMetric(pfWaitCnt)

		Expect(utils.ApplyManifest(pfPlatform(123, pfPerMinute, 0))).To(Succeed())

		By("the limiter has a backlog while the rollout is in progress")
		Eventually(func() float64 { return pfMetric(pfPending) }, 3*time.Minute, 2*time.Second).
			Should(BeNumerically(">=", 1), "the limiter never reported a queued re-render")

		By("every app inherits the platform timeout, rolls a revision, and serves")
		for _, app := range pfApps {
			Eventually(pfKsvc(app, "{.spec.template.spec.timeoutSeconds}"), 10*time.Minute, 3*time.Second).
				Should(Equal("123"), "%s never inherited the platform timeout", app)
		}
		Eventually(pfJSONPath([]string{"get", "nextapp", app1, "-n", pfNamespace},
			"{.status.platform.inheritedFields}")).Should(ContainSubstring("spec.timeoutSeconds"))
		for _, app := range pfApps {
			pfWaitReady(app)
		}
		pfExpectBody(app1, "Hello rev1!")

		By("the new revisions were spaced by the slot interval, not created together")
		var created []time.Time
		Eventually(func(g Gomega) {
			created = created[:0]
			for _, app := range pfApps {
				created = append(created, pfLatestRevisionCreated(g, app))
			}
		}).Should(Succeed())
		sort.Slice(created, func(i, j int) bool { return created[i].Before(created[j]) })
		for i := 1; i < len(created); i++ {
			Expect(created[i].Sub(created[i-1])).To(BeNumerically(">=", (pfSlotSeconds-5)*time.Second),
				"revisions %d and %d were created %v apart; maxAppsPerMinute=%d means >= %ds",
				i-1, i, created[i].Sub(created[i-1]), pfPerMinute, pfSlotSeconds)
		}

		By("nothing rendered twice: baseline revision + exactly one new one, per app")
		pfExpectRevisionCount(2, pfApps...)

		By("the limiter observed the queued re-renders and drained")
		Expect(pfMetric(pfWaitCnt)-waitsBefore).To(BeNumerically(">=", float64(len(pfApps)-1)),
			"five apps at 2/minute: at least four had to wait for a slot")
		Eventually(func() float64 { return pfMetric(pfPending) }, 3*time.Minute, 5*time.Second).Should(Equal(0.0))

		baselineTemplate = pfTemplate(app1)
		baselineRevision = pfKsvc(app1, "{.status.latestReadyRevisionName}")(Default)
	})

	It("leader failover mid-rollout: the standby takes over and the rollout completes without re-rendering", func() {
		Expect(utils.ApplyManifest(pfPlatform(150, pfPerMinute, 0))).To(Succeed())

		By("waiting until the rollout has started but is not finished")
		Eventually(func() int { return pfInheritedTimeout("150") }, 3*time.Minute, time.Second).
			Should(BeNumerically(">=", 1))
		Expect(pfInheritedTimeout("150")).To(BeNumerically("<", len(pfApps)),
			"the rollout finished before the leader could be killed: nothing was queued, so this proves nothing")

		By("killing the lease holder")
		holder, err := utils.Kubectl("get", "lease", pfLeaseName, "-n", pfOperatorNamespace,
			"-o", "jsonpath={.spec.holderIdentity}")
		Expect(err).NotTo(HaveOccurred(), holder)
		leaderPod := strings.SplitN(strings.TrimSpace(holder), "_", 2)[0]
		Expect(leaderPod).To(HavePrefix(pfOperatorDeploy), "unexpected lease holder %q", holder)
		out, err := utils.Kubectl("delete", "pod", leaderPod, "-n", pfOperatorNamespace, "--wait=false")
		Expect(err).NotTo(HaveOccurred(), out)

		By("the operator recovers its replicas and the webhook serves again")
		Eventually(pfJSONPath([]string{"get", "deployment", pfOperatorDeploy, "-n", pfOperatorNamespace},
			"{.status.readyReplicas}"), 5*time.Minute, 3*time.Second).Should(Equal("2"))
		Expect(utils.WaitForWebhookReady(pfNamespace)).To(Succeed())

		By("the rollout completes under the new leader")
		for _, app := range pfApps {
			Eventually(pfKsvc(app, "{.spec.template.spec.timeoutSeconds}"), 10*time.Minute, 3*time.Second).
				Should(Equal("150"), "%s was left behind by the failover", app)
		}
		for _, app := range pfApps {
			pfWaitReady(app)
		}

		By("…and no app rendered twice despite the lost limiter state: baseline + 123 + 150")
		pfExpectRevisionCount(3, pfApps...)
		Eventually(func() float64 { return pfMetric(pfPending) }, 3*time.Minute, 5*time.Second).Should(Equal(0.0))

		baselineTemplate = pfTemplate(app1)
		baselineRevision = pfKsvc(app1, "{.status.latestReadyRevisionName}")(Default)
	})

	It("held: lowering connectionBudget below the footprint holds the apps and the old revision keeps serving", func() {
		holdsBefore := pfMetric(pfHolds)

		Expect(utils.ApplyManifest(pfPlatform(150, pfPerMinute, 40))).To(Succeed())

		By("every app is held: PlatformDefaultsApplied=False/EffectiveSpecInvalid")
		for _, app := range pfApps {
			Eventually(pfCondField(app, "PlatformDefaultsApplied", "status")).Should(Equal("False"), app)
			Eventually(pfCondField(app, "PlatformDefaultsApplied", "reason")).Should(Equal("EffectiveSpecInvalid"), app)
		}

		By("the Knative Service is untouched: same template, same latest-ready revision, still serving")
		Consistently(func(g Gomega) {
			g.Expect(pfKsvc(app1, "{.spec.template}")(g)).To(Equal(baselineTemplate),
				"a held app's Knative Service must be left exactly as it was")
			g.Expect(pfKsvc(app1, "{.status.latestReadyRevisionName}")(g)).To(Equal(baselineRevision))
		}, 15*time.Second, 3*time.Second).Should(Succeed())
		pfExpectBody(app1, "Hello rev1!")

		By("the held metric moved: every app held now, every hold counted")
		Eventually(func() float64 { return pfMetric(pfHeld) }, 2*time.Minute, 5*time.Second).
			Should(Equal(float64(len(pfApps))))
		Expect(pfMetric(pfHolds) - holdsBefore).To(BeNumerically(">=", float64(len(pfApps))))

		By("the platform reports the hold")
		Eventually(pfJSONPath([]string{"get", "knextplatform", "default"}, "{.status.rollout.held}")).
			Should(Equal(fmt.Sprint(len(pfApps))))

		By("a developer change made WHILE held is not applied and reads Ready=False, never a false green")
		// Footprint unchanged (still 80), so the ratcheted webhook admits the edit.
		Eventually(func(g Gomega) {
			g.Expect(utils.ApplyManifest(pfNextApp(app1, "rev2"))).To(Succeed())
		}, 2*time.Minute, 10*time.Second).Should(Succeed())
		Eventually(pfCondField(app1, "Ready", "status")).Should(Equal("False"))
		Eventually(pfCondField(app1, "Ready", "reason")).Should(Equal("EffectiveSpecInvalid"))
		Consistently(func(g Gomega) {
			g.Expect(pfKsvc(app1, "{.spec.template}")(g)).To(Equal(baselineTemplate),
				"the held change must not reach the Knative Service")
		}, 10*time.Second, 3*time.Second).Should(Succeed())
		pfExpectBody(app1, "Hello rev1!")
		pfExpectRevisionCount(3, app1)
	})

	It("delete while over budget: the app leaves and does not hang in Terminating", func() {
		out, err := utils.Kubectl("delete", "nextapp", last, "-n", pfNamespace, "--wait=false")
		Expect(err).NotTo(HaveOccurred(), out)

		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "nextapp", last, "-n", pfNamespace, "-o", "name")
			g.Expect(err).To(HaveOccurred(), "the app is still there (Terminating?): %s", out)
			g.Expect(err.Error()).To(ContainSubstring("NotFound"), "unexpected error reading the app: %s", out)
		}, 2*time.Minute, 3*time.Second).Should(Succeed(),
			"an over-budget app wedged in Terminating: the finalizer-removal update was rejected by the budget webhook")

		By("it left the held gauge with it")
		Eventually(func() float64 { return pfMetric(pfHeld) }, 2*time.Minute, 5*time.Second).
			Should(Equal(float64(len(pfApps) - 1)))
	})

	It("recovery: restoring the budget applies the held change and clears every hold", func() {
		Expect(utils.ApplyManifest(pfPlatform(150, pfPerMinute, 100))).To(Succeed())

		Eventually(pfCondField(app1, "PlatformDefaultsApplied", "status"), 5*time.Minute, 3*time.Second).
			Should(Equal("True"))
		Eventually(pfCondField(app1, "Ready", "status"), 10*time.Minute, 5*time.Second).Should(Equal("True"))
		pfExpectBody(app1, "Hello rev2!")

		By("only the app that changed rendered: one new revision for it, none for the others")
		pfExpectRevisionCount(4, app1)
		pfExpectRevisionCount(3, pfApps[1:len(pfApps)-1]...)

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
