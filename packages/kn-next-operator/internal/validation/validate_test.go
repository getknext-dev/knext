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

package validation

import (
	"strings"
	"testing"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

const digestImage = "registry.example.com/app:v1@sha256:abc123def456"

func TestValidateImageRef(t *testing.T) {
	tests := []struct {
		name    string
		image   string
		wantErr bool
	}{
		{"digest pin only", "registry.example.com/app@sha256:abc123", false},
		{"tag + digest", digestImage, false},
		{"bare :latest", "registry.example.com/app:latest", true},
		{"implicit latest (no tag)", "registry.example.com/app", true},
		{"tag-only no digest", "registry.example.com/app:v1.2.3", true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateImageRef(tc.image)
			if tc.wantErr != (err != nil) {
				t.Fatalf("ValidateImageRef(%q) err=%v, wantErr=%v", tc.image, err, tc.wantErr)
			}
		})
	}
}

func TestValidateNextAppSpec(t *testing.T) {
	tests := []struct {
		name    string
		spec    *appsv1alpha1.NextAppSpec
		wantErr bool
		errHas  string
	}{
		{
			name:    "nil spec rejected",
			spec:    nil,
			wantErr: true,
		},
		{
			name:    "missing image rejected",
			spec:    &appsv1alpha1.NextAppSpec{Image: ""},
			wantErr: true,
			errHas:  "image is required",
		},
		{
			name:    "latest image rejected",
			spec:    &appsv1alpha1.NextAppSpec{Image: "registry.example.com/app:latest"},
			wantErr: true,
			errHas:  ":latest",
		},
		{
			name:    "tag-only image rejected",
			spec:    &appsv1alpha1.NextAppSpec{Image: "registry.example.com/app:v1.2.3"},
			wantErr: true,
		},
		{
			name:    "valid digest-pinned minimal spec accepted",
			spec:    &appsv1alpha1.NextAppSpec{Image: digestImage},
			wantErr: false,
		},
		{
			name: "negative minScale rejected",
			spec: &appsv1alpha1.NextAppSpec{
				Image:   digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{MinScale: -1, MaxScale: 5},
			},
			wantErr: true,
			errHas:  "minScale",
		},
		{
			name: "minScale > maxScale rejected",
			spec: &appsv1alpha1.NextAppSpec{
				Image:   digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{MinScale: 5, MaxScale: 2},
			},
			wantErr: true,
			errHas:  "minScale",
		},
		{
			name: "minScale <= maxScale accepted",
			spec: &appsv1alpha1.NextAppSpec{
				Image:   digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{MinScale: 1, MaxScale: 10},
			},
			wantErr: false,
		},
		{
			name: "maxScale 0 (unbounded) with positive minScale accepted",
			spec: &appsv1alpha1.NextAppSpec{
				Image:   digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{MinScale: 3, MaxScale: 0},
			},
			wantErr: false,
		},
		{
			name: "negative containerConcurrency rejected",
			spec: &appsv1alpha1.NextAppSpec{
				Image:   digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{ContainerConcurrency: -5},
			},
			wantErr: true,
			errHas:  "containerConcurrency",
		},
		{
			name: "unknown storage provider rejected",
			spec: &appsv1alpha1.NextAppSpec{
				Image:   digestImage,
				Storage: &appsv1alpha1.StorageSpec{Provider: "gsc"},
			},
			wantErr: true,
			errHas:  "storage.provider",
		},
		{
			name: "known storage provider accepted",
			spec: &appsv1alpha1.NextAppSpec{
				Image:   digestImage,
				Storage: &appsv1alpha1.StorageSpec{Provider: "gcs"},
			},
			wantErr: false,
		},
		{
			name: "unknown cache provider rejected",
			spec: &appsv1alpha1.NextAppSpec{
				Image: digestImage,
				Cache: &appsv1alpha1.CacheSpec{Provider: "memcached"},
			},
			wantErr: true,
			errHas:  "cache.provider",
		},
		{
			name: "known cache provider accepted",
			spec: &appsv1alpha1.NextAppSpec{
				Image: digestImage,
				Cache: &appsv1alpha1.CacheSpec{Provider: "redis"},
			},
			wantErr: false,
		},
		{
			name: "unknown revalidation queue rejected",
			spec: &appsv1alpha1.NextAppSpec{
				Image:        digestImage,
				Revalidation: &appsv1alpha1.RevalidationSpec{Queue: "rabbitmq"},
			},
			wantErr: true,
			errHas:  "revalidation.queue",
		},
		{
			name: "known revalidation queue accepted",
			spec: &appsv1alpha1.NextAppSpec{
				Image:        digestImage,
				Revalidation: &appsv1alpha1.RevalidationSpec{Queue: "kafka"},
			},
			wantErr: false,
		},
		{
			name: "canaryPercent without pinned revisionName rejected (#92)",
			spec: &appsv1alpha1.NextAppSpec{
				Image:   digestImage,
				Traffic: &appsv1alpha1.TrafficSpec{CanaryPercent: 50},
			},
			wantErr: true,
			errHas:  "canaryPercent requires",
		},
		{
			name: "canaryPercent with pinned revisionName accepted (#92)",
			spec: &appsv1alpha1.NextAppSpec{
				Image:   digestImage,
				Traffic: &appsv1alpha1.TrafficSpec{RevisionName: "app-00002", CanaryPercent: 50},
			},
			wantErr: false,
		},
		{
			name: "pinned revisionName with no canary accepted (#92)",
			spec: &appsv1alpha1.NextAppSpec{
				Image:   digestImage,
				Traffic: &appsv1alpha1.TrafficSpec{RevisionName: "app-00002"},
			},
			wantErr: false,
		},
		{
			name: "nil traffic accepted (back-compat #92)",
			spec: &appsv1alpha1.NextAppSpec{
				Image: digestImage,
			},
			wantErr: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateNextAppSpec(tc.spec)
			if tc.wantErr != (err != nil) {
				t.Fatalf("ValidateNextAppSpec() err=%v, wantErr=%v", err, tc.wantErr)
			}
			if tc.errHas != "" && (err == nil || !strings.Contains(err.Error(), tc.errHas)) {
				t.Fatalf("ValidateNextAppSpec() err=%v, want substring %q", err, tc.errHas)
			}
		})
	}
}

