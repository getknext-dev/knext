//go:build e2e_webhook_down
// +build e2e_webhook_down

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

// Package e2e — WEBHOOK-DOWN DEPLOY FREEZE (#314, sprint 2 S11).
//
// WHAT THIS PROVES
//
//	The NextApp validating webhook runs failurePolicy: Fail. That is correct
//	fail-closed behaviour, and its operational consequence has never been
//	demonstrated: while the webhook is unreachable, the apiserver rejects every
//	CREATE and UPDATE it gates, so a webhook outage FREEZES DEPLOYS — including
//	the in-place image bump of an already-running app.
//
//	This suite takes the webhook down for real (operator scaled to zero) and
//	asserts, in order:
//
//	  1. BASELINE — with the webhook up, a valid NextApp applies and persists.
//	  2. THE WEBHOOK IS ACTUALLY DOWN — two independent proofs: the webhook
//	     Service has no ready endpoints, AND a side-effect-free server dry-run
//	     apply fails with the unreachability class. This assertion is not a
//	     nicety; it IS the test. The silently-useless version of this spec is
//	     one that passes because the webhook was never down.
//	  3. DEPLOYS FREEZE — CREATE of a new app fails and persists NOTHING;
//	     UPDATE (image bump) of the running app fails and the stored spec is
//	     unchanged. DELETE still succeeds, which pins the freeze's exact scope:
//	     the webhook gates create/update only.
//	  4. WEBHOOK-DOWN IS DISTINGUISHABLE FROM SKEW — with the cluster in
//	     EXACTLY the same (frozen) state, a skew-shaped payload fails with a
//	     schema-skew diagnosis, not a webhook-down one, because the apiserver
//	     decodes and field-validates before it calls admission webhooks. Same
//	     state, different payload, different diagnosis: that is what makes the
//	     two diagnosable apart from a single failed apply. It matters because a
//	     user who reads a webhook outage as skew downgrades their CLI, which
//	     changes nothing while the operator stays down.
//	  5. MUTATION PROOF, IN BAND — the webhook is restored and the EXACT apply
//	     that just froze is retried and must now SUCCEED. A freeze assertion
//	     that passes both with and without the webhook proves nothing; this step
//	     is what makes step 3 falsifiable on every run rather than once, by hand.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
//	It does not add a namespaceSelector to the webhook to confine the outage to
//	this suite's namespace. That is a production admission-surface change
//	wearing a test-convenience disguise (SPRINT_2 anti-item), and it narrows the
//	blast radius of a security control. The cost of not taking that shortcut is
//	that this suite is CLUSTER-WIDE DESTRUCTIVE while it runs — every NextApp
//	write anywhere on the cluster is frozen — which is exactly why it is kind-only,
//	carries its own build tag, and restores the operator in AfterAll before it
//	deletes anything (a NextApp cannot finalize with the controller scaled to zero).
//	admission_surface_test.go fails in the unit lane if that selector ever appears.
//
// WHY ITS OWN BUILD TAG (e2e_webhook_down)
//
//	Scaling the operator to zero would break any spec running concurrently in the
//	same binary. It needs cert-manager (the webhook's serving certificate) but NOT
//	a Knative Serving INSTALL: every assertion here is at ADMISSION time, before
//	any reconcile. It does need the `knative-serving` NAMESPACE to exist, because
//	`make deploy` renders two Knative ConfigMaps into it — the BeforeAll creates
//	it if absent and never deletes it.
package e2e

import (
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
	freezeOperatorImage     = "example.com/kn-next-operator:webhook-down-e2e"
	freezeOperatorNamespace = "kn-next-operator-system"
	freezeOperatorDeploy    = "kn-next-operator-controller-manager"
	freezeWebhookService    = "kn-next-operator-webhook-service"

	freezeNamespace = "kn-next-webhook-down-e2e"

	// freezeRunningApp is created while the webhook is UP and then upgraded
	// (image bump) while it is down — the upgrade-under-outage leg.
	freezeRunningApp = "freeze-running-app"
	// freezeNewApp is only ever created while the webhook is DOWN: its absence
	// is the proof that a frozen CREATE persists nothing.
	freezeNewApp = "freeze-new-app"
	// freezeDeletableApp pins the freeze's scope — DELETE is not gated.
	freezeDeletableApp = "freeze-deletable-app"

	// Digest-pinned (so it passes admission) and deliberately unpullable. No
	// pod ever has to run: every assertion here is at admission time.
	freezeImageV1 = "ghcr.io/getknext-dev/file-manager@sha256:" +
		"1111111111111111111111111111111111111111111111111111111111111111"
	freezeImageV2 = "ghcr.io/getknext-dev/file-manager@sha256:" +
		"2222222222222222222222222222222222222222222222222222222222222222"
)

