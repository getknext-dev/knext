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

// Shared helpers for the CLI-driven e2e suites (e2e_cli, e2e_rollback).
//
// WHY THIS FILE EXISTS: the e2e variants live behind mutually-exclusive build
// tags, so spec files cannot share symbols with each other — the first two
// suites (e2e_bundle, e2e_cli) each carried their own copy of the bundle
// override / CLI-runner / teardown helpers, and the architect gate flagged
// that duplication as debt before a third copy landed. The genuinely shared,
// tag-independent pieces now live here (plain-error style — Gomega assertions
// and Eventually retry policy stay in the spec files that own them).

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	. "github.com/onsi/ginkgo/v2" // nolint:revive,staticcheck
)

// RepoRoot returns the monorepo root (two levels above the operator package,
// which is what GetProjectDir resolves).
func RepoRoot() (string, error) {
	dir, err := GetProjectDir()
	if err != nil {
		return "", err
	}
	return filepath.Clean(filepath.Join(dir, "..", "..")), nil
}

// CLIBin is the built CLI entry — the SAME file package.json's bin maps to.
// Invoked with plain `node`: the CLI must not require Bun (#68).
func CLIBin() (string, error) {
	root, err := RepoRoot()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "packages", "kn-next", "dist", "cli", "kn-next.js"), nil
}

// CLIResult carries everything a spec asserts about one CLI invocation.
type CLIResult struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

// RunCLI invokes the REAL built CLI with plain node from the repo root.
// A non-zero exit is NOT an error here — the exit code is part of the CLI's
// contract and the specs assert it explicitly. The returned error is non-nil
// only when the process could not be spawned at all (node missing / CLI not
// built).
func RunCLI(args ...string) (CLIResult, error) {
	root, err := RepoRoot()
	if err != nil {
		return CLIResult{}, err
	}
	return RunCLIInDir(root, args...)
}

// RunCLIInDir is RunCLI with an explicit working directory — needed by the
// e2e_gc suite because `kn-next gc` loads kn-next.config.ts from the CURRENT
// directory (the suite renders a throwaway app dir with the test config).
func RunCLIInDir(dir string, args ...string) (CLIResult, error) {
	bin, err := CLIBin()
	if err != nil {
		return CLIResult{}, err
	}
	cmd := exec.Command("node", append([]string{bin}, args...)...)
	cmd.Dir = dir
	// NODE_OPTIONS is cleared deliberately: the CLI must run on a bare Node,
	// and an inherited preload (dev machines) must not skew the e2e. KUBECONFIG
	// (set by the suite in existing-cluster mode) is inherited via os.Environ.
	cmd.Env = append(os.Environ(), "NODE_OPTIONS=")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	_, _ = fmt.Fprintf(GinkgoWriter, "running CLI: node %s %s\n", bin, strings.Join(args, " "))
	runErr := cmd.Run()
	code := 0
	if runErr != nil {
		var exitErr *exec.ExitError
		if errors.As(runErr, &exitErr) {
			code = exitErr.ExitCode()
		} else {
			return CLIResult{}, fmt.Errorf(
				"failed to spawn the CLI at all (is node installed and the CLI built?): %w", runErr)
		}
	}
	_, _ = fmt.Fprintf(GinkgoWriter, "CLI exit=%d\nstdout:\n%s\nstderr:\n%s\n",
		code, stdout.String(), stderr.String())
	return CLIResult{Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: code}, nil
}

// RunAtRepoRoot runs a toolchain command (pnpm) from the monorepo root.
// Run cannot be used here: it force-overrides cmd.Dir to the operator dir.
func RunAtRepoRoot(name string, args ...string) (string, error) {
	root, err := RepoRoot()
	if err != nil {
		return "", err
	}
	cmd := exec.Command(name, args...)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "NODE_OPTIONS=")
	_, _ = fmt.Fprintf(GinkgoWriter, "running (repo root): %s %s\n", name, strings.Join(args, " "))
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("%s %s failed: %w\n%s", name, strings.Join(args, " "), err, out)
	}
	return string(out), nil
}

