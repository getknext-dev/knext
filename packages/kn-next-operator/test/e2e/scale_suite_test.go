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
// (and the matching undeploy/uninstall) live here ONCE, in the suite's
// Before/AfterSuite, and each spec's BeforeAll/AfterAll only applies and deletes
// its OWN namespace + NextApp CR.
//
// This file is only compiled under the `e2e_scale` tag, so it never interferes
// with the `e2e`-tagged Manager spec (e2e_test.go), which manages its own deploy
// and runs in a separate `go test -tags=e2e` invocation.
package e2e

import (
	"fmt"
	"os/exec"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/test/utils"
)

var _ = BeforeSuite(func() {
	deployOperatorOnce()
})

var _ = AfterSuite(func() {
	undeployOperator()
})

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
