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

// Unit tests for the Profile-B (P4a, #1203) operator-boundary assertion — the
// CORE of the harness. These are UNTAGGED (no e2e_szpg build tag) and free of
// any cluster dependency, so they compile and run — and are mutation-proved —
// under a plain `go test ./...` on every PR, exactly like the Profile-A pure
// helpers (scale_profile_a_helpers_test.go, #1202).
//
// The invariant under test: after the knext operator reconciles a NextApp that
// binds an szpg-provisioned database, the AppDatabase custom resource
// (apps.scale-zero-pg.dev) must be owned/managed ONLY by the szpg control plane
// (the appdb-operator / zone-operator) and human/CI kubectl. The knext operator
// NEVER reads or writes AppDatabase (nextapp_types.go:531, ADR-0001 boundary /
// data sovereignty).
//
// The check is an ALLOWLIST, deliberately (cr-1214 finding): the knext operator
// binary is `/manager` and sets NO explicit FieldOwner, so a real knext write to
// an AppDatabase lands with field manager == the bare "manager" (client-go's
// default from os.Args[0]) — a name a knext-substring rejectlist would MISS.
// Fail-closed: any managedFields manager that is NOT a known-legitimate writer
// (appdb-operator / zone-operator / kubectl-*) is a violation, "manager"
// included.

package e2e

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/AhmedElBanna80/knext/packages/kn-next-operator/internal/controller"
)

// A realistic AppDatabase metadata payload as `kubectl get appdatabase -o json`
// emits it AFTER the szpg appdb-operator has provisioned it and a human/CI ran
// `kubectl apply` — i.e. the CLEAN, boundary-holding state: NO knext writer.
const cleanAppDatabaseJSON = `{
  "apiVersion": "apps.scale-zero-pg.dev/v1alpha1",
  "kind": "AppDatabase",
  "metadata": {
    "name": "db-demo",
    "namespace": "my-apps",
    "ownerReferences": [],
    "managedFields": [
      {
        "manager": "kubectl-client-side-apply",
        "operation": "Update",
        "apiVersion": "apps.scale-zero-pg.dev/v1alpha1"
      },
      {
        "manager": "appdb-operator",
        "operation": "Update",
        "apiVersion": "apps.scale-zero-pg.dev/v1alpha1"
      },
      {
        "manager": "appdb-operator",
        "operation": "Update",
        "apiVersion": "apps.scale-zero-pg.dev/v1alpha1",
        "subresource": "status"
      }
    ]
  }
}`

func parseMeta(t *testing.T, raw string) ObjectMeta {
	t.Helper()
	var obj AppDatabaseObject
	if err := json.Unmarshal([]byte(raw), &obj); err != nil {
		t.Fatalf("unmarshal AppDatabase: %v", err)
	}
	return obj.Metadata
}

// The happy path: a legitimately-provisioned AppDatabase has ONLY allowlisted
// writers, so the boundary holds and no violations are returned.
func TestKnextBoundaryViolations_CleanIsEmpty(t *testing.T) {
	got := KnextBoundaryViolations(parseMeta(t, cleanAppDatabaseJSON))
	if len(got) != 0 {
		t.Fatalf("clean AppDatabase must yield NO violations, got %d: %v", len(got), got)
	}
}

// THE cr-1214 REGRESSION TEST. The realistic breach: the knext operator PATCHES
// an existing szpg AppDatabase. Its binary is /manager with no explicit
// FieldOwner, so the write shows manager == "manager". The rejectlist missed
// this; the allowlist MUST catch it, and the message must name it as knext.
func TestKnextBoundaryViolations_FlagsBareManager(t *testing.T) {
	meta := parseMeta(t, cleanAppDatabaseJSON)
	meta.ManagedFields = append(meta.ManagedFields, ManagedFieldsEntry{
		Manager:    "manager", // <- the knext operator's real, default field manager
		Operation:  "Update",
		APIVersion: "apps.scale-zero-pg.dev/v1alpha1",
	})
	got := KnextBoundaryViolations(meta)
	if len(got) != 1 {
		t.Fatalf("a bare `manager` write (the real knext breach) must yield exactly 1 violation, got %d: %v", len(got), got)
	}
	if !strings.Contains(got[0], `"manager"`) {
		t.Fatalf("violation must name the offending manager, got: %q", got[0])
	}
	if !strings.Contains(strings.ToLower(got[0]), "knext") {
		t.Fatalf("a bare `manager` write should be attributed to the knext operator, got: %q", got[0])
	}
}

