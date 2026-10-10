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
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"k8s.io/apimachinery/pkg/types"
)

// Platform-layer observability (ADR-0064): held apps, the rollout limiter's
// backlog and the admission webhook's silent fallbacks. These metrics only
// OBSERVE decisions computeStatusVerdict / the limiter already made; none of
// them feeds back into a status or a requeue.

func heldGauge(reason string) float64 {
	return testutil.ToFloat64(platformHeldApps.WithLabelValues(reason))
}

func holdsCounter(reason string) float64 {
	return testutil.ToFloat64(platformHoldsTotal.WithLabelValues(reason))
}

// histogramSampleCount reads a histogram's total observation count from the
// operator registry.
func histogramSampleCount(t *testing.T, name string) uint64 {
	t.Helper()
	fam, ok := gatheredMetricNames(t)[name]
	if !ok || len(fam.Metric) == 0 {
		return 0
	}
	return fam.Metric[0].GetHistogram().GetSampleCount()
}

func TestPlatformMetricsRegistered(t *testing.T) {
	platformHeldApps.WithLabelValues(ReasonEffectiveSpecInvalid).Set(0)
	platformHoldsTotal.WithLabelValues(ReasonEffectiveSpecInvalid).Add(0)
	rolloutQueueDepth.Set(0)
	rolloutWaitSeconds.Observe(0)

	families := gatheredMetricNames(t)
	for _, want := range []string{
		"knext_nextapp_platform_held_apps",
		"knext_nextapp_platform_holds_total",
		"knext_platform_rollout_queue_depth",
		"knext_platform_rollout_wait_seconds",
	} {
		if _, ok := families[want]; !ok {
			t.Errorf("expected metric family %q on the operator registry, got none", want)
		}
	}
}

func TestHeldTracker_GaugeFollowsTheCurrentHeldSetByReason(t *testing.T) {
	var h heldTracker
	a := types.NamespacedName{Namespace: "ns", Name: "a"}
	b := types.NamespacedName{Namespace: "ns", Name: "b"}

	h.observe(a, platformGate{hold: holdEffectiveSpecInvalid})
	h.observe(b, platformGate{hold: holdRolloutPending})
	h.observe(b, platformGate{hold: holdRolloutPending}) // same hold again: still one app
	if got := heldGauge(ReasonEffectiveSpecInvalid); got != 1 {
		t.Errorf("one app held for EffectiveSpecInvalid, gauge = %v", got)
	}
	if got := heldGauge(ReasonRolloutPending); got != 1 {
		t.Errorf("one app held for RolloutPending, gauge = %v", got)
	}

	h.observe(a, platformGate{}) // released
	if got := heldGauge(ReasonEffectiveSpecInvalid); got != 0 {
		t.Errorf("a released app must leave the gauge, got %v", got)
	}

	h.forget(b) // deleted while held
	if got := heldGauge(ReasonRolloutPending); got != 0 {
		t.Errorf("a deleted app must leave the gauge, got %v", got)
	}
}

func TestHeldTracker_CounterCountsTransitionsIntoAHoldNotPasses(t *testing.T) {
	var h heldTracker
	a := types.NamespacedName{Namespace: "ns", Name: "count-a"}
	before := holdsCounter(ReasonEffectiveSpecInvalid)

	for i := 0; i < 5; i++ { // a hold that persists across many passes is ONE hold
		h.observe(a, platformGate{hold: holdEffectiveSpecInvalid})
	}
	if got := holdsCounter(ReasonEffectiveSpecInvalid) - before; got != 1 {
		t.Errorf("five passes of one persistent hold must count once, got +%v", got)
	}

	h.observe(a, platformGate{})
	h.observe(a, platformGate{hold: holdEffectiveSpecInvalid}) // held again: a new hold
	if got := holdsCounter(ReasonEffectiveSpecInvalid) - before; got != 2 {
		t.Errorf("released then held again must count a second hold, got +%v", got)
	}
}

func TestRolloutLimiter_ReportsBacklogAndWait(t *testing.T) {
	var l rolloutLimiter
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	beforeObs := histogramSampleCount(t, "knext_platform_rollout_wait_seconds")

	a := types.NamespacedName{Namespace: "ns", Name: "a"}
	b := types.NamespacedName{Namespace: "ns", Name: "b"}
	c := types.NamespacedName{Namespace: "ns", Name: "c"}

	if wait := l.reserve(a, now, 60); wait != 0 {
		t.Fatalf("first app passes immediately, waited %v", wait)
	}
	if got := testutil.ToFloat64(rolloutQueueDepth); got != 0 {
		t.Errorf("an app that passes is not queued, depth = %v", got)
	}
	if got := histogramSampleCount(t, "knext_platform_rollout_wait_seconds") - beforeObs; got != 0 {
		t.Errorf("a zero wait is not a queued re-render and must not be observed, got +%d", got)
	}

	if wait := l.reserve(b, now, 60); wait <= 0 {
		t.Fatalf("second app within the same instant must queue, wait = %v", wait)
	}
	if wait := l.reserve(c, now, 60); wait <= 0 {
		t.Fatalf("third app must queue, wait = %v", wait)
	}
	if got := testutil.ToFloat64(rolloutQueueDepth); got != 2 {
		t.Errorf("two queued apps, depth = %v", got)
	}
	if got := histogramSampleCount(t, "knext_platform_rollout_wait_seconds") - beforeObs; got != 2 {
		t.Errorf("two queued waits must be observed, got +%d", got)
	}

	// b returns at its slot and is spent: the backlog shrinks.
	if wait := l.reserve(b, now.Add(time.Second), 60); wait != 0 {
		t.Fatalf("b at its slot passes, waited %v", wait)
	}
	if got := testutil.ToFloat64(rolloutQueueDepth); got != 1 {
		t.Errorf("after b is spent one app remains queued, depth = %v", got)
	}
}
