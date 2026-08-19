package appdb

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Reconcile-level tests for `spec.tier: warm` reimplemented on the warm-hold
// actuator (#777, closes #778).
//
// The defect these pin: `tier: warm` used to mean "apply the Deployment at
// replicas 1". ApplyCompute PRESERVES live replicas on update (the gateway is
// the single writer of per-app replicas), and the gateway parks the compute at
// 0 once the first connection closes and GW_IDLE_MS elapses — so nothing ever
// restored the replica and the tier silently degraded to cold FOREVER, while
// status kept reporting warm-tier readiness. The fix: a warm tier is a
// PERMANENT warm hold — a 24/7 warmSchedule window — held by the same actuator,
// surfaced on the same WarmHold condition and appdb_warm_hold_active gauge.

func TestTierWarm_HoldEnsuredWithoutAnySchedule(t *testing.T) {
	h, fh := harnessWithHolds(time.Date(2026, 8, 18, 3, 0, 0, 0, time.UTC))
	cr := &AppDatabase{
		Name: "app1", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{AppName: "app1", Tier: "warm"},
	}

	mustReconcile(t, h, cr)

	if len(fh.ensured) != 1 || fh.ensured[0] != "app1" {
		t.Fatalf("EnsureHold calls = %v, want exactly [app1] (tier warm is a permanent hold)", fh.ensured)
	}
	if len(fh.released) != 0 {
		t.Fatalf("ReleaseHold calls = %v, want none for a warm tier", fh.released)
	}
	c := cond(cr, CondWarmHold)
	if c == nil || c.Status != "True" || c.Reason != "TierWarm" {
		t.Fatalf("WarmHold condition = %+v, want True/TierWarm", c)
	}
}

func TestTierWarm_OperatorNeverWritesAReplicaFloor(t *testing.T) {
	// The #766 ruling: no minWarm / replica-floor field, and the operator does
	// not write replicas to keep an app warm. The gateway stays the single
	// writer; warmth comes from the held connection.
	h, _ := harnessWithHolds(time.Date(2026, 8, 18, 3, 0, 0, 0, time.UTC))
	cr := &AppDatabase{
		Name: "app1", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{AppName: "app1", Tier: "warm"},
	}

	mustReconcile(t, h, cr)

	if got := h.cl.applied[len(h.cl.applied)-1].Replicas; got != 0 {
		t.Fatalf("tier warm applied replicas = %d, want 0 (the hold warms it; the gateway owns replicas)", got)
	}
}

func TestTierWarm_StaysWarmPastTheIdleWindowThatUsedToDegradeIt(t *testing.T) {
	// AC1 at the level the reconciler can prove: the exact sequence that used to
	// degrade the tier is (first connection closes) + (GW_IDLE_MS elapses), i.e.
	// the gateway parks the compute and the operator never re-warms it. Modelled
	// here by DROPPING the fake's hold between passes (the actuator-level re-dial
	// of a dead hold is covered by TestHoldManager_DeadHoldIsRedialed): every
	// later pass must re-establish it, hours later and outside any plausible
	// business-hours window, while the operator still writes no replicas. Under
	// the old mechanism no EnsureHold ever happened, so the compute stayed at 0.
	// (The deployment is unavailable throughout — depAvailable is false on every
	// pass — which is exactly the state that used to pin the tier in Provisioning.)
	h, fh := harnessWithHolds(time.Date(2026, 8, 18, 3, 0, 0, 0, time.UTC))
	cr := &AppDatabase{
		Name: "app1", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{AppName: "app1", Tier: "warm"},
	}
	mustReconcile(t, h, cr)
	if !fh.held["app1"] {
		t.Fatal("hold not established on the first pass")
	}

	// The gateway's idle window elapses and several resync ticks pass — hours
	// later, and outside any plausible business-hours window.
	for i, at := range []time.Time{
		time.Date(2026, 8, 18, 4, 0, 0, 0, time.UTC),
		time.Date(2026, 8, 18, 12, 0, 0, 0, time.UTC),
		time.Date(2026, 8, 19, 2, 0, 0, 0, time.UTC),
	} {
		h.d.Now = func() metav1.Time { return metav1.NewTime(at) }
		delete(fh.held, "app1") // the gateway parked the compute; only a re-ensure brings it back
		mustReconcile(t, h, cr)
		if !fh.held["app1"] {
			t.Fatalf("hold dropped on pass %d (%s) — the warm tier degraded to cold", i+2, at)
		}
		if c := cond(cr, CondWarmHold); c == nil || c.Status != "True" {
			t.Fatalf("WarmHold condition on pass %d = %+v, want True", i+2, c)
		}
	}
	if len(fh.released) != 0 {
		t.Fatalf("ReleaseHold calls = %v, want none — a warm tier's hold is permanent", fh.released)
	}
}