// An explicitly knext-named field manager (should the operator ever set a
// FieldOwner, or a controller-runtime SSA manager appear) must also be caught —
// it is not in the allowlist.
func TestKnextBoundaryViolations_FlagsKnextNamedManager(t *testing.T) {
	for _, mgr := range []string{"nextapp-controller", "kn-next-operator"} {
		meta := parseMeta(t, cleanAppDatabaseJSON)
		meta.ManagedFields = append(meta.ManagedFields, ManagedFieldsEntry{Manager: mgr, Operation: "Update"})
		got := KnextBoundaryViolations(meta)
		if len(got) != 1 {
			t.Fatalf("knext-named manager %q must yield 1 violation, got %d: %v", mgr, len(got), got)
		}
	}
}

// THE #1215 REGRESSION TEST. cmd/main.go now sets rest.Config.UserAgent to
// controller.OperatorFieldManager ("kn-next-operator") on every write the
// operator makes, so a CURRENT operator build's breach lands with THAT field
// manager, not the bare "manager" checked above (which only older builds
// still emit). It must be caught exactly the same way: the allowlist is
// fail-closed, so "kn-next-operator" is a violation purely because it is
// absent from AllowedAppDatabaseManagersExact/Prefixes. Mutation-prove: add
// "kn-next-operator" (or controller.OperatorFieldManager) to either allowlist
// and this reds.
func TestKnextBoundaryViolations_FlagsCurrentOperatorIdentity(t *testing.T) {
	meta := parseMeta(t, cleanAppDatabaseJSON)
	meta.ManagedFields = append(meta.ManagedFields, ManagedFieldsEntry{
		Manager:    controller.OperatorFieldManager,
		Operation:  "Update",
		APIVersion: "apps.scale-zero-pg.dev/v1alpha1",
	})
	got := KnextBoundaryViolations(meta)
	if len(got) != 1 {
		t.Fatalf("a write under the operator's current self-identity (%q) must yield exactly 1 violation, got %d: %v",
			controller.OperatorFieldManager, len(got), got)
	}
	if !strings.Contains(got[0], controller.OperatorFieldManager) {
		t.Fatalf("violation must name the offending manager %q, got: %q", controller.OperatorFieldManager, got[0])
	}
	if !strings.Contains(strings.ToLower(got[0]), "knext") {
		t.Fatalf("a %q write should be attributed to the knext operator, got: %q", controller.OperatorFieldManager, got[0])
	}
	// Guard the allowlist itself: kn-next-operator must never be allowed,
	// exactly like the bare "manager" default is deliberately absent above.
	if isAllowedAppDatabaseManager(controller.OperatorFieldManager) {
		t.Fatalf("%q must NEVER be an allowed AppDatabase writer", controller.OperatorFieldManager)
	}
}

// FAIL CLOSED: any UNRECOGNISED writer — not just a knext one — is a violation.
// AppDatabase is szpg's resource; an unexpected controller writing it is a
// boundary breach regardless of who it is.
func TestKnextBoundaryViolations_FailsClosedOnUnknownWriter(t *testing.T) {
	meta := parseMeta(t, cleanAppDatabaseJSON)
	meta.ManagedFields = append(meta.ManagedFields, ManagedFieldsEntry{Manager: "some-random-operator", Operation: "Update"})
	got := KnextBoundaryViolations(meta)
	if len(got) != 1 {
		t.Fatalf("an unrecognised writer must yield 1 violation (fail-closed), got %d: %v", len(got), got)
	}
}

// The legitimate szpg + kubectl writers must NEVER be flagged, or the guard
// cries wolf and gets ignored. zone-operator ALSO legitimately creates/owns
// AppDatabase (scale-zero-pg internal/zone/appdbclient.go), so it is allowlisted.
func TestKnextBoundaryViolations_DoesNotFlagLegitWriters(t *testing.T) {
	for _, mgr := range []string{
		"appdb-operator", "zone-operator",
		"kubectl-client-side-apply", "kubectl-create", "kubectl-edit", "kubectl-patch", "kubectl",
	} {
		meta := ObjectMeta{
			Name:          "db-demo",
			ManagedFields: []ManagedFieldsEntry{{Manager: mgr, Operation: "Update"}},
		}
		if got := KnextBoundaryViolations(meta); len(got) != 0 {
			t.Fatalf("legit writer %q must NOT be flagged, got: %v", mgr, got)
		}
	}
}

