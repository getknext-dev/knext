package appdb

import (
	"context"
	"errors"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ---- fakes -----------------------------------------------------------------

type fakePS struct {
	timelines  map[string]bool // tl -> exists
	lsn        string
	branchArgs []string // tl ids branched
	deleted    []string
	failLSN    bool
}

func newFakePS() *fakePS { return &fakePS{timelines: map[string]bool{}, lsn: "0/1500000"} }

func (f *fakePS) TimelineExists(_ context.Context, _, tl string) (bool, error) {
	return f.timelines[tl], nil
}
func (f *fakePS) TemplateLastLSN(_ context.Context, _, _ string) (string, error) {
	if f.failLSN {
		return "", errors.New("boom")
	}
	return f.lsn, nil
}
func (f *fakePS) Branch(_ context.Context, _, tl, _, _ string, _ int) error {
	f.branchArgs = append(f.branchArgs, tl)
	f.timelines[tl] = true
	return nil
}
func (f *fakePS) DeleteTimeline(_ context.Context, _, tl string) error {
	f.deleted = append(f.deleted, tl)
	delete(f.timelines, tl)
	return nil
}

type fakeSK struct {
	replicas int
	failOrd  map[int]bool
	deleted  []string // "ord:tl"
}

func newFakeSK() *fakeSK { return &fakeSK{replicas: 3, failOrd: map[int]bool{}} }

func (f *fakeSK) Replicas() int { return f.replicas }
func (f *fakeSK) DeleteTimeline(_ context.Context, ord int, _, tl string) error {
	if f.failOrd[ord] {
		return errors.New("safekeeper down")
	}
	f.deleted = append(f.deleted, tl)
	return nil
}

type fakeCluster struct {
	secrets       map[string]bool
	createdSecret []string
	applied       []ComputeSpec
	deleted       []string
	depAvailable  bool
	pending       map[string]string
	statusUpdates int
	finalizerAdds int
	finalizerRms  int
	events        []string
}

func newFakeCluster() *fakeCluster {
	return &fakeCluster{secrets: map[string]bool{}, pending: map[string]string{}}
}

func (c *fakeCluster) SecretExists(_ context.Context, app string) (bool, error) {
	return c.secrets[app], nil
}
func (c *fakeCluster) CreateSecret(_ context.Context, app, _, _, _, _ string) error {
	c.secrets[app] = true
	c.createdSecret = append(c.createdSecret, app)
	return nil
}
func (c *fakeCluster) ApplyCompute(_ context.Context, spec ComputeSpec) error {
	c.applied = append(c.applied, spec)
	return nil
}
func (c *fakeCluster) DeleteCompute(_ context.Context, app string) error {
	c.deleted = append(c.deleted, app)
	delete(c.secrets, app)
	return nil
}
func (c *fakeCluster) DeploymentAvailable(_ context.Context, _ string) (bool, error) {
	return c.depAvailable, nil
}
func (c *fakeCluster) RecordReclaimPending(_ context.Context, tl, ords string) error {
	c.pending[tl] = ords
	return nil
}
func (c *fakeCluster) ClearReclaimPending(_ context.Context, tl string) error {
	delete(c.pending, tl)
	return nil
}
func (c *fakeCluster) UpdateStatus(_ context.Context, _ *AppDatabase) error {
	c.statusUpdates++
	return nil
}
func (c *fakeCluster) AddFinalizer(_ context.Context, cr *AppDatabase) error {
	cr.Finalizers = append(cr.Finalizers, Finalizer)
	c.finalizerAdds++
	return nil
}
func (c *fakeCluster) RemoveFinalizer(_ context.Context, cr *AppDatabase) error {
	out := cr.Finalizers[:0]
	for _, f := range cr.Finalizers {
		if f != Finalizer {
			out = append(out, f)
		}
	}
	cr.Finalizers = out
	c.finalizerRms++
	return nil
}
func (c *fakeCluster) Event(_ *AppDatabase, _, reason, _ string) {
	c.events = append(c.events, reason)
}

// ---- harness ---------------------------------------------------------------

type harness struct {
	ps *fakePS
	sk *fakeSK
	cl *fakeCluster
	d  *Deps
}

func newHarness() *harness {
	ps, sk, cl := newFakePS(), newFakeSK(), newFakeCluster()
	tlCalls := 0
	d := &Deps{
		Pageserver: ps, Safekeeper: sk, Cluster: cl,
		Tenant: "a0000000000000000000000000000001", Template: "a0000000000000000000000000000010",
		PGVersion: 17, RolePrefix: "app_", GatewayHost: "pggw-apps.scale-zero-pg.svc", GatewayPort: 55432,
		Namespace: "scale-zero-pg",
		NewTimelineID: func() string {
			tlCalls++
			return "deadbeef000000000000000000000000"[:24] + string(rune('0'+tlCalls)) + "0000000"
		},
		NewPassword: func() string { return "pw-fixed-0123456789" },
		Now:         func() metav1.Time { return metav1.NewTime(time.Unix(1700000000, 0)) },
	}
	return &harness{ps: ps, sk: sk, cl: cl, d: d}
}

func mustReconcile(t *testing.T, h *harness, cr *AppDatabase) bool {
	t.Helper()
	rq, err := h.d.Reconcile(context.Background(), cr)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	return rq
}

func cond(cr *AppDatabase, typ string) *Condition {
	for i := range cr.Status.Conditions {
		if cr.Status.Conditions[i].Type == typ {
			return &cr.Status.Conditions[i]
		}
	}
	return nil
}

// ---- tests -----------------------------------------------------------------

func TestCreateColdPath(t *testing.T) {
	h := newHarness()
	cr := &AppDatabase{Name: "app1", Namespace: "scale-zero-pg", Generation: 1, Spec: AppDatabaseSpec{AppName: "app1"}}

	rq := mustReconcile(t, h, cr)

	if rq {
		t.Errorf("cold tier should not requeue")
	}
	if !cr.hasFinalizer() {
		t.Errorf("finalizer not added")
	}
	if cr.Status.TimelineID == "" {
		t.Errorf("timeline not minted")
	}
	if len(h.cl.createdSecret) != 1 {
		t.Errorf("secret not minted exactly once: %v", h.cl.createdSecret)
	}
	if len(h.cl.applied) == 0 {
		t.Fatalf("compute not applied")
	}
	if h.cl.applied[0].Replicas != 0 {
		t.Errorf("cold tier replicas = %d, want 0", h.cl.applied[0].Replicas)
	}
	if len(h.ps.branchArgs) != 1 || h.ps.branchArgs[0] != cr.Status.TimelineID {
		t.Errorf("branch not called with minted timeline: %v vs %s", h.ps.branchArgs, cr.Status.TimelineID)
	}
	if cr.Status.Phase != PhaseReady {
		t.Errorf("phase = %q, want Ready", cr.Status.Phase)
	}
	if cr.Status.ComputeReady {
		t.Errorf("cold tier computeReady should be false at rest")
	}
	if cr.Status.ObservedGeneration != 1 {
		t.Errorf("observedGeneration = %d", cr.Status.ObservedGeneration)
	}
	if c := cond(cr, CondProvisioned); c == nil || c.Status != "True" {
		t.Errorf("Provisioned condition not True: %+v", c)
	}
	// Intent-first: timeline id persisted (status update) BEFORE the branch call.
	if h.cl.statusUpdates < 2 {
		t.Errorf("expected an intent status update before branch, got %d", h.cl.statusUpdates)
	}
}

func TestQuotaResolution(t *testing.T) {
	h := newHarness()
	cr := &AppDatabase{Name: "app2", Generation: 1, Spec: AppDatabaseSpec{
		AppName: "app2",
		Quotas:  Quotas{CPU: "2000m", MaxConnections: 50}, // partial; rest defaults
	}}
	mustReconcile(t, h, cr)
	got := h.cl.applied[0].Quotas
	if got.CPU != "2000m" || got.MaxConnections != 50 {
		t.Errorf("custom quota lost: %+v", got)
	}
	if got.Mem != DefaultQuotas.Mem || got.CPURequest != DefaultQuotas.CPURequest {
		t.Errorf("defaults not filled: %+v", got)
	}
}

func TestWarmTierRequeuesUntilAvailable(t *testing.T) {
	h := newHarness()
	cr := &AppDatabase{Name: "w", Generation: 1, Spec: AppDatabaseSpec{AppName: "w", Tier: "warm"}}

	h.cl.depAvailable = false
	if rq := mustReconcile(t, h, cr); !rq {
		t.Errorf("warm tier with no available replica should requeue")
	}
	if cr.Status.Phase != PhaseProvisioning {
		t.Errorf("phase = %q, want Provisioning", cr.Status.Phase)
	}
	if h.cl.applied[0].Replicas != 1 {
		t.Errorf("warm tier replicas = %d, want 1", h.cl.applied[0].Replicas)
	}

	// Replica becomes available -> Ready, no requeue.
	h.cl.depAvailable = true
	if rq := mustReconcile(t, h, cr); rq {
		t.Errorf("warm tier available should not requeue")
	}
	if cr.Status.Phase != PhaseReady || !cr.Status.ComputeReady {
		t.Errorf("not Ready after available: phase=%q ready=%v", cr.Status.Phase, cr.Status.ComputeReady)
	}
}

func TestDriftHealReappliesCompute(t *testing.T) {
	h := newHarness()
	// Already provisioned: branch exists, secret exists, timeline recorded.
	cr := &AppDatabase{Name: "d", Generation: 2, Finalizers: []string{Finalizer},
		Spec:   AppDatabaseSpec{AppName: "d"},
		Status: AppDatabaseStatus{TimelineID: "cafe0000000000000000000000000001", Phase: PhaseReady}}
	h.ps.timelines["cafe0000000000000000000000000001"] = true
	h.cl.secrets["d"] = true

	mustReconcile(t, h, cr)

	// Compute re-applied (heals a hand-deleted Deployment) even though the branch exists.
	if len(h.cl.applied) != 1 {
		t.Errorf("compute not re-applied for drift heal: %d", len(h.cl.applied))
	}
	// Secret NOT re-created (idempotent — live app keeps its password).
	if len(h.cl.createdSecret) != 0 {
		t.Errorf("secret should not be re-created: %v", h.cl.createdSecret)
	}
	// Branch NOT re-created.
	if len(h.ps.branchArgs) != 0 {
		t.Errorf("branch should not be re-created: %v", h.ps.branchArgs)
	}
}

func TestCrashResumeReusesTimeline(t *testing.T) {
	h := newHarness()
	// Crash AFTER status.timelineId persisted + secret minted, BEFORE the branch.
	cr := &AppDatabase{Name: "c", Generation: 1, Finalizers: []string{Finalizer},
		Spec:   AppDatabaseSpec{AppName: "c"},
		Status: AppDatabaseStatus{TimelineID: "beef0000000000000000000000000009", Phase: PhaseProvisioning}}
	h.cl.secrets["c"] = true // secret already minted

	mustReconcile(t, h, cr)

	// No fresh timeline minted — the recorded id is reused (dodges tombstone rules).
	if cr.Status.TimelineID != "beef0000000000000000000000000009" {
		t.Errorf("timeline id changed on resume: %s", cr.Status.TimelineID)
	}
	// Branch finishes the interrupted provision with the SAME id.
	if len(h.ps.branchArgs) != 1 || h.ps.branchArgs[0] != "beef0000000000000000000000000009" {
		t.Errorf("resume did not branch recorded id: %v", h.ps.branchArgs)
	}
	// Secret not re-minted.
	if len(h.cl.createdSecret) != 0 {
		t.Errorf("secret re-minted on resume: %v", h.cl.createdSecret)
	}
}

func TestDeleteFinalizerReclaimsTimeline(t *testing.T) {
	h := newHarness()
	now := metav1.NewTime(time.Unix(1700000000, 0))
	cr := &AppDatabase{Name: "gone", Generation: 3, DeletionTimestamp: &now, Finalizers: []string{Finalizer},
		Spec:   AppDatabaseSpec{AppName: "gone"},
		Status: AppDatabaseStatus{TimelineID: "dead0000000000000000000000000003"}}

	rq := mustReconcile(t, h, cr)

	if rq {
		t.Errorf("clean delete should not requeue")
	}
	if len(h.cl.deleted) != 1 || h.cl.deleted[0] != "gone" {
		t.Errorf("compute objects not deleted: %v", h.cl.deleted)
	}
	if len(h.ps.deleted) != 1 {
		t.Errorf("pageserver timeline not deleted: %v", h.ps.deleted)
	}
	if len(h.sk.deleted) != 3 {
		t.Errorf("expected 3 safekeeper deletes, got %d", len(h.sk.deleted))
	}
	if cr.hasFinalizer() {
		t.Errorf("finalizer not removed after clean deprovision")
	}
}

func TestDeleteKeepTimeline(t *testing.T) {
	h := newHarness()
	now := metav1.NewTime(time.Unix(1700000000, 0))
	cr := &AppDatabase{Name: "keep", DeletionTimestamp: &now, Finalizers: []string{Finalizer},
		Spec:   AppDatabaseSpec{AppName: "keep", KeepTimelineOnDelete: true},
		Status: AppDatabaseStatus{TimelineID: "keep0000000000000000000000000004"}}

	mustReconcile(t, h, cr)

	if len(h.ps.deleted) != 0 || len(h.sk.deleted) != 0 {
		t.Errorf("keepTimeline must NOT delete the timeline: ps=%v sk=%v", h.ps.deleted, h.sk.deleted)
	}
	if len(h.cl.deleted) != 1 {
		t.Errorf("k8s objects should still be removed: %v", h.cl.deleted)
	}
	if cr.hasFinalizer() {
		t.Errorf("finalizer not removed")
	}
	found := false
	for _, e := range h.cl.events {
		if e == "TimelineRetained" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected TimelineRetained event, got %v", h.cl.events)
	}
}

func TestDeleteIncompleteReclaimRequeues(t *testing.T) {
	h := newHarness()
	h.sk.failOrd[1] = true // safekeeper-1 is down
	now := metav1.NewTime(time.Unix(1700000000, 0))
	cr := &AppDatabase{Name: "part", DeletionTimestamp: &now, Finalizers: []string{Finalizer},
		Spec:   AppDatabaseSpec{AppName: "part"},
		Status: AppDatabaseStatus{TimelineID: "part0000000000000000000000000005"}}

	rq := mustReconcile(t, h, cr)

	if !rq {
		t.Errorf("incomplete reclaim must requeue")
	}
	if cr.hasFinalizer() == false {
		t.Errorf("finalizer must be RETAINED until reclaim completes")
	}
	if h.cl.pending["part0000000000000000000000000005"] == "" {
		t.Errorf("failed safekeeper delete not recorded to reclaim ledger: %v", h.cl.pending)
	}
}

func TestInvalidAndReservedNamesFailTerminally(t *testing.T) {
	for _, name := range []string{"Bad_Name", "tmpl", "warm", "ro", "-lead", "trail-", ""} {
		h := newHarness()
		cr := &AppDatabase{Name: "x", Generation: 1, Spec: AppDatabaseSpec{AppName: name}}
		rq := mustReconcile(t, h, cr)
		if rq {
			t.Errorf("%q: validation failure should not requeue", name)
		}
		if cr.Status.Phase != PhaseFailed {
			t.Errorf("%q: phase = %q, want Failed", name, cr.Status.Phase)
		}
		if len(h.ps.branchArgs) != 0 || h.cl.finalizerAdds != 0 || len(h.cl.applied) != 0 {
			t.Errorf("%q: invalid name must not touch the cluster/pageserver", name)
		}
	}
}

func TestReclaimClearsLedgerOnSuccess(t *testing.T) {
	h := newHarness()
	now := metav1.NewTime(time.Unix(1700000000, 0))
	cr := &AppDatabase{Name: "clr", DeletionTimestamp: &now, Finalizers: []string{Finalizer},
		Spec:   AppDatabaseSpec{AppName: "clr"},
		Status: AppDatabaseStatus{TimelineID: "c1c1000000000000000000000000000a"}}
	h.cl.pending["c1c1000000000000000000000000000a"] = "0,1"

	mustReconcile(t, h, cr)

	if _, ok := h.cl.pending["c1c1000000000000000000000000000a"]; ok {
		t.Errorf("ledger not cleared after full reclaim: %v", h.cl.pending)
	}
}
