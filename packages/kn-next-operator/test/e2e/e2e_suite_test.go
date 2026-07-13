//go:build e2e || e2e_scale
// +build e2e e2e_scale

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

package e2e

import (
	"fmt"
	"os"
	"os/exec"
	"testing"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/test/utils"
)

var (
	// managerImage is the manager image to be built and loaded for testing.
	managerImage = "example.com/kn-next-operator:v0.0.1"
	// shouldCleanupCertManager tracks whether CertManager was installed by this suite.
	shouldCleanupCertManager = false
)

// operatorNamespace is where `make deploy` installs the controller-manager.
// Shared by the e2e_scale specs (#38, #39) so the operator is deployed exactly
// once for the whole suite (see deployOperatorOnce / undeployOperator below).
const operatorNamespace = "kn-next-operator-system"

// TestE2E runs the e2e test suite to validate the solution in an isolated environment.
// The default setup requires Kind and CertManager.
//
// To skip CertManager installation, set: CERT_MANAGER_INSTALL_SKIP=true
func TestE2E(t *testing.T) {
	RegisterFailHandler(Fail)
	_, _ = fmt.Fprintf(GinkgoWriter, "Starting kn-next-operator e2e test suite\n")
	RunSpecs(t, "e2e suite")
}

var _ = BeforeSuite(func() {
	// FIRST statement, before ANY cluster read or mutation (plan-v3 P2 /
	// #271): this suite is CLUSTER-MUTATING and kind-only — it installs and,
	// in AfterSuite, UNINSTALLS cert-manager, and under e2e_scale runs `make
	// install/deploy/undeploy/uninstall`. EnsureKindContext pins a rendered
	// KUBECONFIG for the `kind-$KIND_CLUSTER` context (the same cluster-name
	// variable `kind load` targets) for the whole test process — AfterSuite
	// inherits the pin — and hard-fails otherwise, naming both contexts. A
	// set KNEXT_E2E_KUBE_CONTEXT is validated, never silently ignored: an
	// ambient prod context must never receive this suite's teardown.
	Expect(utils.EnsureKindContext(GinkgoT().TempDir())).To(Succeed(),
		"refusing to run the cluster-mutating e2e suite — no cluster operation was attempted")

	By("building the manager image")
	cmd := exec.Command("make", "docker-build", fmt.Sprintf("IMG=%s", managerImage))
	_, err := utils.Run(cmd)
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to build the manager image")

	// TODO(user): If you want to change the e2e test vendor from Kind,
	// ensure the image is built and available, then remove the following block.
	By("loading the manager image on Kind")
	err = utils.LoadImageToKindClusterWithName(managerImage)
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to load the manager image into Kind")

	setupCertManager()

	// Tag-specific extension of the single suite setup. No-op under the plain
	// `e2e` tag; under `e2e_scale` it deploys the operator ONCE for the whole
	// suite so the #38 and #39 specs share one controller-manager. Ginkgo allows
	// only one BeforeSuite, which is why this is a hook, not a second BeforeSuite.
	extraSuiteSetup()
})

var _ = AfterSuite(func() {
	// Mirror of extraSuiteSetup; runs before CertManager teardown so the operator
	// is removed first. No-op under the plain `e2e` tag.
	extraSuiteTeardown()
	teardownCertManager()
})

// setupCertManager installs CertManager if needed for webhook tests.
// Skips installation if CERT_MANAGER_INSTALL_SKIP=true or if already present.
func setupCertManager() {
	if os.Getenv("CERT_MANAGER_INSTALL_SKIP") == "true" {
		_, _ = fmt.Fprintf(GinkgoWriter, "Skipping CertManager installation (CERT_MANAGER_INSTALL_SKIP=true)\n")
		return
	}

	By("checking if CertManager is already installed")
	if utils.IsCertManagerCRDsInstalled() {
		_, _ = fmt.Fprintf(GinkgoWriter, "CertManager is already installed. Skipping installation.\n")
		return
	}

	// Mark for cleanup before installation to handle interruptions and partial installs.
	shouldCleanupCertManager = true

	By("installing CertManager")
	Expect(utils.InstallCertManager()).To(Succeed(), "Failed to install CertManager")
}

// teardownCertManager uninstalls CertManager if it was installed by setupCertManager.
// This ensures we only remove what we installed.
func teardownCertManager() {
	if !shouldCleanupCertManager {
		_, _ = fmt.Fprintf(GinkgoWriter, "Skipping CertManager cleanup (not installed by this suite)\n")
		return
	}

	By("uninstalling CertManager")
	utils.UninstallCertManager()
}
