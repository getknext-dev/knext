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

// Unit tests (no build tag, no cluster) for the PURE kind-context decision
// behind EnsureKindContext (#271, plan-v2 P6c). The safety property: the
// suites' kind-default mode must never fall back to the AMBIENT kubectl
// context — it pins the expected `kind-<cluster>` context when it exists in
// the kubeconfig, and otherwise refuses BEFORE any cluster operation, naming
// both contexts.

import (
	"strings"
	"testing"
)

func TestResolveKindContext(t *testing.T) {
	cases := []struct {
		name     string
		expected string
		current  string
		contexts []string
		wantCtx  string // "" ⇒ expect refusal
	}{
		{
			name:     "expected kind context present: pinned (regardless of ambient current-context)",
			expected: "kind-kind",
			current:  "oke-prod-cluster",
			contexts: []string{"oke-prod-cluster", "kind-kind", "gke_x_y_z"},
			wantCtx:  "kind-kind",
		},
		{
			name:     "expected kind context present and already current: pinned",
			expected: "kind-kind",
			current:  "kind-kind",
			contexts: []string{"kind-kind"},
			wantCtx:  "kind-kind",
		},
		{
			name:     "expected context absent with a foreign ambient context: REFUSED (never the ambient one)",
			expected: "kind-kind",
			current:  "oke-prod-cluster",
			contexts: []string{"oke-prod-cluster"},
			wantCtx:  "",
		},
		{
			name:     "a DIFFERENT kind cluster does not satisfy the expected one: REFUSED",
			expected: "kind-kind",
			current:  "kind-other",
			contexts: []string{"kind-other"},
			wantCtx:  "",
		},
		{
			name:     "custom KIND_CLUSTER name resolves its own context",
			expected: "kind-knext-e2e",
			current:  "kind-kind",
			contexts: []string{"kind-kind", "kind-knext-e2e"},
			wantCtx:  "kind-knext-e2e",
		},
		{
			name:     "empty kubeconfig (no contexts at all): REFUSED",
			expected: "kind-kind",
			current:  "",
			contexts: nil,
			wantCtx:  "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ResolveKindContext(tc.expected, tc.current, tc.contexts)
			if tc.wantCtx != "" {
				if err != nil {
					t.Fatalf("expected context %q to be pinned, got refusal: %v", tc.wantCtx, err)
				}
				if got != tc.wantCtx {
					t.Fatalf("expected context %q, got %q", tc.wantCtx, got)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected a refusal, got context %q", got)
			}
		})
	}
}

// The refusal must name BOTH contexts (#271 acceptance criterion) so the
// suite operator sees exactly what would have been targeted, and point at
// the explicit existing-cluster escape hatch.
func TestResolveKindContextRefusalNamesBothContexts(t *testing.T) {
	_, err := ResolveKindContext("kind-kind", "oke-prod-cluster", []string{"oke-prod-cluster"})
	if err == nil {
		t.Fatal("expected a refusal")
	}
	msg := err.Error()
	for _, want := range []string{"kind-kind", "oke-prod-cluster", existingClusterEnv} {
		if !strings.Contains(msg, want) {
			t.Errorf("refusal must mention %q, got:\n%s", want, msg)
		}
	}
}

// An unreadable/unset ambient context must still produce a readable refusal.
func TestResolveKindContextRefusalWithUnreadableCurrent(t *testing.T) {
	_, err := ResolveKindContext("kind-kind", "", nil)
	if err == nil {
		t.Fatal("expected a refusal")
	}
	if !strings.Contains(err.Error(), "(none)") {
		t.Errorf("refusal should show the ambient context as (none), got:\n%s", err.Error())
	}
}