func TestTierWarm_StatusIsWarmAndHealthyOnlyWhileHeld(t *testing.T) {
	h, _ := harnessWithHolds(time.Date(2026, 8, 18, 3, 0, 0, 0, time.UTC))
	cr := &AppDatabase{
		Name: "app1", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{AppName: "app1", Tier: "warm"},
	}

	mustReconcile(t, h, cr)

	if cr.Status.Phase != PhaseReady {
		t.Fatalf("phase = %q, want Ready", cr.Status.Phase)
	}
	c := cond(cr, CondReady)
	if c == nil || c.Status != "True" || c.Reason != "WarmHeld" {
		t.Fatalf("Ready condition = %+v, want True/WarmHeld", c)
	}
}

func TestTierWarm_FailedHoldNeverReportsWarmAndHealthy(t *testing.T) {
	// Honest status (AC3): a warm tier whose hold FAILED must not claim warmth.
	// Degrade-not-fail, exactly like the schedule path: serving is never gated
	// (cold wake still works), the degradation is on the conditions + the event.
	h, fh := harnessWithHolds(time.Date(2026, 8, 18, 3, 0, 0, 0, time.UTC))
	fh.failEnsure["app1"] = true
	cr := &AppDatabase{
		Name: "app1", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{AppName: "app1", Tier: "warm"},
	}

	mustReconcile(t, h, cr)

	wh := cond(cr, CondWarmHold)
	if wh == nil || wh.Status != "False" || wh.Reason != "HoldFailed" {
		t.Fatalf("WarmHold condition = %+v, want False/HoldFailed", wh)
	}
	if !hasEvent(h, "WarmHoldFailed") {
		t.Fatalf("events = %v, want a WarmHoldFailed Warning", h.cl.events)
	}
	rd := cond(cr, CondReady)
	if rd == nil || rd.Status != "True" || rd.Reason != "WarmHoldDegraded" {
		t.Fatalf("Ready condition = %+v, want True/WarmHoldDegraded (serving is never gated, warmth is not claimed)", rd)
	}
	if cr.Status.Phase != PhaseReady {
		t.Fatalf("phase = %q, want Ready (a hold failure degrades warming, never provisioning)", cr.Status.Phase)
	}
	if !strings.Contains(cr.Status.Message, "wakes on connect") {
		t.Fatalf("status.message = %q, want it to say the compute wakes on connect (degraded to cold)", cr.Status.Message)
	}
}

func TestTierWarm_HoldsUnavailableIsSurfacedNotAssumedWarm(t *testing.T) {
	// An install without the warm-hold actuator wired cannot honour tier: warm.
	// It must say so rather than silently reporting a warm tier.
	h := newHarness()
	h.d.Holds = nil
	cr := &AppDatabase{
		Name: "app1", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{AppName: "app1", Tier: "warm"},
	}

	mustReconcile(t, h, cr)

	wh := cond(cr, CondWarmHold)
	if wh == nil || wh.Status != "False" || wh.Reason != "HoldsUnavailable" {
		t.Fatalf("WarmHold condition = %+v, want False/HoldsUnavailable", wh)
	}
	rd := cond(cr, CondReady)
	if rd == nil || rd.Status != "True" || rd.Reason != "WarmHoldDegraded" {
		t.Fatalf("Ready condition = %+v, want True/WarmHoldDegraded", rd)
	}
}

