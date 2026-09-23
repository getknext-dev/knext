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

// Pure Profile-B (P4a, #1203) boundary logic: given an AppDatabase custom
// resource's metadata (as `kubectl get appdatabase -o json` emits it), decide
// whether ANY non-legitimate writer — the KNEXT operator above all — wrote to /
// owns it. It must NOT: nextapp_types.go:531 states "knext's operator never
// reads or writes AppDatabase (ADR-0001 boundary)", and scs-zones.md makes zone
// data sovereignty a hard rule. This file is the machine-checkable form of that
// invariant.
//
// WHY AN ALLOWLIST, NOT A REJECTLIST (cr-1214, jev 0.91). The knext operator
// binary is `/manager` and sets NO explicit FieldOwner/FieldManager/UserAgent
// anywhere, so a real knext write to an AppDatabase lands with field manager ==
// the bare "manager" (client-go's default, derived from os.Args[0]). A rejectlist
// keyed on "nextapp"/"kn-next" MISSES that entirely — proven live: an AppDatabase
// with managedFields {appdb-operator, manager} false-passed. "nextapp-controller"
// is only the operator's EVENT RECORDER name (cmd/main.go:183), never a field
// manager. So the check inverts: only KNOWN-LEGITIMATE writers of an AppDatabase
// are allowed, and anything else — "manager" included — is a violation. FAIL
// CLOSED: an unrecognised writer is a violation, not a pass.
//
// Kept UNTAGGED (no e2e_szpg build tag) and free of cluster/k8s imports so it
// compiles and is mutation-proved by szpg_boundary_test.go under a plain
// `go test ./...` on every PR — the same discipline as the Profile-A helpers
// (scale_profile_a_helpers.go, #1202). The build-tagged driver
// (szpg_profile_b_test.go) feeds it a LIVE AppDatabase from the cluster.

package e2e

import (
	"fmt"
	"strings"
)

// AllowedAppDatabaseManagersExact are the field managers that may LEGITIMATELY
// write an AppDatabase, matched case-insensitively and in FULL. These are the
// szpg control-plane binaries whose client-go default field manager is the
// binary base name:
//
//   - "appdb-operator" — the szpg operator that reconciles AppDatabase
//     (deploy/83-appdb-operator.yaml, gateway/cmd/appdb-operator).
//   - "zone-operator"  — ALSO creates/owns AppDatabase for zones
//     (gateway/internal/zone/appdbclient.go: "The Zone operator OWNS the
//     AppDatabase it creates").
//
// The bare generic "manager" is DELIBERATELY ABSENT — that is the knext
// operator's default field manager and the exact breach this guard exists to
// catch. Do NOT add it.
var AllowedAppDatabaseManagersExact = []string{
	"appdb-operator",
	"zone-operator",
}

// AllowedAppDatabaseManagerPrefixes are legitimate field-manager prefixes,
// matched case-insensitively. "kubectl" covers the human/CI setup family
// (kubectl-client-side-apply / kubectl-create / kubectl-edit / kubectl-patch /
// kubectl for server-side apply). "scale-zero-pg" is defensive headroom for any
// szpg component that identifies with the platform name.
var AllowedAppDatabaseManagerPrefixes = []string{
	"kubectl",
	"scale-zero-pg",
}

// KnextManagerHints are case-insensitive substrings/exact tokens that let a
// violation MESSAGE attribute an unrecognised write to the knext operator rather
// than to a generic third party. They do NOT drive detection (the allowlist
// does) — they only improve the human-readable reason. "manager" is matched
// exactly (it is the knext binary's default field manager); the others catch a
// knext-named manager should one ever appear.
var KnextManagerHints = []string{
	"nextapp",
	"kn-next",
	"knext",
}

// KnextOwnerAPIGroups are apiVersion group substrings whose presence in an
// AppDatabase ownerReference means the knext operator took ownership of it. The
// knext CRD group is apps.kn-next.dev (cr-builder.ts / nextapp_types.go).
var KnextOwnerAPIGroups = []string{
	"apps.kn-next.dev",
	"kn-next.dev",
}

// KnextOwnerKinds are ownerReference kinds the knext operator sets as controller
// (ctrl.SetControllerReference(&nextApp, ...)). No AppDatabase should carry one.
var KnextOwnerKinds = []string{
	"NextApp",
}

// SzpgManagerTokens identify the szpg control-plane writers of an AppDatabase —
// the LEGITIMATE provisioners. Used by SzpgManagedAppDatabase to reject the
// vacuous-pass failure mode: an AppDatabase managed only by kubectl or by
// nothing at all is NOT proof the szpg operator provisioned it, so the driver
// must not report "boundary PASSED" over it.
var SzpgManagerTokens = []string{
	"appdb-operator",
	"zone-operator",
	"scale-zero-pg",
}

// ManagedFieldsEntry is the subset of metadata.managedFields[] the boundary
// check reads. Extra kubectl fields (fieldsType, time, ...) are ignored.
type ManagedFieldsEntry struct {
	Manager    string `json:"manager"`
	Operation  string `json:"operation"`
	APIVersion string `json:"apiVersion"`
}

