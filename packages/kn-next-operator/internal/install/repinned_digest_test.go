// Package install: completion gate for issue #117 — the install bundle must be
// pinned to the REAL published, cosign-signed operator digest, not the all-zeros
// bootstrap placeholder. The bundle (dist/install.yaml) is gitignored and rendered
// from config/manager/kustomization.yaml (the tracked source of truth) at
// build/release time. Once the operator image is published (the supply-chain
// workflow succeeded on main), a clean-cluster `kubectl apply -f dist/install.yaml`
// must pull a real image — so the kustomization override AND any rendered bundle
// must carry a non-zero @sha256: digest. These tests fail while the placeholder
// survives. The bundle assertion is bundle-gated (skips when dist/install.yaml is
// absent, like the other install tests; CI renders it + sets KNEXT_REQUIRE_BUNDLE=1).
package install

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

const (
	// operatorOwner is the operator image repo (without tag/digest).
	operatorOwner = "ghcr.io/getknext-dev/kn-next-operator"
	// zeroDigest is the all-zeros bootstrap placeholder that must NOT survive
	// once the image is published.
	zeroDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
)

// operatorImageRef extracts the operator image reference (newTag value or full
// image: line) for the getknext-dev operator owner from the given file content.
func operatorImageDigest(t *testing.T, content string) string {
	t.Helper()
	// Match a combined tag@sha256:<hash> following the operator owner, whether it
	// appears as `newTag: v0.1.0@sha256:<hash>` (kustomization) or
	// `image: ghcr.io/.../kn-next-operator:v0.1.0@sha256:<hash>` (rendered bundle).
	re := regexp.MustCompile(`@(sha256:[0-9a-f]{64})`)
	m := re.FindStringSubmatch(content)
	if m == nil {
		t.Fatalf("no @sha256:<hash> digest found in content")
	}
	return m[1]
}

// TestKustomizationPinsRealOperatorDigest: the committed kustomization override
// must reference a REAL (non-zero) operator digest, not the placeholder (#117).
func TestKustomizationPinsRealOperatorDigest(t *testing.T) {
	c := repoFile(t, "config/manager/kustomization.yaml")
	if !strings.Contains(c, operatorOwner) {
		t.Fatalf("kustomization.yaml: expected operator owner %q", operatorOwner)
	}
	if strings.Contains(c, zeroDigest) {
		t.Errorf("kustomization.yaml still pins the all-zeros placeholder digest; "+
			"re-pin to the real published+signed digest (#117):\n%s",
			grepLines(c, zeroDigest))
	}
	d := operatorImageDigest(t, c)
	if d == zeroDigest {
		t.Errorf("kustomization operator digest must be a real published digest, got placeholder %q", d)
	}
}

// TestInstallBundlePinsRealOperatorDigest: the rendered dist/install.yaml — the
// client-facing artifact applied on a clean cluster — must carry the real
// operator digest so the apply pulls a published image (#117).
func TestInstallBundlePinsRealOperatorDigest(t *testing.T) {
	p := requireBundle(t)
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("reading bundle %s: %v", p, err)
	}
	b := string(raw)
	if strings.Contains(b, zeroDigest) {
		t.Errorf("dist/install.yaml still contains the all-zeros placeholder digest; "+
			"regenerate the bundle after re-pinning kustomization (#117):\n%s",
			grepLines(b, zeroDigest))
	}
	// Locate the operator manager image line specifically.
	re := regexp.MustCompile(`(?m)^\s*image:\s*(` + regexp.QuoteMeta(operatorOwner) + `\S*)\s*$`)
	m := re.FindStringSubmatch(b)
	if m == nil {
		t.Fatalf("dist/install.yaml: no operator manager image: line found for %q", operatorOwner)
	}
	if !strings.Contains(m[1], "@sha256:") {
		t.Errorf("operator image must be digest-pinned (@sha256:): %q", m[1])
	}
	if strings.Contains(m[1], zeroDigest) {
		t.Errorf("operator image still pins the placeholder digest: %q", m[1])
	}
}

func grepLines(content, needle string) string {
	var out []string
	for _, ln := range strings.Split(content, "\n") {
		if strings.Contains(ln, needle) {
			out = append(out, "  "+ln)
		}
	}
	return strings.Join(out, "\n")
}