// ADR-0019 — spec.database binding (BYO) validation mirror. These duplicate the
// CRD CEL rules as defense-in-depth for the webhook + reconciler (CRs that
// predate the CEL rules).
func TestValidateNextAppSpecDatabaseBinding(t *testing.T) {
	ref := func(name string) *appsv1alpha1.DatabaseSecretRef {
		return &appsv1alpha1.DatabaseSecretRef{Name: name}
	}
	envMapURL := &appsv1alpha1.SecretsSpec{
		EnvMap: map[string]appsv1alpha1.EnvMapEntry{
			"DATABASE_URL": {SecretName: "other", SecretKey: "url"},
		},
	}

	tests := []struct {
		name    string
		spec    *appsv1alpha1.NextAppSpec
		wantErr bool
		errHas  string
	}{
		{
			name: "plain secretRef accepted",
			spec: &appsv1alpha1.NextAppSpec{
				Image:    digestImage,
				Database: &appsv1alpha1.DatabaseSpec{SecretRef: ref("shop-db")},
			},
		},
		{
			name: "secretRef + roSecretRef accepted",
			spec: &appsv1alpha1.NextAppSpec{
				Image:    digestImage,
				Database: &appsv1alpha1.DatabaseSpec{SecretRef: ref("shop-db"), ROSecretRef: ref("shop-db")},
			},
		},
		{
			name: "non-DNS-1123 secret name rejected",
			spec: &appsv1alpha1.NextAppSpec{
				Image:    digestImage,
				Database: &appsv1alpha1.DatabaseSpec{SecretRef: ref("Not_Valid")},
			},
			wantErr: true,
			errHas:  "secretRef.name",
		},
		{
			name: "empty secretRef name rejected",
			spec: &appsv1alpha1.NextAppSpec{
				Image:    digestImage,
				Database: &appsv1alpha1.DatabaseSpec{SecretRef: ref("")},
			},
			wantErr: true,
		},
		{
			name: "non-DNS-1123 roSecretRef name rejected",
			spec: &appsv1alpha1.NextAppSpec{
				Image:    digestImage,
				Database: &appsv1alpha1.DatabaseSpec{SecretRef: ref("shop-db"), ROSecretRef: ref("UPPER")},
			},
			wantErr: true,
			errHas:  "roSecretRef.name",
		},
		{
			name: "roSecretRef without secretRef rejected",
			spec: &appsv1alpha1.NextAppSpec{
				Image:    digestImage,
				Database: &appsv1alpha1.DatabaseSpec{ROSecretRef: ref("shop-db")},
			},
			wantErr: true,
			errHas:  "roSecretRef",
		},
		{
			// Collisions are deliberately NOT part of ValidateNextAppSpec: the
			// reconciler runs it fail-closed, so a stored (pre-rule) collision
			// CR would brick on operator upgrade. The webhook enforces them
			// with true ratcheting — see TestDatabaseEnvMapCollisions below
			// and the webhook tests.
			name: "secretRef colliding with envMap DATABASE_URL is NOT a shared-validation error (webhook-only, ratcheted)",
			spec: &appsv1alpha1.NextAppSpec{
				Image:    digestImage,
				Database: &appsv1alpha1.DatabaseSpec{SecretRef: ref("shop-db")},
				Secrets:  envMapURL,
			},
			wantErr: false,
		},
		{
			name: "envMap for OTHER env vars alongside secretRef accepted",
			spec: &appsv1alpha1.NextAppSpec{
				Image:    digestImage,
				Database: &appsv1alpha1.DatabaseSpec{SecretRef: ref("shop-db")},
				Secrets: &appsv1alpha1.SecretsSpec{
					EnvMap: map[string]appsv1alpha1.EnvMapEntry{
						"STRIPE_KEY": {SecretName: "stripe", SecretKey: "key"},
					},
				},
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateNextAppSpec(tc.spec)
			if tc.wantErr != (err != nil) {
				t.Fatalf("ValidateNextAppSpec() err=%v, wantErr=%v", err, tc.wantErr)
			}
			if tc.errHas != "" && (err == nil || !strings.Contains(err.Error(), tc.errHas)) {
				t.Fatalf("ValidateNextAppSpec() err=%v, want substring %q", err, tc.errHas)
			}
		})
	}
}