// PinKubeContext renders a minified, self-contained kubeconfig for the given
// context into dir and exports KUBECONFIG so EVERY subprocess (the Go
// harness's kubectl AND the CLI under test) targets exactly that cluster —
// without ever touching the user's global current-context. Credential exec
// plugins (e.g. OCI's security_token auth) keep working because --raw
// preserves the users section and env vars like OCI_CLI_PROFILE/OCI_CLI_AUTH
// pass through os.Environ. `dir` should be a per-run temp dir (e.g.
// GinkgoT().TempDir()).
func PinKubeContext(ctx, dir string) error {
	out, err := Run(exec.Command("kubectl", "config", "view",
		"--minify", "--raw", "--flatten", fmt.Sprintf("--context=%s", ctx), "-o", "yaml"))
	if err != nil {
		return fmt.Errorf("failed to render a kubeconfig for context %q: %w", ctx, err)
	}
	path := filepath.Join(dir, "kubeconfig")
	if err := os.WriteFile(path, []byte(out), 0o600); err != nil {
		return err
	}
	if err := os.Setenv("KUBECONFIG", path); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(GinkgoWriter, "pinned KUBECONFIG for context %q at %s\n", ctx, path)
	return nil
}

// OverrideManagerImage renders a copy of dist/install.yaml with the operator
// manager image line rewritten to `img`, returning the rewritten bundle's
// path (dist/<dstName>).
func OverrideManagerImage(img, dstName string) (string, error) {
	src, err := os.ReadFile(filepath.Join("dist", "install.yaml"))
	if err != nil {
		return "", fmt.Errorf("failed to read rendered dist/install.yaml: %w", err)
	}

	var b strings.Builder
	replaced := false
	for _, line := range strings.Split(string(src), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "image:") &&
			strings.Contains(line, "ghcr.io/getknext-dev/kn-next-operator") {
			indent := line[:strings.Index(line, "image:")]
			b.WriteString(indent + "image: " + img + "\n")
			replaced = true
			continue
		}
		b.WriteString(line + "\n")
	}
	if !replaced {
		return "", fmt.Errorf("did not find the operator manager image line in dist/install.yaml")
	}

	dst := filepath.Join("dist", dstName)
	if err := os.WriteFile(dst, []byte(b.String()), 0o644); err != nil {
		return "", err
	}
	return dst, nil
}

// ApplyOrDeleteBundle runs `kubectl <apply|delete> -f <bundle>`
// (apply is server-side; delete ignores not-found).
func ApplyOrDeleteBundle(verb, bundle string) error {
	if bundle == "" {
		return nil
	}
	args := []string{verb}
	if verb == "apply" {
		args = append(args, "--server-side")
	} else {
		args = append(args, "--ignore-not-found")
	}
	args = append(args, "-f", bundle)
	cmd := exec.Command("kubectl", args...)
	_, err := Run(cmd)
	return err
}

// ApplyManifest pipes a YAML manifest into `kubectl apply -f -`.
func ApplyManifest(manifest string) error {
	cmd := exec.Command("kubectl", "apply", "-f", "-")
	cmd.Stdin = strings.NewReader(manifest)
	_, err := Run(cmd)
	return err
}

// KubectlCreateIgnoreExists runs an idempotent kubectl create-style command,
// treating "already exists" as success — the retry after a half-committed
// create (WAN blip against a remote cluster) must not fail the suite. Retry
// policy (Eventually) stays with the caller.
func KubectlCreateIgnoreExists(args ...string) error {
	out, err := Kubectl(args...)
	if err != nil && strings.Contains(out, "already exists") {
		return nil
	}
	return err
}

// NamespaceDeletedConfirmed makes ONE bounded attempt to delete the namespace
// and CONFIRMS it is gone with a read that must return NotFound — a transient
// error can never fake a completed cleanup on a shared cluster. Callers wrap
// it in Eventually for the retry policy. Deletion is waited on (bounded)
// deliberately: tearing down the operator bundle while a NextApp CR is still
// finalizing in a terminating namespace deadlocks the CRD's instance-cleanup
// finalizer (observed live: a --wait=false hung an AfterAll for 25m), so the
// namespace MUST be fully gone before any bundle delete.
//
// OWNERSHIP GUARD (plan P5): the delete is issued ONLY if
// NamespaceTeardownAuthorized allows it — the namespace must carry the
// creation-stamped kn-next.dev/e2e-owned=true label (or, in self-contained
// kind mode only, match the generated e2e-* prefix; or the human
// KNEXT_E2E_FORCE_TEARDOWN override). A refusal wraps ErrTeardownRefused —
// callers' Eventually loops should StopTrying on it, not retry.
func NamespaceDeletedConfirmed(ns string) error {
	if err := NamespaceTeardownAuthorized(ns); err != nil {
		return err
	}
	_, _ = Kubectl("delete", "ns", ns, "--ignore-not-found", "--timeout=5m")
	out, err := Kubectl("get", "ns", ns)
	if err == nil {
		return fmt.Errorf("namespace %s still exists:\n%s", ns, out)
	}
	if !strings.Contains(out, "NotFound") {
		return fmt.Errorf("namespace %s deletion not confirmed (transient error, not NotFound):\n%s", ns, out)
	}
	return nil
}
