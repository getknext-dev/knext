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
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

// ADR-0064 failure mode F2: a platform edit can change the effective values of
// every app at once, each change is a new Knative revision, and each new
// revision boots a pod. The rollout limiter spaces those re-renders at
// rollout.maxAppsPerMinute.
//
// It is a RESERVATION limiter, not a poll-until-a-token-frees-up one: an app
// asks once, is told when its slot is, and is expected back exactly then. That
// matters at scale — N held apps each re-polling would cost O(N^2) reconciles
// across a long rollout, where reservations cost two each.

func nn(i int) types.NamespacedName {
	return types.NamespacedName{Namespace: "default", Name: fmt.Sprintf("app-%d", i)}
}

func TestRolloutLimiter_SpacesReRendersAtTheConfiguredRate(t *testing.T) {
	var l rolloutLimiter
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	// 10 per minute => one slot every 6s, the first one immediate.
	var waits []time.Duration
	for i := 0; i < 5; i++ {
		waits = append(waits, l.reserve(nn(i), t0, 10))
	}
	want := []time.Duration{0, 6 * time.Second, 12 * time.Second, 18 * time.Second, 24 * time.Second}
	for i := range want {
		if waits[i] != want[i] {
			t.Errorf("app %d wait = %v, want %v (all waits %v)", i, waits[i], want[i], waits)
		}
	}
}

func TestRolloutLimiter_NeverExceedsTheRateOverAnyMinuteWindow(t *testing.T) {
	var l rolloutLimiter
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	const apps, perMinute = 100, 10

	slots := map[time.Duration]int{}
	for i := 0; i < apps; i++ {
		slots[l.reserve(nn(i), t0, perMinute)]++
	}
	// Collect the slot instants and check every 60s window holds <= perMinute.
	var instants []time.Duration
	for d, n := range slots {
		for j := 0; j < n; j++ {
			instants = append(instants, d)
		}
	}
	for _, start := range instants {
		inWindow := 0
		for _, x := range instants {
			if x >= start && x < start+time.Minute {
				inWindow++
			}
		}
		if inWindow > perMinute {
			t.Fatalf("%d re-renders land in the minute starting at +%v; the cap is %d", inWindow, start, perMinute)
		}
	}
}

// An app told to wait comes back at its slot and is let through — it must not be
// charged a second time, or the rollout would never finish.
func TestRolloutLimiter_AnAppReturningAtItsSlotIsLetThroughOnce(t *testing.T) {
	var l rolloutLimiter
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	_ = l.reserve(nn(0), t0, 10)
	wait := l.reserve(nn(1), t0, 10)
	if wait != 6*time.Second {
		t.Fatalf("setup: second app wait = %v, want 6s", wait)
	}

	// Back too early: still waiting, for the remainder, not a fresh slot.
	if got := l.reserve(nn(1), t0.Add(2*time.Second), 10); got != 4*time.Second {
		t.Errorf("early return wait = %v, want the remaining 4s", got)
	}
	// Back at the slot: through.
	if got := l.reserve(nn(1), t0.Add(6*time.Second), 10); got != 0 {
		t.Errorf("return at the slot wait = %v, want 0", got)
	}
	// Having been let through, the reservation is spent: a LATER platform change
	// reserves anew instead of riding a stale pass.
	if got := l.reserve(nn(1), t0.Add(time.Hour), 10); got != 0 {
		t.Errorf("after an idle hour the next reservation should be immediate, got %v", got)
	}
}

func TestRolloutLimiter_IdleTimeDoesNotBankBurstCapacity(t *testing.T) {
	var l rolloutLimiter
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	_ = l.reserve(nn(0), t0, 10)

	// A long quiet spell, then a wave of apps: still spaced, not released together.
	later := t0.Add(6 * time.Hour)
	w0 := l.reserve(nn(1), later, 10)
	w1 := l.reserve(nn(2), later, 10)
	if w0 != 0 || w1 != 6*time.Second {
		t.Errorf("after idle: waits %v, %v; want 0 then 6s (an idle hour must not bank a burst)", w0, w1)
	}
}

func TestRolloutLimiter_RateChangeAppliesToNewReservations(t *testing.T) {
	var l rolloutLimiter
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	_ = l.reserve(nn(0), t0, 60) // 1s spacing
	if got := l.reserve(nn(1), t0, 60); got != time.Second {
		t.Errorf("at 60/min the second slot is 1s out, got %v", got)
	}
	// Slow the rate down: the NEXT slot uses the new spacing.
	if got := l.reserve(nn(2), t0, 6); got != time.Second+10*time.Second {
		t.Errorf("after slowing to 6/min the third slot should follow the second by 10s, got %v", got)
	}
}

func TestRolloutLimiter_NonPositiveRateFallsBackToTheBuiltin(t *testing.T) {
	var l rolloutLimiter
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	_ = l.reserve(nn(0), t0, 0)
	if got := l.reserve(nn(1), t0, -3); got != 6*time.Second {
		t.Errorf("a non-positive rate must mean the built-in 10/min (6s spacing), got %v", got)
	}
}

func TestRolloutLimiter_StaleReservationsAreForgotten(t *testing.T) {
	var l rolloutLimiter
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < 50; i++ {
		l.reserve(nn(i), t0, 10)
	}
	// An app deleted while waiting never comes back; its entry must not leak.
	l.reserve(nn(1000), t0.Add(24*time.Hour), 10)
	if n := l.pending(); n > 1 {
		t.Errorf("%d reservations still held a day later; abandoned ones must be purged", n)
	}
}

func TestRolloutLimiter_ReleaseDropsTheSlotAndRefreshesTheGauge(t *testing.T) {
	var l rolloutLimiter
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	l.reserve(nn(0), t0, 10)
	l.reserve(nn(1), t0, 10) // queued
	if got := testutil.ToFloat64(rolloutPending); got != 1 {
		t.Fatalf("rollout_pending = %v, want 1 after queueing one app", got)
	}
	l.release(nn(1))
	if n := l.pending(); n != 0 {
		t.Errorf("pending = %d after release, want 0", n)
	}
	if got := testutil.ToFloat64(rolloutPending); got != 0 {
		t.Errorf("rollout_pending = %v after release, want 0", got)
	}
}

// A deleted app that held a queued slot must not leave a phantom backlog: the
// gauge only otherwise refreshes inside reserve, so an alert on it would
// false-fire until some unrelated app next reserved.
func TestReconcile_DeletedAppReleasesItsQueuedRolloutSlot(t *testing.T) {
	r := &NextAppReconciler{Client: fake.NewClientBuilder().WithScheme(prewarmTestScheme(t)).Build()}
	t0 := time.Now()
	r.rollout.reserve(nn(0), t0, 10)
	r.rollout.reserve(nn(1), t0, 10) // queued, then the app is deleted
	if got := testutil.ToFloat64(rolloutPending); got != 1 {
		t.Fatalf("rollout_pending = %v, want 1 before delete", got)
	}
	if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: nn(1)}); err != nil {
		t.Fatalf("reconcile of a deleted app: %v", err)
	}
	if got := testutil.ToFloat64(rolloutPending); got != 0 {
		t.Errorf("rollout_pending = %v after the app was deleted, want 0", got)
	}
}
