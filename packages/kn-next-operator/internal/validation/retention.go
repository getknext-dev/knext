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

import "time"

// LongestRenderedRetention returns the longest of the given duration strings,
// taken from a zone's RENDERED Knative Service template (its scale-down-delay
// and scale-to-zero-pod-retention-period annotations). Those values were
// already validated at admission (validateScaleDownDelay) or are operator
// literals, so this never rejects anything: an empty or unparseable value
// counts as zero. It lives here, beside the validator, because the operator
// parses durations only in this package (ADR-0045 Decision 3); the
// BackendService reconciler uses it to keep a bound function's retention longer
// than its zone's (ADR-0004 Amendment 1 Decision 3).
func LongestRenderedRetention(values ...string) time.Duration {
	var longest time.Duration
	for _, v := range values {
		if v == "" {
			continue
		}
		if d, err := time.ParseDuration(v); err == nil && d > longest {
			longest = d
		}
	}
	return longest
}
