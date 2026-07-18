package appdb

import (
	"testing"
	"time"
)

// Pure unit tests for the AppDatabase scheduled warm-window evaluation (#388,
// ADR-0030 addendum). These pin SEMANTIC PARITY with the knext operator's
// warmScheduleFloor (packages/kn-next-operator/internal/controller/
// warm_schedule_floor_test.go, #380/#394): the SAME 5-field-cron [start,end)
// membership rule ("active iff the next end fire is sooner than the next start
// fire"), the same per-window IANA timezone handling (empty => UTC), the same
// robfig/cron ParseStandard parser, and the same DST-transition behavior. The
// two operators evaluate the same owner-declared windows against cluster-synchronized
// clocks, so the knext pod floor and this DB warm hold flip together (the lockstep).
//
// Divergence from the knext shape BY DESIGN: no `replicas` field. A Neon compute
// is single-writer (Recreate strategy; one attach per timeline), so a DB warm
// window is binary — warm means exactly one compute held awake. A replicas field
// would imply a multi-replica writer compute that cannot exist.
//
// The table below is deliberately a PORT of the knext test table (incl. the
// #394 DST characterization cases) so the parity is reviewed line-by-line and a
// future semantic change on either side breaks one of the pair loudly.

func TestWarmScheduleActive(t *testing.T) {
	utc := time.UTC
	noon := time.Date(2026, 7, 18, 12, 0, 0, 0, utc)

	tests := []struct {
		name        string
		ws          []WarmWindow
		now         time.Time
		wantActive  bool
		wantInvalid int
	}{
		{
			name:       "empty schedule => inactive",
			ws:         nil,
			now:        noon,
			wantActive: false,
		},
		{
			name:       "inside an all-day window => active",
			ws:         []WarmWindow{{Start: "1 0 * * *", End: "59 23 * * *", Timezone: "UTC"}},
			now:        noon,
			wantActive: true,
		},
		{
			name:       "outside the window => inactive",
			ws:         []WarmWindow{{Start: "0 8 * * *", End: "0 9 * * *", Timezone: "UTC"}},
			now:        noon,
			wantActive: false,
		},
		{
			name:       "inside a bounded window => active",
			ws:         []WarmWindow{{Start: "0 10 * * *", End: "0 14 * * *", Timezone: "UTC"}},
			now:        noon,
			wantActive: true,
		},
		{
			name: "one of several windows active => active",
			ws: []WarmWindow{
				{Start: "0 8 * * *", End: "0 9 * * *", Timezone: "UTC"},
				{Start: "0 10 * * *", End: "0 14 * * *", Timezone: "UTC"},
			},
			now:        noon,
			wantActive: true,
		},
		{
			name:       "timezone-aware: window is active in its own tz",
			ws:         []WarmWindow{{Start: "0 8 * * *", End: "0 20 * * *", Timezone: "America/New_York"}},
			now:        time.Date(2026, 7, 18, 16, 0, 0, 0, utc), // 12:00 America/New_York (EDT, -4) => inside 08:00-20:00
			wantActive: true,
		},
		{
			name:       "timezone-aware: same UTC instant outside the tz window",
			ws:         []WarmWindow{{Start: "0 8 * * *", End: "0 20 * * *", Timezone: "America/New_York"}},
			now:        time.Date(2026, 7, 18, 3, 0, 0, 0, utc), // 23:00 previous day NY => outside
			wantActive: false,
		},
		{
			name:       "empty timezone defaults to UTC (active)",
			ws:         []WarmWindow{{Start: "0 10 * * *", End: "0 14 * * *"}},
			now:        noon,
			wantActive: true,
		},
		{
			name:        "malformed start cron => invalid, never active",
			ws:          []WarmWindow{{Start: "not-a-cron", End: "0 9 * * *", Timezone: "UTC"}},
			now:         noon,
			wantActive:  false,
			wantInvalid: 1,
		},
		{
			name:        "malformed end cron => invalid",
			ws:          []WarmWindow{{Start: "0 8 * * *", End: "70 9 * * *", Timezone: "UTC"}},
			now:         noon,
			wantActive:  false,
			wantInvalid: 1,
		},
		{
			name:        "unknown timezone => invalid",
			ws:          []WarmWindow{{Start: "0 8 * * *", End: "0 9 * * *", Timezone: "Not/AZone"}},
			now:         noon,
			wantActive:  false,
			wantInvalid: 1,
		},
		{
			name: "invalid window does not mask a valid active one",
			ws: []WarmWindow{
				{Start: "bogus", End: "0 9 * * *", Timezone: "UTC"},
				{Start: "0 10 * * *", End: "0 14 * * *", Timezone: "UTC"},
			},
			now:         noon,
			wantActive:  true,
			wantInvalid: 1,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			active, invalid := warmScheduleActive(tc.ws, tc.now)
			if active != tc.wantActive {
				t.Fatalf("warmScheduleActive active = %v, want %v", active, tc.wantActive)
			}
			if len(invalid) != tc.wantInvalid {
				t.Fatalf("warmScheduleActive invalid = %d, want %d (%v)", len(invalid), tc.wantInvalid, invalid)
			}
		})
	}
}

