//go:build e2e_rollback
// +build e2e_rollback

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

// Package e2e — the ROLLBACK end-to-end suite (build tag `e2e_rollback`).
//
// WHAT THIS PROVES (the ROADMAP Tier-B exit criterion "rollback demoed"):
//
//	`kn-next rollback` (#92, ADR-0014) is unit-tested hermetically
//	(rollback-cr.test.ts asserts the exact merge-patch argv) — until this
//	suite, NOTHING proved the full chain on a real cluster:
//
//	  CLI merge-patch of NextApp spec.traffic (the CLI's ONLY write, ADR-0001)
//	    → operator reconciles ksvc.spec.traffic (buildTrafficTargets)
//	      → Knative routes REAL HTTP to the pinned revision.
//
//	Unlike the cli/bundle suites this needs the ksvc to actually become READY
//	with TWO revisions, so the app image is a real, SERVABLE, public,
//	digest-pinned image: ghcr.io/knative/helloworld-go (multi-arch
//	amd64+arm64). It listens on $PORT (Knative sets PORT=3000 from the
//	operator's containerPort) and answers "Hello ${TARGET}!" on "/" — so
//	spec.env.TARGET (#191) is BOTH the lever that forces a new Revision AND an
//	HTTP-observable marker of WHICH revision served a request. The CR sets
//	healthCheckPath: "/" so the operator's readiness/liveness probes pass.
//
//	The specs then assert, in order:
//	  a. rev1 (TARGET=rev1) becomes Ready and serves "Hello rev1!".
//	  b. a spec.env change to TARGET=rev2 rolls a NEW revision; latest-ready
//	     traffic moves to rev2 ("Hello rev2!").
//	  c. `kn-next rollback <app> --to <rev1>` exits 0; the CR's spec.traffic
//	     carries the pin; the operator reconciles the ksvc split so rev1
//	     serves 100% (status.traffic + status.currentTraffic + REAL HTTP);
//	     rev2 REMAINS Ready/serviceable (#93 skew note — assets untouched).
//	  d. `--canary 25` reconciles the two-target split the operator implements:
//	     75% pinned rev1 + 25% latest-ready (asserted on ksvc status.traffic —
//	     percentage-of-requests sampling would be flaky, the programmed split
//	     is the deterministic truth).
//	  e. bare `kn-next rollback <app>` clears the pin: spec.traffic gone from
//	     the CR, ksvc back to 100% latest-ready (rev2, "Hello rev2!").
//
// TWO PROVISIONING MODES (KNEXT_E2E_KUBE_CONTEXT): same contract as the
// e2e_cli suite — default self-contained kind mode (build operator image,
// kind-load, apply dist/install.yaml image-overridden, tear down after);
// existing-cluster mode pins a rendered kubeconfig, installs NOTHING, and
// confines every write to one fresh namespace it fully deletes. NOTE: unlike
// e2e_cli, this suite's app image is REAL and pullable, so pods DO run in
// existing-cluster mode — still only inside the throwaway namespace.
//
// WHY A SEPARATE BUILD TAG (`e2e_rollback`): same reason as e2e_cli — needs
// cert-manager + Knative Serving + Kourier + Node/pnpm, and its OWN suite
// runner so it never collides with the other suites' BeforeSuite hooks. It
// runs in operator-e2e-nightly.yml as the INDEPENDENT `rollback-e2e` job
// (no continue-on-error: every assertion is state-based; a failure is
// signal, not noise).
package e2e

import (
	"encoding/json"
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
	// rbOperatorImage is the LOCALLY-built operator image for kind mode
	// (never a published image), same pattern as the cli suite.
	rbOperatorImage = "registry.invalid/kn-next-operator:rollback-e2e"

	rbOperatorNamespace = "kn-next-operator-system"
	rbOperatorDeploy    = "kn-next-operator-controller-manager"

	rbAppName = "rollback-e2e-app"

	// rbAppImageDefault is a REAL, SERVABLE, public image — digest-pinned (the
	// operator rejects :latest) and multi-arch (linux/amd64 + linux/arm64, so
	// the same pin works on CI runners and arm64 dev machines). The Knative
	// helloworld-go sample listens on $PORT (=3000 via the operator's
	// containerPort), serves 200 on "/", and echoes "Hello ${TARGET}!" — the
	// per-revision marker these specs route on. Override via
	// ROLLBACK_TEST_IMAGE only with another digest-pinned image that honors
	// PORT and TARGET the same way.
	rbAppImageDefault = "ghcr.io/knative/helloworld-go@sha256:" +
		"c2b7412fbea6f1ef24a0cac60698e88df7ae3c4278e42d0cb34fe7d4b2641bba"
)