// TestDatabaseEnvMapCollisions covers the webhook-side collision detector
// (ADR-0019 rules 3/4). The webhook applies it unratcheted on CREATE and
// ratcheted on UPDATE (only NEW collisions rejected).
func TestDatabaseEnvMapCollisions(t *testing.T) {
	ref := func(name string) *appsv1alpha1.DatabaseSecretRef {
		return &appsv1alpha1.DatabaseSecretRef{Name: name}
	}
	envMap := func(names ...string) *appsv1alpha1.SecretsSpec {
		m := map[string]appsv1alpha1.EnvMapEntry{}
		for _, n := range names {
			m[n] = appsv1alpha1.EnvMapEntry{SecretName: "other", SecretKey: "k"}
		}
		return &appsv1alpha1.SecretsSpec{EnvMap: m}
	}

	tests := []struct {
		name string
		spec *appsv1alpha1.NextAppSpec
		want []string
	}{
		{
			name: "nil database — none",
			spec: &appsv1alpha1.NextAppSpec{Secrets: envMap("DATABASE_URL")},
			want: nil,
		},
		{
			name: "BYO + envMap DATABASE_URL",
			spec: &appsv1alpha1.NextAppSpec{
				Database: &appsv1alpha1.DatabaseSpec{SecretRef: ref("shop-db")},
				Secrets:  envMap("DATABASE_URL"),
			},
			want: []string{"DATABASE_URL"},
		},
		{
			name: "BYO+RO + both envMap entries",
			spec: &appsv1alpha1.NextAppSpec{
				Database: &appsv1alpha1.DatabaseSpec{SecretRef: ref("shop-db"), ROSecretRef: ref("shop-db")},
				Secrets:  envMap("DATABASE_URL", "DATABASE_URL_RO"),
			},
			want: []string{"DATABASE_URL", "DATABASE_URL_RO"},
		},
		{
			name: "other env vars never collide",
			spec: &appsv1alpha1.NextAppSpec{
				Database: &appsv1alpha1.DatabaseSpec{SecretRef: ref("shop-db")},
				Secrets:  envMap("STRIPE_KEY"),
			},
			want: nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := DatabaseEnvMapCollisions(tc.spec)
			if len(got) != len(tc.want) {
				t.Fatalf("DatabaseEnvMapCollisions() = %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("DatabaseEnvMapCollisions() = %v, want %v", got, tc.want)
				}
			}
		})
	}
}
