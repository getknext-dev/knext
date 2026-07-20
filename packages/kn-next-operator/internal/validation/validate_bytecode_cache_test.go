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

// #431 — spec.cache.bytecodeCacheSize is user-supplied free text that the
// reconciler turns into a Kubernetes quantity for the bytecode-cache PVC.
// Before this check the reconcile site called resource.MustParse on it, so a
// malformed size PANICKED the reconciler rather than failing the CR. These
// specs pin the durable contract: a bad quantity is a VALIDATION ERROR (which
// surfaces as a status condition / admission rejection), never a panic.
func bytecodeSpec(size string, enabled bool) *appsv1alpha1.NextAppSpec {
	return &appsv1alpha1.NextAppSpec{
		Image: digestImage,
		Cache: &appsv1alpha1.CacheSpec{
			EnableBytecodeCache: enabled,
			BytecodeCacheSize:   size,
		},
	}
}

func TestValidateNextAppSpecBytecodeCacheSize(t *testing.T) {
	tests := []struct {
		name    string
		size    string
		wantErr bool
	}{
		// Valid binary SI.
		{"binary 512Mi", "512Mi", false},
		{"binary 1Gi", "1Gi", false},
		{"binary 1Pi", "1Pi", false},
		{"binary 64Ki", "64Ki", false},
		// Valid decimal SI — lowercase k is kilo.
		{"decimal 500k", "500k", false},
		{"decimal 1M", "1M", false},
		{"decimal exponent 1e3", "1e3", false},
		{"bare bytes", "536870912", false},
		// Unset means "operator default of 512Mi", not an error.
		{"empty means default", "", false},
		// The panic-inducing case: uppercase K is not a Kubernetes suffix.
		{"uppercase K rejected", "512K", true},
		// Other malformed input.
		{"letters", "abc", true},
		{"MB is not a suffix", "12MB", true},
		{"embedded space", "512 Mi", true},
		{"suffix only", "Mi", true},
		// Semantically invalid sizes for a PVC.
		{"negative size", "-1Gi", true},
		{"zero size", "0", true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateNextAppSpec(bytecodeSpec(tc.size, true))
			if tc.wantErr != (err != nil) {
				t.Fatalf("ValidateNextAppSpec(bytecodeCacheSize=%q) err=%v, wantErr=%v",
					tc.size, err, tc.wantErr)
			}
			if tc.wantErr && !strings.Contains(err.Error(), "spec.cache.bytecodeCacheSize") {
				t.Fatalf("error %q does not name the offending field", err)
			}
		})
	}
}

// A size is only meaningful when the bytecode cache is enabled, but validating
// it unconditionally is the safer contract: a user who sets a bad size and
// later flips enableBytecodeCache to true must not turn a dormant typo into a
// reconcile failure at that moment.
func TestValidateNextAppSpecBytecodeCacheSizeCheckedWhenDisabled(t *testing.T) {
	if err := ValidateNextAppSpec(bytecodeSpec("512K", false)); err == nil {
		t.Fatal("expected a malformed bytecodeCacheSize to be rejected even when the cache is disabled")
	}
}

// Guards the reconcile-site contract directly: whatever ValidateNextAppSpec
// accepts must be parseable without panicking, so the PVC sizing path can
// never blow up the controller on admitted input.
func TestAcceptedBytecodeCacheSizesNeverPanicOnParse(t *testing.T) {
	for _, size := range []string{"512Mi", "1Gi", "1Pi", "500k", "1M", "1e3", "536870912"} {
		if err := ValidateNextAppSpec(bytecodeSpec(size, true)); err != nil {
			t.Fatalf("size %q should be accepted, got %v", size, err)
		}
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("parsing accepted size %q panicked: %v", size, r)
				}
			}()
			_ = mustBeParseableQuantity(size)
		}()
	}
}