// rbAppNamespace is fresh and randomly-suffixed per run (same hygiene contract
// as the cli suite); KNEXT_E2E_NAMESPACE overrides it for reclaiming an
// aborted run's namespace.
var rbAppNamespace = func() string {
	if v := strings.TrimSpace(os.Getenv("KNEXT_E2E_NAMESPACE")); v != "" {
		return v
	}
	return fmt.Sprintf("e2e-rollback-%x", time.Now().UnixNano()&0xffffff)
}()

func rbAppImage() string {
	if v := strings.TrimSpace(os.Getenv("ROLLBACK_TEST_IMAGE")); v != "" {
		return v
	}
	return rbAppImageDefault
}

// rbExistingContext selects existing-cluster mode when non-empty.
func rbExistingContext() string {
	return strings.TrimSpace(os.Getenv("KNEXT_E2E_KUBE_CONTEXT"))
}

// TestRollbackE2E runs the rollback e2e suite. Own runner — every other suite
// runner is excluded by the build tag.
func TestRollbackE2E(t *testing.T) {
	RegisterFailHandler(Fail)
	_, _ = fmt.Fprintf(GinkgoWriter, "Starting kn-next rollback e2e suite (#92 / Tier-B rollback demoed)\n")
	RunSpecs(t, "rollback e2e suite")
}

// rbRunCLI invokes the REAL built CLI with plain node (utils.RunCLI); only a
// spawn failure is an error — exit codes are asserted by the specs.
func rbRunCLI(args ...string) utils.CLIResult {
	res, err := utils.RunCLI(args...)
	Expect(err).NotTo(HaveOccurred(),
		"failed to spawn the CLI at all (is node installed and the CLI built?)")
	return res
}

// rbAssertTimeout / rbAssertPoll bound the Eventually blocks wrapping each CLI
// invocation + its assertions — retried as a whole for the same reason as the
// cli suite (a WAN blip inside one attempt is not a counterexample; a
// deterministic misbehavior keeps failing and surfaces as the real failure).
const (
	rbAssertTimeout = 8 * time.Minute
	rbAssertPoll    = 5 * time.Second
)

// ---------------------------------------------------------------------------
// Typed views of the traffic state the specs assert
// ---------------------------------------------------------------------------

// rbTrafficTarget is one entry of ksvc status.traffic / NextApp
// status.currentTraffic (the shared shape both sides expose).
type rbTrafficTarget struct {
	RevisionName   string `json:"revisionName"`
	Percent        int64  `json:"percent"`
	LatestRevision bool   `json:"latestRevision"`
}

// rbKsvcTraffic reads the ksvc's OBSERVED traffic distribution (status, not
// spec — the routed truth, post-reconcile).
func rbKsvcTraffic(g Gomega) []rbTrafficTarget {
	out, err := utils.Kubectl("get", "ksvc", rbAppName, "-n", rbAppNamespace,
		"-o", "jsonpath={.status.traffic}")
	g.Expect(err).NotTo(HaveOccurred(), out)
	g.Expect(strings.TrimSpace(out)).NotTo(BeEmpty(), "ksvc status.traffic is empty")
	var targets []rbTrafficTarget
	g.Expect(json.Unmarshal([]byte(out), &targets)).To(Succeed(),
		"unparseable ksvc status.traffic: %s", out)
	return targets
}

