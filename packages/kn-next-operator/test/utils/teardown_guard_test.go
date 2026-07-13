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

// Unit tests (no build tag, no cluster) for the PURE teardown ownership
// decision behind NamespaceDeletedConfirmed (plan P5). The safety property
// under test: on a SHARED cluster (existing-cluster mode,
// KNEXT_E2E_KUBE_CONTEXT set) a namespace may only be deleted if THIS test
// infrastructure created it — proven by the ownership label stamped at
// creation. Prefix-matching must NEVER authorize teardown there: a teammate's
// hand-made `e2e-foo` namespace is exactly the footgun. The only bypass is
// the explicit, human-set KNEXT_E2E_FORCE_TEARDOWN override.

import (
	"errors"
	"strings"
	"testing"
)

func TestDecideTeardown(t *testing.T) {
	cases := []struct {
		name        string
		req         TeardownRequest
		wantAllow   bool
		wantWarning bool // force-override path must be LOUD
	}{
		{
			name: "labeled namespace in existing-cluster mode: allowed",
			req: TeardownRequest{
				Namespace:       "e2e-cli-abc123",
				NamespaceExists: true,
				OwnedLabel:      E2EOwnershipLabelValue,
				ExistingCluster: true,
			},
			wantAllow: true,
		},
		{
			name: "labeled namespace in kind mode: allowed",
			req: TeardownRequest{
				Namespace:       "kn-next-bundle-e2e",
				NamespaceExists: true,
				OwnedLabel:      E2EOwnershipLabelValue,
				ExistingCluster: false,
			},
			wantAllow: true,
		},
		{
			// THE footgun: a shared-cluster namespace that merely LOOKS like
			// ours. The e2e- prefix must not authorize teardown when
			// KNEXT_E2E_KUBE_CONTEXT points at an existing (shared) cluster.
			name: "unlabeled e2e-prefixed namespace in existing-cluster mode: REFUSED",
			req: TeardownRequest{
				Namespace:       "e2e-foo",
				NamespaceExists: true,
				OwnedLabel:      "",
				ExistingCluster: true,
			},
			wantAllow: false,
		},
		{
			name: "unlabeled arbitrary namespace (KNEXT_E2E_NAMESPACE typo) in existing-cluster mode: REFUSED",
			req: TeardownRequest{
				Namespace:       "default",
				NamespaceExists: true,
				OwnedLabel:      "",
				ExistingCluster: true,
			},
			wantAllow: false,
		},
		{
			// Self-contained kind mode: the generated e2e-* names from runs
			// that predate the ownership label may still be reclaimed by
			// prefix — the whole cluster is throwaway. The fallback now also
			// requires the POSITIVE kind-context check (P6c / #271).
			name: "unlabeled e2e-prefixed namespace in kind mode with a VERIFIED kind context: allowed (prefix fallback)",
			req: TeardownRequest{
				Namespace:       "e2e-rollback-1a2b3c",
				NamespaceExists: true,
				OwnedLabel:      "",
				ExistingCluster: false,
				KindContext:     true,
			},
			wantAllow: true,
		},
		{
			// FAIL CLOSED (P6c gate ruling / #271): "no KNEXT_E2E_KUBE_CONTEXT"
			// does not prove the ambient context is a throwaway kind cluster —
			// it can be an OKE/GKE context. Without the positive kind-*
			// verification the request gets existing-cluster semantics: the
			// ownership label is REQUIRED, the prefix never authorizes.
			name: "unlabeled e2e-prefixed namespace in kind mode with an UNVERIFIED (non-kind/unreadable) context: REFUSED",
			req: TeardownRequest{
				Namespace:       "e2e-rollback-1a2b3c",
				NamespaceExists: true,
				OwnedLabel:      "",
				ExistingCluster: false,
				KindContext:     false,
			},
			wantAllow: false,
		},
		{
			name: "force override still allows the unverified-context case, with warning",
			req: TeardownRequest{
				Namespace:       "e2e-rollback-1a2b3c",
				NamespaceExists: true,
				OwnedLabel:      "",
				ExistingCluster: false,
				KindContext:     false,
				Force:           true,
			},
			wantAllow:   true,
			wantWarning: true,
		},
		{
			name: "ownership label always authorizes, even with an unverified context",
			req: TeardownRequest{
				Namespace:       "e2e-cli-abc123",
				NamespaceExists: true,
				OwnedLabel:      E2EOwnershipLabelValue,
				ExistingCluster: false,
				KindContext:     false,
			},
			wantAllow: true,
		},
		{
			name: "unlabeled non-prefixed namespace in kind mode: REFUSED",
			req: TeardownRequest{
				Namespace:       "kube-system",
				NamespaceExists: true,
				OwnedLabel:      "",
				ExistingCluster: false,
				KindContext:     true,
			},
			wantAllow: false,
		},
		{
			name: "wrong label value never authorizes",
			req: TeardownRequest{
				Namespace:       "some-namespace",
				NamespaceExists: true,
				OwnedLabel:      "false",
				ExistingCluster: true,
			},
			wantAllow: false,
		},
		{
			// The explicit human escape hatch for deliberate reclaim — allowed,
			// but it MUST come back with a loud warning for the caller to log.
			name: "force override allows an unlabeled namespace in existing-cluster mode, with warning",
			req: TeardownRequest{
				Namespace:       "e2e-aborted-old-run",
				NamespaceExists: true,
				OwnedLabel:      "",
				ExistingCluster: true,
				Force:           true,
			},
			wantAllow:   true,
			wantWarning: true,
		},
		{
			name: "force override allows a non-prefixed namespace too (deliberate human action), with warning",
			req: TeardownRequest{
				Namespace:       "team-scratch",
				NamespaceExists: true,
				OwnedLabel:      "",
				ExistingCluster: true,
				Force:           true,
			},
			wantAllow:   true,
			wantWarning: true,
		},
		{
			// A namespace that no longer exists is a no-op deletion — nothing
			// to protect, teardown may proceed (delete is --ignore-not-found
			// and the confirmed read wants NotFound anyway).
			name: "nonexistent namespace: allowed (no-op)",
			req: TeardownRequest{
				Namespace:       "e2e-cli-gone",
				NamespaceExists: false,
				ExistingCluster: true,
			},
			wantAllow: true,
		},
		{
			name: "empty namespace name: REFUSED even with force",
			req: TeardownRequest{
				Namespace:       "",
				NamespaceExists: true,
				OwnedLabel:      E2EOwnershipLabelValue,
				Force:           true,
			},
			wantAllow: false,
		},
		{
			name: "whitespace namespace name: REFUSED even with force",
			req: TeardownRequest{
				Namespace:       "   ",
				NamespaceExists: true,
				Force:           true,
			},
			wantAllow: false,
		},
		{
			name: "invalid DNS-1123 name (uppercase): REFUSED",
			req: TeardownRequest{
				Namespace:       "Default",
				NamespaceExists: true,
				OwnedLabel:      E2EOwnershipLabelValue,
			},
			wantAllow: false,
		},
		{
			name: "invalid DNS-1123 name (embedded space / flag smuggling): REFUSED even with force",
			req: TeardownRequest{
				Namespace:       "e2e-x --all",
				NamespaceExists: true,
				Force:           true,
			},
			wantAllow: false,
		},
		{
			name: "over-63-char name: REFUSED",
			req: TeardownRequest{
				Namespace:       "e2e-" + strings.Repeat("a", 63),
				NamespaceExists: true,
				OwnedLabel:      E2EOwnershipLabelValue,
			},
			wantAllow: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			warning, err := DecideTeardown(tc.req)
			if tc.wantAllow {
				if err != nil {
					t.Fatalf("expected teardown to be allowed, got refusal: %v", err)
				}
			} else {
				if err == nil {
					t.Fatalf("expected teardown to be REFUSED, but it was allowed")
				}
				if !errors.Is(err, ErrTeardownRefused) {
					t.Fatalf("refusal must wrap ErrTeardownRefused (callers fail fast on it), got: %v", err)
				}
			}
			if tc.wantWarning && warning == "" {
				t.Fatalf("force-override path must return a loud warning for the caller to log")
			}
			if !tc.wantWarning && warning != "" {
				t.Fatalf("unexpected warning on a non-override path: %q", warning)
			}
		})
	}
}

