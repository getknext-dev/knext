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

	"github.com/robfig/cron/v3"
	"k8s.io/apimachinery/pkg/api/resource"
	utilvalidation "k8s.io/apimachinery/pkg/util/validation"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// validateCronExpr validates the 5-field (minute hour day-of-month month
// day-of-week) cron syntax of a warmSchedule window start/end. It uses the same
// robfig/cron ParseStandard parser the operator's reconcile-time window
// evaluation (warmScheduleFloor, ADR-0030) uses, so a cron this admission check
// accepts is exactly one the reconciler can evaluate. Rejecting a trailing
// seconds field, an out-of-range value, or unparseable text HERE (at admission)
// means a malformed cron never reaches the operator's min-scale floor
// calculation — where it would otherwise be skipped and silently warm nothing.
func validateCronExpr(expr string) error {
	_, err := cron.ParseStandard(strings.TrimSpace(expr))
	return err
}

// MaxConnections documents scale-zero-pg's Postgres primary `max_connections`
// (100). It is NOT the bound the operator validates against — the app
// autoscaling must live well within it (see MaxAppConnections).
const MaxConnections = 100

// MaxAppConnections is the connection BUDGET the app autoscaling must fit
// within (ADR-0028) — the bound the operator actually enforces. Derivation:
//
//	GW_MAX_CONNS (90)  — the wake gateway's hard cap; excess connections are
//	                     refused with SQLSTATE 53300 (too_many_connections).
//	  − ~10 reserve     — superuser_reserved_connections (default 3) +
//	                     replication slots + the wake gateway's own probe
//	                     connection headroom.
//	  = 80              — MaxAppConnections.
//
// Budgeting against max_connections (100) directly would exhaust the 90 gateway
// cap AND leave zero admin/replication headroom, defeating the guard the cc=20
// change (#377) makes necessary. The operator enforces
// `maxScale × poolMax ≤ MaxAppConnections` when a per-pod poolMax is declared,
// so a low ContainerConcurrency (which scales apps to more pods sooner) cannot
// silently exhaust the gateway/DB. W3 (#378) owns breaking this wall (e.g. a
// shared server-side pooler that decouples pod count from backend connections).
const MaxAppConnections = 80

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
//   - When a per-pod poolMax is declared, maxScale × poolMax ≤ MaxAppConnections
//     (the ADR-0028 connection-wall invariant — the gateway cap minus reserve,
//     not the raw Postgres max_connections).
//   - TargetBurstCapacity, when set, is -1 or >= 0 (ADR-0032, #411).
//   - PanicWindowPercentage, when set, is in [1,100]; PanicThresholdPercentage,
//     when set, is >= 110 (ADR-0033, #413).
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
		// ADR-0028 instead. When declared, the reactive fan-out must fit within
		// the app connection BUDGET (GW_MAX_CONNS 90 minus admin/replication
		// reserve = MaxAppConnections 80), NOT the raw max_connections (100):
		//   maxScale × poolMax ≤ MaxAppConnections.
		// An unbounded maxScale (0) with a declared poolMax cannot satisfy a
		// finite budget, so it is rejected outright.
		if s.PoolMax > 0 {
			if s.MaxScale == 0 {
				return fmt.Errorf(
					"spec.scaling.poolMax (%d) is declared with an unbounded maxScale (0): "+
						"an unbounded pod fan-out cannot fit within the app connection budget (%d) — "+
						"set a finite maxScale so maxScale × poolMax ≤ %d (ADR-0028)",
					s.PoolMax, MaxAppConnections, MaxAppConnections,
				)
			}
			if int64(s.MaxScale)*int64(s.PoolMax) > int64(MaxAppConnections) {
				return fmt.Errorf(
					"spec.scaling: maxScale × poolMax (%d × %d = %d) exceeds the app connection budget (%d = GW_MAX_CONNS 90 − reserve; max_connections is %d): "+
						"lower maxScale or poolMax so their product ≤ %d (ADR-0028 connection wall; "+
						"W3/#378 owns breaking it)",
					s.MaxScale, s.PoolMax, int64(s.MaxScale)*int64(s.PoolMax),
					MaxAppConnections, MaxConnections, MaxAppConnections,
				)
			}
		}

		// targetBurstCapacity (#411, ADR-0032): -1 (always keep the activator
		// in path) and any value >= 0 (a numeric burst capacity) are valid
		// Knative semantics; only < -1 is meaningless and rejected. Unset
		// (nil) skips the check entirely — no annotation is stamped
		// (back-compat, see buildDesiredKsvc).
		if s.TargetBurstCapacity != nil && *s.TargetBurstCapacity < -1 {
			return fmt.Errorf(
				"spec.scaling.targetBurstCapacity must be -1 (always keep the activator in path) or >= 0 (a burst capacity in requests), got %d",
				*s.TargetBurstCapacity,
			)
		}

		// panicWindowPercentage / panicThresholdPercentage (#413, ADR-0033):
		// mirror Knative's own bounds on the panic-window and panic-threshold
		// KPA annotations. Unset (nil) skips the check entirely — no
		// annotation is stamped (back-compat, see buildDesiredKsvc).
		if s.PanicWindowPercentage != nil && (*s.PanicWindowPercentage < 1 || *s.PanicWindowPercentage > 100) {
			return fmt.Errorf(
				"spec.scaling.panicWindowPercentage must be between 1 and 100 (a percentage of the KPA stable window), got %d",
				*s.PanicWindowPercentage,
			)
		}
		if s.PanicThresholdPercentage != nil && *s.PanicThresholdPercentage < 110 {
			return fmt.Errorf(
				"spec.scaling.panicThresholdPercentage must be >= 110 (a percentage of the steady-state target; Knative requires > 100), got %d",
				*s.PanicThresholdPercentage,
			)
		}

		// Scheduled warm-floor windows (ADR-0030, W5/#380). Each window declares a
		// cron start/end and a warm-pod floor. At runtime the OPERATOR (the single
		// writer of min-scale) evaluates these windows against NOW on every
		// reconcile and stamps max(minScale, active-window replicas) onto the ksvc
		// min-scale annotation — there is no CronJob. Validated here (shared with
		// the fail-closed reconciler) so a bad window is rejected at admission AND
		// a stored CR with one is refused, rather than a malformed cron silently
		// being skipped in the reconcile floor calc (warming nothing). CRD CEL
		// enforces MinLength/Minimum on the fields; the checks below add the cron
		// SYNTAX validation (the same robfig/cron parser the reconciler evaluates
		// with) and the cross-field replicas ≤ maxScale rule CEL cannot express
		// against a sibling field cleanly.
		for i, w := range s.WarmSchedule {
			if strings.TrimSpace(w.Start) == "" {
				return fmt.Errorf("spec.scaling.warmSchedule[%d].start is required (a 5-field cron expression)", i)
			}
			if err := validateCronExpr(w.Start); err != nil {
				return fmt.Errorf(
					"spec.scaling.warmSchedule[%d].start %q is not a valid 5-field cron expression (e.g. \"0 8 * * 1-5\"): %v",
					i, w.Start, err,
				)
			}
			if strings.TrimSpace(w.End) == "" {
				return fmt.Errorf("spec.scaling.warmSchedule[%d].end is required (a 5-field cron expression)", i)
			}
			if err := validateCronExpr(w.End); err != nil {
				return fmt.Errorf(
					"spec.scaling.warmSchedule[%d].end %q is not a valid 5-field cron expression (e.g. \"0 20 * * 1-5\"): %v",
					i, w.End, err,
				)
			}
			if w.Replicas < 1 {
				return fmt.Errorf(
					"spec.scaling.warmSchedule[%d].replicas must be >= 1 (a window that floors at 0 warms nothing; omit the window for scale-to-zero), got %d",
					i, w.Replicas,
				)
			}
			// A warm floor above the reactive ceiling is a self-contradiction: the
			// scheduled min-scale would floor higher than the KPA is ever allowed to
			// scale. Only checked against a FINITE maxScale (0 = unbounded, no
			// ceiling to breach).
			if s.MaxScale > 0 && w.Replicas > s.MaxScale {
				return fmt.Errorf(
					"spec.scaling.warmSchedule[%d].replicas (%d) exceeds maxScale (%d): "+
						"the warm floor cannot be higher than the reactive scale ceiling (ADR-0030)",
					i, w.Replicas, s.MaxScale,
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
	// Bytecode cache (#431): the PVC size is free text the reconciler turns
	// into a Kubernetes quantity. Validate it HERE so a malformed value fails
	// as a status condition / admission rejection instead of panicking the
	// reconciler at the PVC sizing site.
	if err := validateBytecodeCacheSize(spec); err != nil {
		return err
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

	// warmSchedule + pinned traffic (#393, ADR-0030): the scheduled warm-floor
	// changes the ksvc min-scale annotation at each window boundary. A min-scale
	// change is a template change, so Knative rolls a NEW Revision and resets
	// traffic to latest-ready. If the app ALSO pins traffic to a specific Revision
	// (spec.traffic.revisionName — #92 rollback/canary), the boundary roll would
	// silently reset the pin. Reject the combination at admission (shared webhook +
	// fail-closed reconciler) rather than leaving it as an advisory foot-gun.
	if spec.Scaling != nil && len(spec.Scaling.WarmSchedule) > 0 &&
		spec.Traffic != nil && spec.Traffic.RevisionName != "" {
		return fmt.Errorf(
			"warmSchedule cannot be combined with pinned traffic (spec.traffic.revisionName %q): "+
				"the scheduled min-scale change rolls a new Revision at each window boundary and "+
				"would reset the pin; drop the pin or the warmSchedule (see ADR-0030)",
			spec.Traffic.RevisionName,
		)
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

// validateBytecodeCacheSize rejects a spec.cache.bytecodeCacheSize that is not
// a valid, positive Kubernetes quantity (#431). This field is user-supplied
// free text that the reconciler turns into the bytecode-cache PVC's storage
// request; before this check the reconcile site parsed it with
// resource.MustParse, so a typo like "512K" (uppercase K is not a Kubernetes
// suffix — decimal kilo is lowercase `k`) PANICKED the reconciler. Validating
// here means the failure surfaces as an admission rejection / status
// condition instead. The size is checked even when EnableBytecodeCache is
// false, so a dormant typo cannot turn into a reconcile failure the moment
// the cache is switched on.
func validateBytecodeCacheSize(spec *appsv1alpha1.NextAppSpec) error {
	if spec.Cache == nil || spec.Cache.BytecodeCacheSize == "" {
		return nil // unset → reconciler default of 512Mi
	}
	size := spec.Cache.BytecodeCacheSize
	q, err := resource.ParseQuantity(size)
	if err != nil {
		return fmt.Errorf(
			"spec.cache.bytecodeCacheSize %q is not a valid Kubernetes quantity (e.g. \"512Mi\", \"1Gi\"): %v",
			size, err,
		)
	}
	if q.Sign() <= 0 {
		return fmt.Errorf(
			"spec.cache.bytecodeCacheSize %q must be a positive quantity (the bytecode-cache PVC cannot be sized <= 0)",
			size,
		)
	}
	return nil
}

// mustBeParseableQuantity is the test seam that pins the reconcile-site
// contract: any size ValidateNextAppSpec accepts must round-trip through the
// same parser the PVC sizing path uses, without panicking.
func mustBeParseableQuantity(size string) resource.Quantity {
	return resource.MustParse(size)
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
