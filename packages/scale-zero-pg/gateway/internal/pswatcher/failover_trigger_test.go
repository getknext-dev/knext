package pswatcher

import (
	"context"
	"errors"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// T5 (#1099) — the failover TRIGGER must discriminate a recoverable dependency
// degradation from a genuine node/process death, and must honor a TTL-bounded
// maintenance freeze. The live incident: a MinIO→GCS cred switch briefly degraded
// the primary (its readiness probe, also /v1/status, failed) and the naive liveness
// trigger failed over needlessly → split-brain.

// (a) DEPENDENCY DEGRADED — the pageserver process is UP (its container is Running)
// but its readiness probe is failing (a dependency degraded, e.g. object-store creds
// mid-rotation). The watcher must NOT fail over: it must HOLD and count the
// degradation, keeping the only standby.
func TestNoFailoverOnDependencyDegradation(t *testing.T) {
	primary := &toggleProber{alive: false} // our HTTP probe fails (status endpoint degraded)
	standby := &toggleProber{alive: true}
	promoter := &fakePromoter{}
	// present + NotReady + container RUNNING ⇒ process alive, dependency degraded.
	k8s := &fakeK8s{
		selectorApp: "pageserver", gen: 1, genSet: true,
		primaryPresent: true, primaryReady: false, primaryRunning: true,
	}
	c := newControllerFull(primary, standby, promoter, k8s, 1)

	for i := 0; i < 8; i++ {
		fo, err := c.Tick(context.Background())
		if err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
		if fo {
			t.Fatal("failed over on a recoverable dependency degradation (process still Running) — this is the live split-brain")
		}
	}
	if len(promoter.calls) != 0 {
		t.Fatalf("promoted despite the pageserver process being alive: %v", promoter.calls)
	}
	if len(k8s.flippedTo) != 0 {
		t.Fatalf("flipped the Service on a dependency degradation: %v", k8s.flippedTo)
	}
	if c.Metrics().DependencyDegradedCount() == 0 {
		t.Fatal("pswatcher_dependency_degraded_total must increment when a promotion is withheld for a live-but-degraded primary")
	}
}

// (a') Once the degradation is severe enough that the pageserver's own livenessProbe
// restarts it into a CrashLoopBackOff, the container is no longer Running — that is a
// genuine death and the watcher DOES promote. Proves the discrimination is on the
// RUNNING bit, not a blanket "never promote a present pod".
func TestFailoverWhenDegradationBecomesCrashLoop(t *testing.T) {
	primary := &toggleProber{alive: false}
	standby := &toggleProber{alive: true}
	promoter := &fakePromoter{}
	// present + NotReady, container NOT running (CrashLoopBackOff / Terminated) ⇒ death.
	k8s := &fakeK8s{
		selectorApp: "pageserver", gen: 1, genSet: true,
		primaryPresent: true, primaryReady: false, primaryRunning: false,
	}
	c := newControllerFull(primary, standby, promoter, k8s, 1)

	fo, err := c.Tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !fo {
		t.Fatal("a present-but-NotReady pod whose container is NOT running is a genuine death — must promote")
	}
}

// (b) NODE/PROCESS DOWN — the pod is absent (or its container is not running) after
// being anchored: a genuine death. The watcher fails over AND classifies the reason
// as node_death (the failover drill asserts pswatcher_failover_reason{reason=...}).
func TestFailoverOnNodeDeathClassifiesReason(t *testing.T) {
	primary := &toggleProber{alive: false}
	standby := &toggleProber{alive: true}
	promoter := &fakePromoter{}
	// present + NotReady + not running ⇒ genuine death (anchors on the present read).
	k8s := &fakeK8s{
		selectorApp: "pageserver", gen: 1, genSet: true,
		primaryPresent: true, primaryReady: false, primaryRunning: false,
	}
	c := newControllerFull(primary, standby, promoter, k8s, 1)

	fo, err := c.Tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !fo {
		t.Fatal("a genuine node death must fail over")
	}
	if c.Metrics().FailoverReason() != "node_death" {
		t.Fatalf("failover reason = %q, want node_death (the discrimination verdict the drill asserts)", c.Metrics().FailoverReason())
	}
	if !containsFT(c.Metrics().PromText(), `pswatcher_failover_reason{reason="node_death"} 1`) {
		t.Fatalf("PromText must carry the labeled classification sample:\n%s", c.Metrics().PromText())
	}
}

// freezeController wires a controller with a fixed clock and a maintenance-freeze
// window on the fake K8s surface.
func freezeControllerAt(now time.Time, k *fakeK8s) (*Controller, *fakePromoter) {
	primary := &toggleProber{alive: false} // genuine death stimulus
	standby := &toggleProber{alive: true}
	promoter := &fakePromoter{}
	c := newControllerFull(primary, standby, promoter, k, 1)
	c.SetClock(func() time.Time { return now })
	return c, promoter
}

// (c) FREEZE SET — a maintenance freeze suppresses failover even on a CONFIRMED
// node death (planned op expects the primary to be unreachable). The active freeze
// is surfaced on the metric, and the suppressed would-be failover is counted.
func TestFreezeSuppressesFailoverOnRealDeath(t *testing.T) {
	now := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)
	until := now.Add(30 * time.Minute)
	k8s := &fakeK8s{
		selectorApp: "pageserver", gen: 1, genSet: true,
		primaryPresent: true, primaryReady: false, primaryRunning: false, // genuine death
		freezePresent: true, freezeUntil: until, freezeCreatedAt: now,
	}
	c, promoter := freezeControllerAt(now, k8s)

	for i := 0; i < 5; i++ {
		fo, err := c.Tick(context.Background())
		if err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
		if fo {
			t.Fatal("failed over during an active maintenance freeze")
		}
	}
	if len(promoter.calls) != 0 {
		t.Fatalf("promoted during a freeze: %v", promoter.calls)
	}
	if len(k8s.flippedTo) != 0 {
		t.Fatalf("flipped the Service during a freeze: %v", k8s.flippedTo)
	}
	if c.Metrics().FreezeSuppressedCount() == 0 {
		t.Fatal("pswatcher_failover_freeze_suppressed_total must count a suppressed would-be failover")
	}
	// (e) the active freeze must be observable for alerting.
	if c.Metrics().FailoverFrozen() != 1 {
		t.Fatal("pswatcher_failover_frozen must be 1 while a freeze is active")
	}
	if c.Metrics().FreezeExpiry() != until.Unix() {
		t.Fatalf("pswatcher_failover_freeze_expiry_seconds = %d, want %d", c.Metrics().FreezeExpiry(), until.Unix())
	}
}