// The refusal must be LOUD and actionable: name the namespace, the missing
// authorization (the ownership label), and the override env var.
func TestDecideTeardownRefusalMessage(t *testing.T) {
	_, err := DecideTeardown(TeardownRequest{
		Namespace:       "e2e-foo",
		NamespaceExists: true,
		OwnedLabel:      "",
		ExistingCluster: true,
	})
	if err == nil {
		t.Fatal("expected a refusal")
	}
	msg := err.Error()
	for _, want := range []string{"e2e-foo", E2EOwnershipLabel, E2EForceTeardownEnv} {
		if !strings.Contains(msg, want) {
			t.Errorf("refusal message must mention %q, got:\n%s", want, msg)
		}
	}
}

// The creation-side manifest must stamp the ownership label — creation is the
// ONLY moment the label may be applied (never adopt a pre-existing namespace).
func TestOwnedNamespaceManifestStampsLabel(t *testing.T) {
	m := ownedNamespaceManifest("e2e-cli-abc123")
	if !strings.Contains(m, "name: e2e-cli-abc123") {
		t.Errorf("manifest must name the namespace, got:\n%s", m)
	}
	if !strings.Contains(m, E2EOwnershipLabel+": \""+E2EOwnershipLabelValue+"\"") {
		t.Errorf("manifest must stamp %s=%q at creation, got:\n%s",
			E2EOwnershipLabel, E2EOwnershipLabelValue, m)
	}
}

