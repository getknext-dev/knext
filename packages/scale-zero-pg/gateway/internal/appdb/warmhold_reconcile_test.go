package appdb

import (
	"context"
	"errors"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Reconcile-level tests for the scheduled DB warm lockstep (#388, ADR-0030
// addendum). The decision — ensure a hold while any warmSchedule window is
// active, release it otherwise — lives in the pure reconciler so it is
// table-testable here against the fake Holds port; the HoldManager actuator is
// unit-tested separately (warmhold_test.go).

type fakeHolds struct {
	ensured    []string
	released   []string
	held       map[string]bool
	failEnsure map[string]bool
}

func newFakeHolds() *fakeHolds {
	return &fakeHolds{held: map[string]bool{}, failEnsure: map[string]bool{}}
}

func (f *fakeHolds) EnsureHold(_ context.Context, app string) error {
	f.ensured = append(f.ensured, app)
	if f.failEnsure[app] {
		return errors.New("dial pggw-apps: connection refused")
	}
	f.held[app] = true
	return nil
}

func (f *fakeHolds) ReleaseHold(app string) {
	f.released = append(f.released, app)
	delete(f.held, app)
}

// harnessWithHolds builds the standard harness plus the Holds port and a
// settable clock (window membership is evaluated against d.Now()).
func harnessWithHolds(now time.Time) (*harness, *fakeHolds) {
	h := newHarness()
	fh := newFakeHolds()
	h.d.Holds = fh
	h.d.Now = func() metav1.Time { return metav1.NewTime(now) }
	return h, fh
}

func hasEvent(h *harness, reason string) bool {
	for _, e := range h.cl.events {
		if e == reason {
			return true
		}
	}
	return false
}

func TestWarmHold_EnsuredWhileWindowActive(t *testing.T) {
	// Noon UTC; an 08:00-20:00 UTC window is active.
	h, fh := harnessWithHolds(time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC))
	cr := &AppDatabase{
		Name: "app1", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{
			AppName:      "app1",
			WarmSchedule: []WarmWindow{{Start: "0 8 * * *", End: "0 20 * * *", Timezone: "UTC"}},
		},
	}

	mustReconcile(t, h, cr)

	if len(fh.ensured) != 1 || fh.ensured[0] != "app1" {
		t.Fatalf("EnsureHold calls = %v, want exactly [app1] (window active)", fh.ensured)
	}
	if len(fh.released) != 0 {
		t.Fatalf("ReleaseHold calls = %v, want none while the window is active", fh.released)
	}
	c := cond(cr, CondWarmHold)
	if c == nil || c.Status != "True" || c.Reason != "WindowActive" {
		t.Fatalf("WarmHold condition = %+v, want True/WindowActive", c)
	}
	// The cold-tier readiness contract is unchanged: provisioned == Ready even with
	// a hold engaged (the hold is warming, not a serving gate).
	if cr.Status.Phase != PhaseReady {
		t.Fatalf("phase = %q, want Ready (a warm hold must not change serving semantics)", cr.Status.Phase)
	}
}

func TestWarmHold_ReleasedOutsideWindow(t *testing.T) {
	// 23:00 UTC; the 08:00-20:00 UTC window has ended.
	h, fh := harnessWithHolds(time.Date(2026, 7, 18, 23, 0, 0, 0, time.UTC))
	cr := &AppDatabase{
		Name: "app1", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{
			AppName:      "app1",
			WarmSchedule: []WarmWindow{{Start: "0 8 * * *", End: "0 20 * * *", Timezone: "UTC"}},
		},
	}

	mustReconcile(t, h, cr)

	if len(fh.ensured) != 0 {
		t.Fatalf("EnsureHold calls = %v, want none outside the window", fh.ensured)
	}
	if len(fh.released) != 1 || fh.released[0] != "app1" {
		t.Fatalf("ReleaseHold calls = %v, want exactly [app1] (idempotent release at window end)", fh.released)
	}
	c := cond(cr, CondWarmHold)
	if c == nil || c.Status != "False" || c.Reason != "WindowInactive" {
		t.Fatalf("WarmHold condition = %+v, want False/WindowInactive", c)
	}
}

func TestWarmHold_FlipsWithTheClock(t *testing.T) {
	// The SAME cr reconciled at two instants flips the hold — this is the lockstep
	// the owner gets by declaring the same windows on the NextApp.
	h, fh := harnessWithHolds(time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC))
	cr := &AppDatabase{
		Name: "app1", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{
			AppName:      "app1",
			WarmSchedule: []WarmWindow{{Start: "0 8 * * *", End: "0 20 * * *", Timezone: "UTC"}},
		},
	}
	mustReconcile(t, h, cr)
	if !fh.held["app1"] {
		t.Fatal("hold not established inside the window")
	}

	h.d.Now = func() metav1.Time { return metav1.NewTime(time.Date(2026, 7, 18, 21, 0, 0, 0, time.UTC)) }
	mustReconcile(t, h, cr)
	if fh.held["app1"] {
		t.Fatal("hold still established after the window ended")
	}
}

