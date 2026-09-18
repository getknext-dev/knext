package appdb

import (
	"testing"
	"time"
)

// alwaysWarm (ADR-0002 C3) is an additive ALIAS over the existing tier: warm
// held-connection warmhold — OR'd with tier and warmSchedule at BOTH decision
// sites (warmHoldRequested + reconcileWarmHold's `permanent`). Updating only one
// site silently RELEASES the hold on the other path, which is the regression these
// tests pin.

func TestWarmHoldRequested_AlwaysWarmMatrix(t *testing.T) {
	cases := []struct {
		name string
		spec AppDatabaseSpec
		want bool
	}{
		{"cold, nothing set", AppDatabaseSpec{AppName: "a"}, false},
		{"alwaysWarm true alone", AppDatabaseSpec{AppName: "a", AlwaysWarm: true}, true},
		{"tier warm alone", AppDatabaseSpec{AppName: "a", Tier: "warm"}, true},
		{"alwaysWarm false + tier warm (not a kill-switch)", AppDatabaseSpec{AppName: "a", AlwaysWarm: false, Tier: "warm"}, true},
		{"alwaysWarm true + tier cold", AppDatabaseSpec{AppName: "a", AlwaysWarm: true, Tier: "cold"}, true},
		{"schedule only", AppDatabaseSpec{AppName: "a", WarmSchedule: []WarmWindow{{Start: "0 8 * * *", End: "0 20 * * *"}}}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := &AppDatabase{Spec: tc.spec}
			if got := a.warmHoldRequested(); got != tc.want {
				t.Fatalf("warmHoldRequested()=%v, want %v", got, tc.want)
			}
		})
	}
}

// C3 regression: alwaysWarm:true ALONE (no tier, no warmSchedule) must reach the
// held-connection warmhold — the compute is pinned active and never idles to zero.
// Mutation-prove: revert EITHER warmHoldRequested() OR reconcile.go's `permanent`
// OR back to `== "warm"` and this reds (the first gate skips reconcileWarmHold
// entirely; the second releases the hold as "no window active").
func TestReconcile_AlwaysWarmAloneReachesHold(t *testing.T) {
	h, fh := harnessWithHolds(time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC))
	cr := &AppDatabase{
		Name: "shop", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{AppName: "shop", AlwaysWarm: true},
	}

	mustReconcile(t, h, cr)

	if !fh.held["shop"] {
		t.Fatalf("alwaysWarm:true alone did not reach the warmhold (held=%v, ensured=%v, released=%v)", fh.held, fh.ensured, fh.released)
	}
	if len(fh.released) != 0 {
		t.Fatalf("alwaysWarm:true released the hold: %v", fh.released)
	}
	c := cond(cr, CondWarmHold)
	if c == nil || c.Status != "True" || c.Reason != "TierWarm" {
		t.Fatalf("WarmHold condition = %+v, want True/TierWarm (permanent hold)", c)
	}
}

// alwaysWarm:false with tier:warm STILL holds — alwaysWarm is not a kill-switch,
// both are OR'd. Mutation-prove: an AND at either site would drop this hold.
func TestReconcile_AlwaysWarmFalseWithTierWarmStillHolds(t *testing.T) {
	h, fh := harnessWithHolds(time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC))
	cr := &AppDatabase{
		Name: "shop", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{AppName: "shop", AlwaysWarm: false, Tier: "warm"},
	}

	mustReconcile(t, h, cr)

	if !fh.held["shop"] {
		t.Fatalf("tier:warm with alwaysWarm:false did not hold (held=%v)", fh.held)
	}
}

// alwaysWarm:true SUBSUMES warmSchedule windows exactly like tier:warm — an
// INACTIVE window at `now` must NOT release the permanent hold. (Noon UTC; the
// window is 01:00-02:00, i.e. inactive.)
func TestReconcile_AlwaysWarmSubsumesInactiveWindow(t *testing.T) {
	h, fh := harnessWithHolds(time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC))
	cr := &AppDatabase{
		Name: "shop", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{
			AppName:      "shop",
			AlwaysWarm:   true,
			WarmSchedule: []WarmWindow{{Start: "0 1 * * *", End: "0 2 * * *", Timezone: "UTC"}},
		},
	}

	mustReconcile(t, h, cr)

	if !fh.held["shop"] {
		t.Fatalf("alwaysWarm did not subsume an inactive window (held=%v, released=%v)", fh.held, fh.released)
	}
	c := cond(cr, CondWarmHold)
	if c == nil || c.Status != "True" || c.Reason != "TierWarm" {
		t.Fatalf("WarmHold condition = %+v, want True/TierWarm", c)
	}
}
