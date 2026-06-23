// Package install also gates the cosign-verify helper (issue #117): a reusable,
// image-ref-parameterized script that verifies the published operator image's
// keyless signature. It is only meaningful POST-publish (the image must exist in
// GHCR with a Sigstore signature), so it is wired into the supply-chain/release
// flow rather than per-PR CI. These tests assert the script exists, refuses to run
// without an image ref, and pins the keyless identity/issuer.
package install

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func cosignVerifyScript(t *testing.T) string {
	t.Helper()
	p, err := filepath.Abs(filepath.Join("..", "..", "hack", "cosign-verify.sh"))
	if err != nil {
		t.Fatalf("resolving cosign-verify path: %v", err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("hack/cosign-verify.sh missing — the parameterized cosign-verify helper (#117): %v", err)
	}
	return p
}

// TestCosignVerifyScriptRequiresImageRef: invoked with no argument the script must
// fail fast (non-zero) with a usage message — never silently pass.
func TestCosignVerifyScriptRequiresImageRef(t *testing.T) {
	script := cosignVerifyScript(t)
	cmd := exec.Command("bash", script)
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Errorf("cosign-verify.sh must fail when no image ref is given; output:\n%s", out)
	}
}

// TestCosignVerifyScriptPinsKeylessIdentity: the script must pass the keyless
// identity-regexp and OIDC issuer that match operator-supply-chain.yml's signer, or
// `cosign verify` would accept a signature from any identity.
func TestCosignVerifyScriptPinsKeylessIdentity(t *testing.T) {
	b, err := os.ReadFile(cosignVerifyScript(t))
	if err != nil {
		t.Fatalf("reading cosign-verify.sh: %v", err)
	}
	s := string(b)
	for _, want := range []string{
		"--certificate-identity-regexp",
		"--certificate-oidc-issuer",
		"token.actions.githubusercontent.com",
		"cosign verify",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("cosign-verify.sh must pass %q (keyless identity pinning); not found", want)
		}
	}
}

// TestBundleE2eExists asserts a dedicated install-BUNDLE e2e spec exists: the
// artifact a client actually runs (dist/install.yaml) must itself be the thing
// applied to a live cluster, distinct from the kustomize `make deploy` path the
// existing e2e_test.go uses. It is build-tagged `e2e_bundle` (Knative-requiring),
// so it does not run in the light per-PR e2e — but the spec must be present.
func TestBundleE2eExists(t *testing.T) {
	p, err := filepath.Abs(filepath.Join("..", "..", "test", "e2e", "install_bundle_test.go"))
	if err != nil {
		t.Fatalf("resolving bundle e2e path: %v", err)
	}
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("test/e2e/install_bundle_test.go missing — the install-bundle live e2e (#117): %v", err)
	}
	s := string(b)
	for _, want := range []string{
		"//go:build e2e_bundle",
		"dist/install.yaml",
		"NextApp",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("install_bundle_test.go must reference %q (apply the rendered bundle + a NextApp); not found", want)
		}
	}
}
