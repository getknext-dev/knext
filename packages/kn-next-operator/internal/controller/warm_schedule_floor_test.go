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

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// Pure unit tests for the scheduled warm-floor window evaluation (ADR-0030,
// W5/#380). The operator is the single writer of min-scale; warmScheduleFloor is
// the deterministic core it uses on every reconcile. No API server / clock seam
// needed — `now` is a parameter.

func appWithWindows(minScale int32, ws ...appsv1alpha1.WarmWindow) *appsv1alpha1.NextApp {
	return &appsv1alpha1.NextApp{
		Spec: appsv1alpha1.NextAppSpec{
			Scaling: &appsv1alpha1.ScalingSpec{MinScale: minScale, MaxScale: 10, WarmSchedule: ws},
		},
	}
}

func TestWarmScheduleFloor(t *testing.T) {
	utc := time.UTC
	noon := time.Date(2026, 7, 18, 12, 0, 0, 0, utc)

	tests := []struct {
		name      string
		app       *appsv1alpha1.NextApp
		now       time.Time
		wantFloor int32
	}{
		{
			name:      "nil scaling => no floor",
			app:       &appsv1alpha1.NextApp{},
			now:       noon,
			wantFloor: 0,
		},
		{
			name:      "empty schedule => no floor",
			app:       appWithWindows(0),
			now:       noon,
			wantFloor: 0,
		},
		{
			name:      "inside an all-day window => window floor",
			app:       appWithWindows(0, appsv1alpha1.WarmWindow{Start: "1 0 * * *", End: "59 23 * * *", Replicas: 3, Timezone: "UTC"}),
			now:       noon,
			wantFloor: 3,
		},
		{
			name:      "outside the window => no floor",
			app:       appWithWindows(0, appsv1alpha1.WarmWindow{Start: "0 8 * * *", End: "0 9 * * *", Replicas: 5, Timezone: "UTC"}),
			now:       noon,
			wantFloor: 0,
		},
		{
			name:      "inside a bounded window => window floor",
			app:       appWithWindows(0, appsv1alpha1.WarmWindow{Start: "0 10 * * *", End: "0 14 * * *", Replicas: 5, Timezone: "UTC"}),
			now:       noon,
			wantFloor: 5,
		},
		{
			name: "overlapping active windows => max replicas",
			app: appWithWindows(0,
				appsv1alpha1.WarmWindow{Start: "1 0 * * *", End: "59 23 * * *", Replicas: 2, Timezone: "UTC"},
				appsv1alpha1.WarmWindow{Start: "0 10 * * *", End: "0 14 * * *", Replicas: 6, Timezone: "UTC"},
			),
			now:       noon,
			wantFloor: 6,
		},
		{
			name:      "timezone-aware: window is active in its own tz",
			app:       appWithWindows(0, appsv1alpha1.WarmWindow{Start: "0 8 * * *", End: "0 20 * * *", Replicas: 4, Timezone: "America/New_York"}),
			now:       time.Date(2026, 7, 18, 16, 0, 0, 0, utc), // 12:00 America/New_York (EDT, -4) => inside 08:00-20:00
			wantFloor: 4,
		},
		{
			name:      "timezone-aware: same UTC instant outside the tz window",
			app:       appWithWindows(0, appsv1alpha1.WarmWindow{Start: "0 8 * * *", End: "0 20 * * *", Replicas: 4, Timezone: "America/New_York"}),
			now:       time.Date(2026, 7, 18, 3, 0, 0, 0, utc), // 23:00 previous day NY => outside
			wantFloor: 0,
		},
		{
			name:      "empty timezone defaults to UTC (active)",
			app:       appWithWindows(0, appsv1alpha1.WarmWindow{Start: "0 10 * * *", End: "0 14 * * *", Replicas: 7}),
			now:       noon,
			wantFloor: 7,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			floor, _, _ := warmScheduleFloor(tc.app, tc.now)
			if floor != tc.wantFloor {
				t.Fatalf("warmScheduleFloor floor = %d, want %d", floor, tc.wantFloor)
			}
		})
	}
}