// DST-transition-boundary characterization tests — a direct port of the knext
// operator's #394 cases so both sides of the lockstep behave identically across
// the America/New_York 2026 transitions. A failure here is a real DST finding on
// the DB side, not something to paper over: if the app pod floor engages but the
// DB hold does not (or vice versa), the "lockstep" claim is false exactly at the
// boundaries where it matters.
//
// Reference instants (America/New_York, 2026):
//
//	spring-forward: 2026-03-08, 02:00 EST(-5) -> 03:00 EDT(-4). The 02:xx wall hour
//	  does not exist. UTC 07:00 == 03:00 EDT (the first instant after the gap).
//	fall-back: 2026-11-01, 02:00 EDT(-4) -> 01:00 EST(-5). The 01:xx wall hour occurs
//	  twice: first at UTC 05:00 (EDT), again at UTC 06:00 (EST).
func TestWarmScheduleActive_DSTSpringForward(t *testing.T) {
	utc := time.UTC
	ny := "America/New_York"

	morning := []WarmWindow{{Start: "0 3 * * *", End: "0 6 * * *", Timezone: ny}}

	// 01:30 EST (UTC 06:30) — before the window, before the gap. Hold off.
	if active, _ := warmScheduleActive(morning, time.Date(2026, 3, 8, 6, 30, 0, 0, utc)); active {
		t.Fatal("spring-forward pre-window (01:30 EST): active = true, want false")
	}
	// 03:00 EDT exactly (UTC 07:00) — the window start, immediately after the gap.
	if active, _ := warmScheduleActive(morning, time.Date(2026, 3, 8, 7, 0, 0, 0, utc)); !active {
		t.Fatal("spring-forward at window start (03:00 EDT): active = false, want true")
	}
	// 04:00 EDT (UTC 08:00) — inside the window. Hold held.
	if active, _ := warmScheduleActive(morning, time.Date(2026, 3, 8, 8, 0, 0, 0, utc)); !active {
		t.Fatal("spring-forward inside window (04:00 EDT): active = false, want true")
	}
	// 06:00 EDT (UTC 10:00) — the window end. Hold released.
	if active, _ := warmScheduleActive(morning, time.Date(2026, 3, 8, 10, 0, 0, 0, utc)); active {
		t.Fatal("spring-forward at window end (06:00 EDT): active = true, want false")
	}

	// EDGE: a window whose START (02:00) falls INSIDE the spring-forward gap. That
	// wall-clock instant does not exist on 2026-03-08; robfig/cron's Next skips to
	// the next real occurrence, so the window must still engage for the morning.
	gapStart := []WarmWindow{{Start: "0 2 * * *", End: "0 6 * * *", Timezone: ny}}
	if active, _ := warmScheduleActive(gapStart, time.Date(2026, 3, 8, 7, 30, 0, 0, utc)); !active {
		t.Fatal("spring-forward gap-start window (03:30 EDT): active = false, want true (start in the gap must not drop the window)")
	}
	if active, _ := warmScheduleActive(gapStart, time.Date(2026, 3, 8, 10, 0, 0, 0, utc)); active {
		t.Fatal("spring-forward gap-start window end (06:00 EDT): active = true, want false")
	}
}

func TestWarmScheduleActive_DSTFallBack(t *testing.T) {
	utc := time.UTC
	ny := "America/New_York"

	// A window 00:30 -> 03:00 spanning the fall-back overlap (the 01:00 wall hour
	// occurs twice). The hold must stay on across BOTH 01:xx passes and only drop
	// at the real 03:00 end.
	overnight := []WarmWindow{{Start: "30 0 * * *", End: "0 3 * * *", Timezone: ny}}

	if active, _ := warmScheduleActive(overnight, time.Date(2026, 11, 1, 4, 45, 0, 0, utc)); !active {
		t.Fatal("fall-back pre-transition (00:45 EDT): active = false, want true")
	}
	if active, _ := warmScheduleActive(overnight, time.Date(2026, 11, 1, 5, 30, 0, 0, utc)); !active {
		t.Fatal("fall-back first 01:30 pass (EDT): active = false, want true")
	}
	if active, _ := warmScheduleActive(overnight, time.Date(2026, 11, 1, 6, 30, 0, 0, utc)); !active {
		t.Fatal("fall-back second 01:30 pass (EST): active = false, want true (window must not drop across the overlap)")
	}
	if active, _ := warmScheduleActive(overnight, time.Date(2026, 11, 1, 7, 30, 0, 0, utc)); !active {
		t.Fatal("fall-back post-overlap (02:30 EST): active = false, want true")
	}
	if active, _ := warmScheduleActive(overnight, time.Date(2026, 11, 1, 8, 0, 0, 0, utc)); active {
		t.Fatal("fall-back at window end (03:00 EST): active = true, want false")
	}

	// A window whose START (01:00) lands on the repeated hour engages on the first
	// pass and must not be confused by the second.
	repeatStart := []WarmWindow{{Start: "0 1 * * *", End: "0 4 * * *", Timezone: ny}}
	if active, _ := warmScheduleActive(repeatStart, time.Date(2026, 11, 1, 4, 30, 0, 0, utc)); active {
		t.Fatal("fall-back repeat-start pre-window (00:30 EDT): active = true, want false")
	}
	if active, _ := warmScheduleActive(repeatStart, time.Date(2026, 11, 1, 6, 30, 0, 0, utc)); !active {
		t.Fatal("fall-back repeat-start inside window (01:30 EST): active = false, want true")
	}
	if active, _ := warmScheduleActive(repeatStart, time.Date(2026, 11, 1, 9, 0, 0, 0, utc)); active {
		t.Fatal("fall-back repeat-start at end (04:00 EST): active = true, want false")
	}
}
