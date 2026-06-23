// Package install also verifies the FIRST-PUBLISH bootstrap guards (issue #117):
// the committed bundle intentionally carries an all-zeros placeholder digest
// pre-publish, so the per-PR no-:latest guard MUST keep accepting it. But once the
// operator image is actually published (the release/main context), that placeholder
// must NOT survive — a guard that runs only in the published context fails if the
// all-zeros digest is still present. These tests gate the existence + behavior of
// hack/check-published-digest.sh and its wiring into operator-supply-chain.yml.
package install

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const placeholderDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"

// publishedDigestGuard returns the absolute path to hack/check-published-digest.sh.
func publishedDigestGuard(t *testing.T) string {
	t.Helper()
	p, err := filepath.Abs(filepath.Join("..", "..", "hack", "check-published-digest.sh"))
	if err != nil {
		t.Fatalf("resolving guard path: %v", err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("hack/check-published-digest.sh missing — the published-context placeholder guard (#117): %v", err)
	}
	return p
}

// runGuardOnContent writes content to a temp bundle and runs the guard against it,
// returning the exit code and combined output.
func runGuardOnContent(t *testing.T, guard, content string) (int, string) {
	t.Helper()
	dir := t.TempDir()
	bundle := filepath.Join(dir, "install.yaml")
	if err := os.WriteFile(bundle, []byte(content), 0o644); err != nil {
		t.Fatalf("writing temp bundle: %v", err)
	}
	cmd := exec.Command("bash", guard, bundle)
	out, err := cmd.CombinedOutput()
	code := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else {
			t.Fatalf("running guard: %v", err)
		}
	}
	return code, string(out)
}

// TestPublishedDigestGuardRejectsPlaceholder: the all-zeros placeholder is OK
// pre-publish but is a HARD failure when the bundle is treated as published.
func TestPublishedDigestGuardRejectsPlaceholder(t *testing.T) {
	guard := publishedDigestGuard(t)
	content := "image: ghcr.io/getknext-dev/kn-next-operator:v0.1.0@" + placeholderDigest + "\n"
	code, out := runGuardOnContent(t, guard, content)
	if code == 0 {
		t.Errorf("guard must FAIL on the all-zeros placeholder digest in a published bundle; output:\n%s", out)
	}
}

// TestPublishedDigestGuardRejectsLatest: a :latest tag must also fail (closes the
// controller:latest placeholder noted in security.md, in the published context).
func TestPublishedDigestGuardRejectsLatest(t *testing.T) {
	guard := publishedDigestGuard(t)
	content := "image: ghcr.io/getknext-dev/kn-next-operator:latest\n"
	code, out := runGuardOnContent(t, guard, content)
	if code == 0 {
		t.Errorf("guard must FAIL on a :latest image ref; output:\n%s", out)
	}
}

// TestPublishedDigestGuardAcceptsRealDigest: a real (non-zero) digest-pinned image
// passes — this is the post-publish happy path.
func TestPublishedDigestGuardAcceptsRealDigest(t *testing.T) {
	guard := publishedDigestGuard(t)
	real := "sha256:abc1230000000000000000000000000000000000000000000000000000000def"
	content := "image: ghcr.io/getknext-dev/kn-next-operator:v0.1.0@" + real + "\n"
	code, out := runGuardOnContent(t, guard, content)
	if code != 0 {
		t.Errorf("guard must PASS on a real digest-pinned image (post-publish); exit=%d output:\n%s", code, out)
	}
}

// TestSupplyChainWorkflowWiresPublishedDigestGuard asserts the supply-chain workflow
// runs the published-digest guard on the main/publish path (after the digest is
// pinned into dist/install.yaml), so a failed re-pin can never ship a placeholder.
func TestSupplyChainWorkflowWiresPublishedDigestGuard(t *testing.T) {
	wf := readWorkflow(t)
	if !strings.Contains(wf, "check-published-digest.sh") {
		t.Errorf("operator-supply-chain.yml must run hack/check-published-digest.sh on the publish path " +
			"so the placeholder digest can never survive into a published bundle (#117)")
	}
}

// TestSupplyChainWorkflowWiresCosignVerify asserts the workflow verifies the image
// signature it just produced (cosign verify), parameterized by the pushed digest.
func TestSupplyChainWorkflowWiresCosignVerify(t *testing.T) {
	wf := readWorkflow(t)
	if !strings.Contains(wf, "cosign-verify.sh") && !strings.Contains(wf, "cosign verify") {
		t.Errorf("operator-supply-chain.yml must run cosign verify (or hack/cosign-verify.sh) against the " +
			"published operator image digest (#117)")
	}
}
