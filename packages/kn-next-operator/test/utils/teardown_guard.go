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

// Teardown ownership guard (plan P5).
//
// THE FOOTGUN THIS CLOSES: NamespaceDeletedConfirmed runs a confirmed
// `kubectl delete ns` on whatever namespace it is handed, and
// KNEXT_E2E_NAMESPACE lets existing-cluster mode (KNEXT_E2E_KUBE_CONTEXT set,
// e.g. shared OKE) point a suite at ANY namespace — one typo (`default`, a
// teammate's namespace) and the suite destroys it on teardown.
//
// THE MODEL: the ownership label IS the authorization.
//   - CreateOwnedNamespace stamps `kn-next.dev/e2e-owned=true` at namespace
//     CREATION only. It uses `kubectl create` (never apply/label), so a
//     pre-existing namespace is NEVER adopted — creation collides with
//     AlreadyExists, and the suite FAILS FAST right there unless the collided
//     namespace already carries the label (an owned leftover / retried
//     half-committed create). Failing at creation matters: without it a
//     KNEXT_E2E_NAMESPACE typo would silently RUN the suite inside a foreign
//     namespace (deploying its Secret/NextApp/MinIO there) and only trip the
//     guard at teardown, leaving debris behind.
//   - In existing-cluster mode the label is REQUIRED. Prefix-matching never
//     authorizes teardown there: a teammate's hand-made `e2e-foo` namespace
//     on a shared cluster is exactly the thing the guard protects.
//   - In self-contained kind mode (no KNEXT_E2E_KUBE_CONTEXT) the generated
//     `e2e-*` prefix is an acceptable fallback — the whole cluster is
//     throwaway, and it lets a run reclaim a pre-guard run's namespace.
//   - KNEXT_E2E_FORCE_TEARDOWN=1 is the explicit HUMAN escape hatch for
//     deliberate reclaim; it is loud (warning logged to GinkgoWriter AND
//     stderr) and never set by CI.
//
// Refusal is deterministic and wraps ErrTeardownRefused so callers can
// StopTrying immediately instead of spinning their Eventually retry budget.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"

	. "github.com/onsi/ginkgo/v2" // nolint:revive,staticcheck
)

const (
	// E2EOwnershipLabel marks a namespace as created (and therefore owned and
	// deletable) by this repo's e2e suites. Stamped at creation ONLY.
	E2EOwnershipLabel = "kn-next.dev/e2e-owned"
	// E2EOwnershipLabelValue is the only value that authorizes teardown.
	E2EOwnershipLabelValue = "true"
	// E2EForceTeardownEnv is the explicit human override for deliberate
	// reclaim of a namespace the guard would refuse (e.g. one left behind by
	// a run that predates the ownership label).
	E2EForceTeardownEnv = "KNEXT_E2E_FORCE_TEARDOWN"

	// e2eGeneratedPrefix matches the suites' generated namespace names
	// (e2e-cli-*, e2e-rollback-*, e2e-gc-*). Only consulted in kind mode.
	e2eGeneratedPrefix = "e2e-"

	// existingClusterEnv mirrors the suites' mode switch — non-empty means
	// the run targets a live, possibly shared cluster.
	existingClusterEnv = "KNEXT_E2E_KUBE_CONTEXT"
)

// ErrTeardownRefused is wrapped by every guard refusal. Refusals are
// DETERMINISTIC (env + label state), so callers should fail fast on it
// (ginkgo StopTrying) rather than retry.
var ErrTeardownRefused = errors.New("e2e namespace teardown refused")

// ErrForeignNamespace is wrapped when namespace CREATION collides with a
// pre-existing namespace that does not carry the ownership label — the suite
// must not run inside a namespace this infrastructure did not create. Like
// ErrTeardownRefused it is deterministic: callers should fail fast on it.
var ErrForeignNamespace = errors.New("e2e namespace is not owned by this test infrastructure")

// dns1123Label is the K8s namespace-name shape. Anything else is refused
// outright (also keeps shell-arg smuggling out of the kubectl calls).
var dns1123Label = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