func TestTierWarm_SubsumesWarmScheduleWindows(t *testing.T) {
	// Lead's semantics call (AC6): tier: warm is a PERMANENT hold, active
	// regardless of any declared window. Reconciled at 23:00 UTC — outside the
	// 08:00-20:00 window — the hold is still ensured, never released.
	h, fh := harnessWithHolds(time.Date(2026, 8, 18, 23, 0, 0, 0, time.UTC))
	cr := &AppDatabase{
		Name: "app1", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{
			AppName:      "app1",
			Tier:         "warm",
			WarmSchedule: []WarmWindow{{Start: "0 8 * * *", End: "0 20 * * *", Timezone: "UTC"}},
		},
	}

	mustReconcile(t, h, cr)

	if len(fh.ensured) != 1 || fh.ensured[0] != "app1" {
		t.Fatalf("EnsureHold calls = %v, want [app1] — the permanent hold subsumes the windows", fh.ensured)
	}
	if len(fh.released) != 0 {
		t.Fatalf("ReleaseHold calls = %v, want none — a window boundary must not drop a warm tier's hold", fh.released)
	}
	c := cond(cr, CondWarmHold)
	if c == nil || c.Status != "True" || c.Reason != "TierWarm" {
		t.Fatalf("WarmHold condition = %+v, want True/TierWarm (tier wins over the window)", c)
	}
}

func TestTierWarm_HoldReleasedOnDelete(t *testing.T) {
	h, fh := harnessWithHolds(time.Date(2026, 8, 18, 3, 0, 0, 0, time.UTC))
	now := metav1.NewTime(time.Date(2026, 8, 18, 3, 0, 0, 0, time.UTC))
	cr := &AppDatabase{
		Name: "app1", Namespace: "scale-zero-pg", Generation: 1, UID: "u1",
		Spec: AppDatabaseSpec{AppName: "app1", Tier: "warm"},
	}
	mustReconcile(t, h, cr)
	if !fh.held["app1"] {
		t.Fatal("hold not established before delete")
	}

	cr.DeletionTimestamp = &now
	mustReconcile(t, h, cr)

	if fh.held["app1"] {
		t.Fatal("hold still established after delete — a deprovisioned warm app would keep warming")
	}
}

func TestTierCold_UnaffectedByTheWarmTierHold(t *testing.T) {
	// Back-compat (the cheap path): a cold tier (the default) never DIALS a hold
	// and grows no WarmHold condition. Withdrawal (below) makes the reconciler
	// call the idempotent ReleaseHold on every non-warm pass — that is a cheap
	// in-process map delete, and it must remain INVISIBLE on the CR: no
	// condition, no event, no churn across repeated passes.
	h, fh := harnessWithHolds(time.Date(2026, 8, 18, 3, 0, 0, 0, time.UTC))
	cr := &AppDatabase{
		Name: "app1", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{AppName: "app1", Tier: "cold"},
	}

	mustReconcile(t, h, cr)
	condsAfterFirst := len(cr.Status.Conditions)
	eventsAfterFirst := len(h.cl.events)
	mustReconcile(t, h, cr) // a second resync tick must change nothing

	if len(fh.ensured) != 0 {
		t.Fatalf("EnsureHold calls = %v, want none for a cold tier", fh.ensured)
	}
	if c := cond(cr, CondWarmHold); c != nil {
		t.Fatalf("WarmHold condition = %+v, want absent for a cold tier that never asked for warmth", c)
	}
	if hasEvent(h, "WarmHoldFailed") || hasEvent(h, "InvalidWarmWindow") {
		t.Fatalf("events = %v, want no warm-hold events on an ordinary cold CR", h.cl.events)
	}
	if got := len(cr.Status.Conditions); got != condsAfterFirst {
		t.Fatalf("conditions churned on resync: %d -> %d (%+v)", condsAfterFirst, got, cr.Status.Conditions)
	}
	if got := len(h.cl.events); got != eventsAfterFirst {
		t.Fatalf("events churned on resync: %d -> %d (%v)", eventsAfterFirst, got, h.cl.events)
	}
	rd := cond(cr, CondReady)
	if rd == nil || rd.Status != "True" || rd.Reason != "Provisioned" {
		t.Fatalf("Ready condition = %+v, want True/Provisioned (cold tier unchanged)", rd)
	}
}

