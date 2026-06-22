// Package install also verifies the operator supply-chain workflow invariants
// (issue #76 review): the SBOM file path must be consistent across the
// generate/upload/attest steps, and the digest-pinned install.yaml bundle must be
// published as a real GitHub Release asset (so the README's
// releases/latest/download/install.yaml URL actually resolves) — not only as a
// transient, auth-gated CI artifact.
package install

import (
	"regexp"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func readWorkflow(t *testing.T) string {
	t.Helper()
	// repoFile joins "..","..",rel — pass a path that climbs to the repo root.
	return repoFile(t, "../../.github/workflows/operator-supply-chain.yml")
}

// TestWorkflowIsValidYAML guards against a malformed workflow.
func TestWorkflowIsValidYAML(t *testing.T) {
	var v any
	if err := yaml.Unmarshal([]byte(readWorkflow(t)), &v); err != nil {
		t.Fatalf("operator-supply-chain.yml is not valid YAML: %v", err)
	}
}

// TestSbomPathIsConsistent ensures the SBOM is written, uploaded, and attested via
// the SAME real path. The bug: with a job-level working-directory default, the
// `uses:` sbom-action writes to $GITHUB_WORKSPACE (repo root) while the `run:`
// cosign attest honors the working-directory (operator subdir) — so they diverge
// and both the upload and the attestation miss the file.
func TestSbomPathIsConsistent(t *testing.T) {
	wf := readWorkflow(t)

	// The job must NOT carry a run.working-directory default, because that silently
	// diverges `uses:` and `run:` step cwds for file paths.
	if regexp.MustCompile(`(?m)working-directory:\s*packages/kn-next-operator\s*$`).MatchString(wf) {
		t.Errorf("job sets working-directory default: this makes `uses:` (sbom-action) " +
			"and `run:` (cosign attest) resolve sbom.spdx.json at different cwds")
	}

	// The sbom-action output-file, the upload artifact path, and the cosign attest
	// --predicate must all reference the same file path.
	outputFile := firstSubmatch(wf, `output-file:\s*(\S+)`)
	if outputFile == "" {
		t.Fatalf("no output-file: on the sbom-action step")
	}
	uploadPath := firstSubmatch(wf, `name:\s*operator-sbom-[^\n]*\n(?:.|\n)*?path:\s*(\S+)`)
	if uploadPath == "" {
		t.Fatalf("no SBOM upload-artifact path found")
	}
	attestPred := firstSubmatch(wf, `cosign attest[^\n]*--predicate\s+(\S+)`)
	if attestPred == "" {
		t.Fatalf("no `cosign attest --predicate` predicate path found")
	}

	if uploadPath != outputFile {
		t.Errorf("SBOM upload path %q != sbom-action output-file %q", uploadPath, outputFile)
	}
	if attestPred != outputFile {
		t.Errorf("cosign attest --predicate %q != sbom-action output-file %q", attestPred, outputFile)
	}
}

// TestInstallBundlePublishedAsReleaseAsset ensures the digest-pinned install.yaml is
// attached to a GitHub Release (so releases/latest/download/install.yaml resolves),
// not only uploaded as a transient actions/upload-artifact.
func TestInstallBundlePublishedAsReleaseAsset(t *testing.T) {
	wf := readWorkflow(t)

	usesRelease := strings.Contains(wf, "softprops/action-gh-release") ||
		regexp.MustCompile(`gh release (create|upload)`).MatchString(wf)
	if !usesRelease {
		t.Errorf("workflow must publish dist/install.yaml as a GitHub Release asset " +
			"(softprops/action-gh-release or `gh release create|upload`) so the README " +
			"releases/latest/download/install.yaml URL resolves")
	}

	if !strings.Contains(wf, "install.yaml") {
		t.Fatalf("release step does not reference install.yaml")
	}

	// contents: write is required to create/update a Release.
	if !regexp.MustCompile(`contents:\s*write`).MatchString(wf) {
		t.Errorf("publishing a Release requires `contents: write` permission")
	}
}

// TestReadmeUrlMatchesReleaseTag ensures the README install URL and the release
// mechanism agree on where the bundle lands (latest vs a specific tag).
func TestReadmeUrlMatchesReleaseTag(t *testing.T) {
	readme := repoFile(t, "README.md")
	if !strings.Contains(readme, "releases/latest/download/install.yaml") {
		t.Fatalf("README must document the releases/latest/download/install.yaml URL")
	}
	wf := readWorkflow(t)
	// If the release is keyed to a fixed non-"latest" tag, `releases/latest/...` only
	// resolves when that release is also marked latest. Require either a moving tag
	// strategy that keeps a "latest"-resolvable release, or make_latest: true.
	tag := firstSubmatch(wf, `tag_name:\s*(\S+)`)
	if tag != "" && !strings.Contains(tag, "${{") {
		// A literal fixed tag: must be marked as latest for releases/latest to resolve.
		if !regexp.MustCompile(`make_latest:\s*["']?true`).MatchString(wf) {
			t.Errorf("fixed release tag %q but no make_latest: true — releases/latest URL "+
				"may not resolve", tag)
		}
	}
}

// TestInstallBundleIsStructurallyValid is the infra-free smoke check (#76 review,
// minor item 4): the checked-in dist/install.yaml must parse as a set of Kubernetes
// objects (each doc has apiVersion + kind), and must carry the digest-pinned manager
// image — never :latest. Live `kubectl apply` of the bundle is exercised by the
// existing kind e2e harness (test/e2e), which is too heavy to stand up on every PR.
func TestInstallBundleIsStructurallyValid(t *testing.T) {
	// dist/install.yaml is a gitignored build artifact (run `make build-installer`).
	// Skip cleanly on a clean checkout rather than hard-failing — but hard-fail under
	// KNEXT_REQUIRE_BUNDLE=1 (CI) so a green check can never mean "skipped".
	requireBundle(t)
	raw := repoFile(t, "dist/install.yaml")
	dec := yaml.NewDecoder(strings.NewReader(raw))

	docs := 0
	sawManagerImage := false
	for {
		var obj map[string]any
		err := dec.Decode(&obj)
		if err != nil {
			break // io.EOF or trailing empty doc
		}
		if len(obj) == 0 {
			continue
		}
		docs++
		if _, ok := obj["apiVersion"]; !ok {
			t.Errorf("dist/install.yaml doc %d missing apiVersion: %v", docs, obj["kind"])
		}
		if _, ok := obj["kind"]; !ok {
			t.Errorf("dist/install.yaml doc %d missing kind", docs)
		}
	}
	if docs == 0 {
		t.Fatalf("dist/install.yaml parsed to zero Kubernetes objects")
	}

	imgLine := regexp.MustCompile(`(?m)^\s*image:\s*(ghcr\.io/getknext-dev/kn-next-operator\S+)`)
	m := imgLine.FindStringSubmatch(raw)
	if m == nil {
		t.Fatalf("dist/install.yaml: no operator manager image line found")
	}
	sawManagerImage = true
	if strings.Contains(m[1], ":latest") {
		t.Errorf("dist/install.yaml manager image must not be :latest: %q", m[1])
	}
	if !strings.Contains(m[1], "@sha256:") {
		t.Errorf("dist/install.yaml manager image must be digest-pinned: %q", m[1])
	}
	if !sawManagerImage {
		t.Errorf("dist/install.yaml did not reference the operator manager image")
	}
}

func firstSubmatch(s, pattern string) string {
	m := regexp.MustCompile(`(?m)` + pattern).FindStringSubmatch(s)
	if m == nil || len(m) < 2 {
		return ""
	}
	return strings.TrimSpace(m[1])
}