// TeardownRequest is the pure decision input, assembled from the live
// namespace read + env by NamespaceTeardownAuthorized.
type TeardownRequest struct {
	// Namespace is the name handed to the teardown path.
	Namespace string
	// NamespaceExists reports whether the namespace currently exists; a
	// nonexistent namespace is a no-op deletion and always allowed.
	NamespaceExists bool
	// OwnedLabel is the live value of E2EOwnershipLabel on the namespace
	// ("" when absent).
	OwnedLabel string
	// ExistingCluster is true when KNEXT_E2E_KUBE_CONTEXT selects
	// existing-cluster mode (shared cluster: the label is REQUIRED).
	ExistingCluster bool
	// KindContext is true ONLY when the resolved current kube context was
	// read successfully AND is positively a kind context (`kind-*`). The
	// generated-prefix fallback below requires it: "no KNEXT_E2E_KUBE_CONTEXT"
	// alone does not prove the ambient context is a throwaway kind cluster
	// (#271 — two local runs hit an ambient OKE context in "kind mode").
	// FAIL CLOSED: an unreadable or non-kind context leaves this false, which
	// gives the request existing-cluster semantics (label required).
	KindContext bool
	// Force is the explicit human override (KNEXT_E2E_FORCE_TEARDOWN).
	Force bool
}

// DecideTeardown is the PURE authorization decision: nil error means teardown
// may proceed. When it proceeds ONLY because of the force override, warning is
// non-empty and the caller MUST log it loudly. Every refusal wraps
// ErrTeardownRefused and names the namespace, the missing authorization, and
// the override env.
func DecideTeardown(req TeardownRequest) (warning string, err error) {
	// An invalid name is never deletable — not even under force. It cannot be
	// a real namespace this infrastructure created.
	if !dns1123Label.MatchString(req.Namespace) || len(req.Namespace) > 63 {
		return "", fmt.Errorf("%w: %q is not a valid namespace name — refusing outright (the override %s does not apply to invalid names)",
			ErrTeardownRefused, req.Namespace, E2EForceTeardownEnv)
	}

	// Nothing exists → nothing to protect. The delete is --ignore-not-found
	// and the confirmed read wants NotFound anyway.
	if !req.NamespaceExists {
		return "", nil
	}

	// The label IS the authorization.
	if req.OwnedLabel == E2EOwnershipLabelValue {
		return "", nil
	}

	// Explicit human escape hatch — allowed, but LOUD.
	if req.Force {
		return fmt.Sprintf(
			"TEARDOWN OVERRIDE: %s is set — deleting namespace %q WITHOUT ownership authorization (label %s=%q is missing). This must be a deliberate human reclaim.",
			E2EForceTeardownEnv, req.Namespace, E2EOwnershipLabel, E2EOwnershipLabelValue), nil
	}

	// Kind self-contained mode only: the generated e2e-* prefix may reclaim a
	// pre-guard run's namespace. NEVER in existing-cluster mode — a shared
	// cluster can hold a teammate's identically-prefixed namespace. And ONLY
	// with a POSITIVELY-verified kind current-context (P6c / #271): "no
	// KNEXT_E2E_KUBE_CONTEXT" alone does not prove the ambient context is a
	// throwaway kind cluster. FAIL CLOSED — an unreadable or non-kind context
	// gets existing-cluster semantics (the label is required).
	if !req.ExistingCluster && req.KindContext && strings.HasPrefix(req.Namespace, e2eGeneratedPrefix) {
		return "", nil
	}

	mode := "self-contained kind mode (and the name does not match the generated e2e-* prefix)"
	if req.ExistingCluster {
		mode = fmt.Sprintf("existing-cluster mode (%s is set), where prefix-matching NEVER authorizes teardown", existingClusterEnv)
	} else if !req.KindContext {
		mode = fmt.Sprintf("kind-default mode WITHOUT a positively-verified kind-* current-context (fail closed: the ambient context may be a real, shared cluster), where prefix-matching never authorizes teardown — the label is required, exactly as if %s were set", existingClusterEnv)
	}
	return "", fmt.Errorf(
		"%w: refusing to delete namespace %q — it does not carry the ownership label %s=%q (stamped only when THIS test infrastructure creates a namespace; a pre-existing namespace is never adopted), and the run is in %s. If reclaiming this namespace is deliberate, re-run with %s=1.",
		ErrTeardownRefused, req.Namespace, E2EOwnershipLabel, E2EOwnershipLabelValue, mode, E2EForceTeardownEnv)
}

