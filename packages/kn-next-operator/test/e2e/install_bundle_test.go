//go:build e2e_bundle
// +build e2e_bundle

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

// Package e2e — the INSTALL-BUNDLE end-to-end (issue #117).
//
// WHAT THIS PROVES (distinct from e2e_test.go and the scale specs):
//
//	The existing `e2e` Manager spec deploys the operator via `make deploy`
//	(kustomize build config/default | kubectl apply). That is NOT the artifact a
//	client runs. A client runs `kubectl apply -f dist/install.yaml`. This spec
//	makes the rendered BUNDLE (dist/install.yaml) the thing under test:
//	  1. render dist/install.yaml via `make build-installer`,
//	  2. build the operator image LOCALLY and load it into kind,
//	  3. apply the bundle with the manager image OVERRIDDEN to the local image
//	     (so the all-zeros placeholder digest is NOT required to exist in GHCR),
//	  4. wait for the operator Deployment to be Available,
//	  5. apply a DIGEST-PINNED sample NextApp,
//	  6. assert the operator reconciles it END-TO-END: it creates the child Knative
//	     Service, mirrors ksvc.Status.URL onto status.url, and reports an HONEST
//	     Ready condition that reflects the ksvc's REAL health.
//
// HONEST READY (why step 6 no longer blanket-asserts Ready=True):
//
//	NextApp.status.conditions[Ready] is now gated on the child Knative Service's OWN
//	Ready condition (Configuration + Route + pod readiness), NOT on the operator
//	merely having written the ksvc. The default sample image is an all-zeros
//	placeholder digest that is DELIBERATELY UNPULLABLE in kind, so its ksvc can never
//	honestly reach Ready — the operator correctly reports Ready=False with
//	Reason=KnativeServiceNotReady. The previous "Ready=True without a real app image"
//	expectation was a FALSE-GREEN that depended on the old unconditional Ready=True;
//	asserting it now would just wait out the suite deadline. So with the placeholder
//	image this spec asserts the honest NotReady semantics (ksvc created, status.url
//	mirrored, Ready=False / KnativeServiceNotReady). When CI sets BUNDLE_APP_IMAGE to
//	a REAL, pullable, digest-pinned serving image, the spec instead proves the full
//	happy path: the ksvc actually serves and NextApp reaches Ready=True.
//
// WHY A SEPARATE BUILD TAG (`e2e_bundle`):
//
//	Step 6 needs Knative Serving present, because the reconciler creates a Knative
//	Service and reads ksvc.Status.URL to set the NextApp's status.url + Ready. A
//	cluster with cert-manager + Knative Serving + Kourier is heavier than the light
//	per-PR `e2e` job, so this runs in its own CI workflow (operator-bundle-e2e),
//	not on every PR. It shares the e2e package but declares its OWN suite runner so
//	it never collides with the `e2e || e2e_scale` BeforeSuite in e2e_suite_test.go.
//
// LOCAL-IMAGE INVARIANT (#117 constraint):
//
//	This NEVER depends on the unpublished placeholder-digest operator image. The
//	operator image is built+loaded locally and substituted into the bundle. The
//	first real GHCR publish (which replaces the placeholder) is a maintainer step
//	documented in docs/RUNBOOK-first-publish.md — out of scope for this test.
package e2e

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/test/utils"
)

const (
	// bundleOperatorImage is the LOCALLY-built operator image used for the bundle
	// e2e. It is never pushed; it is loaded straight into kind and substituted into
	// dist/install.yaml in place of the (unpublished) placeholder digest.
	bundleOperatorImage = "example.com/kn-next-operator:bundle-e2e"

	bundleOperatorNamespace = "kn-next-operator-system"
	bundleOperatorDeploy    = "kn-next-operator-controller-manager"

	bundleAppNamespace = "kn-next-bundle-e2e"
	bundleAppName      = "bundle-sample-app"

	// bundleAppImageDefault is a digest-pinned (so it passes admission) but
	// DELIBERATELY UNPULLABLE all-zeros placeholder. Knative assigns ksvc.Status.URL
	// (which the operator mirrors onto status.url) before the app image is pulled, so
	// status.url is still reachable — but the NextApp's Ready condition is now gated
	// on the ksvc's REAL readiness, and this image can never make the ksvc Ready (it
	// ErrImagePulls). So with this default the spec asserts the HONEST NotReady
	// semantics (Ready=False / KnativeServiceNotReady). CI sets BUNDLE_APP_IMAGE to a
	// real, pullable, digest-pinned serving image when it wants to prove the full
	// happy path (ksvc serves → NextApp Ready=True). See bundleWantReady below.
	bundleAppImageDefault = "ghcr.io/getknext-dev/file-manager@sha256:" +
		"0000000000000000000000000000000000000000000000000000000000000000"
)

