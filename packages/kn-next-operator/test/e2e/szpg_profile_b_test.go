//go:build e2e_szpg

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

// Profile-B (P4a, #1203) DRIVER — the LEAD-LOCAL leg. Behind the `e2e_szpg`
// build tag so it is INVISIBLE to `go test ./...`, `go vet ./...`, and the
// per-PR CI: this never gates a PR (platform-e2e-design.md §2 — no cluster leg
// gates a PR; Profile B is lead-owned, same class as the standing OKE-verify
// stage). The reproducible plane stand-up + teardown lives in
// test/e2e/szpg/setup-profile-b.sh; this driver reads the AppDatabase that
// script provisioned and applies the boundary assertion whose DETECTION logic is
// mutation-proved off-cluster in szpg_boundary_test.go.
//
// Run (after ./test/e2e/szpg/setup-profile-b.sh has stood the plane up):
//
//	KNEXT_SZPG_E2E=1 \
//	  APPDB_NAMESPACE=my-apps APPDB_NAME=db-demo \
//	  KUBECONFIG=... \
//	  go test -tags e2e_szpg ./test/e2e/ -run TestProfileB_OperatorBoundary -v
//
// Without KNEXT_SZPG_E2E=1 it SKIPS — a compiled-but-inert guard, so a lead who
// runs the whole tagged suite without a live szpg plane gets a clean skip rather
// than a spurious failure.

package e2e

import (
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
)

func szpgEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// TestProfileB_OperatorBoundary is step B1's assertion from the design: after
// szpg provisions the AppDatabase and `kn-next db bind` wires it into the
// NextApp, the knext operator must have written NOTHING to the AppDatabase. This
// proves the ADR-0001 / data-sovereignty boundary (nextapp_types.go:531) against
// the RUNNING system, not the source.
func TestProfileB_OperatorBoundary(t *testing.T) {
	if os.Getenv("KNEXT_SZPG_E2E") != "1" {
		t.Skip("KNEXT_SZPG_E2E!=1: Profile-B is a lead-local cluster drill; " +
			"run ./test/e2e/szpg/setup-profile-b.sh first, then set KNEXT_SZPG_E2E=1")
	}

	ns := szpgEnv("APPDB_NAMESPACE", "my-apps")
	name := szpgEnv("APPDB_NAME", "db-demo")

	// Read the LIVE AppDatabase with its managedFields (kubectl includes them by
	// default on -o json; --show-managed-fields is redundant but explicit here).
	cmd := exec.Command("kubectl", "get", "appdatabase", name,
		"-n", ns, "-o", "json", "--show-managed-fields=true")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("kubectl get appdatabase %s/%s failed: %v\n%s", ns, name, err, string(out))
	}

	var obj AppDatabaseObject
	if err := json.Unmarshal(out, &obj); err != nil {
		t.Fatalf("unmarshal AppDatabase JSON: %v", err)
	}

	// Positive control: szpg MUST be a writer, or an empty/half-provisioned
	// object would pass the boundary check vacuously.
	if !SzpgManagedAppDatabase(obj.Metadata) {
		managers := make([]string, 0, len(obj.Metadata.ManagedFields))
		for _, mf := range obj.Metadata.ManagedFields {
			managers = append(managers, mf.Manager)
		}
		t.Fatalf("AppDatabase %s/%s is not szpg-managed (managers: %s) — "+
			"the plane did not provision it; boundary check would be vacuous",
			ns, name, strings.Join(managers, ", "))
	}

	// THE boundary assertion: knext wrote nothing, owns nothing.
	violations := KnextBoundaryViolations(obj.Metadata)
	if len(violations) != 0 {
		t.Fatalf("ADR-0001 boundary BREACH — knext operator touched AppDatabase %s/%s:\n  - %s",
			ns, name, strings.Join(violations, "\n  - "))
	}

	t.Logf("boundary OK: AppDatabase %s/%s is szpg-managed and carries NO knext writer/owner", ns, name)
}
