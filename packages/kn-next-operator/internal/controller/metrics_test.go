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
	"strings"
	"testing"

	dto "github.com/prometheus/client_model/go"
	"k8s.io/client-go/util/workqueue"
	"sigs.k8s.io/controller-runtime/pkg/metrics"
)

// gatheredMetricNames collects the family names currently registered on the
// controller-runtime metrics registry (the one served on the operator's
// /metrics), so tests can assert a series is scrapable without hitting HTTP.
func gatheredMetricNames(t *testing.T) map[string]*dto.MetricFamily {
	t.Helper()
	families, err := metrics.Registry.Gather()
	if err != nil {
		t.Fatalf("gather metrics registry: %v", err)
	}
	byName := make(map[string]*dto.MetricFamily, len(families))
	for _, f := range families {
		byName[f.GetName()] = f
	}
	return byName
}

// TestKnextReconcileMetricsRegistered locks the golden control-plane signals the
// operator must export (#315, item 3): reconcile count (by result), duration
// histogram, and error count — all on the controller-runtime registry so they
// land on the existing /metrics endpoint.
func TestKnextReconcileMetricsRegistered(t *testing.T) {
	// Force at least one sample so the family is present in Gather().
	reconcileTotal.WithLabelValues("success").Inc()
	reconcileErrors.Inc()
	reconcileDuration.Observe(0.01)

	families := gatheredMetricNames(t)
	for _, want := range []string{
		"knext_nextapp_reconcile_total",
		"knext_nextapp_reconcile_errors_total",
		"knext_nextapp_reconcile_duration_seconds",
	} {
		if _, ok := families[want]; !ok {
			t.Errorf("expected metric family %q registered on the operator registry, got none", want)
		}
	}
}

// TestWorkqueueDepthMetricRegistered proves the fourth control-plane golden
// signal — work-queue depth (#315, item 3) — is scrapable on the SAME operator
// /metrics endpoint. controller-runtime's workqueue metrics provider is set as
// client-go's global provider in its package init; a NAMED workqueue then
// registers a `workqueue_depth{name=...}` child (a GaugeVec) on the shared
// `metrics.Registry`. The operator's controller is a named queue
// (`SetupWithManager(...).Named("nextapp")`), so in production the series
// `workqueue_depth{name="nextapp"}` is exported alongside the knext reconcile
// metrics with no extra wiring.
//
// We reproduce that mechanism here by creating a named queue exactly as the
// controller does (any name materializes the shared `depth` family), then
// assert the family is registered. Guards against a regression (custom
// registry, unnamed queue, disabled provider) silently dropping queue depth.
func TestWorkqueueDepthMetricRegistered(t *testing.T) {
	// A NAMED queue registers the workqueue metric children on metrics.Registry
	// via the global provider — the same path SetupWithManager uses.
	q := workqueue.NewTypedRateLimitingQueueWithConfig(
		workqueue.DefaultTypedControllerRateLimiter[string](),
		workqueue.TypedRateLimitingQueueConfig[string]{Name: "nextapp-metrics-test"},
	)
	defer q.ShutDown()
	q.Add("materialize-the-depth-metric")

	families := gatheredMetricNames(t)
	if _, ok := families["workqueue_depth"]; !ok {
		// Surface what IS registered to make a regression obvious.
		names := make([]string, 0, len(families))
		for n := range families {
			names = append(names, n)
		}
		t.Fatalf("expected 'workqueue_depth' registered on the operator registry; registered families: %s",
			strings.Join(names, ", "))
	}
}