// TestBundleE2E runs the install-bundle suite. It declares its OWN suite runner
// (the e2e/e2e_scale runner in e2e_suite_test.go is excluded by the build tag), so
// the two never register two BeforeSuites in one binary.
func TestBundleE2E(t *testing.T) {
	RegisterFailHandler(Fail)
	_, _ = fmt.Fprintf(GinkgoWriter, "Starting kn-next-operator INSTALL-BUNDLE e2e suite (#117)\n")
	RunSpecs(t, "install-bundle e2e suite")
}

var _ = Describe("Install bundle (dist/install.yaml)", Ordered, func() {
	SetDefaultEventuallyTimeout(5 * time.Minute)
	SetDefaultEventuallyPollingInterval(2 * time.Second)

	var renderedBundle string

	BeforeAll(func() {
		By("building the operator image LOCALLY (never the placeholder-digest image)")
		_, err := utils.Run(exec.Command("make", "docker-build",
			fmt.Sprintf("IMG=%s", bundleOperatorImage)))
		Expect(err).NotTo(HaveOccurred(), "failed to build the operator image")

		By("loading the locally-built operator image into kind")
		Expect(utils.LoadImageToKindClusterWithName(bundleOperatorImage)).
			To(Succeed(), "failed to load operator image into kind")

		By("rendering the install bundle via make build-installer")
		_, err = utils.Run(exec.Command("make", "build-installer"))
		Expect(err).NotTo(HaveOccurred(), "failed to render dist/install.yaml")

		By("overriding the manager image in the rendered bundle to the local image")
		// The committed bundle pins the operator to the (unpublished) placeholder
		// digest. We rewrite ONLY that manager image line to the local image so the
		// apply works without the placeholder existing in any registry. This keeps
		// dist/install.yaml itself — the client artifact — as the thing applied.
		renderedBundle = overrideManagerImage(bundleOperatorImage)
	})

	AfterAll(func() {
		By("deleting the sample app namespace (ownership-guarded, confirmed)")
		// OWNERSHIP-GUARDED delete (plan P5): utils.NamespaceDeletedConfirmed
		// only deletes a namespace this run's create stamped with the
		// kn-next.dev/e2e-owned=true label (never a pre-existing one), and it
		// must complete BEFORE the bundle delete below — tearing down the
		// operator/CRD while a NextApp is still finalizing in a terminating
		// namespace deadlocks the CRD's instance-cleanup finalizer. The error
		// is asserted AFTER the bundle cleanup so a refusal is loud but never
		// leaves the rendered bundle behind on the kind cluster.
		nsErr := utils.NamespaceDeletedConfirmed(bundleAppNamespace)

		By("deleting the rendered bundle from the cluster")
		_ = applyOrDeleteBundle("delete", renderedBundle)

		if renderedBundle != "" {
			_ = os.Remove(renderedBundle)
		}

		Expect(nsErr).NotTo(HaveOccurred(),
			"namespace teardown failed or was refused by the ownership guard")
	})

	It("applies the bundle, the operator goes Available, and reconciles a NextApp with HONEST Ready", func() {
		By("applying the rendered install bundle (kubectl apply --server-side -f)")
		Expect(applyOrDeleteBundle("apply", renderedBundle)).
			To(Succeed(), "failed to kubectl apply the install bundle")

		By("waiting for the operator Deployment to become Available")
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "deployment", bundleOperatorDeploy,
				"-n", bundleOperatorNamespace,
				"-o", "jsonpath={.status.conditions[?(@.type=='Available')].status}")
			g.Expect(err).NotTo(HaveOccurred(), out)
			g.Expect(out).To(Equal("True"), "operator Deployment not Available")
		}).Should(Succeed())

		By("creating the sample app namespace (ownership label stamped at creation)")
		// utils.CreateOwnedNamespace stamps kn-next.dev/e2e-owned=true IN the
		// create call — the AfterAll teardown guard's authorization (plan P5).
		// "already exists" is tolerated (idempotent re-run on the same kind
		// cluster), but a pre-existing namespace is never adopted/labeled.
		Expect(utils.CreateOwnedNamespace(bundleAppNamespace)).To(Succeed(),
			"failed to create the sample app namespace")

		By("waiting for the validating webhook to actually serve (Available ≠ webhook ready, #233)")
		// Deployment Available does NOT imply the webhook server inside the pod
		// accepts TLS connections (serving-cert mount + bind + caBundle injection
		// lag it). On a slow runner the first apply landed entirely in that gap
		// and failed with `failed calling webhook ... connection refused`. The
		// helper dry-run-applies a valid NextApp until the webhook ANSWERS —
		// a genuine admission rejection also counts as ready and returns
		// immediately, so no admission assertion is weakened.
		Expect(utils.WaitForWebhookReady(bundleAppNamespace)).To(Succeed(),
			"operator validating webhook never became reachable after Deployment Available")

		By("applying a DIGEST-PINNED sample NextApp")
		// Defense in depth (#233): even after WaitForWebhookReady, retry ONLY the
		// webhook-unreachability class (e.g. the webhook pod got rescheduled
		// between the probe and this apply). Any other failure — in particular a
		// GENUINE admission rejection — aborts immediately via StopTrying, so a
		// real CEL/:latest/immutability bug still fails fast, never a timeout.
		Eventually(func(g Gomega) {
			err := applyBundleManifest(sampleNextApp())
			if err != nil && utils.ClassifyWebhookApplyError(err.Error()) != utils.WebhookUnreachable {
				StopTrying("sample NextApp apply failed outside the webhook-unreachability class").
					Wrap(err).Now()
			}
			g.Expect(err).NotTo(HaveOccurred(), "failed to apply sample NextApp")
		}, 2*time.Minute, 5*time.Second).Should(Succeed(), "failed to apply sample NextApp")

		By("waiting for the operator to create the child Knative Service (proves reconcile ran)")
		// The ksvc is named after the NextApp. Its creation is the deterministic,
		// image-independent proof that the bundle's operator reconciled the CR —
		// it is written before any pod/image pull, so it appears whether or not the
		// app image is pullable.
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "ksvc", bundleAppName, "-n", bundleAppNamespace,
				"-o", "jsonpath={.metadata.name}")
			g.Expect(err).NotTo(HaveOccurred(), out)
			g.Expect(strings.TrimSpace(out)).To(Equal(bundleAppName), "child Knative Service not created")
		}).Should(Succeed())

		By("asserting status.url is populated (the reconciler mirrored the ksvc URL)")
		// Knative assigns the route URL before the image is pulled, so status.url is
		// reachable under both the placeholder and the real-image paths.
		Eventually(func(g Gomega) {
			out, err := utils.Kubectl("get", "nextapp", bundleAppName, "-n", bundleAppNamespace,
				"-o", "jsonpath={.status.url}")
			g.Expect(err).NotTo(HaveOccurred(), out)
			g.Expect(strings.TrimSpace(out)).NotTo(BeEmpty(), "NextApp status.url is empty")
		}).Should(Succeed())

		if bundleWantReady() {
			By("waiting for the NextApp to reconcile to Ready=True (real serving image)")
			// BUNDLE_APP_IMAGE is a real, pullable, digest-pinned serving image: the
			// ksvc's pods come up and become Ready, so the HONEST gate lets NextApp
			// reach Ready=True. This is the full end-to-end happy path.
			Eventually(func(g Gomega) {
				out, err := utils.Kubectl("get", "nextapp", bundleAppName, "-n", bundleAppNamespace,
					"-o", "jsonpath={.status.conditions[?(@.type=='Ready')].status}")
				g.Expect(err).NotTo(HaveOccurred(), out)
				g.Expect(out).To(Equal("True"), "NextApp Ready condition not True with a real serving image")
			}).Should(Succeed())
			return
		}

		By("asserting HONEST Ready=False / Reason=KnativeServiceNotReady (placeholder image)")
		// The default image is an UNPULLABLE all-zeros placeholder, so the ksvc can
		// never become Ready. The honest gate (PR: gate NextApp Ready on real
		// Knative Service health) must therefore report Ready=False with
		// Reason=KnativeServiceNotReady — NOT the old false-green Ready=True. This is
		// the per-PR proof that the bundle's operator surfaces real ksvc health.
		Eventually(func(g Gomega) {
			status, err := utils.Kubectl("get", "nextapp", bundleAppName, "-n", bundleAppNamespace,
				"-o", "jsonpath={.status.conditions[?(@.type=='Ready')].status}")
			g.Expect(err).NotTo(HaveOccurred(), status)
			g.Expect(strings.TrimSpace(status)).To(Equal("False"),
				"NextApp Ready should be False for an unpullable placeholder image")

			reason, err := utils.Kubectl("get", "nextapp", bundleAppName, "-n", bundleAppNamespace,
				"-o", "jsonpath={.status.conditions[?(@.type=='Ready')].reason}")
			g.Expect(err).NotTo(HaveOccurred(), reason)
			g.Expect(strings.TrimSpace(reason)).To(Equal("KnativeServiceNotReady"),
				"NextApp Ready reason should be KnativeServiceNotReady")
		}).Should(Succeed())

		By("asserting NextApp must never report a false-green Ready=True for the placeholder image")
		// Guard against regressing to the old unconditional Ready=True: hold for a
		// short window and confirm Ready never flips to True while the image is
		// unpullable.
		Consistently(func(g Gomega) {
			out, err := utils.Kubectl("get", "nextapp", bundleAppName, "-n", bundleAppNamespace,
				"-o", "jsonpath={.status.conditions[?(@.type=='Ready')].status}")
			g.Expect(err).NotTo(HaveOccurred(), out)
			g.Expect(strings.TrimSpace(out)).NotTo(Equal("True"),
				"NextApp falsely reported Ready=True for an unpullable image (false-green regression)")
		}, 20*time.Second, 4*time.Second).Should(Succeed())
	})
})

