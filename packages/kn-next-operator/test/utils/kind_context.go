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

// Kind-context pinning for the self-contained e2e suites (#271, plan-v2 P6c).
//
// THE FOOTGUN THIS CLOSES: the suites' kind-default mode (no
// KNEXT_E2E_KUBE_CONTEXT) used the AMBIENT kubectl current-context for every
// namespace/apply/read, while `kind load` targets the kind cluster by name.
// With an ambient OKE/GKE context the suite's cluster operations land on a
// FOREIGN cluster (observed live during PR #269's verification) — the
// ownership-label guard protects teardown, not creation-era operations.
//
// THE MODEL: before ANY cluster operation, kind-default mode either PINS the
// run to the expected kind context (rendering a minified kubeconfig, exactly
// like existing-cluster mode does for KNEXT_E2E_KUBE_CONTEXT) or REFUSES,
// naming both the ambient context and the expected one. The decision itself
// (ResolveKindContext) is pure and table-tested; EnsureKindContext is the
// thin live wrapper the four suites call in their setup.

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// kindContextPrefix is how kind names the kubeconfig context for a cluster:
// `kind create cluster --name <c>` registers context `kind-<c>`.
const kindContextPrefix = "kind-"

// ExpectedKindContext returns the kubeconfig context name of the kind cluster
// the suites target: `kind-<cluster>`, where <cluster> honors the same
// KIND_CLUSTER override LoadImageToKindClusterWithName uses (default "kind").
func ExpectedKindContext() string {
	cluster := defaultKindCluster
	if v, ok := os.LookupEnv("KIND_CLUSTER"); ok {
		cluster = v
	}
	return kindContextPrefix + cluster
}

// ResolveKindContext is the PURE decision for kind-default mode: given the
// expected kind context, the ambient current-context (may be empty when
// unreadable/unset), and the kubeconfig's known context names, it returns the
// context to pin — always the EXPECTED kind context when it exists, never the
// ambient one. When the expected context is absent the run must refuse
// BEFORE any cluster operation; the error names both contexts so the
// operator of the suite sees exactly what would have been targeted (#271).
func ResolveKindContext(expected, current string, contexts []string) (string, error) {
	for _, c := range contexts {
		if c == expected {
			return expected, nil
		}
	}
	if strings.TrimSpace(current) == "" {
		current = "(none)"
	}
	return "", fmt.Errorf(
		"kind-default mode requires the kind context %q in the kubeconfig, but it is absent "+
			"(ambient current-context: %q). Refusing to fall back to the ambient context — it may be "+
			"a real, shared cluster. Create the kind cluster (kind create cluster --name %s), or set "+
			"KIND_CLUSTER to the right cluster name, or run against an existing cluster explicitly "+
			"with %s=<context>.",
		expected, current, strings.TrimPrefix(expected, kindContextPrefix), existingClusterEnv)
}

// CurrentKubeContext returns the ambient kubectl current-context, or "" when
// it cannot be read (no kubeconfig / no current-context set).
func CurrentKubeContext() string {
	out, err := Run(exec.Command("kubectl", "config", "current-context"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// CurrentContextIsKind reports whether the resolved current kube context was
// read successfully AND is positively a kind context (`kind-*`). Used by the
// teardown guard's generated-prefix fallback: FAIL CLOSED — an unreadable or
// non-kind context returns false, which gives the teardown request
// existing-cluster semantics (ownership label required).
func CurrentContextIsKind() bool {
	return strings.HasPrefix(CurrentKubeContext(), kindContextPrefix)
}

// EnsureKindContext pins the whole run to the expected kind cluster for the
// suites' kind-default mode: it resolves the expected `kind-<cluster>` context
// against the kubeconfig and renders a minified, pinned KUBECONFIG for it
// (PinKubeContext) — or fails BEFORE any cluster operation, naming both the
// ambient and the expected context. `dir` should be a per-run temp dir (e.g.
// GinkgoT().TempDir()).
func EnsureKindContext(dir string) error {
	out, err := Run(exec.Command("kubectl", "config", "get-contexts", "-o", "name"))
	if err != nil {
		return fmt.Errorf("could not list kubeconfig contexts to verify the kind context: %w", err)
	}
	ctx, err := ResolveKindContext(ExpectedKindContext(), CurrentKubeContext(), GetNonEmptyLines(out))
	if err != nil {
		return err
	}
	return PinKubeContext(ctx, dir)
}