// rbCRTrafficSpec reads spec.traffic from the LIVE NextApp CR (nil when the
// pin is cleared/absent).
func rbCRTrafficSpec(g Gomega) *struct {
	RevisionName  string `json:"revisionName"`
	CanaryPercent int32  `json:"canaryPercent"`
} {
	out, err := utils.Kubectl("get", "nextapp", rbAppName, "-n", rbAppNamespace, "-o", "json")
	g.Expect(err).NotTo(HaveOccurred(), out)
	var cr struct {
		Spec struct {
			Traffic *struct {
				RevisionName  string `json:"revisionName"`
				CanaryPercent int32  `json:"canaryPercent"`
			} `json:"traffic"`
		} `json:"spec"`
	}
	g.Expect(json.Unmarshal([]byte(out), &cr)).To(Succeed(), "unparseable NextApp JSON:\n%s", out)
	return cr.Spec.Traffic
}

// rbLatestReadyRevision reads ksvc status.latestReadyRevisionName.
func rbLatestReadyRevision(g Gomega) string {
	out, err := utils.Kubectl("get", "ksvc", rbAppName, "-n", rbAppNamespace,
		"-o", "jsonpath={.status.latestReadyRevisionName}")
	g.Expect(err).NotTo(HaveOccurred(), out)
	return strings.TrimSpace(out)
}

// rbExpectBody asserts (with retry) that a REAL HTTP request routed through
// the Knative route/activator returns 200 with the given marker in the body —
// the end-to-end proof of WHICH revision serves. Scale-from-zero activation
// latency is inside the retry budget by design.
func rbExpectBody(marker string) {
	Eventually(func(g Gomega) {
		status, body, err := utils.ActivateAndGet(rbAppNamespace, rbAppName, "/")
		g.Expect(err).NotTo(HaveOccurred(), body)
		g.Expect(status).To(Equal(200), "request did not return 200 (body: %s)", body)
		g.Expect(body).To(ContainSubstring(marker),
			"response body did not carry the expected revision marker")
	}, rbAssertTimeout, rbAssertPoll).Should(Succeed())
}