// forceTeardownEnabled parses the override env: only explicit truthy values
// ("1"/"true", case-insensitive) enable it.
func forceTeardownEnabled() bool {
	v := strings.TrimSpace(os.Getenv(E2EForceTeardownEnv))
	return v == "1" || strings.EqualFold(v, "true")
}

// ownedNamespaceManifest renders the create-time Namespace manifest carrying
// the ownership label. Rendered (not `kubectl create ns` + label) so the label
// exists from the very first API write — there is no unlabeled window and no
// second, adoptable labeling step.
func ownedNamespaceManifest(ns string) string {
	return fmt.Sprintf(`apiVersion: v1
kind: Namespace
metadata:
  name: %s
  labels:
    %s: %q
`, ns, E2EOwnershipLabel, E2EOwnershipLabelValue)
}

// DecideCreationCollision is the PURE decision for an AlreadyExists collision
// on CreateOwnedNamespace: nil error means the collision is benign (the
// namespace carries the ownership label — a retried half-committed create or
// an owned leftover being reclaimed) and the suite may proceed. An unlabeled
// collision wraps ErrForeignNamespace: the suite is pointed at a namespace
// this infrastructure did not create (KNEXT_E2E_NAMESPACE typo) and must fail
// fast BEFORE deploying anything into it. Force (the same explicit human
// override as teardown) proceeds with a loud warning the caller MUST log —
// it is the deliberate-reclaim path for namespaces that predate the label.
func DecideCreationCollision(ns, ownedLabel string, force bool) (warning string, err error) {
	if ownedLabel == E2EOwnershipLabelValue {
		return "", nil
	}
	if force {
		return fmt.Sprintf(
			"CREATION-COLLISION OVERRIDE: %s is set — running the suite in pre-existing namespace %q WITHOUT ownership authorization (label %s=%q is missing). This must be a deliberate human reclaim.",
			E2EForceTeardownEnv, ns, E2EOwnershipLabel, E2EOwnershipLabelValue), nil
	}
	return "", fmt.Errorf(
		"%w: namespace %q already exists and does not carry the ownership label %s=%q — refusing to run the suite inside a namespace this test infrastructure did not create (is KNEXT_E2E_NAMESPACE pointing at the wrong namespace?). If reclaiming it is deliberate, re-run with %s=1.",
		ErrForeignNamespace, ns, E2EOwnershipLabel, E2EOwnershipLabelValue, E2EForceTeardownEnv)
}

// readNamespaceOwnership fetches the namespace and returns whether it exists
// and the live value of the ownership label. Full-JSON read + Go-side parse
// (NOT jsonpath): label keys with dots need jsonpath escaping that differs
// across kubectl versions — encoding/json is deterministic everywhere.
// A transient error (neither success nor NotFound) is returned as-is for the
// caller's retry loop.
func readNamespaceOwnership(ns string) (exists bool, ownedLabel string, err error) {
	out, err := Kubectl("get", "ns", ns, "-o", "json")
	switch {
	case err == nil:
		var obj struct {
			Metadata struct {
				Labels map[string]string `json:"labels"`
			} `json:"metadata"`
		}
		if jerr := json.Unmarshal([]byte(out), &obj); jerr != nil {
			return false, "", fmt.Errorf("could not parse namespace %s ownership read: %w", ns, jerr)
		}
		return true, obj.Metadata.Labels[E2EOwnershipLabel], nil
	case strings.Contains(out, "NotFound"):
		return false, "", nil
	default:
		return false, "", fmt.Errorf("could not read namespace %s ownership: %w", ns, err)
	}
}