// (d) FREEZE PAST ITS TTL — once the freeze's expiry has passed, failover resumes on
// a real death. Also proves the gauge falls back to 0 (so an "expired" alert can fire).
func TestFailoverResumesAfterFreezeExpires(t *testing.T) {
	now := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)
	until := now.Add(-1 * time.Minute) // already expired
	k8s := &fakeK8s{
		selectorApp: "pageserver", gen: 1, genSet: true,
		primaryPresent: true, primaryReady: false, primaryRunning: false, // genuine death
		freezePresent: true, freezeUntil: until, freezeCreatedAt: now.Add(-31 * time.Minute),
	}
	c, promoter := freezeControllerAt(now, k8s)

	fo, err := c.Tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !fo {
		t.Fatal("a freeze past its TTL must not suppress failover — HA has to resume")
	}
	if len(promoter.calls) != 1 {
		t.Fatalf("expected exactly one promotion after the freeze expired, got %v", promoter.calls)
	}
	if c.Metrics().FailoverFrozen() != 0 {
		t.Fatal("pswatcher_failover_frozen must be 0 once the freeze has expired")
	}
}

// (d') TTL CLAMP — a fat-fingered / forgotten freeze whose `until` is set far in the
// future is clamped to createdAt+MaxFreezeDuration, so a stuck freeze cannot silently
// disable HA indefinitely. With the default 2h bound and a freeze created 3h ago, the
// effective expiry is already in the past → failover resumes despite `until` being
// days ahead.
func TestStuckFreezeIsBoundedByMaxDuration(t *testing.T) {
	now := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)
	until := now.Add(72 * time.Hour)   // admin set (or fat-fingered) days out
	created := now.Add(-3 * time.Hour) // but the freeze was created 3h ago
	k8s := &fakeK8s{
		selectorApp: "pageserver", gen: 1, genSet: true,
		primaryPresent: true, primaryReady: false, primaryRunning: false, // genuine death
		freezePresent: true, freezeUntil: until, freezeCreatedAt: created,
	}
	c, promoter := freezeControllerAt(now, k8s)

	fo, err := c.Tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !fo {
		t.Fatal("a freeze older than MaxFreezeDuration must lapse (clamped) so a stuck freeze cannot disable HA forever")
	}
	if len(promoter.calls) != 1 {
		t.Fatalf("failover must resume once the clamped TTL has passed, got %v", promoter.calls)
	}
	if c.Metrics().FailoverFrozen() != 0 {
		t.Fatal("a clamped-expired freeze must report pswatcher_failover_frozen 0")
	}
}