// The effective ksvc floor is max(Spec.MinScale, active window). warmScheduleFloor
// only returns the window part; the max is applied in buildDesiredKsvc. This test
// documents that contract so the composition is not accidentally broken.
func TestWarmScheduleFloor_WindowPartOnly(t *testing.T) {
	app := appWithWindows(2, appsv1alpha1.WarmWindow{Start: "0 8 * * *", End: "0 9 * * *", Replicas: 5, Timezone: "UTC"})
	// Outside the window the window-floor is 0 (Spec.MinScale is applied by the caller).
	floor, _, _ := warmScheduleFloor(app, time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC))
	if floor != 0 {
		t.Fatalf("outside window: window floor = %d, want 0 (Spec.MinScale is the caller's job)", floor)
	}
}

func TestWarmScheduleFloor_NextBoundary(t *testing.T) {
	utc := time.UTC
	app := appWithWindows(0, appsv1alpha1.WarmWindow{Start: "0 8 * * *", End: "0 9 * * *", Replicas: 5, Timezone: "UTC"})

	// At 07:00 the next boundary is the 08:00 start (1h away).
	_, next, has := warmScheduleFloor(app, time.Date(2026, 7, 18, 7, 0, 0, 0, utc))
	if !has {
		t.Fatal("expected a next boundary")
	}
	if want := time.Date(2026, 7, 18, 8, 0, 0, 0, utc); !next.Equal(want) {
		t.Fatalf("next boundary = %v, want %v (the 08:00 start)", next, want)
	}

	// Inside the window at 08:30 the next boundary is the 09:00 end.
	_, next2, _ := warmScheduleFloor(app, time.Date(2026, 7, 18, 8, 30, 0, 0, utc))
	if want := time.Date(2026, 7, 18, 9, 0, 0, 0, utc); !next2.Equal(want) {
		t.Fatalf("next boundary = %v, want %v (the 09:00 end)", next2, want)
	}
}

func TestWarmScheduleRequeue(t *testing.T) {
	utc := time.UTC
	app := appWithWindows(0, appsv1alpha1.WarmWindow{Start: "0 8 * * *", End: "0 9 * * *", Replicas: 5, Timezone: "UTC"})

	// No schedule => zero (no requeue driven by warm floor).
	if d := warmScheduleRequeue(appWithWindows(0), time.Now()); d != 0 {
		t.Fatalf("empty schedule requeue = %v, want 0", d)
	}

	// A boundary far in the future is clamped to warmRequeueMax.
	if d := warmScheduleRequeue(app, time.Date(2026, 7, 18, 10, 0, 0, 0, utc)); d != warmRequeueMax {
		t.Fatalf("distant boundary requeue = %v, want clamp %v", d, warmRequeueMax)
	}

	// A boundary essentially now is floored to warmRequeueMin (never a 0s busy loop).
	if d := warmScheduleRequeue(app, time.Date(2026, 7, 18, 7, 59, 59, 0, utc)); d != warmRequeueMin {
		t.Fatalf("near boundary requeue = %v, want floor %v", d, warmRequeueMin)
	}

	// A boundary ~30m out is returned as-is (within the clamp band).
	if d := warmScheduleRequeue(app, time.Date(2026, 7, 18, 7, 30, 0, 0, utc)); d != 30*time.Minute {
		t.Fatalf("mid-band boundary requeue = %v, want 30m", d)
	}
}