func TestTierWarm_FlipToColdReleasesTheHoldAndRetractsTheCondition(t *testing.T) {
	// Review finding (HIGH): withdrawing warmth by EDITING the spec must undo it.
	// Before this fix the whole hold path was gated on warmHoldRequested(), so a
	// warm -> cold edit on a schedule-less CR never reached ReleaseHold: the
	// permanent hold survived until the operator process restarted, the compute
	// could never idle to zero again, CondWarmHold stayed True/TierWarm on a COLD
	// tier, and the leaked hold kept counting in appdb_warm_hold_active — blinding
	// the ComputePhantomKeepalive alert that would otherwise have caught it.
	h, fh := harnessWithHolds(time.Date(2026, 8, 18, 3, 0, 0, 0, time.UTC))
	cr := &AppDatabase{
		Name: "app1", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{AppName: "app1", Tier: "warm"},
	}
	mustReconcile(t, h, cr)
	if !fh.held["app1"] {
		t.Fatal("hold not established while tier: warm")
	}

	// The owner edits the CR back to the cold tier (no warmSchedule at all).
	cr.Spec.Tier = "cold"
	cr.Generation = 2
	mustReconcile(t, h, cr)

	if fh.held["app1"] {
		t.Fatal("hold STILL held after flipping tier: warm -> cold — the compute can never idle to zero again")
	}
	if len(fh.released) == 0 {
		t.Fatalf("ReleaseHold calls = %v, want app1 released when warmth is withdrawn", fh.released)
	}
	wh := cond(cr, CondWarmHold)
	if wh == nil || wh.Status != "False" || wh.Reason != "WarmthNotRequested" {
		t.Fatalf("WarmHold condition = %+v, want False/WarmthNotRequested (retracted, never stale True/TierWarm)", wh)
	}
	rd := cond(cr, CondReady)
	if rd == nil || rd.Status != "True" || rd.Reason != "Provisioned" {
		t.Fatalf("Ready condition = %+v, want True/Provisioned — and it is only honest because the hold is gone", rd)
	}
}

func TestTierWarm_FirstPassDoesNotFailTheHoldBeforeTheBranchExists(t *testing.T) {
	// Review finding (MED, ordering): on a first-ever `tier: warm` create the hold
	// must be dialled AFTER the pageserver branch exists. Dialling first wakes the
	// compute against a TIMELINE_ID the pageserver does not have yet, so the first
	// pass predictably yielded False/HoldFailed + a WarmHoldFailed Warning event +
	// a burnt wake-budget token, self-healing only on the next ~15s resync.
	h, fh := harnessWithHolds(time.Date(2026, 8, 18, 3, 0, 0, 0, time.UTC))
	// Model the real failure mode: the hold can only be established once this
	// app's branch exists on the pageserver.
	h.d.Holds = &branchGatedHolds{inner: fh, ps: h.ps}
	cr := &AppDatabase{
		Name: "app1", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{AppName: "app1", Tier: "warm"},
	}

	mustReconcile(t, h, cr)

	if hasEvent(h, "WarmHoldFailed") {
		t.Fatalf("events = %v, want no WarmHoldFailed on a first-pass warm create whose branch succeeded in the same pass", h.cl.events)
	}
	wh := cond(cr, CondWarmHold)
	if wh == nil || wh.Status != "True" || wh.Reason != "TierWarm" {
		t.Fatalf("WarmHold condition = %+v, want True/TierWarm on the first pass", wh)
	}
	if !fh.held["app1"] {
		t.Fatal("hold not established on the first pass")
	}
	// The step-4 invariant still holds: the compute is applied at 0 BEFORE the
	// branch — a Deployment at 0 starts nothing.
	if h.cl.applied[0].Replicas != 0 {
		t.Fatalf("first applied replicas = %d, want 0", h.cl.applied[0].Replicas)
	}
}

// branchGatedHolds refuses to establish a hold until the app's timeline has been
// branched on the pageserver — the fake counterpart of a gateway wake against a
// TIMELINE_ID the pageserver does not know yet.
type branchGatedHolds struct {
	inner *fakeHolds
	ps    *fakePS
}

func (b *branchGatedHolds) EnsureHold(ctx context.Context, app string) error {
	if len(b.ps.branchArgs) == 0 {
		b.inner.ensured = append(b.inner.ensured, app)
		return errors.New("dial pggw-apps: compute-" + app + " failed to start (no such timeline on the pageserver)")
	}
	return b.inner.EnsureHold(ctx, app)
}

func (b *branchGatedHolds) ReleaseHold(app string) { b.inner.ReleaseHold(app) }