// (d”) A far-future `until` within the clamp window is HONORED — the clamp bounds a
// stuck freeze, it does not shorten a legitimately recent freeze.
func TestFreshFreezeWithinClampIsActive(t *testing.T) {
	now := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)
	until := now.Add(72 * time.Hour) // far out
	created := now.Add(-5 * time.Minute)
	k8s := &fakeK8s{
		selectorApp: "pageserver", gen: 1, genSet: true,
		primaryPresent: true, primaryReady: false, primaryRunning: false,
		freezePresent: true, freezeUntil: until, freezeCreatedAt: created,
	}
	c, promoter := freezeControllerAt(now, k8s)

	fo, err := c.Tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if fo {
		t.Fatal("a freeze created 5m ago (well within MaxFreezeDuration) must still suppress failover")
	}
	if len(promoter.calls) != 0 {
		t.Fatalf("must not promote while a valid freeze is active: %v", promoter.calls)
	}
	// The published expiry is the CLAMPED value (created+MaxFreeze), not the raw until.
	wantExpiry := created.Add(DefaultMaxFreezeDuration).Unix()
	if c.Metrics().FreezeExpiry() != wantExpiry {
		t.Fatalf("published freeze expiry = %d, want clamped %d", c.Metrics().FreezeExpiry(), wantExpiry)
	}
}

// (f) FIX 1 — a freeze-read error must be FAIL-SAFE, never fail-open-to-outage.
//
// The pre-fix code ABORTED the tick on any freeze-read error, which returned BEFORE
// the prober / PodReady / failover path ran. A PERMANENT error (the classic being a
// malformed `until` — see TestMalformedFreezeUntilDoesNotDisableHA) therefore disabled
// HA forever, froze pswatcher_primary_up at its last value, and fired no alert: the
// exact fat-finger this feature claims to bound, failing OPEN to an outage.
//
// The contract now: an unreadable/invalid freeze is treated as NO freeze — HA stays
// ON, the tick completes, and the error is COUNTED (pswatcher_freeze_read_errors_total)
// so the blind freeze read is alertable. A transient error skipping the freeze for one
// tick is the low-risk direction; a permanent one silently disabling HA is not.
func TestFreezeReadErrorKeepsHAOnAndCounts(t *testing.T) {
	k8s := &fakeK8s{
		selectorApp: "pageserver", gen: 1, genSet: true,
		primaryPresent: true, primaryReady: false, primaryRunning: false, // genuine death
		freezeErr: errors.New("apiserver unreachable"),
	}
	c, promoter := freezeControllerAt(time.Now(), k8s)

	fo, err := c.Tick(context.Background())
	if err != nil {
		t.Fatalf("an unreadable freeze must NOT abort the tick (that disables HA): %v", err)
	}
	if !fo {
		t.Fatal("HA must stay ON when the freeze state cannot be read — a genuine death still fails over")
	}
	if len(promoter.calls) != 1 {
		t.Fatalf("expected exactly one promotion, got %v", promoter.calls)
	}
	if c.Metrics().FreezeReadErrors() == 0 {
		t.Fatal("pswatcher_freeze_read_errors_total must count an unreadable/invalid freeze so a blind freeze read is alertable")
	}
	if c.Metrics().FailoverFrozen() != 0 {
		t.Fatal("an unreadable freeze must publish frozen=0 (treated as no freeze), never a stale 1")
	}
}

