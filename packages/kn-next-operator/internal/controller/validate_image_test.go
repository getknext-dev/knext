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

package controller

import "testing"

// TestValidateImageRef is the table-driven test for the pure validateImageRef
// function extracted from the reconciler's inline image validation.
//
// Acceptance rules (ADR-0001 / A1-digest):
//   - ACCEPT:  image ref that contains "@sha256:" — digest-pinned images
//   - REJECT:  image ref ending in ":latest" — prevents rollbacks
//   - REJECT:  image ref with a plain tag but no "@sha256:" suffix — tag-only refs
//     are mutable and cannot be used to verify image provenance
func TestValidateImageRef(t *testing.T) {
	tests := []struct {
		name    string
		image   string
		wantErr bool
	}{
		// ── ACCEPT ────────────────────────────────────────────────────────────
		{
			name:    "digest pin only (no tag)",
			image:   "registry.example.com/app@sha256:abc123def456",
			wantErr: false,
		},
		{
			name:    "tag + digest pin (both present)",
			image:   "registry.example.com/app:v1.2.3@sha256:abc123def456",
			wantErr: false,
		},
		{
			name:    "gcr.io digest pin",
			image:   "gcr.io/project/app@sha256:deadbeef00000000000000000000000000000000000000000000000000000000",
			wantErr: false,
		},
		// ── REJECT :latest ────────────────────────────────────────────────────
		{
			name:    "bare :latest tag",
			image:   "registry.example.com/app:latest",
			wantErr: true,
		},
		{
			name:    "implicit latest (no tag at all — treated as :latest)",
			image:   "registry.example.com/app",
			wantErr: true,
		},
		// ── REJECT tag-only (no digest) ────────────────────────────────────
		{
			name:    "semver tag without digest",
			image:   "registry.example.com/app:v1.2.3",
			wantErr: true,
		},
		{
			name:    "sha-like tag without @sha256: prefix",
			image:   "registry.example.com/app:abc123def456",
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := validateImageRef(tc.image)
			if tc.wantErr && err == nil {
				t.Errorf("validateImageRef(%q) = nil; want error", tc.image)
			}
			if !tc.wantErr && err != nil {
				t.Errorf("validateImageRef(%q) = %v; want nil", tc.image, err)
			}
		})
	}
}
