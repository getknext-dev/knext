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
// whether the KNEXT operator wrote to it. It must NOT: nextapp_types.go:531
// states "knext's operator never reads or writes AppDatabase (ADR-0001
// boundary)", and scs-zones.md makes zone data sovereignty a hard rule. This
// file is the machine-checkable form of that invariant.
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

// KnextManagerIdentifiers are case-insensitive substrings that mark a
// managedFields entry's `manager` as the KNEXT operator (a controller-runtime
// field manager or the operator binary). If any appears on an AppDatabase, knext
// wrote to a resource it must never touch.
//
// These are KNEXT-specific on purpose. The szpg writers — "appdb-operator",
// "kubectl-*", "pggw"/"scale-zero-pg-gateway" — do not contain any of these
// substrings, so the guard cannot false-positive on the legitimate owners
// (proven by TestKnextBoundaryViolations_DoesNotFlagSzpgManagers). "manager"
// alone is deliberately NOT listed: it is the generic controller-runtime
// default and would also match szpg's own controllers.
var KnextManagerIdentifiers = []string{
	"nextapp",          // nextapp-controller (mgr.GetEventRecorderFor / client field manager)
	"kn-next-operator", // the operator binary / user-agent
	"knext-operator",
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

// SzpgManagerIdentifiers are case-insensitive substrings that mark a
// managedFields entry as belonging to the szpg (scale-zero-pg) control plane —
// the LEGITIMATE owner of an AppDatabase. Used to reject the vacuous-pass
// failure mode: an AppDatabase with NO knext writer AND no szpg writer either
// (e.g. an empty/half-provisioned object) would pass KnextBoundaryViolations
// while proving nothing. The Profile-B driver asserts BOTH "knext wrote nothing"
// AND "szpg did provision it".
var SzpgManagerIdentifiers = []string{
	"appdb-operator",
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

// KnextBoundaryViolations inspects an AppDatabase's metadata and returns a list
// of human-readable violations proving the knext operator wrote to / owns it. An
// EMPTY slice means the ADR-0001 boundary held: knext touched nothing, and the
// AppDatabase is managed solely by szpg (+ kubectl). A NON-empty slice must fail
// the Profile-B drill loudly — it is a data-sovereignty breach, not a flake.
func KnextBoundaryViolations(meta ObjectMeta) []string {
	var violations []string

	for _, mf := range meta.ManagedFields {
		if id, ok := matchIdentifier(mf.Manager, KnextManagerIdentifiers); ok {
			violations = append(violations, fmt.Sprintf(
				"managedFields manager %q matches knext identifier %q (operation %s) — knext wrote to AppDatabase",
				mf.Manager, id, mf.Operation))
		}
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

// SzpgManagedAppDatabase reports whether the szpg control plane appears as a
// managedFields writer on the object — i.e. it really did provision it. The
// Profile-B assertion pairs this with an empty KnextBoundaryViolations: szpg
// owns the AppDatabase, knext owns nothing on it.
func SzpgManagedAppDatabase(meta ObjectMeta) bool {
	for _, mf := range meta.ManagedFields {
		if _, ok := matchIdentifier(mf.Manager, SzpgManagerIdentifiers); ok {
			return true
		}
	}
	return false
}