// Creation-collision decision: "already exists" may only be treated as
// idempotent-success when the collided namespace carries the ownership label
// (a previous run's owned leftover / a retry after a half-committed create).
// An UNLABELED collision means the suite is pointed at a foreign namespace
// (KNEXT_E2E_NAMESPACE typo) and must fail fast AT CREATION — before any
// Secret/NextApp/MinIO is deployed into it — not only at teardown.
func TestDecideCreationCollision(t *testing.T) {
	t.Run("labeled collision proceeds (idempotent retry / owned leftover)", func(t *testing.T) {
		warning, err := DecideCreationCollision("e2e-cli-abc123", E2EOwnershipLabelValue, false)
		if err != nil {
			t.Fatalf("labeled collision must proceed, got: %v", err)
		}
		if warning != "" {
			t.Fatalf("unexpected warning on the labeled path: %q", warning)
		}
	})

	t.Run("unlabeled collision REFUSES at creation, loudly and actionably", func(t *testing.T) {
		_, err := DecideCreationCollision("default", "", false)
		if err == nil {
			t.Fatal("unlabeled collision must be refused at creation")
		}
		if !errors.Is(err, ErrForeignNamespace) {
			t.Fatalf("refusal must wrap ErrForeignNamespace (callers fail fast on it), got: %v", err)
		}
		msg := err.Error()
		for _, want := range []string{"default", E2EOwnershipLabel, E2EForceTeardownEnv} {
			if !strings.Contains(msg, want) {
				t.Errorf("creation refusal must mention %q, got:\n%s", want, msg)
			}
		}
	})

	t.Run("wrong label value is still a refusal", func(t *testing.T) {
		_, err := DecideCreationCollision("e2e-foo", "false", false)
		if !errors.Is(err, ErrForeignNamespace) {
			t.Fatalf("expected ErrForeignNamespace, got: %v", err)
		}
	})

	t.Run("force override proceeds with a loud warning (deliberate reclaim of a pre-guard namespace)", func(t *testing.T) {
		warning, err := DecideCreationCollision("e2e-aborted-old-run", "", true)
		if err != nil {
			t.Fatalf("force override must proceed, got: %v", err)
		}
		if warning == "" {
			t.Fatal("force-override path must return a loud warning for the caller to log")
		}
	})
}

// Env parsing for the override: only explicit truthy values enable it.
func TestForceTeardownEnvParsing(t *testing.T) {
	for _, tc := range []struct {
		val  string
		want bool
	}{
		{"", false}, {"0", false}, {"no", false}, {"false", false},
		{"1", true}, {"true", true}, {"TRUE", true}, {" 1 ", true},
	} {
		t.Setenv(E2EForceTeardownEnv, tc.val)
		if got := forceTeardownEnabled(); got != tc.want {
			t.Errorf("forceTeardownEnabled() with %s=%q = %v, want %v",
				E2EForceTeardownEnv, tc.val, got, tc.want)
		}
	}
}
