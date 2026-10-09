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

package defaults

import "testing"

// The table is the platform layer's "empty means unchanged" promise written
// down: these are the values the operator used BEFORE the platform layer
// existed. A cluster that has not opted in must keep getting exactly these.
//
// This pin is deliberately the literal numbers, not references back to the
// constants — a test that compares a constant to itself would stay green when
// the constant moved, which is the one failure it exists to catch. It guards the
// values that never reach a rendered object (ConnectionBudget, MaxAppsPerMinute)
// as well as the ones the zero-diff golden also covers.
func TestBuiltinTableIsPinnedToThePrePlatformOperator(t *testing.T) {
	if ContainerConcurrency != 20 {
		t.Errorf("ContainerConcurrency = %d, want 20 (ADR-0028)", ContainerConcurrency)
	}
	for _, c := range []struct{ name, got, want string }{
		{"CPURequest", CPURequest, "250m"},
		{"CPULimit", CPULimit, "1000m"},
		{"MemoryRequest", MemoryRequest, "512Mi"},
		{"MemoryLimit", MemoryLimit, "1Gi"},
	} {
		if c.got != c.want {
			t.Errorf("%s = %q, want %q", c.name, c.got, c.want)
		}
	}
	if TimeoutSeconds != 300 {
		t.Errorf("TimeoutSeconds = %d, want 300", TimeoutSeconds)
	}
	if ConnectionBudget != 80 {
		t.Errorf("ConnectionBudget = %d, want 80 (GW_MAX_CONNS 90 minus reserve, ADR-0028)", ConnectionBudget)
	}
	if MaxAppsPerMinute != 10 {
		t.Errorf("MaxAppsPerMinute = %d, want 10", MaxAppsPerMinute)
	}
}