// CreateOwnedNamespace creates the namespace WITH the ownership label in one
// `kubectl create` call. On an AlreadyExists collision it VERIFIES the
// collided namespace carries the label before treating the collision as
// idempotent success (a half-committed create on a WAN blip already carried
// the label; an owned leftover may be reclaimed). An UNLABELED collision
// fails fast with ErrForeignNamespace — the suite must never run inside a
// namespace this infrastructure did not create (KNEXT_E2E_NAMESPACE typo),
// not even up to teardown. KNEXT_E2E_FORCE_TEARDOWN=1 overrides, loudly.
func CreateOwnedNamespace(ns string) error {
	if !dns1123Label.MatchString(ns) || len(ns) > 63 {
		return fmt.Errorf("invalid namespace name %q", ns)
	}
	cmd := exec.Command("kubectl", "create", "-f", "-")
	cmd.Stdin = strings.NewReader(ownedNamespaceManifest(ns))
	out, err := Run(cmd)
	if err == nil {
		return nil
	}
	if !strings.Contains(out, "already exists") {
		return err
	}

	// AlreadyExists: only an ownership-labeled namespace makes this benign.
	exists, ownedLabel, rerr := readNamespaceOwnership(ns)
	if rerr != nil {
		return rerr // transient — caller's Eventually retries
	}
	if !exists {
		// Vanished between the collision and the read (e.g. a Terminating
		// namespace finished deleting): retryable — the next create attempt
		// will stamp a fresh, owned namespace.
		return fmt.Errorf("namespace %s vanished after a create collision; retry the create", ns)
	}
	warning, derr := DecideCreationCollision(ns, ownedLabel, forceTeardownEnabled())
	if derr != nil {
		return derr
	}
	if warning != "" {
		_, _ = fmt.Fprintf(GinkgoWriter, "%s\n", warning)
		_, _ = fmt.Fprintf(os.Stderr, "%s\n", warning)
	}
	return nil
}

// NamespaceTeardownAuthorized assembles the live TeardownRequest (namespace
// existence + ownership label via kubectl, mode + override via env) and runs
// the pure decision. A transient read error is returned as-is (callers'
// Eventually retries it); a refusal wraps ErrTeardownRefused (callers should
// StopTrying). The force-override warning is logged loudly to BOTH
// GinkgoWriter and stderr.
func NamespaceTeardownAuthorized(ns string) error {
	existingCluster := strings.TrimSpace(os.Getenv(existingClusterEnv)) != ""
	req := TeardownRequest{
		Namespace:       ns,
		ExistingCluster: existingCluster,
		// Positive verification, fail closed (P6c / #271): only read the
		// current context in kind-default mode; an unreadable or non-kind-*
		// context leaves this false → existing-cluster semantics. With the
		// suites pinning via EnsureKindContext, the pinned KUBECONFIG's
		// current-context IS the kind context, so this read is consistent.
		KindContext: !existingCluster && CurrentContextIsKind(),
		Force:       forceTeardownEnabled(),
	}

	// Validate the name BEFORE touching the cluster — an invalid name is a
	// deterministic refusal and must not reach kubectl.
	if !dns1123Label.MatchString(ns) || len(ns) > 63 {
		_, err := DecideTeardown(req)
		return err
	}

	// Live ownership read; a transient error (WAN blip / API hiccup /
	// unparseable output) is NOT a refusal — it surfaces as-is so the
	// caller's Eventually retries the read.
	exists, ownedLabel, err := readNamespaceOwnership(ns)
	if err != nil {
		return fmt.Errorf("could not authorize teardown: %w", err)
	}
	req.NamespaceExists = exists
	req.OwnedLabel = ownedLabel

	warning, err := DecideTeardown(req)
	if err != nil {
		return err
	}
	if warning != "" {
		_, _ = fmt.Fprintf(GinkgoWriter, "%s\n", warning)
		_, _ = fmt.Fprintf(os.Stderr, "%s\n", warning)
	}
	return nil
}
