// Package install also verifies the operator CI gating (issue #102): the operator
// Go test suite (controller envtest + internal/install assertions) must actually run
// in CI. The gap was that .github/workflows/ci.yml ran vitest + codegen-diff +
// no-:latest guard but NO job ran `make test`, so a reconciler/validation regression
// could merge green and the install-bundle namespace-immunity guarantees were never
// gated (they SKIP when dist/install.yaml is absent — it is gitignored).
package install

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func readCIWorkflow(t *testing.T) string {
	t.Helper()
	return repoFile(t, "../../.github/workflows/ci.yml")
}

// TestCIWorkflowIsValidYAML guards against a malformed ci.yml.
func TestCIWorkflowIsValidYAML(t *testing.T) {
	var v any
	if err := yaml.Unmarshal([]byte(readCIWorkflow(t)), &v); err != nil {
		t.Fatalf("ci.yml is not valid YAML: %v", err)
	}
}

// TestCIRunsOperatorTestJob asserts ci.yml defines a jobs.operator-test job that
// builds the install bundle and runs the operator Go test suite (envtest), so a red
// operator unit/envtest fails the PR and the bundle-immunity assertions actually run.
func TestCIRunsOperatorTestJob(t *testing.T) {
	wf := readCIWorkflow(t)

	var doc struct {
		Jobs map[string]any `yaml:"jobs"`
	}
	if err := yaml.Unmarshal([]byte(wf), &doc); err != nil {
		t.Fatalf("decoding ci.yml: %v", err)
	}

	job, ok := doc.Jobs["operator-test"]
	if !ok {
		t.Fatalf("ci.yml jobs.operator-test missing: the operator Go test suite is not run in CI")
	}

	// Re-marshal just the job so we can string-assert its steps (mirrors the
	// string-assert style of workflow_test.go).
	jobYAML, err := yaml.Marshal(job)
	if err != nil {
		t.Fatalf("re-marshaling operator-test job: %v", err)
	}
	js := string(jobYAML)

	for _, want := range []string{
		"make setup-envtest",
		"make build-installer",
		"make test",
	} {
		if !strings.Contains(js, want) {
			t.Errorf("jobs.operator-test must run %q (not found in job steps)", want)
		}
	}

	// The bundle-immunity tests must hard-fail (not skip) in CI when the bundle is
	// missing, so a green check can never mean "skipped".
	if !strings.Contains(js, "KNEXT_REQUIRE_BUNDLE") {
		t.Errorf("jobs.operator-test must set KNEXT_REQUIRE_BUNDLE so a missing bundle hard-fails")
	}
}
