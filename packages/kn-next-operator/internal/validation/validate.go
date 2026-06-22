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

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

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

	// Traffic (issue #92): a canary split is only meaningful against a pinned
	// revision (the remainder of traffic goes to RevisionName). A canaryPercent
	// without a revisionName is ambiguous and rejected.
	if spec.Traffic != nil && spec.Traffic.CanaryPercent != 0 && spec.Traffic.RevisionName == "" {
		return fmt.Errorf("spec.traffic.canaryPercent requires a pinned revisionName")
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