// TestWebhookDownE2E declares its own suite runner: the e2e/e2e_scale runner in
// e2e_suite_test.go is excluded by this file's build tag, so the two never
// register two BeforeSuites in one binary.
func TestWebhookDownE2E(t *testing.T) {
	RegisterFailHandler(Fail)
	_, _ = fmt.Fprintf(GinkgoWriter,
		"Starting kn-next-operator WEBHOOK-DOWN DEPLOY-FREEZE e2e suite (#314, S11)\n")
	RunSpecs(t, "webhook-down deploy-freeze e2e suite")
}

var _ = Describe("Webhook-down deploy freeze", Ordered, func() {
	SetDefaultEventuallyTimeout(3 * time.Minute)
	SetDefaultEventuallyPollingInterval(3 * time.Second)

	// frozenCreateErr is captured in step 3 and replayed in step 5. Replaying
	// the SAME manifest is what makes the mutation proof honest — a different
	// payload would prove only that some other apply works.
	var frozenCreateErr error

	BeforeAll(func() {
		By("KIND-only suite: pinning the kind kube context before any cluster operation (#271)")
		Expect(utils.EnsureKindContext(GinkgoT().TempDir())).To(Succeed(),
			"refusing to run a cluster-DESTRUCTIVE suite — no cluster operation was attempted")

		By("building and loading the operator image")
		_, err := utils.Run(exec.Command("make", "docker-build",
			fmt.Sprintf("IMG=%s", freezeOperatorImage)))
		Expect(err).NotTo(HaveOccurred(), "failed to build the operator image")
		Expect(utils.LoadImageToKindClusterWithName(freezeOperatorImage)).To(Succeed(),
			"failed to load the operator image into kind")

		if os.Getenv("CERT_MANAGER_INSTALL_SKIP") != "true" && !utils.IsCertManagerCRDsInstalled() {
			By("installing cert-manager (the webhook's serving certificate)")
			Expect(utils.InstallCertManager()).To(Succeed(), "failed to install cert-manager")
		}

		// MEASURED, not assumed: `make deploy` renders two Knative ConfigMaps
		// (config/default → config-features et al.) into the `knative-serving`
		// namespace, so the apply fails with `namespaces "knative-serving" not
		// found` on a cluster without it. This suite does NOT need Knative
		// Serving to be installed — every assertion here is at admission time —
		// it only needs that namespace to exist for those ConfigMaps to land.
		// Creating it is strictly additive and it is never deleted: tearing down
		// a namespace this suite did not create is exactly what the ownership
		// guard exists to prevent.
		By("ensuring the knative-serving namespace exists (make deploy renders ConfigMaps into it)")
		if _, err := utils.Kubectl("get", "namespace", "knative-serving"); err != nil {
			out, cerr := utils.Kubectl("create", "namespace", "knative-serving")
			Expect(cerr).NotTo(HaveOccurred(), out)
		}

		By("installing the CRDs and deploying the controller-manager")
		_, err = utils.Run(exec.Command("make", "install"))
		Expect(err).NotTo(HaveOccurred(), "failed to install CRDs")
		_, err = utils.Run(exec.Command("make", "deploy",
			fmt.Sprintf("IMG=%s", freezeOperatorImage)))
		Expect(err).NotTo(HaveOccurred(), "failed to deploy the controller-manager")

		By("waiting for the controller-manager rollout")
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("rollout", "status",
				"deployment/"+freezeOperatorDeploy, "-n", freezeOperatorNamespace, "--timeout=15s")
			g.Expect(err).NotTo(HaveOccurred(), out)
		}).Should(Succeed())

		By("creating the app namespace (ownership label stamped at creation)")
		Expect(utils.CreateOwnedNamespace(freezeNamespace)).To(Succeed())

		By("waiting for the validating webhook to actually serve (Available ≠ webhook ready, #233)")
		Expect(utils.WaitForWebhookReady(freezeNamespace)).To(Succeed(),
			"the webhook never became reachable — this suite cannot prove a FREEZE without a working baseline")
	})

	AfterAll(func() {
		// ORDER IS LOAD-BEARING. The operator must be back up before anything
		// is deleted: a NextApp carries a finalizer, so deleting the namespace
		// with the controller scaled to zero deadlocks termination. Restoring
		// it also un-freezes the cluster for whatever runs next.
		By("restoring the operator (un-freezing the cluster) BEFORE any teardown")
		_, _ = utils.Kubectl("scale", "deployment/"+freezeOperatorDeploy,
			"-n", freezeOperatorNamespace, "--replicas=1")
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("rollout", "status",
				"deployment/"+freezeOperatorDeploy, "-n", freezeOperatorNamespace, "--timeout=15s")
			g.Expect(err).NotTo(HaveOccurred(), out)
		}).Should(Succeed())

		nsErr := utils.NamespaceDeletedConfirmed(freezeNamespace)

		By("undeploying the operator and uninstalling the CRDs")
		_, _ = utils.Run(exec.Command("make", "undeploy"))
		_, _ = utils.Run(exec.Command("make", "uninstall"))

		Expect(nsErr).NotTo(HaveOccurred(),
			"namespace teardown failed or was refused by the ownership guard")
	})

	// ---------------------------------------------------------------------
	// 1. BASELINE
	// ---------------------------------------------------------------------

	It("baseline: with the webhook UP, valid NextApps apply and persist", func() {
		for _, name := range []string{freezeRunningApp, freezeDeletableApp} {
			By("applying " + name)
			Expect(freezeApply(freezeNextApp(name, freezeImageV1))).To(Succeed(),
				"a valid NextApp must apply while the webhook is serving — "+
					"without this baseline a later failure proves nothing about the webhook")

			out, err := utils.Kubectl("get", "nextapp", name, "-n", freezeNamespace,
				"-o", "jsonpath={.spec.image}")
			Expect(err).NotTo(HaveOccurred(), out)
			Expect(freezeStripWarnings(out)).To(Equal(freezeImageV1))
		}
	})

	// ---------------------------------------------------------------------
	// 2. THE WEBHOOK IS ACTUALLY DOWN — the assertion that IS the test
	// ---------------------------------------------------------------------

	It("takes the webhook down and PROVES it is down (two independent proofs)", func() {
		By("scaling the controller-manager to zero replicas")
		out, err := utils.Kubectl("scale", "deployment/"+freezeOperatorDeploy,
			"-n", freezeOperatorNamespace, "--replicas=0")
		Expect(err).NotTo(HaveOccurred(), out)

		By("PROOF 1 (cluster state): the webhook Service has no ready endpoints")
		// EndpointSlice, not the v1 Endpoints API: the latter is deprecated from
		// k8s 1.33 and kubectl prints a `Warning:` line that utils.Kubectl folds
		// into its combined output — which made an EMPTY address list read as
		// non-empty and failed this assertion for the wrong reason. Warnings are
		// stripped as well, so a future deprecation cannot resurrect that.
		Eventually(func(g Gomega) {
			addrs, err := utils.Kubectl("get", "endpointslices",
				"-n", freezeOperatorNamespace,
				"-l", "kubernetes.io/service-name="+freezeWebhookService,
				"-o", "jsonpath={.items[*].endpoints[*].addresses[*]}")
			g.Expect(err).NotTo(HaveOccurred(), addrs)
			g.Expect(freezeStripWarnings(addrs)).To(BeEmpty(),
				"the webhook Service still has endpoints — the webhook is NOT down")
		}).Should(Succeed())

		By("PROOF 2 (behaviour): a side-effect-free server dry-run hits the unreachability class")
		// State alone is not enough: what matters is that the APISERVER cannot
		// reach it. --dry-run=server traverses the full admission chain and
		// persists nothing.
		Eventually(func(g Gomega) {
			err := freezeApplyDryRun(freezeNextApp("freeze-probe", freezeImageV1))
			g.Expect(err).To(HaveOccurred(),
				"a dry-run apply SUCCEEDED with the operator scaled to zero — the webhook is not down")
			g.Expect(utils.DiagnoseApplyFailure(err.Error())).To(Equal(utils.FailureWebhookDown),
				"dry-run failed for a reason other than webhook unreachability: %v", err)
		}).Should(Succeed())
	})

	// ---------------------------------------------------------------------
	// 3. DEPLOYS FREEZE
	// ---------------------------------------------------------------------

	It("freezes CREATE — the apply fails and NOTHING is persisted", func() {
		frozenCreateErr = freezeApply(freezeNextApp(freezeNewApp, freezeImageV1))
		Expect(frozenCreateErr).To(HaveOccurred(),
			"a NextApp was CREATED while the validating webhook was unreachable — "+
				"failurePolicy: Fail is not being honoured")
		Expect(utils.DiagnoseApplyFailure(frozenCreateErr.Error())).To(Equal(utils.FailureWebhookDown),
			"the frozen CREATE failed for the wrong reason: %v", frozenCreateErr)

		By("asserting the rejected CREATE persisted nothing")
		out, err := utils.Kubectl("get", "nextapp", freezeNewApp, "-n", freezeNamespace)
		Expect(err).To(HaveOccurred(),
			"the rejected NextApp exists on the cluster: %s", out)
		Expect(out).To(ContainSubstring("NotFound"))
	})

	It("freezes UPDATE — an in-place image bump of a RUNNING app is rejected and the stored spec is unchanged", func() {
		// The upgrade-under-outage leg: the freeze is not confined to new
		// deploys. An operator mid-incident cannot roll an existing app forward
		// (or back) either.
		err := freezeApply(freezeNextApp(freezeRunningApp, freezeImageV2))
		Expect(err).To(HaveOccurred(),
			"an existing NextApp was UPDATED while the webhook was unreachable")
		Expect(utils.DiagnoseApplyFailure(err.Error())).To(Equal(utils.FailureWebhookDown),
			"the frozen UPDATE failed for the wrong reason: %v", err)

		out, kerr := utils.Kubectl("get", "nextapp", freezeRunningApp, "-n", freezeNamespace,
			"-o", "jsonpath={.spec.image}")
		Expect(kerr).NotTo(HaveOccurred(), out)
		Expect(freezeStripWarnings(out)).To(Equal(freezeImageV1),
			"the rejected UPDATE was partially applied — the stored image changed")
	})

	It("does NOT freeze DELETE — the freeze's scope is exactly the create/update the webhook gates", func() {
		// Pins the blast radius honestly. The webhook's rules cover CREATE and
		// UPDATE only, so a delete must still go through even while it is down.
		// Asserting this stops "the outage blocks everything" from becoming
		// folklore, and it is how an operator drains a stuck app mid-incident.
		out, err := utils.Kubectl("delete", "nextapp", freezeDeletableApp,
			"-n", freezeNamespace, "--wait=false")
		Expect(err).NotTo(HaveOccurred(),
			"DELETE was rejected while the webhook was down, which the webhook's rules do not gate: %s", out)
	})

	// ---------------------------------------------------------------------
	// 4. DISTINGUISHABLE FROM SKEW — same frozen cluster, different payload
	// ---------------------------------------------------------------------

	It("diagnoses a SKEW-shaped payload as skew, not as a webhook outage, while the webhook is still down", func() {
		// The apiserver decodes and field-validates BEFORE calling admission
		// webhooks, so a field the CRD does not know is rejected at a stage the
		// outage never reaches. This It is the empirical check of that
		// precedence claim — the ordering DiagnoseApplyFailure encodes. If it
		// ever fails, the premise is wrong and the diagnosis must be revisited
		// rather than the assertion relaxed.
		err := freezeApply(freezeNextAppUnknownField("freeze-skew-shaped"))
		Expect(err).To(HaveOccurred(),
			"an unknown field was accepted under --validate=strict — the skew signal does not exist here")

		diagnosis := utils.DiagnoseApplyFailure(err.Error())
		Expect(diagnosis).To(Equal(utils.FailureSchemaSkew),
			"a skew-shaped payload was diagnosed as %v while the webhook happened to be down. "+
				"These MUST stay distinguishable: a user who reads a webhook outage as skew "+
				"downgrades their CLI, which fixes nothing. Raw error: %v", diagnosis, err)

		By("asserting the two diagnoses carry different remediations")
		Expect(utils.FailureSchemaSkew.Remediation()).
			NotTo(Equal(utils.FailureWebhookDown.Remediation()))

		By("asserting the skew failure never even mentions the webhook")
		Expect(strings.ToLower(err.Error())).NotTo(ContainSubstring("failed calling webhook"),
			"the skew rejection mentions the webhook call — the two stages are not cleanly separated")
	})

	// ---------------------------------------------------------------------
	// 5. MUTATION PROOF, IN BAND
	// ---------------------------------------------------------------------

	It("MUTATION PROOF: restoring the webhook un-freezes the EXACT apply that just failed", func() {
		By("scaling the controller-manager back to one replica")
		out, err := utils.Kubectl("scale", "deployment/"+freezeOperatorDeploy,
			"-n", freezeOperatorNamespace, "--replicas=1")
		Expect(err).NotTo(HaveOccurred(), out)

		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("rollout", "status",
				"deployment/"+freezeOperatorDeploy, "-n", freezeOperatorNamespace, "--timeout=15s")
			g.Expect(err).NotTo(HaveOccurred(), out)
		}).Should(Succeed())

		Expect(utils.WaitForWebhookReady(freezeNamespace)).To(Succeed(),
			"the webhook never came back — the mutation proof cannot be completed")

		By("replaying the IDENTICAL manifest whose CREATE was frozen")
		Expect(frozenCreateErr).To(HaveOccurred(),
			"internal: the frozen-create step did not record a failure to replay against")
		Expect(freezeApply(freezeNextApp(freezeNewApp, freezeImageV1))).To(Succeed(),
			"the apply that failed while the webhook was down ALSO fails with it up — "+
				"the freeze assertion is therefore not measuring the webhook at all")

		By("and the previously-frozen UPDATE now lands too")
		Expect(freezeApply(freezeNextApp(freezeRunningApp, freezeImageV2))).To(Succeed())
		img, kerr := utils.Kubectl("get", "nextapp", freezeRunningApp, "-n", freezeNamespace,
			"-o", "jsonpath={.spec.image}")
		Expect(kerr).NotTo(HaveOccurred(), img)
		Expect(freezeStripWarnings(img)).To(Equal(freezeImageV2))
	})

	It("still diagnoses a SKEW-shaped payload as skew with the webhook UP (payload-driven, not state-driven)", func() {
		// The converse of step 4. Together they show the diagnosis is decided
		// by what was sent, not by whether the operator happens to be running:
		// skew ⇒ skew in both cluster states, and a valid payload succeeds in
		// exactly one of them.
		err := freezeApply(freezeNextAppUnknownField("freeze-skew-shaped-up"))
		Expect(err).To(HaveOccurred())
		Expect(utils.DiagnoseApplyFailure(err.Error())).To(Equal(utils.FailureSchemaSkew),
			"skew must diagnose as skew regardless of webhook state: %v", err)
	})
})