// (f') the same fail-safe posture, proven END TO END through the REAL K8sClient: a
// fat-fingered `until` ("2026-09-20 12:00:00" — space, not `T`) in a real ConfigMap
// must not disable HA. This is the precise incident shape FIX 1 exists for.
func TestMalformedFreezeUntilDoesNotDisableHA(t *testing.T) {
	ns := "scale-zero-pg"
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "pageserver-0", Namespace: ns, Labels: map[string]string{"app": "pageserver"}},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
			// container CRASHLOOPING ⇒ a genuine death the watcher must act on.
			ContainerStatuses: []corev1.ContainerStatus{waitingCS("pageserver", "CrashLoopBackOff")},
			Conditions:        []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionFalse}},
		},
	}
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: "pageserver", Namespace: ns},
		Spec:       corev1.ServiceSpec{Selector: map[string]string{"app": "pageserver"}},
	}
	genCM := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "pageserver-generation", Namespace: ns},
		Data:       map[string]string{"generation": "1"},
	}
	freezeCM := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "pageserver-failover-freeze", Namespace: ns},
		Data:       map[string]string{"until": "2026-09-20 12:00:00"}, // the fat-finger
	}
	k := newTestK8sClient(pod, svc, genCM, freezeCM)

	promoter := &fakePromoter{}
	c := NewController(&toggleProber{alive: false}, &toggleProber{alive: true}, promoter, k, Config{
		Tenant:          "f0f0",
		ClientService:   "pageserver",
		StandbyApp:      "pageserver-standby",
		ComputeSelector: "plane=compute",
		PrimarySelector: "app=pageserver",
		FailThreshold:   1,
		BaseGeneration:  1,
	}, NewMetrics())
	// This test is about the freeze window, not tenant coverage: wire the live-accurate
	// standby (holds every routed tenant) so it runs the same pre-flight production does.
	c.SetStandbyMembershipViewer(allHeld{})

	fo, err := c.Tick(context.Background())
	if err != nil {
		t.Fatalf("a malformed freeze `until` must not abort the tick — that is a permanent, silent HA disable: %v", err)
	}
	if !fo {
		t.Fatal("HA must stay ON despite a malformed freeze `until` — the primary is genuinely dead and must fail over")
	}
	if c.Metrics().FreezeReadErrors() == 0 {
		t.Fatal("a malformed `until` must raise pswatcher_freeze_read_errors_total (the operator's freeze is NOT in effect — that has to be loud)")
	}
}

// (g) FIX 5 — a freeze whose createdAt is ZERO cannot be TTL-clamped, so honouring its
// raw `until` would be an unbounded, unclampable HA suppression (fail-open). Refuse it:
// treat it as no freeze, count it as a freeze-read error, and keep HA on.
func TestZeroCreatedAtFreezeIsRefused(t *testing.T) {
	now := time.Date(2026, 9, 20, 12, 0, 0, 0, time.UTC)
	k8s := &fakeK8s{
		selectorApp: "pageserver", gen: 1, genSet: true,
		primaryPresent: true, primaryReady: false, primaryRunning: false, // genuine death
		freezePresent: true, freezeUntil: now.Add(72 * time.Hour), // far future, unclampable
		// freezeCreatedAt deliberately left as the zero time.
	}
	c, promoter := freezeControllerAt(now, k8s)

	fo, err := c.Tick(context.Background())
	if err != nil {
		t.Fatalf("a zero-createdAt freeze must not abort the tick: %v", err)
	}
	if !fo {
		t.Fatal("a freeze with no createdAt anchor cannot be TTL-bounded — it must be REFUSED, not honoured for 72h")
	}
	if len(promoter.calls) != 1 {
		t.Fatalf("expected one promotion after refusing the unclampable freeze, got %v", promoter.calls)
	}
	if c.Metrics().FailoverFrozen() != 0 {
		t.Fatal("a refused freeze must publish pswatcher_failover_frozen 0")
	}
	if c.Metrics().FreezeReadErrors() == 0 {
		t.Fatal("a refused (unclampable) freeze must be counted so the operator learns their freeze is NOT in effect")
	}
}

// No freeze set (the steady state) must not suppress anything: the gauge stays 0 and
// a real death still fails over.
func TestNoFreezeDoesNotSuppress(t *testing.T) {
	k8s := &fakeK8s{
		selectorApp: "pageserver", gen: 1, genSet: true,
		primaryPresent: true, primaryReady: false, primaryRunning: false,
		freezePresent: false, // no freeze CM
	}
	c, promoter := freezeControllerAt(time.Now(), k8s)

	fo, err := c.Tick(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !fo {
		t.Fatal("with no freeze set a genuine death must fail over")
	}
	if len(promoter.calls) != 1 {
		t.Fatalf("expected one promotion with no freeze, got %v", promoter.calls)
	}
	if c.Metrics().FailoverFrozen() != 0 {
		t.Fatal("pswatcher_failover_frozen must be 0 when no freeze is set")
	}
}

func containsFT(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