// bundleWantReady reports whether the spec should assert the full happy path
// (NextApp Ready=True). That requires a REAL, pullable, digest-pinned serving image
// supplied via BUNDLE_APP_IMAGE. With the default unpullable placeholder, the spec
// instead asserts the HONEST NotReady semantics. This keeps the per-PR gate
// deterministic and registry-free while still letting a maintainer/nightly run prove
// real serving by setting BUNDLE_APP_IMAGE.
func bundleWantReady() bool {
	return strings.TrimSpace(os.Getenv("BUNDLE_APP_IMAGE")) != ""
}

// overrideManagerImage renders a copy of dist/install.yaml with the operator
// manager image line rewritten to `img`, and returns the path of the rewritten
// bundle. It rewrites ONLY the ghcr.io/getknext-dev/kn-next-operator image line so
// the rest of the client-facing bundle is exactly what ships.
func overrideManagerImage(img string) string {
	src, err := os.ReadFile(filepath.Join("dist", "install.yaml"))
	Expect(err).NotTo(HaveOccurred(), "failed to read rendered dist/install.yaml")

	var b strings.Builder
	replaced := false
	for _, line := range strings.Split(string(src), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "image:") &&
			strings.Contains(line, "ghcr.io/getknext-dev/kn-next-operator") {
			indent := line[:strings.Index(line, "image:")]
			b.WriteString(indent + "image: " + img + "\n")
			replaced = true
			continue
		}
		b.WriteString(line + "\n")
	}
	Expect(replaced).To(BeTrue(),
		"did not find the operator manager image line in dist/install.yaml")

	dst := filepath.Join("dist", "install.bundle-e2e.yaml")
	Expect(os.WriteFile(dst, []byte(b.String()), 0o644)).To(Succeed())
	return dst
}