// An ownerReference pointing at a NextApp means the knext operator took
// ownership of the AppDatabase — a breach even if no managedFields entry shows
// it (owner refs are set on create, before any managed-field write is recorded).
func TestKnextBoundaryViolations_FlagsNextAppOwner(t *testing.T) {
	meta := parseMeta(t, cleanAppDatabaseJSON)
	meta.OwnerReferences = append(meta.OwnerReferences, OwnerReference{
		APIVersion: "apps.kn-next.dev/v1alpha1",
		Kind:       "NextApp",
		Name:       "db-demo",
	})
	got := KnextBoundaryViolations(meta)
	if len(got) != 1 {
		t.Fatalf("a NextApp ownerReference must yield 1 violation, got %d: %v", len(got), got)
	}
	if !strings.Contains(got[0], "NextApp") && !strings.Contains(got[0], "kn-next.dev") {
		t.Fatalf("violation must name the offending owner, got: %q", got[0])
	}
}

// An ownerReference in the knext API group (apps.kn-next.dev) is a breach even
// if its Kind is something other than NextApp (e.g. a future knext-owned kind).
func TestKnextBoundaryViolations_FlagsKnextOwnerGroup(t *testing.T) {
	meta := parseMeta(t, cleanAppDatabaseJSON)
	meta.OwnerReferences = append(meta.OwnerReferences, OwnerReference{
		APIVersion: "apps.kn-next.dev/v1beta1",
		Kind:       "SomethingKnext",
		Name:       "x",
	})
	got := KnextBoundaryViolations(meta)
	if len(got) != 1 {
		t.Fatalf("a knext-group owner must yield 1 violation, got %d: %v", len(got), got)
	}
}

// SzpgManagedAppDatabase must recognise the legitimate szpg writers so the
// driver can reject a vacuous pass (an AppDatabase nobody provisioned).
func TestSzpgManagedAppDatabase(t *testing.T) {
	if !SzpgManagedAppDatabase(parseMeta(t, cleanAppDatabaseJSON)) {
		t.Fatal("appdb-operator-managed AppDatabase must be recognised as szpg-managed")
	}
	// zone-operator is also an szpg writer of AppDatabase.
	if !SzpgManagedAppDatabase(ObjectMeta{ManagedFields: []ManagedFieldsEntry{{Manager: "zone-operator"}}}) {
		t.Fatal("zone-operator-managed AppDatabase must be recognised as szpg-managed")
	}
	// A kubectl-only object is NOT proof szpg provisioned it.
	if SzpgManagedAppDatabase(ObjectMeta{ManagedFields: []ManagedFieldsEntry{{Manager: "kubectl-client-side-apply"}}}) {
		t.Fatal("a kubectl-only object must NOT count as szpg-managed (vacuous-pass guard)")
	}
	// An object with only a knext writer is NOT szpg-managed.
	if SzpgManagedAppDatabase(ObjectMeta{ManagedFields: []ManagedFieldsEntry{{Manager: "manager"}}}) {
		t.Fatal("a knext-only-managed object must NOT count as szpg-managed")
	}
	// An empty object is not szpg-managed (the vacuous-pass case).
	if SzpgManagedAppDatabase(ObjectMeta{Name: "db-demo"}) {
		t.Fatal("an unmanaged (empty) object must NOT count as szpg-managed")
	}
}

// The end-to-end shape the driver uses: unmarshal `kubectl get -o json` and
// assert clean. Proves the JSON tags on the structs match kubectl's output.
func TestParseAppDatabaseObject_RoundTrips(t *testing.T) {
	var obj AppDatabaseObject
	if err := json.Unmarshal([]byte(cleanAppDatabaseJSON), &obj); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if obj.Metadata.Name != "db-demo" {
		t.Fatalf("metadata.name mismatch: %q", obj.Metadata.Name)
	}
	if len(obj.Metadata.ManagedFields) != 3 {
		t.Fatalf("expected 3 managedFields entries, got %d", len(obj.Metadata.ManagedFields))
	}
}