// DST-transition-boundary characterization tests (#394, ADR-0030). warmScheduleFloor
// evaluates each window in its own IANA timezone via robfig/cron ParseStandard +
// time.LoadLocation, which is DST-aware. DST transitions are a classic scheduled-job
// bug source: at spring-forward a wall-clock hour is SKIPPED (02:00->03:00 gap) and
// at fall-back an hour occurs TWICE (01:00->02:00 replayed). These tests pin that the
// floor engages/disengages correctly straddling the two America/New_York 2026
// transitions. They must PASS against current code — they characterize (not fix)
// behavior. A failure here is a real DST finding to report, not to paper over.
//
// Reference instants (America/New_York, 2026):
//
//	spring-forward: 2026-03-08, 02:00 EST(-5) -> 03:00 EDT(-4). The 02:xx wall hour
//	  does not exist. UTC 07:00 == 03:00 EDT (the first instant after the gap).
//	fall-back: 2026-11-01, 02:00 EDT(-4) -> 01:00 EST(-5). The 01:xx wall hour occurs
//	  twice: first at UTC 05:00 (EDT), again at UTC 06:00 (EST).
func TestWarmScheduleFloor_DSTSpringForward(t *testing.T) {
	utc := time.UTC
	ny := "America/New_York"

	// A window whose START (03:00) falls exactly on the post-gap resume. Before the
	// transition the floor is off; from 03:00 EDT onward it engages. The 02:xx gap
	// hour never occurs, so a would-be 02:00 wall time is moot.
	morning := appWithWindows(0, appsv1alpha1.WarmWindow{
		Start: "0 3 * * *", End: "0 6 * * *", Replicas: 4, Timezone: ny,
	})

	// 01:30 EST (UTC 06:30) — before the window, before the gap. Floor off.
	if floor, _, _ := warmScheduleFloor(morning, time.Date(2026, 3, 8, 6, 30, 0, 0, utc)); floor != 0 {
		t.Fatalf("spring-forward pre-window (01:30 EST): floor = %d, want 0", floor)
	}
	// 03:00 EDT exactly (UTC 07:00) — the window start, immediately after the gap.
	// Floor engages.
	if floor, _, _ := warmScheduleFloor(morning, time.Date(2026, 3, 8, 7, 0, 0, 0, utc)); floor != 4 {
		t.Fatalf("spring-forward at window start (03:00 EDT): floor = %d, want 4", floor)
	}
	// 04:00 EDT (UTC 08:00) — inside the window. Floor held.
	if floor, _, _ := warmScheduleFloor(morning, time.Date(2026, 3, 8, 8, 0, 0, 0, utc)); floor != 4 {
		t.Fatalf("spring-forward inside window (04:00 EDT): floor = %d, want 4", floor)
	}
	// 06:00 EDT (UTC 10:00) — the window end. Floor disengages.
	if floor, _, _ := warmScheduleFloor(morning, time.Date(2026, 3, 8, 10, 0, 0, 0, utc)); floor != 0 {
		t.Fatalf("spring-forward at window end (06:00 EDT): floor = %d, want 0", floor)
	}

	// EDGE: a window whose START (02:00) falls INSIDE the spring-forward gap. That
	// wall-clock instant does not exist on 2026-03-08. robfig/cron's Next skips to
	// the next real occurrence, so the 02:00 start effectively fires at/after the
	// resumed clock. This pins that the floor still engages across the morning of
	// the transition rather than silently vanishing for the day.
	gapStart := appWithWindows(0, appsv1alpha1.WarmWindow{
		Start: "0 2 * * *", End: "0 6 * * *", Replicas: 5, Timezone: ny,
	})
	// 03:30 EDT (UTC 07:30) — past the (skipped) 02:00 start, before the 06:00 end.
	// The window is active for the rest of the morning.
	if floor, _, _ := warmScheduleFloor(gapStart, time.Date(2026, 3, 8, 7, 30, 0, 0, utc)); floor != 5 {
		t.Fatalf("spring-forward gap-start window (03:30 EDT): floor = %d, want 5 (start in the gap must not drop the window)", floor)
	}
	// 06:00 EDT (UTC 10:00) — the end. Floor off.
	if floor, _, _ := warmScheduleFloor(gapStart, time.Date(2026, 3, 8, 10, 0, 0, 0, utc)); floor != 0 {
		t.Fatalf("spring-forward gap-start window end (06:00 EDT): floor = %d, want 0", floor)
	}
}