// applyOrDeleteBundle runs `kubectl <apply|delete> --server-side -f <bundle>`.
// --server-side mirrors the README's documented client install command and lets
// the bundle's knative-serving ConfigMaps merge instead of clobber.
func applyOrDeleteBundle(verb, bundle string) error {
	if bundle == "" {
		return nil
	}
	args := []string{verb}
	if verb == "apply" {
		args = append(args, "--server-side")
	} else {
		args = append(args, "--ignore-not-found")
	}
	args = append(args, "-f", bundle)
	cmd := exec.Command("kubectl", args...)
	_, err := utils.Run(cmd)
	return err
}

// applyBundleManifest pipes a YAML manifest into `kubectl apply -f -`. (The e2e_scale
// suite has its own applyManifest; this e2e_bundle-tagged copy avoids a cross-tag
// symbol dependency.)
func applyBundleManifest(manifest string) error {
	cmd := exec.Command("kubectl", "apply", "-f", "-")
	cmd.Stdin = strings.NewReader(manifest)
	_, err := utils.Run(cmd)
	return err
}

// sampleNextApp renders a minimal, DIGEST-PINNED NextApp CR. BUNDLE_APP_IMAGE
// overrides the (digest-pinned but lightweight) default with a real app image.
func sampleNextApp() string {
	image := bundleAppImageDefault
	if v := os.Getenv("BUNDLE_APP_IMAGE"); v != "" {
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
`, bundleAppName, bundleAppNamespace, image)
}