// freezeApply pipes a manifest to `kubectl apply -f -` with STRICT validation,
// mirroring what the CLI issues since #547. Strict validation is not incidental
// here: it is what turns an unknown field into a rejection instead of a silent
// prune, which is what makes the skew leg observable at all.
func freezeApply(manifest string) error {
	return freezeKubectlApply(manifest, "--validate=strict")
}

// freezeApplyDryRun runs a SERVER-side dry run: it traverses the whole admission
// chain (so it hits the webhook) but persists nothing, which is what makes it
// safe to use as the "is it down?" probe.
func freezeApplyDryRun(manifest string) error {
	return freezeKubectlApply(manifest, "--validate=strict", "--dry-run=server")
}

// freezeStripWarnings drops kubectl's `Warning:` lines (API deprecations and
// the like) from combined output and trims the rest. Without it an assertion
// that some jsonpath result is EMPTY can be satisfied by a warning alone, which
// fails the spec for a reason that has nothing to do with the webhook.
func freezeStripWarnings(out string) string {
	var kept []string
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "Warning:") {
			continue
		}
		kept = append(kept, line)
	}
	return strings.TrimSpace(strings.Join(kept, "\n"))
}

func freezeKubectlApply(manifest string, extra ...string) error {
	args := append([]string{"apply"}, extra...)
	args = append(args, "-f", "-")
	cmd := exec.Command("kubectl", args...)
	cmd.Stdin = strings.NewReader(manifest)
	_, err := utils.Run(cmd)
	return err
}

// freezeNextApp renders a minimal VALID, digest-pinned NextApp.
func freezeNextApp(name, image string) string {
	return fmt.Sprintf(`apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: %s
  namespace: %s
spec:
  image: %q
`, name, freezeNamespace, image)
}

// freezeNextAppUnknownField renders the SKEW-SHAPED payload: identical to the
// valid one except for a spec field no CRD version has ever served. That is
// exactly what a CLI newer than the installed operator emits, and under
// --validate=strict the apiserver rejects it at decode time — before admission,
// so the webhook's state is irrelevant to the outcome.
func freezeNextAppUnknownField(name string) string {
	return fmt.Sprintf(`apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: %s
  namespace: %s
spec:
  image: %q
  fieldFromANewerCLIThatThisCRDDoesNotKnow: "skew"
`, name, freezeNamespace, freezeImageV1)
}