func TestWarmScheduleFloor_DSTFallBack(t *testing.T) {
	utc := time.UTC
	ny := "America/New_York"

	// A window 00:30 -> 03:00 that spans the fall-back overlap (the 01:00 wall hour
	// occurs twice). The floor must stay engaged across BOTH 01:xx passes and only
	// disengage at the real 03:00 end.
	overnight := appWithWindows(0, appsv1alpha1.WarmWindow{
		Start: "30 0 * * *", End: "0 3 * * *", Replicas: 6, Timezone: ny,
	})

	// 00:45 EDT (UTC 04:45) — inside the window, before the fall-back. Floor on.
	if floor, _, _ := warmScheduleFloor(overnight, time.Date(2026, 11, 1, 4, 45, 0, 0, utc)); floor != 6 {
		t.Fatalf("fall-back pre-transition (00:45 EDT): floor = %d, want 6", floor)
	}
	// 01:30 EDT (UTC 05:30) — the FIRST pass through the repeated 01:xx hour. On.
	if floor, _, _ := warmScheduleFloor(overnight, time.Date(2026, 11, 1, 5, 30, 0, 0, utc)); floor != 6 {
		t.Fatalf("fall-back first 01:30 pass (EDT): floor = %d, want 6", floor)
	}
	// 01:30 EST (UTC 06:30) — the SECOND pass through the repeated 01:xx hour after
	// clocks fell back. Still inside the window; floor must stay on (not double-fire
	// or drop).
	if floor, _, _ := warmScheduleFloor(overnight, time.Date(2026, 11, 1, 6, 30, 0, 0, utc)); floor != 6 {
		t.Fatalf("fall-back second 01:30 pass (EST): floor = %d, want 6 (window must not drop across the overlap)", floor)
	}
	// 02:30 EST (UTC 07:30) — after the overlap, still before 03:00 end. On.
	if floor, _, _ := warmScheduleFloor(overnight, time.Date(2026, 11, 1, 7, 30, 0, 0, utc)); floor != 6 {
		t.Fatalf("fall-back post-overlap (02:30 EST): floor = %d, want 6", floor)
	}
	// 03:00 EST (UTC 08:00) — the window end. Floor off.
	if floor, _, _ := warmScheduleFloor(overnight, time.Date(2026, 11, 1, 8, 0, 0, 0, utc)); floor != 0 {
		t.Fatalf("fall-back at window end (03:00 EST): floor = %d, want 0", floor)
	}

	// A window whose START (01:00) lands on the repeated hour. It should engage on
	// the first 01:00 pass and remain engaged; it must not be confused by the second.
	repeatStart := appWithWindows(0, appsv1alpha1.WarmWindow{
		Start: "0 1 * * *", End: "0 4 * * *", Replicas: 7, Timezone: ny,
	})
	// 00:30 EDT (UTC 04:30) — before the 01:00 start. Off.
	if floor, _, _ := warmScheduleFloor(repeatStart, time.Date(2026, 11, 1, 4, 30, 0, 0, utc)); floor != 0 {
		t.Fatalf("fall-back repeat-start pre-window (00:30 EDT): floor = %d, want 0", floor)
	}
	// 01:30 EST (UTC 06:30) — inside the window (after both 01:00 firings). On.
	if floor, _, _ := warmScheduleFloor(repeatStart, time.Date(2026, 11, 1, 6, 30, 0, 0, utc)); floor != 7 {
		t.Fatalf("fall-back repeat-start inside window (01:30 EST): floor = %d, want 7", floor)
	}
	// 04:00 EST (UTC 09:00) — the end. Off.
	if floor, _, _ := warmScheduleFloor(repeatStart, time.Date(2026, 11, 1, 9, 0, 0, 0, utc)); floor != 0 {
		t.Fatalf("fall-back repeat-start at end (04:00 EST): floor = %d, want 0", floor)
	}
}
