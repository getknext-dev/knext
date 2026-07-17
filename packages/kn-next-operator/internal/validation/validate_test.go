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
			// Connection-wall invariant (#377, ADR-0028): with a declared
			// per-pod pool.max, maxScale * poolMax must not exceed the app
			// connection budget MaxAppConnections (80 = GW_MAX_CONNS 90 minus a
			// ~10 reserve for superuser_reserved_connections + replication +
			// wake-probe headroom). Lowering ContainerConcurrency makes apps
			// scale to more pods sooner, so this guards against a lower cc
			// silently enabling connection exhaustion.
			name: "maxScale * poolMax exceeding app budget rejected (#377)",
			spec: &appsv1alpha1.NextAppSpec{
				Image:   digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{MaxScale: 10, PoolMax: 20},
			},
			wantErr: true,
			errHas:  "connection budget",
		},
		{
			name: "maxScale * poolMax within app budget accepted (#377)",
			spec: &appsv1alpha1.NextAppSpec{
				Image:   digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{MaxScale: 10, PoolMax: 5},
			},
			wantErr: false,
		},
		{
			// 10 × 8 = 80 == MaxAppConnections — the boundary is INCLUSIVE.
			name: "maxScale * poolMax exactly at app budget (80) accepted (#377)",
			spec: &appsv1alpha1.NextAppSpec{
				Image:   digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{MaxScale: 10, PoolMax: 8},
			},
			wantErr: false,
		},
		{
			// 27 × 3 = 81 — one over MaxAppConnections — rejected.
			name: "maxScale * poolMax one over app budget (81) rejected (#377)",
			spec: &appsv1alpha1.NextAppSpec{
				Image:   digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{MaxScale: 27, PoolMax: 3},
			},
			wantErr: true,
			errHas:  "connection budget",
		},
		{
			// 10 × 10 = 100 (= Postgres max_connections) is now REJECTED: it
			// blows past both the 90 gateway cap and the 80 app budget, leaving
			// zero admin/replication headroom.
			name: "maxScale * poolMax at Postgres max_connections (100) rejected (#377)",
			spec: &appsv1alpha1.NextAppSpec{
				Image:   digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{MaxScale: 10, PoolMax: 10},
			},
			wantErr: true,
			errHas:  "connection budget",
		},
		{
			// poolMax unset (0) means "not declared" — the cap check is skipped
			// (the operator can't verify the wall it doesn't know about; it is
			// documented loudly in ADR-0028 instead). Back-compat for every
			// existing CR that never set poolMax.
			name: "poolMax unset skips the cap check (#377 back-compat)",
			spec: &appsv1alpha1.NextAppSpec{
				Image:   digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{MaxScale: 50},
			},
			wantErr: false,
		},
		{
			// maxScale 0 (unbounded) with a declared poolMax cannot satisfy a
			// finite budget — an unbounded fan-out against a fixed
			// MaxAppConnections is exactly the exhaustion this guards.
			name: "unbounded maxScale with declared poolMax rejected (#377)",
			spec: &appsv1alpha1.NextAppSpec{
				Image:   digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{MaxScale: 0, PoolMax: 5},
			},
			wantErr: true,
			errHas:  "connection budget",
		},
		{
			name: "negative poolMax rejected (#377)",
			spec: &appsv1alpha1.NextAppSpec{
				Image:   digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{PoolMax: -1},
			},
			wantErr: true,
			errHas:  "poolMax",
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
			name: "warmSchedule window with empty start rejected (#380)",
			spec: &appsv1alpha1.NextAppSpec{
				Image: digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{
					WarmSchedule: []appsv1alpha1.WarmWindow{
						{Start: "", End: "0 20 * * *", Replicas: 2},
					},
				},
			},
			wantErr: true,
			errHas:  "warmSchedule",
		},
		{
			name: "warmSchedule window with empty end rejected (#380)",
			spec: &appsv1alpha1.NextAppSpec{
				Image: digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{
					WarmSchedule: []appsv1alpha1.WarmWindow{
						{Start: "0 8 * * *", End: "", Replicas: 2},
					},
				},
			},
			wantErr: true,
			errHas:  "warmSchedule",
		},
		{
			name: "warmSchedule window with malformed start cron rejected (#380)",
			spec: &appsv1alpha1.NextAppSpec{
				Image: digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{
					WarmSchedule: []appsv1alpha1.WarmWindow{
						{Start: "not a cron", End: "0 20 * * *", Replicas: 2},
					},
				},
			},
			wantErr: true,
			errHas:  "cron",
		},
		{
			name: "warmSchedule window with wrong field-count cron rejected (#380)",
			spec: &appsv1alpha1.NextAppSpec{
				Image: digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{
					WarmSchedule: []appsv1alpha1.WarmWindow{
						// 6 fields (has a seconds field) — not the K8s 5-field CronJob format.
						{Start: "0 0 8 * * 1-5", End: "0 20 * * *", Replicas: 2},
					},
				},
			},
			wantErr: true,
			errHas:  "cron",
		},
		{
			name: "warmSchedule window with out-of-range cron field rejected (#380)",
			spec: &appsv1alpha1.NextAppSpec{
				Image: digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{
					WarmSchedule: []appsv1alpha1.WarmWindow{
						// minute 99 is out of range.
						{Start: "99 8 * * *", End: "0 20 * * *", Replicas: 2},
					},
				},
			},
			wantErr: true,
			errHas:  "cron",
		},
		{
			name: "warmSchedule window with replicas < 1 rejected (#380)",
			spec: &appsv1alpha1.NextAppSpec{
				Image: digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{
					WarmSchedule: []appsv1alpha1.WarmWindow{
						{Start: "0 8 * * *", End: "0 20 * * *", Replicas: 0},
					},
				},
			},
			wantErr: true,
			errHas:  "warmSchedule",
		},
		{
			name: "warmSchedule replicas above finite maxScale rejected (#380)",
			spec: &appsv1alpha1.NextAppSpec{
				Image: digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{
					MaxScale: 3,
					WarmSchedule: []appsv1alpha1.WarmWindow{
						{Start: "0 8 * * *", End: "0 20 * * *", Replicas: 5},
					},
				},
			},
			wantErr: true,
			errHas:  "maxScale",
		},
		{
			name: "valid warmSchedule window accepted (#380)",
			spec: &appsv1alpha1.NextAppSpec{
				Image: digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{
					MaxScale: 5,
					WarmSchedule: []appsv1alpha1.WarmWindow{
						{Start: "0 8 * * 1-5", End: "0 20 * * 1-5", Replicas: 3, Timezone: "UTC"},
					},
				},
			},
			wantErr: false,
		},
		{
			name: "warmSchedule with unbounded maxScale accepted (no ceiling to breach, #380)",
			spec: &appsv1alpha1.NextAppSpec{
				Image: digestImage,
				Scaling: &appsv1alpha1.ScalingSpec{
					MaxScale: 0,
					WarmSchedule: []appsv1alpha1.WarmWindow{
						{Start: "0 8 * * *", End: "0 20 * * *", Replicas: 4},
					},
				},
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