// OwnerReference is the subset of metadata.ownerReferences[] the check reads.
type OwnerReference struct {
	APIVersion string `json:"apiVersion"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
}

// ObjectMeta is the subset of an object's metadata the boundary check needs.
type ObjectMeta struct {
	Name            string               `json:"name"`
	Namespace       string               `json:"namespace"`
	ManagedFields   []ManagedFieldsEntry `json:"managedFields"`
	OwnerReferences []OwnerReference     `json:"ownerReferences"`
}

// AppDatabaseObject unmarshals `kubectl get appdatabase <n> -o json`.
type AppDatabaseObject struct {
	Metadata ObjectMeta `json:"metadata"`
}

// matchIdentifier reports whether s contains (case-insensitively) any of the
// given substrings, returning the first match for a readable violation message.
func matchIdentifier(s string, identifiers []string) (string, bool) {
	ls := strings.ToLower(s)
	for _, id := range identifiers {
		if strings.Contains(ls, strings.ToLower(id)) {
			return id, true
		}
	}
	return "", false
}

// isAllowedAppDatabaseManager reports whether a field manager is a
// known-legitimate writer of an AppDatabase (szpg control plane + human/CI
// kubectl). Everything else — the bare "manager" of the knext operator
// included — is NOT allowed. Matching is case-insensitive; exact for the szpg
// binaries, prefix for the kubectl/szpg families.
func isAllowedAppDatabaseManager(manager string) bool {
	m := strings.ToLower(strings.TrimSpace(manager))
	if m == "" {
		return false // an empty manager is never legitimate — fail closed
	}
	for _, a := range AllowedAppDatabaseManagersExact {
		if m == strings.ToLower(a) {
			return true
		}
	}
	for _, p := range AllowedAppDatabaseManagerPrefixes {
		if strings.HasPrefix(m, strings.ToLower(p)) {
			return true
		}
	}
	return false
}

// KnextBoundaryViolations inspects an AppDatabase's metadata and returns a list
// of human-readable violations. An EMPTY slice means the ADR-0001 boundary held:
// EVERY writer is a known-legitimate one (szpg / kubectl) and no knext owner ref
// is present. A NON-empty slice must fail the Profile-B drill loudly — it is a
// data-sovereignty breach, not a flake.
//
// The managedFields leg is an ALLOWLIST (fail-closed): any manager NOT in the
// allowlist is a violation, which is what actually catches a knext write
// (manager == "manager"). The ownerReference leg is secondary — a knext CREATE
// would set a NextApp owner ref, which a patch/update would not show, so both
// legs are needed.
func KnextBoundaryViolations(meta ObjectMeta) []string {
	var violations []string

	for _, mf := range meta.ManagedFields {
		if isAllowedAppDatabaseManager(mf.Manager) {
			continue
		}
		who := "an unrecognised writer"
		if _, ok := matchIdentifier(mf.Manager, KnextManagerHints); ok || strings.EqualFold(strings.TrimSpace(mf.Manager), "manager") {
			who = "the knext operator (its binary is /manager, no explicit FieldOwner)"
		}
		violations = append(violations, fmt.Sprintf(
			"managedFields manager %q is not an allowed AppDatabase writer — %s (operation %s); only szpg (appdb-operator/zone-operator) and kubectl may write AppDatabase",
			mf.Manager, who, mf.Operation))
	}

	for _, or := range meta.OwnerReferences {
		if id, ok := matchIdentifier(or.APIVersion, KnextOwnerAPIGroups); ok {
			violations = append(violations, fmt.Sprintf(
				"ownerReference apiVersion %q is in knext group %q (kind %s, name %s) — knext owns AppDatabase",
				or.APIVersion, id, or.Kind, or.Name))
			continue
		}
		for _, k := range KnextOwnerKinds {
			if strings.EqualFold(or.Kind, k) {
				violations = append(violations, fmt.Sprintf(
					"ownerReference kind %q (apiVersion %s, name %s) is a knext-owned kind — knext owns AppDatabase",
					or.Kind, or.APIVersion, or.Name))
			}
		}
	}

	return violations
}

// SzpgManagedAppDatabase reports whether the szpg control plane (appdb-operator
// or zone-operator) appears as a managedFields writer on the object — i.e. it
// really did provision it. The Profile-B assertion pairs this with an empty
// KnextBoundaryViolations: szpg owns the AppDatabase, knext owns nothing on it.
// A kubectl-only or empty object is NOT szpg-managed — that is the vacuous-pass
// guard, so a "boundary PASSED" is never reported over an object the szpg
// operator never touched.
func SzpgManagedAppDatabase(meta ObjectMeta) bool {
	for _, mf := range meta.ManagedFields {
		if _, ok := matchIdentifier(mf.Manager, SzpgManagerTokens); ok {
			return true
		}
	}
	return false
}
