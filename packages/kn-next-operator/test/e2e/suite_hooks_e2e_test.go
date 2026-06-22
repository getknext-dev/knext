//go:build e2e && !e2e_scale
// +build e2e,!e2e_scale

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

// Plain `e2e` variant of the suite-setup hook: a no-op. Under the e2e tag the
// Manager spec (e2e_test.go) deploys and undeploys the operator inside its own
// BeforeAll/AfterAll, so the suite-level hook must NOT also deploy it. The
// e2e_scale variant lives in suite_hooks_scale_test.go.
package e2e

// extraSuiteSetup is a no-op under the plain e2e tag.
func extraSuiteSetup() {}

// extraSuiteTeardown is a no-op under the plain e2e tag.
func extraSuiteTeardown() {}
