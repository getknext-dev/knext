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
