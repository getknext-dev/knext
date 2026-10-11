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

package utils

import "testing"

// MetricValue reads one sample out of Prometheus exposition text scraped through
// `kubectl run --rm`, which merges its own `pod ... deleted` notice into the
// output. The platform e2e keys its held-app / limiter / fallback assertions on
// it, so it must be exact about WHICH series it returns: a `_count` or a
// different label set must never be mistaken for the series asked for.

const sampleExposition = `# HELP knext_platform_apps_held Number of NextApps held.
# TYPE knext_platform_apps_held gauge
knext_platform_apps_held{reason="EffectiveSpecInvalid"} 2
knext_platform_apps_held{reason="RolloutPending"} 0
# TYPE knext_platform_rollout_wait_seconds histogram
knext_platform_rollout_wait_seconds_bucket{le="1"} 0
knext_platform_rollout_wait_seconds_sum 12.5
knext_platform_rollout_wait_seconds_count 3
knext_platform_rollout_pending 1
pod "scrape-x" deleted
`

func TestMetricValue_ReadsTheExactSeries(t *testing.T) {
	for series, want := range map[string]float64{
		`knext_platform_apps_held{reason="EffectiveSpecInvalid"}`: 2,
		`knext_platform_apps_held{reason="RolloutPending"}`:       0,
		`knext_platform_rollout_pending`:                          1,
		`knext_platform_rollout_wait_seconds_count`:               3,
		`knext_platform_rollout_wait_seconds_sum`:                 12.5,
	} {
		got, ok := MetricValue(sampleExposition, series)
		if !ok || got != want {
			t.Errorf("%s = (%v, %v), want (%v, true)", series, got, ok, want)
		}
	}
}

func TestMetricValue_DoesNotMatchAPrefixOfALongerName(t *testing.T) {
	// `queue_depth` is not `queue_depth_total`, and the bare histogram name is not
	// its `_count`: a prefix match would return the wrong series silently.
	if v, ok := MetricValue(sampleExposition, `knext_platform_rollout_wait_seconds`); ok {
		t.Errorf("the bare histogram name has no sample of its own, got %v", v)
	}
	if v, ok := MetricValue(sampleExposition, `knext_platform_rollout_queue`); ok {
		t.Errorf("a prefix of a metric name must not match, got %v", v)
	}
}

func TestMetricValue_AbsentSeries(t *testing.T) {
	if _, ok := MetricValue(sampleExposition, `knext_platform_budget_fallback_total{cause="read_error"}`); ok {
		t.Error("a series that is not in the exposition must report ok=false, not zero")
	}
	if _, ok := MetricValue("", `anything`); ok {
		t.Error("empty exposition has no series")
	}
}
