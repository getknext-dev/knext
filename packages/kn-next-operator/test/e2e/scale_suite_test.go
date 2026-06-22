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

// Shared bootstrap for the `e2e_scale` suite, which contains MULTIPLE Ordered
// Describes that each need the operator running:
//
//   - scale_to_zero_cache_test.go     — A2-2 / #38 (bytecode cache survival)
//   - scale_from_zero_test.go         — A2-3 / #39 (scale-to-zero then activate)
//
// Both specs must NOT each `make deploy` the controller-manager — a second
// deploy of the same release into the same namespace races the first spec's
// AfterAll undeploy and flakes the suite. So the operator install/deploy/rollout
// (and the matching undeploy/uninstall) run ONCE for the whole suite, and each
// spec's BeforeAll/AfterAll only applies and deletes its OWN namespace +
// NextApp CR.
//
// Ginkgo allows exactly ONE BeforeSuite and ONE AfterSuite per suite, and the
// shared e2e_suite_test.go (tag `e2e || e2e_scale`) already owns them. So this
// file does NOT declare its own suite-setup nodes — a second BeforeSuite would
// make Ginkgo fail the whole suite before any spec runs. Instead it exposes the
// deploy/undeploy helpers, which the `e2e_scale`-only build-tagged hook in
// suite_hooks.go calls from that single BeforeSuite/AfterSuite. Under the plain
// `e2e` tag the hook is a no-op (e2e_test.go's Manager spec owns its own
// deploy), so this never interferes with that path.
package e2e

import (
	"fmt"
	"os/exec"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/test/utils"
)

// deployOperatorOnce installs the CRDs and deploys the controller-manager, then
// waits for the rollout. Called exactly once for the whole e2e_scale suite.
func deployOperatorOnce() {
	By("installing the operator CRDs")
	_, err := utils.Run(exec.Command("make", "install"))
	Expect(err).NotTo(HaveOccurred(), "failed to install CRDs")

	By("deploying the controller-manager")
	_, err = utils.Run(exec.Command("make", "deploy", fmt.Sprintf("IMG=%s", managerImage)))
	Expect(err).NotTo(HaveOccurred(), "failed to deploy the controller-manager")

	By("waiting for the controller-manager rollout to complete")
	Eventually(func(g Gomega) {
		out, err := utils.Kubectl("rollout", "status",
			"deployment/kn-next-operator-controller-manager",
			"-n", operatorNamespace, "--timeout=10s")
		g.Expect(err).NotTo(HaveOccurred(), out)
	}).Should(Succeed())
}

// undeployOperator tears down the controller-manager and CRDs. Called exactly
// once for the whole e2e_scale suite.
func undeployOperator() {
	By("undeploying the controller-manager")
	_, _ = utils.Run(exec.Command("make", "undeploy"))

	By("uninstalling the operator CRDs")
	_, _ = utils.Run(exec.Command("make", "uninstall"))
}