// rbNextAppManifest renders the NextApp CR under test. TARGET is the
// revision-forcing env lever (#191) AND the HTTP marker.
func rbNextAppManifest(target string) string {
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
    maxScale: 2
`, rbAppName, rbAppNamespace, rbAppImage(), target)
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

var _ = Describe("kn-next rollback against a live cluster (#92)", Ordered, func() {
	SetDefaultEventuallyTimeout(5 * time.Minute)
	SetDefaultEventuallyPollingInterval(2 * time.Second)

	var renderedBundle string
	existing := rbExistingContext()

	// rev1Name / rev2Name are captured by the first spec and used by the rest
	// of the Ordered chain.
	var rev1Name, rev2Name string

	BeforeAll(func() {
		By("building the CLI from source with pnpm (plain-Node dist, no Bun)")
		_, err := utils.RunAtRepoRoot("pnpm", "--filter", "@knext/core...", "build")
		Expect(err).NotTo(HaveOccurred(),
			"failed to build the CLI — run `pnpm install --frozen-lockfile` at the repo root first")
		bin, err := utils.CLIBin()
		Expect(err).NotTo(HaveOccurred())
		Expect(bin).To(BeAnExistingFile(), "CLI build produced no dist/cli/kn-next.js")

		if existing != "" {
			By(fmt.Sprintf("EXISTING-CLUSTER mode: pinning kube context %q (no operator install)", existing))
			Expect(utils.PinKubeContext(existing, GinkgoT().TempDir())).To(Succeed())
		} else {
			By("building the operator image LOCALLY (never a published image)")
			_, err = utils.Run(exec.Command("make", "docker-build",
				fmt.Sprintf("IMG=%s", rbOperatorImage)))
			Expect(err).NotTo(HaveOccurred(), "failed to build the operator image")

			By("loading the locally-built operator image into kind")
			Expect(utils.LoadImageToKindClusterWithName(rbOperatorImage)).
				To(Succeed(), "failed to load operator image into kind")

			By("rendering the install bundle via make build-installer")
			_, err = utils.Run(exec.Command("make", "build-installer"))
			Expect(err).NotTo(HaveOccurred(), "failed to render dist/install.yaml")

			By("overriding the manager image in the rendered bundle to the local image")
			renderedBundle, err = utils.OverrideManagerImage(rbOperatorImage, "install.rollback-e2e.yaml")
			Expect(err).NotTo(HaveOccurred(), "failed to render the image-overridden bundle")

			By("applying the rendered install bundle (kubectl apply --server-side -f)")
			Expect(utils.ApplyOrDeleteBundle("apply", renderedBundle)).
				To(Succeed(), "failed to kubectl apply the install bundle")
		}

		By("waiting for the operator Deployment to be Available")
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "deployment", rbOperatorDeploy,
				"-n", rbOperatorNamespace,
				"-o", "jsonpath={.status.conditions[?(@.type=='Available')].status}")
			g.Expect(err).NotTo(HaveOccurred(), out)
			g.Expect(out).To(Equal("True"), "operator Deployment not Available")
		}).Should(Succeed())

		By(fmt.Sprintf("creating the fresh, dedicated app namespace %q", rbAppNamespace))
		Eventually(func(g Gomega) {
			g.Expect(utils.KubectlCreateIgnoreExists("create", "ns", rbAppNamespace)).To(Succeed())
		}, 2*time.Minute, 10*time.Second).Should(Succeed())

		By("applying the SERVABLE, digest-pinned NextApp (TARGET=rev1)")
		Eventually(func(g Gomega) {
			g.Expect(utils.ApplyManifest(rbNextAppManifest("rev1"))).To(Succeed(),
				"failed to apply NextApp")
		}, 2*time.Minute, 10*time.Second).Should(Succeed())
	})

	AfterAll(func() {
		By(fmt.Sprintf("deleting the dedicated app namespace %q (full cleanup)", rbAppNamespace))
		// Namespace deletion is confirmed (NotFound) BEFORE the bundle delete —
		// tearing the operator/CRD down while a NextApp is still finalizing in a
		// terminating namespace deadlocks the CRD's instance-cleanup finalizer.
		// See utils.NamespaceDeletedConfirmed.
		Eventually(func(g Gomega) {
			g.Expect(utils.NamespaceDeletedConfirmed(rbAppNamespace)).To(Succeed())
		}, 10*time.Minute, 5*time.Second).Should(Succeed(),
			"failed to fully delete the dedicated namespace %s", rbAppNamespace)

		if existing == "" {
			By("deleting the rendered bundle from the cluster")
			_ = utils.ApplyOrDeleteBundle("delete", renderedBundle)
			if renderedBundle != "" {
				_ = os.Remove(renderedBundle)
			}
		}
	})

	It("deploys rev1 Ready, then a spec.env change rolls traffic to a NEW revision rev2", func() {
		By("waiting for the ksvc to become Ready (a REAL, servable image this time)")
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "ksvc", rbAppName, "-n", rbAppNamespace,
				"-o", "jsonpath={.status.conditions[?(@.type=='Ready')].status}")
			g.Expect(err).NotTo(HaveOccurred(), out)
			g.Expect(strings.TrimSpace(out)).To(Equal("True"), "ksvc not Ready")
		}, 10*time.Minute, 5*time.Second).Should(Succeed())

		By("waiting for the operator's honest Ready=True on the NextApp CR")
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "nextapp", rbAppName, "-n", rbAppNamespace,
				"-o", "jsonpath={.status.conditions[?(@.type=='Ready')].status}")
			g.Expect(err).NotTo(HaveOccurred(), out)
			g.Expect(strings.TrimSpace(out)).To(Equal("True"))
		}).Should(Succeed())

		By("capturing revision-1's name from status.latestReadyRevisionName")
		Eventually(func(g Gomega) {
			rev1Name = rbLatestReadyRevision(g)
			g.Expect(rev1Name).NotTo(BeEmpty())
		}).Should(Succeed())
		_, _ = fmt.Fprintf(GinkgoWriter, "revision 1: %s\n", rev1Name)

		By("proving rev1 serves REAL HTTP: body carries 'Hello rev1!'")
		rbExpectBody("Hello rev1!")

		By("forcing a SECOND revision via a spec.env change (TARGET=rev2, #191)")
		// The harness updates only the NextApp CR (ADR-0001 — this stands in
		// for the redeploy a user would do); the operator rolls the ksvc.
		Eventually(func(g Gomega) {
			g.Expect(utils.ApplyManifest(rbNextAppManifest("rev2"))).To(Succeed())
		}, 2*time.Minute, 10*time.Second).Should(Succeed())

		By("waiting for revision-2 to become the latest-ready revision")
		Eventually(func(g Gomega) {
			rev2Name = rbLatestReadyRevision(g)
			g.Expect(rev2Name).NotTo(BeEmpty())
			g.Expect(rev2Name).NotTo(Equal(rev1Name), "no new revision was rolled")
		}, 10*time.Minute, 5*time.Second).Should(Succeed())
		_, _ = fmt.Fprintf(GinkgoWriter, "revision 2: %s\n", rev2Name)

		By("asserting 100% of traffic follows latest-ready (rev2) — no pin yet")
		Eventually(func(g Gomega) {
			targets := rbKsvcTraffic(g)
			g.Expect(targets).To(HaveLen(1), "expected a single traffic target, got %+v", targets)
			g.Expect(targets[0].Percent).To(Equal(int64(100)))
			g.Expect(targets[0].RevisionName).To(Equal(rev2Name))
		}).Should(Succeed())

		By("proving rev2 serves REAL HTTP: body carries 'Hello rev2!'")
		rbExpectBody("Hello rev2!")
	})

	It("kn-next rollback --to <rev1>: ONE CR merge-patch pins traffic and the operator reconciles it", func() {
		By("running the REAL CLI: kn-next rollback <app> --to <rev1>")
		Eventually(func(g Gomega) {
			res := rbRunCLI("rollback", rbAppName, "--to", rev1Name, "-n", rbAppNamespace)
			g.Expect(res.ExitCode).To(Equal(0),
				"rollback must exit 0\nstdout:\n%s\nstderr:\n%s", res.Stdout, res.Stderr)
		}, rbAssertTimeout, rbAssertPoll).Should(Succeed())

		By("asserting the LIVE CR carries the pin (spec.traffic.revisionName == rev1)")
		// This is the merge-patch's whole write surface (ADR-0001): the CLI
		// touched ONLY the CR — the ksvc change below is the OPERATOR's doing.
		Eventually(func(g Gomega) {
			traffic := rbCRTrafficSpec(g)
			g.Expect(traffic).NotTo(BeNil(), "spec.traffic missing — the merge-patch did not land")
			g.Expect(traffic.RevisionName).To(Equal(rev1Name))
			g.Expect(traffic.CanaryPercent).To(BeZero(), "no canary was requested")
		}, rbAssertTimeout, rbAssertPoll).Should(Succeed())

		By("waiting for the operator to reconcile the ksvc: 100% to rev1, latestRevision=false")
		Eventually(func(g Gomega) {
			targets := rbKsvcTraffic(g)
			g.Expect(targets).To(HaveLen(1), "expected a single pinned target, got %+v", targets)
			g.Expect(targets[0].RevisionName).To(Equal(rev1Name))
			g.Expect(targets[0].Percent).To(Equal(int64(100)))
			g.Expect(targets[0].LatestRevision).To(BeFalse(), "pinned target must not track latest")
		}).Should(Succeed())

		By("asserting NextApp status.currentTraffic mirrors the observed split (#92 status contract)")
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "nextapp", rbAppName, "-n", rbAppNamespace,
				"-o", "jsonpath={.status.currentTraffic}")
			g.Expect(err).NotTo(HaveOccurred(), out)
			var targets []rbTrafficTarget
			g.Expect(json.Unmarshal([]byte(out), &targets)).To(Succeed(),
				"unparseable status.currentTraffic: %s", out)
			g.Expect(targets).To(HaveLen(1))
			g.Expect(targets[0].RevisionName).To(Equal(rev1Name))
			g.Expect(targets[0].Percent).To(Equal(int64(100)))
		}).Should(Succeed())

		By("proving the ROLLED-BACK revision serves REAL HTTP: body carries 'Hello rev1!'")
		rbExpectBody("Hello rev1!")

		By("asserting rev2 REMAINS Ready/serviceable (#93 skew note: rollback touches no assets)")
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "revision", rev2Name, "-n", rbAppNamespace,
				"-o", "jsonpath={.status.conditions[?(@.type=='Ready')].status}")
			g.Expect(err).NotTo(HaveOccurred(), out)
			g.Expect(strings.TrimSpace(out)).To(Equal("True"),
				"rev2 must remain Ready so already-loaded clients keep working")
		}).Should(Succeed())
	})

	It("kn-next rollback --to <rev1> --canary 25: the operator reconciles the 75/25 split", func() {
		// The operator DOES implement canary reconcile (buildTrafficTargets:
		// (100-p)%% pinned + p%% latest-ready), so this asserts the reconciled
		// ksvc truth, not just the CR. Percent-of-requests sampling over HTTP
		// would be statistically flaky — the PROGRAMMED split in ksvc
		// status.traffic is the deterministic post-reconcile truth.
		By("running the REAL CLI: kn-next rollback <app> --to <rev1> --canary 25")
		Eventually(func(g Gomega) {
			res := rbRunCLI("rollback", rbAppName, "--to", rev1Name, "--canary", "25", "-n", rbAppNamespace)
			g.Expect(res.ExitCode).To(Equal(0),
				"rollback --canary must exit 0\nstdout:\n%s\nstderr:\n%s", res.Stdout, res.Stderr)
		}, rbAssertTimeout, rbAssertPoll).Should(Succeed())

		By("asserting the LIVE CR carries revisionName=rev1 + canaryPercent=25")
		Eventually(func(g Gomega) {
			traffic := rbCRTrafficSpec(g)
			g.Expect(traffic).NotTo(BeNil())
			g.Expect(traffic.RevisionName).To(Equal(rev1Name))
			g.Expect(traffic.CanaryPercent).To(Equal(int32(25)))
		}, rbAssertTimeout, rbAssertPoll).Should(Succeed())

		By("waiting for the operator to reconcile the two-target split: rev1=75, latest-ready=25")
		Eventually(func(g Gomega) {
			targets := rbKsvcTraffic(g)
			g.Expect(targets).To(HaveLen(2), "expected a two-target canary split, got %+v", targets)
			byRev := map[string]rbTrafficTarget{}
			total := int64(0)
			for _, t := range targets {
				byRev[t.RevisionName] = t
				total += t.Percent
			}
			g.Expect(total).To(Equal(int64(100)), "split must always sum to 100")
			pinned, ok := byRev[rev1Name]
			g.Expect(ok).To(BeTrue(), "pinned rev1 missing from the split: %+v", targets)
			g.Expect(pinned.Percent).To(Equal(int64(75)))
			g.Expect(pinned.LatestRevision).To(BeFalse())
			latest, ok := byRev[rev2Name]
			g.Expect(ok).To(BeTrue(), "latest-ready (rev2) missing from the split: %+v", targets)
			g.Expect(latest.Percent).To(Equal(int64(25)))
			g.Expect(latest.LatestRevision).To(BeTrue(), "the canary leg must track latest-ready")
		}).Should(Succeed())
	})

	It("bare kn-next rollback clears the pin: ksvc returns to 100% latest-ready (rev2)", func() {
		By("running the REAL CLI: kn-next rollback <app> (no --to)")
		Eventually(func(g Gomega) {
			res := rbRunCLI("rollback", rbAppName, "-n", rbAppNamespace)
			g.Expect(res.ExitCode).To(Equal(0),
				"bare rollback must exit 0\nstdout:\n%s\nstderr:\n%s", res.Stdout, res.Stderr)
		}, rbAssertTimeout, rbAssertPoll).Should(Succeed())

		By("asserting the pin is GONE from the live CR (spec.traffic cleared)")
		Eventually(func(g Gomega) {
			g.Expect(rbCRTrafficSpec(g)).To(BeNil(),
				"spec.traffic must be cleared by the null merge-patch")
		}, rbAssertTimeout, rbAssertPoll).Should(Succeed())

		By("waiting for the operator to revert the ksvc to 100% latest-ready (rev2)")
		Eventually(func(g Gomega) {
			targets := rbKsvcTraffic(g)
			g.Expect(targets).To(HaveLen(1), "expected a single latest-ready target, got %+v", targets)
			g.Expect(targets[0].RevisionName).To(Equal(rev2Name))
			g.Expect(targets[0].Percent).To(Equal(int64(100)))
		}).Should(Succeed())

		By("proving latest-ready serves REAL HTTP again: body carries 'Hello rev2!'")
		rbExpectBody("Hello rev2!")
	})
})
