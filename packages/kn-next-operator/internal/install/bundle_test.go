// Package install verifies the operator's installable-bundle invariants (issue #76):
// the manager image must be published under the getknext-dev GHCR owner, stay
// digest-pinned (never :latest), and the release-time digest substitution must
// keep the guard-safe combined newTag form.
package install

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// repoFile reads a file relative to the operator package root (two dirs up from
// internal/install).
func repoFile(t *testing.T, rel string) string {
	t.Helper()
	p := filepath.Join("..", "..", rel)
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("reading %s: %v", rel, err)
	}
	return string(b)
}

const (
	wantOwner  = "ghcr.io/getknext-dev/kn-next-operator"
	staleOwner = "ahmedelbanna80"
)

// AC: manager.yaml + kustomization.yaml reference the getknext-dev owner.
func TestManagerManifestsUseGetknextOwner(t *testing.T) {
	for _, rel := range []string{
		"config/manager/manager.yaml",
		"config/manager/kustomization.yaml",
	} {
		c := repoFile(t, rel)
		if !strings.Contains(c, wantOwner) {
			t.Errorf("%s: expected image owner %q, not found", rel, wantOwner)
		}
		if strings.Contains(c, staleOwner) {
			t.Errorf("%s: stale owner %q must be removed", rel, staleOwner)
		}
	}
}

// AC: the manager image is digest-pinned (@sha256:) and never :latest.
func TestManagerImageDigestPinned(t *testing.T) {
	imgLine := regexp.MustCompile(`(?m)^\s*image:\s*ghcr\.io/getknext-dev/kn-next-operator:[^\s]+`)
	c := repoFile(t, "config/manager/manager.yaml")
	m := imgLine.FindString(c)
	if m == "" {
		t.Fatalf("manager.yaml: no getknext-dev image line found")
	}
	if strings.Contains(m, ":latest") {
		t.Errorf("manager.yaml image must not be :latest: %q", m)
	}
	if !strings.Contains(m, "@sha256:") {
		t.Errorf("manager.yaml image must be digest-pinned (@sha256:): %q", m)
	}
}

// AC: kustomization keeps the combined newTag: <tag>@sha256:<hash> form (so the
// check-no-latest.sh guard's check-2 passes — no bare newTag).
func TestKustomizationCombinedDigestForm(t *testing.T) {
	c := repoFile(t, "config/manager/kustomization.yaml")
	newTag := regexp.MustCompile(`(?m)^\s*newTag:\s*(\S+)`)
	m := newTag.FindStringSubmatch(c)
	if m == nil {
		t.Fatalf("kustomization.yaml: no newTag line found")
	}
	if !strings.Contains(m[1], "@sha256:") {
		t.Errorf("kustomization newTag must carry the digest inline (combined form), got %q", m[1])
	}
}

// AC: the release-time substitution (mirrors operator-supply-chain.yml) replaces a
// placeholder digest with a real one while preserving the combined form.
func TestDigestSubstitutionKeepsCombinedForm(t *testing.T) {
	const placeholder = "newTag: v0.1.0@sha256:" +
		"0000000000000000000000000000000000000000000000000000000000000000"
	const realDigest = "abc1230000000000000000000000000000000000000000000000000000000def"

	re := regexp.MustCompile(`(newTag: v[0-9]+\.[0-9]+\.[0-9]+@sha256:)[0-9a-f]{64}`)
	got := re.ReplaceAllString(placeholder, "${1}"+realDigest)

	want := "newTag: v0.1.0@sha256:" + realDigest
	if got != want {
		t.Errorf("substitution = %q, want %q", got, want)
	}
	if strings.Count(got, "@sha256:") != 1 {
		t.Errorf("substituted ref must keep exactly one @sha256: combined ref: %q", got)
	}
}
