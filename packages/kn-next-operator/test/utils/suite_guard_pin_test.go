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

package utils

// Source-order pin for the plan-v3 P2 guard (base e2e/e2e_scale suite,
// sysdesign's #1): utils.EnsureKindContext must be the FIRST statement of the
// suite's BeforeSuite — before the first cluster read
// (IsCertManagerCRDsInstalled), docker-build, kind-load, setupCertManager and
// extraSuiteSetup. The e2e package is build-tagged, so an untagged unit test
// cannot compile it; pinning the source text is the only way `go test
// ./test/utils/` can enforce the ORDERING (the decision itself is table-tested
// in kind_context_test.go). Brittle by design: moving the guard must break
// this test.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBaseSuiteGuardIsFirstStatementOfBeforeSuite(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "e2e", "e2e_suite_test.go"))
	if err != nil {
		t.Fatalf("could not read the base suite source: %v", err)
	}
	s := string(src)

	const beforeSuiteOpen = "var _ = BeforeSuite(func() {"
	start := strings.Index(s, beforeSuiteOpen)
	if start < 0 {
		t.Fatalf("e2e_suite_test.go no longer contains %q — update this pin", beforeSuiteOpen)
	}
	end := strings.Index(s, "var _ = AfterSuite(")
	if end < 0 || end < start {
		t.Fatal("e2e_suite_test.go no longer defines AfterSuite after BeforeSuite — update this pin")
	}
	body := s[start+len(beforeSuiteOpen) : end]

	guard := strings.Index(body, "utils.EnsureKindContext(")
	if guard < 0 {
		t.Fatal("BeforeSuite does not call utils.EnsureKindContext — the suite would run " +
			"cluster-mutating setup (cert-manager install, make deploy) against the AMBIENT kube context")
	}

	// Every cluster-touching (or cluster-name-coupled) setup step must come
	// after the guard within BeforeSuite.
	for _, op := range []string{
		"docker-build",
		"LoadImageToKindClusterWithName",
		"setupCertManager",
		"extraSuiteSetup",
	} {
		idx := strings.Index(body, op)
		if idx >= 0 && idx < guard {
			t.Errorf("BeforeSuite runs %q BEFORE the EnsureKindContext guard — the guard must be first", op)
		}
	}

	// FIRST STATEMENT, not merely early: nothing but blank lines and comments
	// may precede the line carrying the guard call inside the BeforeSuite body.
	guardLineStart := strings.LastIndex(body[:guard], "\n") + 1
	for _, line := range strings.Split(body[:guardLineStart], "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "//") {
			continue
		}
		t.Errorf("BeforeSuite has a statement before the EnsureKindContext guard: %q", trimmed)
	}
}
