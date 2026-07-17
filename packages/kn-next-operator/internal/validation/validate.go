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

// Package validation holds the single, authoritative validation logic for a
// NextApp spec. Both the validating admission webhook and the reconciler call
// ValidateNextAppSpec so the two cannot drift: a NextApp that the webhook
// rejects at write time is exactly the one the reconciler would refuse to act
// on, and vice-versa.
package validation

import (
	"fmt"
	"strings"

	utilvalidation "k8s.io/apimachinery/pkg/util/validation"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// MaxConnections is the shared Postgres primary connection ceiling the app
// autoscaling must live within (ADR-0028). It mirrors scale-zero-pg's
// `max_connections=100` (the wake gateway caps at GW_MAX_CONNS=90). The
// operator enforces `maxScale × poolMax ≤ MaxConnections` when a per-pod
// poolMax is declared, so a low ContainerConcurrency (which scales apps to
// more pods sooner) cannot silently exhaust the DB. W3 (#378) owns breaking
// this wall (e.g. a shared server-side pooler).
const MaxConnections = 100

// Recognized enum values for the provider/queue free-form string fields.
// These mirror the providers the CLI + reconciler actually wire up. They are
// intentionally permissive supersets — unknown values are rejected so that a
// typo (e.g. "gsc") fails at admission rather than silently producing a broken
// Knative Service.
var (
	validStorageProviders = map[string]struct{}{
		"gcs":   {},
		"s3":    {},
		"minio": {},
		"azure": {},
		"local": {},
	}
	validCacheProviders = map[string]struct{}{
		"redis":  {},
		"memory": {},
	}
	validRevalidationQueues = map[string]struct{}{
		"kafka": {},
	}
)

// ValidateImageRef enforces digest-pinning for all NextApp images.
//
// Acceptance rules (ADR-0001 / A1-digest):
//   - ACCEPT:  image contains "@sha256:" — digest-pinned (with or without a tag)
//   - REJECT:  image ends with ":latest" — mutable, prevents rollbacks
//   - REJECT:  image has no "@sha256:" suffix — tag-only refs are mutable
//   - REJECT:  image has no tag separator at all (implicitly :latest)
//
// This is the single source of truth for digest validation: the reconciler and
// the admission webhook both reach it (the reconciler via validateImageRef,
// which delegates here).
func ValidateImageRef(image string) error {
	// A digest-pinned image MUST contain "@sha256:" — accept immediately.
	if strings.Contains(image, "@sha256:") {
		return nil
	}

	// No "@sha256:" — image is either tagless (implicit :latest) or tag-only.
	// Both are rejected: tags are mutable and cannot guarantee provenance.

	if strings.HasSuffix(image, ":latest") {
		return fmt.Errorf(
			"image %q uses the :latest tag which is forbidden: "+
				"use a digest-pinned ref (e.g. myapp:v1@sha256:<hash>)",
			image,
		)
	}

	if !strings.Contains(image, ":") {
		// No tag separator at all — registry resolves to :latest.
		return fmt.Errorf(
			"image %q has no explicit tag or digest: "+
				"use a digest-pinned ref (e.g. myapp:v1@sha256:<hash>)",
			image,
		)
	}

	// Has a tag but no @sha256: — tag-only ref, still mutable.
	return fmt.Errorf(
		"image %q has a tag but no digest pin (@sha256:): "+
			"use a digest-pinned ref (e.g. %s@sha256:<hash>)",
		image, image,
	)
}

// ValidateNextAppSpec validates a NextApp spec and returns the first error
// found, or nil if the spec is valid. It enforces:
//
//   - Image is required and digest-pinned (delegates to ValidateImageRef).
//   - Scaling is non-negative and MinScale <= MaxScale (when MaxScale is set).
//   - ContainerConcurrency is non-negative.
//   - When a per-pod poolMax is declared, maxScale × poolMax ≤ max_connections
//     (the ADR-0028 connection-wall invariant).
//   - Storage.Provider / Cache.Provider / Revalidation.Queue, when set, are
//     recognized enum values.
//
// This is the shared entry point used by both the webhook and the reconciler.
func ValidateNextAppSpec(spec *appsv1alpha1.NextAppSpec) error {
	if spec == nil {
		return fmt.Errorf("spec is required")
	}

	// Image: required + digest-pinned.
	if strings.TrimSpace(spec.Image) == "" {
		return fmt.Errorf("spec.image is required")
	}
	if err := ValidateImageRef(spec.Image); err != nil {
		return err
	}

	// Scaling sanity.
	if spec.Scaling != nil {
		s := spec.Scaling
		if s.MinScale < 0 {
			return fmt.Errorf("spec.scaling.minScale must be >= 0, got %d", s.MinScale)
		}
		if s.MaxScale < 0 {
			return fmt.Errorf("spec.scaling.maxScale must be >= 0, got %d", s.MaxScale)
		}
		if s.ContainerConcurrency < 0 {
			return fmt.Errorf("spec.scaling.containerConcurrency must be >= 0, got %d", s.ContainerConcurrency)
		}
		// MaxScale == 0 means "unbounded" in Knative, so only enforce the
		// ordering when MaxScale is explicitly set to a positive value.
		if s.MaxScale > 0 && s.MinScale > s.MaxScale {
			return fmt.Errorf(
				"spec.scaling.minScale (%d) must be <= maxScale (%d)",
				s.MinScale, s.MaxScale,
			)
		}
		if s.PoolMax < 0 {
			return fmt.Errorf("spec.scaling.poolMax must be >= 0, got %d", s.PoolMax)
		}
		// Connection-wall invariant (#377, ADR-0028). Only enforced when the
		// per-pod pool.max is DECLARED (>0) — the operator cannot guard a wall
		// it does not know about; an undeclared poolMax is documented loudly in
		// ADR-0028 instead. When declared, the reactive fan-out must fit under
		// the shared max_connections ceiling:
		//   maxScale × poolMax ≤ MaxConnections.
		// An unbounded maxScale (0) with a declared poolMax cannot satisfy a
		// finite ceiling, so it is rejected outright.
		if s.PoolMax > 0 {
			if s.MaxScale == 0 {
				return fmt.Errorf(
					"spec.scaling.poolMax (%d) is declared with an unbounded maxScale (0): "+
						"an unbounded pod fan-out cannot fit under max_connections (%d) — "+
						"set a finite maxScale so maxScale × poolMax ≤ %d (ADR-0028)",
					s.PoolMax, MaxConnections, MaxConnections,
				)
			}
			if int64(s.MaxScale)*int64(s.PoolMax) > int64(MaxConnections) {
				return fmt.Errorf(
					"spec.scaling: maxScale × poolMax (%d × %d = %d) exceeds max_connections (%d): "+
						"lower maxScale or poolMax so their product ≤ %d (ADR-0028 connection wall; "+
						"W3/#378 owns breaking it)",
					s.MaxScale, s.PoolMax, int64(s.MaxScale)*int64(s.PoolMax),
					MaxConnections, MaxConnections,
				)
			}
		}
	}

	// Provider / queue enums.
	if spec.Storage != nil && spec.Storage.Provider != "" {
		if _, ok := validStorageProviders[spec.Storage.Provider]; !ok {
			return fmt.Errorf(
				"spec.storage.provider %q is not recognized (valid: %s)",
				spec.Storage.Provider, keys(validStorageProviders),
			)
		}
	}
	if spec.Cache != nil && spec.Cache.Provider != "" {
		if _, ok := validCacheProviders[spec.Cache.Provider]; !ok {
			return fmt.Errorf(
				"spec.cache.provider %q is not recognized (valid: %s)",
				spec.Cache.Provider, keys(validCacheProviders),
			)
		}
	}
	if spec.Revalidation != nil && spec.Revalidation.Queue != "" {
		if _, ok := validRevalidationQueues[spec.Revalidation.Queue]; !ok {
			return fmt.Errorf(
				"spec.revalidation.queue %q is not recognized (valid: %s)",
				spec.Revalidation.Queue, keys(validRevalidationQueues),
			)
		}
	}

	// Database (ADR-0019): mode exclusivity + BYO binding shape + no silent
	// DATABASE_URL precedence against spec.secrets.envMap. Mirrors the CRD CEL
	// rules for CRs that predate them (validation ratcheting).
	if err := validateDatabase(spec); err != nil {
		return err
	}

	// Traffic (issue #92): a canary split is only meaningful against a pinned
	// revision (the remainder of traffic goes to RevisionName). A canaryPercent
	// without a revisionName is ambiguous and rejected.
	if spec.Traffic != nil && spec.Traffic.CanaryPercent != 0 && spec.Traffic.RevisionName == "" {
		return fmt.Errorf("spec.traffic.canaryPercent requires a pinned revisionName")
	}

	return nil
}

// validateDatabase enforces the ADR-0019 spec.database rules (matrix mirrored
// from the CRD CEL validations):
//
//  1. roSecretRef requires secretRef.
//  2. secretRef/roSecretRef names are DNS-1123 subdomains.
//
// knext is engine-agnostic and provisions no database (managed mode removed —
// ADR-0025); the only surface is the BYO secretRef binding (ADR-0019).
//
// DATABASE_URL(_RO) collisions against spec.secrets.envMap are deliberately
// NOT validated here: this function is shared with the FAIL-CLOSED reconciler,
// and a stored CR that predates the collision rules must keep reconciling
// (true ratcheting) — the reconciler resolves such CRs loudly instead
// (spec.database wins + Warning event). Collisions are enforced by the WEBHOOK
// only: see DatabaseEnvMapCollisions / ValidateNextAppSpecCreate /
// ValidateNextAppSpecUpdate.
func validateDatabase(spec *appsv1alpha1.NextAppSpec) error {
	db := spec.Database
	if db == nil {
		return nil
	}

	if db.ROSecretRef != nil && db.SecretRef == nil {
		return fmt.Errorf("spec.database.roSecretRef requires spec.database.secretRef")
	}
	if db.SecretRef != nil {
		if errs := utilvalidation.IsDNS1123Subdomain(db.SecretRef.Name); len(errs) > 0 {
			return fmt.Errorf("spec.database.secretRef.name %q is not a valid Secret name: %s", db.SecretRef.Name, strings.Join(errs, "; "))
		}
	}
	if db.ROSecretRef != nil {
		if errs := utilvalidation.IsDNS1123Subdomain(db.ROSecretRef.Name); len(errs) > 0 {
			return fmt.Errorf("spec.database.roSecretRef.name %q is not a valid Secret name: %s", db.ROSecretRef.Name, strings.Join(errs, "; "))
		}
	}

	return nil
}

// DatabaseEnvMapCollisions returns, in deterministic order, the env var names
// that spec.database claims (DATABASE_URL, and DATABASE_URL_RO when applicable)
// which spec.secrets.envMap ALSO defines (ADR-0019 "no silent precedence").
// Empty result = no collision.
func DatabaseEnvMapCollisions(spec *appsv1alpha1.NextAppSpec) []string {
	db := spec.Database
	if db == nil || spec.Secrets == nil || spec.Secrets.EnvMap == nil {
		return nil
	}
	var out []string
	definesURL := db.SecretRef != nil
	if _, clash := spec.Secrets.EnvMap["DATABASE_URL"]; clash && definesURL {
		out = append(out, "DATABASE_URL")
	}
	definesRO := db.ROSecretRef != nil
	if _, clash := spec.Secrets.EnvMap["DATABASE_URL_RO"]; clash && definesRO {
		out = append(out, "DATABASE_URL_RO")
	}
	return out
}

// ValidateNextAppSpecCreate is the CREATE-time admission entry point (webhook
// only): the shared spec validation PLUS an unratcheted rejection of any
// DATABASE_URL(_RO) collision between spec.database and spec.secrets.envMap.
func ValidateNextAppSpecCreate(spec *appsv1alpha1.NextAppSpec) error {
	if err := ValidateNextAppSpec(spec); err != nil {
		return err
	}
	if collisions := DatabaseEnvMapCollisions(spec); len(collisions) > 0 {
		return fmt.Errorf(
			"spec.database and spec.secrets.envMap both define %s — remove one (no silent precedence)",
			strings.Join(collisions, ", "),
		)
	}
	return nil
}

// ValidateNextAppSpecUpdate is the UPDATE-time admission entry point (webhook
// only), with TRUE ratcheting on the collision rule: a collision is rejected
// only when the update ADDS it (per env var name). An update that merely
// carries a pre-existing collision forward — e.g. an image bump on a CR stored
// before the rules existed — is allowed; otherwise upgrading the operator
// would brick running apps on their next unrelated update. The reconciler
// resolves the carried-forward collision loudly (spec.database wins + Warning
// event).
func ValidateNextAppSpecUpdate(oldSpec, newSpec *appsv1alpha1.NextAppSpec) error {
	if err := ValidateNextAppSpec(newSpec); err != nil {
		return err
	}
	old := map[string]struct{}{}
	if oldSpec != nil {
		for _, name := range DatabaseEnvMapCollisions(oldSpec) {
			old[name] = struct{}{}
		}
	}
	var added []string
	for _, name := range DatabaseEnvMapCollisions(newSpec) {
		if _, preexisting := old[name]; !preexisting {
			added = append(added, name)
		}
	}
	if len(added) > 0 {
		return fmt.Errorf(
			"spec.database and spec.secrets.envMap both define %s — remove one (no silent precedence)",
			strings.Join(added, ", "),
		)
	}
	return nil
}

// keys returns the sorted-ish set keys for an error message. Order is not
// guaranteed but the content is stable enough for human-readable errors.
func keys(m map[string]struct{}) string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return strings.Join(out, ", ")
}
