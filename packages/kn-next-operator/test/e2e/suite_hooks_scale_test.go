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

// e2e_scale variant of the suite-setup hook. Ginkgo permits only one BeforeSuite
// / AfterSuite per suite, and the shared e2e_suite_test.go owns them; these hooks
// let the e2e_scale suite extend that single pair to deploy the operator ONCE for
// the whole suite (see scale_suite_test.go). The matching e2e variant
// (suite_hooks_e2e_test.go) is a no-op because e2e_test.go deploys per-Describe.
package e2e

// extraSuiteSetup deploys the operator once for the e2e_scale suite.
func extraSuiteSetup() { deployOperatorOnce() }

// extraSuiteTeardown undeploys the operator once at the end of the e2e_scale suite.
func extraSuiteTeardown() { undeployOperator() }
