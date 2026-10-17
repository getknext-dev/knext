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

package main

import (
	"os"
	"regexp"
	"testing"
)

// The flag's default must BE the controller's constant, not a copy of its
// value: the constant is derived from the kubelet's sync period (see
// zone_signing_key.go) and the validation, the docs and the Z7 kind lane all
// follow it. A number written into the flag registration would let the shipped
// default drift from the one the rest of the operator checks.
func TestPropagationBoundFlagDefaultsToTheControllerConstant(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	re := regexp.MustCompile(`flag\.DurationVar\(&zoneKeyPropagationBound,\s*"zone-signing-key-propagation-bound",\s*` +
		`controller\.DefaultZoneKeyPropagationBound,`)
	if n := len(re.FindAll(src, -1)); n != 1 {
		t.Fatalf("--zone-signing-key-propagation-bound must default to controller.DefaultZoneKeyPropagationBound "+
			"exactly once in main.go, found %d", n)
	}
}
