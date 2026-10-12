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

import (
	"reflect"
	"testing"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// Go map iteration order is random, so an unsorted result differs between calls.
// The condition message is compared for equality on every reconcile (a changed
// message re-fires the event and rewrites status), so the order must be fixed.
func TestCDNReservedEnvIgnored_OrderIsDeterministic(t *testing.T) {
	entry := appsv1alpha1.EnvMapEntry{SecretName: "s", SecretKey: "k"}
	app := reservedApp(
		map[string]string{"KNEXT_CDN_Z": "1", "KNEXT_CDN_M": "1", "KNEXT_CDN_A": "1", "KNEXT_CDN_Q": "1"},
		map[string]appsv1alpha1.EnvMapEntry{"KNEXT_CDN_Z": entry, "KNEXT_CDN_M": entry, "KNEXT_CDN_A": entry, "KNEXT_CDN_Q": entry},
	)
	want := []string{
		"spec.env[KNEXT_CDN_A]", "spec.env[KNEXT_CDN_M]", "spec.env[KNEXT_CDN_Q]", "spec.env[KNEXT_CDN_Z]",
		"spec.secrets.envMap[KNEXT_CDN_A]", "spec.secrets.envMap[KNEXT_CDN_M]",
		"spec.secrets.envMap[KNEXT_CDN_Q]", "spec.secrets.envMap[KNEXT_CDN_Z]",
	}
	for i := 0; i < 50; i++ {
		if got := cdnReservedEnvIgnored(app); !reflect.DeepEqual(got, want) {
			t.Fatalf("iteration %d: got %v, want %v", i, got, want)
		}
	}
}