func TestWarmHold_EnsureFailureDegradesNeverFails(t *testing.T) {
	h, fh := harnessWithHolds(time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC))
	fh.failEnsure["app1"] = true
	cr := &AppDatabase{
		Name: "app1", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{
			AppName:      "app1",
			WarmSchedule: []WarmWindow{{Start: "0 8 * * *", End: "0 20 * * *", Timezone: "UTC"}},
		},
	}

	// A failed hold must NOT fail provisioning: warming is best-effort, the cold
	// wake path still works. The failure surfaces as a Warning event + a False
	// condition; the reconcile itself succeeds.
	rq := mustReconcile(t, h, cr)
	_ = rq
	if !hasEvent(h, "WarmHoldFailed") {
		t.Fatalf("events = %v, want a WarmHoldFailed Warning", h.cl.events)
	}
	c := cond(cr, CondWarmHold)
	if c == nil || c.Status != "False" || c.Reason != "HoldFailed" {
		t.Fatalf("WarmHold condition = %+v, want False/HoldFailed", c)
	}
	if cr.Status.Phase != PhaseReady {
		t.Fatalf("phase = %q, want Ready (a hold failure degrades warming, never provisioning)", cr.Status.Phase)
	}
}

func TestWarmHold_InvalidWindowWarnsAndNeverHolds(t *testing.T) {
	h, fh := harnessWithHolds(time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC))
	cr := &AppDatabase{
		Name: "app1", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{
			AppName:      "app1",
			WarmSchedule: []WarmWindow{{Start: "garbage", End: "0 20 * * *", Timezone: "UTC"}},
		},
	}

	mustReconcile(t, h, cr)

	// There is no admission webhook on AppDatabase, so a malformed cron must be
	// LOUD (a Warning event), never a silently skipped window.
	if !hasEvent(h, "InvalidWarmWindow") {
		t.Fatalf("events = %v, want an InvalidWarmWindow Warning", h.cl.events)
	}
	if len(fh.ensured) != 0 {
		t.Fatalf("EnsureHold calls = %v, want none for an invalid window", fh.ensured)
	}
	c := cond(cr, CondWarmHold)
	if c == nil || c.Status != "False" || c.Reason != "InvalidWarmWindow" {
		t.Fatalf("WarmHold condition = %+v, want False/InvalidWarmWindow", c)
	}
}

func TestWarmHold_ReleasedOnDelete(t *testing.T) {
	h, fh := harnessWithHolds(time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC))
	now := metav1.NewTime(time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC))
	cr := &AppDatabase{
		Name: "app1", Namespace: "scale-zero-pg", Generation: 1, UID: "u1",
		Spec: AppDatabaseSpec{
			AppName:      "app1",
			WarmSchedule: []WarmWindow{{Start: "0 8 * * *", End: "0 20 * * *", Timezone: "UTC"}},
		},
	}
	mustReconcile(t, h, cr) // provisions; window active -> held
	if !fh.held["app1"] {
		t.Fatal("hold not established before delete")
	}

	cr.DeletionTimestamp = &now
	mustReconcile(t, h, cr)

	if fh.held["app1"] {
		t.Fatal("hold still established after delete")
	}
	if len(fh.released) == 0 {
		t.Fatal("ReleaseHold was not called on the delete path — a deprovisioned app would keep warming")
	}
}

func TestWarmHold_NoScheduleMeansNoHoldAndNoCondition(t *testing.T) {
	// Back-compat (the ADR-0030 byte-identical promise, mirrored on the DB side):
	// a CR that omits warmSchedule must reconcile exactly as before — no Holds
	// calls, no WarmHold condition in status.
	h, fh := harnessWithHolds(time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC))
	cr := &AppDatabase{Name: "app1", Namespace: "scale-zero-pg", Generation: 1, Spec: AppDatabaseSpec{AppName: "app1"}}

	mustReconcile(t, h, cr)

	if len(fh.ensured) != 0 || len(fh.released) != 0 {
		t.Fatalf("Holds calls = ensured %v released %v, want none for a schedule-less CR", fh.ensured, fh.released)
	}
	if c := cond(cr, CondWarmHold); c != nil {
		t.Fatalf("WarmHold condition = %+v, want absent for a schedule-less CR", c)
	}
}

func TestWarmHold_TierWarmUnchanged(t *testing.T) {
	// A static tier:warm AppDatabase with NO schedule still provisions at 1 replica
	// exactly as before — the schedule machinery must not touch the tier path.
	h, fh := harnessWithHolds(time.Date(2026, 7, 18, 12, 0, 0, 0, time.UTC))
	h.cl.depAvailable = true
	cr := &AppDatabase{
		Name: "app1", Namespace: "scale-zero-pg", Generation: 1,
		Spec: AppDatabaseSpec{AppName: "app1", Tier: "warm"},
	}

	mustReconcile(t, h, cr)

	if got := h.cl.applied[len(h.cl.applied)-1].Replicas; got != 1 {
		t.Fatalf("tier warm applied replicas = %d, want 1 (unchanged)", got)
	}
	if len(fh.ensured) != 0 || len(fh.released) != 0 {
		t.Fatalf("Holds calls = ensured %v released %v, want none for tier warm without a schedule", fh.ensured, fh.released)
	}
}
