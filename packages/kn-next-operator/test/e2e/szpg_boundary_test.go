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
// (apps.scale-zero-pg.dev) must be owned/managed ONLY by the szpg appdb-operator
// (and kubectl / whatever provisioned it). The knext operator NEVER reads or
// writes AppDatabase (nextapp_types.go:531, ADR-0001 boundary / data
// sovereignty). This file proves the DETECTION logic; szpg_profile_b_test.go
// drives it against a live AppDatabase's `kubectl get -o json`.

package e2e

import (
	"encoding/json"
	"strings"
	"testing"
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

// The happy path: a legitimately-provisioned AppDatabase has ZERO knext
// writers, so the boundary holds and no violations are returned.
func TestKnextBoundaryViolations_CleanIsEmpty(t *testing.T) {
	got := KnextBoundaryViolations(parseMeta(t, cleanAppDatabaseJSON))
	if len(got) != 0 {
		t.Fatalf("clean AppDatabase must yield NO violations, got %d: %v", len(got), got)
	}
}

// A managedFields entry whose manager identifies the knext operator is a
// boundary breach — knext wrote to a resource it must never touch.
func TestKnextBoundaryViolations_FlagsKnextManager(t *testing.T) {
	meta := parseMeta(t, cleanAppDatabaseJSON)
	meta.ManagedFields = append(meta.ManagedFields, ManagedFieldsEntry{
		Manager:    "nextapp-controller",
		Operation:  "Update",
		APIVersion: "apps.scale-zero-pg.dev/v1alpha1",
	})
	got := KnextBoundaryViolations(meta)
	if len(got) != 1 {
		t.Fatalf("a knext field manager must yield exactly 1 violation, got %d: %v", len(got), got)
	}
	if !strings.Contains(got[0], "nextapp-controller") {
		t.Fatalf("violation must name the offending manager, got: %q", got[0])
	}
}

// The generic controller-runtime binary field manager ("kn-next-operator")
// must also be caught — it is the same operator by another name.
func TestKnextBoundaryViolations_FlagsOperatorBinaryManager(t *testing.T) {
	meta := parseMeta(t, cleanAppDatabaseJSON)
	meta.ManagedFields = append(meta.ManagedFields, ManagedFieldsEntry{
		Manager:   "kn-next-operator",
		Operation: "Apply",
	})
	got := KnextBoundaryViolations(meta)
	if len(got) != 1 {
		t.Fatalf("the operator binary manager must yield 1 violation, got %d: %v", len(got), got)
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

// szpg's OWN managers (appdb-operator, kubectl, client-go) must NEVER be
// flagged — the guard must not false-positive on the legitimate writers, or the
// whole harness cries wolf and gets ignored.
func TestKnextBoundaryViolations_DoesNotFlagSzpgManagers(t *testing.T) {
	for _, mgr := range []string{"appdb-operator", "kubectl-client-side-apply", "kubectl-edit", "scale-zero-pg-gateway", "pggw"} {
		meta := ObjectMeta{
			Name:          "db-demo",
			ManagedFields: []ManagedFieldsEntry{{Manager: mgr, Operation: "Update"}},
		}
		if got := KnextBoundaryViolations(meta); len(got) != 0 {
			t.Fatalf("szpg manager %q must NOT be flagged, got: %v", mgr, got)
		}
	}
}

// Case-insensitivity: apiserver casing / mixed-case managers must not let a
// knext write slip through.
func TestKnextBoundaryViolations_CaseInsensitive(t *testing.T) {
	meta := ObjectMeta{
		Name:          "db-demo",
		ManagedFields: []ManagedFieldsEntry{{Manager: "NextApp-Controller", Operation: "Update"}},
	}
	if got := KnextBoundaryViolations(meta); len(got) != 1 {
		t.Fatalf("mixed-case knext manager must be flagged, got %d: %v", len(got), got)
	}
}

// SzpgManagedAppDatabase must recognise the legitimate szpg writer so the
// driver can reject a vacuous pass (an AppDatabase nobody provisioned).
func TestSzpgManagedAppDatabase(t *testing.T) {
	if !SzpgManagedAppDatabase(parseMeta(t, cleanAppDatabaseJSON)) {
		t.Fatal("appdb-operator-managed AppDatabase must be recognised as szpg-managed")
	}
	// An object with only a knext writer (and no szpg writer) is NOT szpg-managed.
	knextOnly := ObjectMeta{
		Name:          "db-demo",
		ManagedFields: []ManagedFieldsEntry{{Manager: "nextapp-controller", Operation: "Update"}},
	}
	if SzpgManagedAppDatabase(knextOnly) {
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
