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
//     AlreadyExists, the label stays absent, and teardown refuses.
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
	// cluster can hold a teammate's identically-prefixed namespace.
	if !req.ExistingCluster && strings.HasPrefix(req.Namespace, e2eGeneratedPrefix) {
		return "", nil
	}

	mode := "self-contained kind mode (and the name does not match the generated e2e-* prefix)"
	if req.ExistingCluster {
		mode = fmt.Sprintf("existing-cluster mode (%s is set), where prefix-matching NEVER authorizes teardown", existingClusterEnv)
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

// CreateOwnedNamespace creates the namespace WITH the ownership label in one
// `kubectl create` call. "already exists" is treated as success so the
// callers' Eventually retry loops stay idempotent (a half-committed create on
// a WAN blip already carried the label) — but a namespace that pre-existed
// this run was NOT created here, keeps whatever labels it had, and is
// therefore never adopted: its teardown will be refused by the guard.
func CreateOwnedNamespace(ns string) error {
	if !dns1123Label.MatchString(ns) || len(ns) > 63 {
		return fmt.Errorf("invalid namespace name %q", ns)
	}
	cmd := exec.Command("kubectl", "create", "-f", "-")
	cmd.Stdin = strings.NewReader(ownedNamespaceManifest(ns))
	out, err := Run(cmd)
	if err != nil && strings.Contains(out, "already exists") {
		return nil
	}
	return err
}

// NamespaceTeardownAuthorized assembles the live TeardownRequest (namespace
// existence + ownership label via kubectl, mode + override via env) and runs
// the pure decision. A transient read error is returned as-is (callers'
// Eventually retries it); a refusal wraps ErrTeardownRefused (callers should
// StopTrying). The force-override warning is logged loudly to BOTH
// GinkgoWriter and stderr.
func NamespaceTeardownAuthorized(ns string) error {
	req := TeardownRequest{
		Namespace:       ns,
		ExistingCluster: strings.TrimSpace(os.Getenv(existingClusterEnv)) != "",
		Force:           forceTeardownEnabled(),
	}

	// Validate the name BEFORE touching the cluster — an invalid name is a
	// deterministic refusal and must not reach kubectl.
	if !dns1123Label.MatchString(ns) || len(ns) > 63 {
		_, err := DecideTeardown(req)
		return err
	}

	// Full-JSON read + Go-side parse (NOT jsonpath): label keys with dots need
	// jsonpath escaping that differs across kubectl versions — encoding/json
	// is deterministic everywhere.
	out, err := Kubectl("get", "ns", ns, "-o", "json")
	switch {
	case err == nil:
		var obj struct {
			Metadata struct {
				Labels map[string]string `json:"labels"`
			} `json:"metadata"`
		}
		if jerr := json.Unmarshal([]byte(out), &obj); jerr != nil {
			// Unparseable read: NOT a refusal — surface it for retry.
			return fmt.Errorf("could not parse namespace %s to authorize teardown: %w", ns, jerr)
		}
		req.NamespaceExists = true
		req.OwnedLabel = obj.Metadata.Labels[E2EOwnershipLabel]
	case strings.Contains(out, "NotFound"):
		req.NamespaceExists = false
	default:
		// Transient (WAN blip / API hiccup): NOT a refusal — surface it so the
		// caller's Eventually retries the read.
		return fmt.Errorf("could not read namespace %s to authorize teardown: %w", ns, err)
	}

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
