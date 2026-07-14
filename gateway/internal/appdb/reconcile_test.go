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
	rcLSN      string   // template remote_consistent_lsn (cold-restorability, §9d-bis)
	branchArgs []string // tl ids branched
	deleted    []string
	failLSN    bool
	failRCLSN  bool
}

// newFakePS defaults rcLSN == lsn so a freshly-branched app is cold-restorable
// immediately (the common case); tests that exercise the un-durable window set rcLSN
// below lsn explicitly.
func newFakePS() *fakePS {
	return &fakePS{timelines: map[string]bool{}, lsn: "0/1500000", rcLSN: "0/1500000"}
}

func (f *fakePS) TimelineExists(_ context.Context, _, tl string) (bool, error) {
	return f.timelines[tl], nil
}
func (f *fakePS) TemplateLastLSN(_ context.Context, _, _ string) (string, error) {
	if f.failLSN {
		return "", errors.New("boom")
	}
	return f.lsn, nil
}
func (f *fakePS) TemplateRemoteConsistentLSN(_ context.Context, _, _ string) (string, error) {
	if f.failRCLSN {
		return "", errors.New("boom")
	}
	return f.rcLSN, nil
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
	writerDSN     map[string]string // app -> DATABASE_URL (recorded by CreateSecret)
	roKeys        map[string]string // app -> DATABASE_URL_RO (set/removed by EnsureSecretROKey)
	createdSecret []string
	applied       []ComputeSpec
	roApplied     map[string]ROComputeSpec          // app -> RO compute spec (ApplyROCompute)
	roDeleted     []string                          // apps whose RO compute was deleted
	secretOwner   map[string]*metav1.OwnerReference // app -> ownerRef back-filled onto the Secret (#122)
	deleted       []string
	depAvailable  bool
	pending       map[string]string
	statusUpdates int
	finalizerAdds int
	finalizerRms  int
	events        []string
}

func newFakeCluster() *fakeCluster {
	return &fakeCluster{
		secrets:   map[string]bool{},
		writerDSN: map[string]string{},
		roKeys:    map[string]string{},
		pending:   map[string]string{},
	}
}

func (c *fakeCluster) SecretExists(_ context.Context, app string) (bool, error) {
	return c.secrets[app], nil
}
func (c *fakeCluster) CreateSecret(_ context.Context, app, _, _, _, dsn string, owner *metav1.OwnerReference) error {
	c.secrets[app] = true
	c.writerDSN[app] = dsn
	c.createdSecret = append(c.createdSecret, app)
	if owner != nil {
		if c.secretOwner == nil {
			c.secretOwner = map[string]*metav1.OwnerReference{}
		}
		c.secretOwner[app] = owner
	}
	return nil
}

// EnsureSecretROKey mirrors K8sCluster: when enabled, derive DATABASE_URL_RO from
// the writer DSN by swapping the gateway port; when disabled, drop the key. No-op
// when the secret does not exist yet (the create path runs first).
func (c *fakeCluster) EnsureSecretROKey(_ context.Context, app string, enabled bool, writerPort, roPort int) error {
	if !c.secrets[app] {
		return nil
	}
	if !enabled {
		delete(c.roKeys, app)
		return nil
	}
	w := c.writerDSN[app]
	if w == "" {
		return errors.New("no writer dsn to derive DATABASE_URL_RO from")
	}
	c.roKeys[app] = roDSN(w, writerPort, roPort)
	return nil
}
func (c *fakeCluster) ApplyCompute(_ context.Context, spec ComputeSpec) error {
	c.applied = append(c.applied, spec)
	return nil
}

// EnsureSecretOwnerRef records the controller ownerRef the reconciler wants
// back-filled onto the per-app Secret (native cascade-GC, #122). A nil owner is a
// no-op (the CR has no UID yet), mirroring K8sCluster.
func (c *fakeCluster) EnsureSecretOwnerRef(_ context.Context, app string, owner *metav1.OwnerReference) error {
	if c.secretOwner == nil {
		c.secretOwner = map[string]*metav1.OwnerReference{}
	}
	if owner == nil {
		return nil
	}
	c.secretOwner[app] = owner
	return nil
}
func (c *fakeCluster) ApplyROCompute(_ context.Context, spec ROComputeSpec) error {
	if c.roApplied == nil {
		c.roApplied = map[string]ROComputeSpec{}
	}
	c.roApplied[spec.App] = spec
	return nil
}
func (c *fakeCluster) DeleteROCompute(_ context.Context, app string) error {
	c.roDeleted = append(c.roDeleted, app)
	if c.roApplied != nil {
		delete(c.roApplied, app)
	}
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
		GatewayROPort: 55434,
		Namespace:     "scale-zero-pg",
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

// The status publishes the output Secret NAME so an external driver reads it from
// status instead of reconstructing "app-db-<app>" (external-driver contract #119).
func TestStatusPublishesSecretName(t *testing.T) {
	h := newHarness()
	cr := &AppDatabase{Name: "shop", Namespace: "scale-zero-pg", Generation: 1, Spec: AppDatabaseSpec{AppName: "shop"}}
	mustReconcile(t, h, cr)
	if cr.Status.SecretName != "app-db-shop" {
		t.Errorf("status.secretName = %q, want app-db-shop", cr.Status.SecretName)
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

// ---- DATABASE_URL_RO emission (ADR-0006 #119, external-driver contract) ------

// roDSN is a pure transform of the writer DSN -> the read-only DSN: same role,
// password, host and database, only the gateway listener port differs.
func TestRODSNSwapsOnlyThePort(t *testing.T) {
	writer := "postgres://app_shop:pw-secret@pggw-apps.scale-zero-pg.svc:55432/shop?sslmode=disable"
	got := roDSN(writer, 55432, 55434)
	want := "postgres://app_shop:pw-secret@pggw-apps.scale-zero-pg.svc:55434/shop?sslmode=disable"
	if got != want {
		t.Errorf("roDSN\n got=%q\nwant=%q", got, want)
	}
	// A writer DSN that does not contain the writer port is returned unchanged
	// (defensive; never fabricate a bogus RO endpoint).
	if roDSN("postgres://x", 55432, 55434) != "postgres://x" {
		t.Errorf("roDSN must leave a non-matching DSN unchanged")
	}
}

// When roPool.enabled, the per-app Secret gains DATABASE_URL_RO derived from the
// writer DSN (app_<app> creds, RO port). This is the key knext injects for reads.
func TestROKeyEmittedWhenROPoolEnabled(t *testing.T) {
	h := newHarness()
	cr := &AppDatabase{Name: "shop", Generation: 1, Spec: AppDatabaseSpec{
		AppName: "shop",
		ROPool:  ROPool{Enabled: true},
	}}
	mustReconcile(t, h, cr)

	ro, ok := h.cl.roKeys["shop"]
	if !ok || ro == "" {
		t.Fatalf("DATABASE_URL_RO not emitted when roPool.enabled: %v", h.cl.roKeys)
	}
	want := "postgres://app_shop:pw-fixed-0123456789@pggw-apps.scale-zero-pg.svc:55434/shop?sslmode=disable"
	if ro != want {
		t.Errorf("RO DSN\n got=%q\nwant=%q", ro, want)
	}
}

// When roPool is off (default), NO DATABASE_URL_RO is emitted — the writer-only
// contract is unchanged and knext injects only DATABASE_URL.
func TestNoROKeyWhenROPoolDisabled(t *testing.T) {
	h := newHarness()
	cr := &AppDatabase{Name: "plain", Generation: 1, Spec: AppDatabaseSpec{AppName: "plain"}}
	mustReconcile(t, h, cr)

	if _, ok := h.cl.roKeys["plain"]; ok {
		t.Errorf("DATABASE_URL_RO must NOT be emitted when roPool is off: %v", h.cl.roKeys)
	}
}

// Toggling roPool.enabled false on an already-provisioned app REMOVES the RO key
// (idempotent reconcile of the Secret), without re-minting the password.
func TestROKeyRemovedWhenROPoolTurnedOff(t *testing.T) {
	h := newHarness()
	// Already provisioned WITH an RO key.
	h.cl.secrets["shop"] = true
	h.cl.writerDSN["shop"] = "postgres://app_shop:pw@pggw-apps.scale-zero-pg.svc:55432/shop?sslmode=disable"
	h.cl.roKeys["shop"] = "postgres://app_shop:pw@pggw-apps.scale-zero-pg.svc:55434/shop?sslmode=disable"
	h.ps.timelines["cafe0000000000000000000000000009"] = true
	cr := &AppDatabase{Name: "shop", Generation: 2, Finalizers: []string{Finalizer},
		Spec:   AppDatabaseSpec{AppName: "shop", ROPool: ROPool{Enabled: false}},
		Status: AppDatabaseStatus{TimelineID: "cafe0000000000000000000000000009", Phase: PhaseReady}}

	mustReconcile(t, h, cr)

	if _, ok := h.cl.roKeys["shop"]; ok {
		t.Errorf("DATABASE_URL_RO must be removed when roPool toggled off: %v", h.cl.roKeys)
	}
	// Password/secret NOT re-minted (live app never locked out).
	if len(h.cl.createdSecret) != 0 {
		t.Errorf("secret must not be re-created on RO toggle: %v", h.cl.createdSecret)
	}
}

// ---- per-app RO compute provisioning (#127) --------------------------------

// When roPool.enabled, the operator provisions THIS app's own RO compute
// (compute-ro-<app>, attached to the app's OWN timeline) so DATABASE_URL_RO has a
// real, tenant-isolated serving endpoint — not a stub, not a shared pool.
func TestROComputeProvisionedWhenEnabled(t *testing.T) {
	h := newHarness()
	cr := &AppDatabase{Name: "shop", Generation: 1, Spec: AppDatabaseSpec{
		AppName: "shop",
		ROPool:  ROPool{Enabled: true, MinReplicas: 0, MaxReplicas: 4},
	}}
	mustReconcile(t, h, cr)

	spec, ok := h.cl.roApplied["shop"]
	if !ok {
		t.Fatalf("RO compute not provisioned when roPool.enabled: %v", h.cl.roApplied)
	}
	// Attached to the app's OWN timeline (isolation) — the same timeline as the writer.
	if spec.TimelineID != cr.Status.TimelineID {
		t.Errorf("RO compute timeline = %q, want the app's own %q", spec.TimelineID, cr.Status.TimelineID)
	}
	if spec.TenantID != h.d.Tenant {
		t.Errorf("RO compute tenant = %q, want apps tenant %q", spec.TenantID, h.d.Tenant)
	}
	if spec.MaxReplicas != 4 {
		t.Errorf("RO maxReplicas = %d, want 4", spec.MaxReplicas)
	}
	// The RO DSN contract key is emitted too (already tested), and it is now LIVE.
	if _, ok := h.cl.roKeys["shop"]; !ok {
		t.Errorf("DATABASE_URL_RO must still be emitted alongside the RO compute")
	}
}

// When roPool is off (default), NO RO compute is provisioned — the writer-only
// app costs nothing extra.
func TestNoROComputeWhenDisabled(t *testing.T) {
	h := newHarness()
	cr := &AppDatabase{Name: "plain", Generation: 1, Spec: AppDatabaseSpec{AppName: "plain"}}
	mustReconcile(t, h, cr)
	if len(h.cl.roApplied) != 0 {
		t.Errorf("RO compute must not be provisioned when roPool is off: %v", h.cl.roApplied)
	}
}

// Toggling roPool off on a provisioned app tears down the RO compute (reclaims the
// read replicas) without touching the writer.
func TestROComputeTornDownWhenDisabled(t *testing.T) {
	h := newHarness()
	h.cl.secrets["shop"] = true
	h.cl.writerDSN["shop"] = "postgres://app_shop:pw@pggw-apps.scale-zero-pg.svc:55432/shop?sslmode=disable"
	h.ps.timelines["cafe0000000000000000000000000009"] = true
	cr := &AppDatabase{Name: "shop", Generation: 2, Finalizers: []string{Finalizer},
		Spec:   AppDatabaseSpec{AppName: "shop", ROPool: ROPool{Enabled: false}},
		Status: AppDatabaseStatus{TimelineID: "cafe0000000000000000000000000009", Phase: PhaseReady}}

	mustReconcile(t, h, cr)

	if len(h.cl.roDeleted) == 0 || h.cl.roDeleted[0] != "shop" {
		t.Errorf("RO compute must be torn down when roPool toggled off: %v", h.cl.roDeleted)
	}
}

// Delete of the app also removes the RO compute (no orphaned read replicas).
func TestDeleteAlsoRemovesROCompute(t *testing.T) {
	h := newHarness()
	now := metav1.NewTime(time.Unix(1700000000, 0))
	cr := &AppDatabase{Name: "gone", DeletionTimestamp: &now, Finalizers: []string{Finalizer},
		Spec:   AppDatabaseSpec{AppName: "gone", ROPool: ROPool{Enabled: true}},
		Status: AppDatabaseStatus{TimelineID: "dead0000000000000000000000000003"}}

	mustReconcile(t, h, cr)

	if len(h.cl.roDeleted) == 0 || h.cl.roDeleted[0] != "gone" {
		t.Errorf("delete must remove the RO compute too: %v", h.cl.roDeleted)
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

// ---- cold-restorability (ancestor-durability, docs/runbook-dr.md §9d-bis) --------

// A fresh branch whose template remote_consistent_lsn already covers the branch point
// is cold-restorable immediately: ColdRestorable=True, ancestor LSN persisted, and it
// does NOT add a requeue (a cold-tier app still settles to Ready with no requeue).
func TestColdRestorable_TrueWhenAncestorDurable(t *testing.T) {
	h := newHarness()
	h.ps.lsn = "0/1500000"
	h.ps.rcLSN = "0/1500000" // template layers up to the branch point are uploaded
	cr := &AppDatabase{Name: "app1", Namespace: "scale-zero-pg", Generation: 1, Spec: AppDatabaseSpec{AppName: "app1"}}

	rq := mustReconcile(t, h, cr)

	if rq {
		t.Errorf("cold, cold-restorable app should not requeue")
	}
	if cr.Status.AncestorLSN != "0/1500000" {
		t.Errorf("ancestor LSN not persisted: %q", cr.Status.AncestorLSN)
	}
	c := cond(cr, CondColdRestorable)
	if c == nil || c.Status != "True" || c.Reason != "AncestorDurable" {
		t.Fatalf("ColdRestorable not True/AncestorDurable: %+v", c)
	}
}

// In the risk window right after provisioning, the template's un-flushed WAL tail means
// remote_consistent_lsn has NOT reached the branch point: ColdRestorable=False and the
// reconciler REQUEUES so it flips to True once the tail uploads (self-heal). The app is
// still provisioned + Ready (usable) — the window is a restore-coverage gap, not an outage.
func TestColdRestorable_FalseWhenAncestorNotYetDurable(t *testing.T) {
	h := newHarness()
	h.ps.lsn = "0/1500000"
	h.ps.rcLSN = "0/1400000" // template upload lags the branch point
	cr := &AppDatabase{Name: "app1", Namespace: "scale-zero-pg", Generation: 1, Spec: AppDatabaseSpec{AppName: "app1"}}

	rq := mustReconcile(t, h, cr)

	if !rq {
		t.Errorf("not-yet-cold-restorable app must requeue to re-check")
	}
	if cr.Status.Phase != PhaseReady {
		t.Errorf("phase = %q, want Ready (the window does not block serving)", cr.Status.Phase)
	}
	c := cond(cr, CondColdRestorable)
	if c == nil || c.Status != "False" || c.Reason != "AncestorWALNotYetDurable" {
		t.Fatalf("ColdRestorable not False/AncestorWALNotYetDurable: %+v", c)
	}
}

// A pageserver blip while reading remote_consistent_lsn must NOT fail provisioning:
// the condition goes Unknown and the reconciler requeues to re-check.
func TestColdRestorable_UnknownOnPageserverError(t *testing.T) {
	h := newHarness()
	h.ps.failRCLSN = true
	cr := &AppDatabase{Name: "app1", Namespace: "scale-zero-pg", Generation: 1, Spec: AppDatabaseSpec{AppName: "app1"}}

	rq := mustReconcile(t, h, cr)

	if !rq {
		t.Errorf("pageserver error should requeue to re-check")
	}
	if cr.Status.Phase != PhaseReady {
		t.Errorf("phase = %q, want Ready — a pageserver blip must not fail provisioning", cr.Status.Phase)
	}
	c := cond(cr, CondColdRestorable)
	if c == nil || c.Status != "Unknown" {
		t.Fatalf("ColdRestorable not Unknown on pageserver error: %+v", c)
	}
}

// Once ColdRestorable is True the property is MONOTONIC (remote_consistent_lsn only
// advances), so the reconciler stops polling: a later pageserver error does NOT flip
// the condition back to Unknown, and it does not requeue on account of the check.
func TestColdRestorable_MonotonicStopsPolling(t *testing.T) {
	h := newHarness()
	h.ps.lsn = "0/1500000"
	h.ps.rcLSN = "0/1500000"
	cr := &AppDatabase{Name: "app1", Namespace: "scale-zero-pg", Generation: 1, Spec: AppDatabaseSpec{AppName: "app1"}}
	if rq := mustReconcile(t, h, cr); rq {
		t.Fatalf("first pass should settle without requeue")
	}
	if c := cond(cr, CondColdRestorable); c == nil || c.Status != "True" {
		t.Fatalf("precondition: ColdRestorable should be True after first pass: %+v", c)
	}

	// Pageserver now errors; a monotonic-True condition must be left untouched.
	h.ps.failRCLSN = true
	rq := mustReconcile(t, h, cr)

	if rq {
		t.Errorf("already-cold-restorable app should not re-poll or requeue")
	}
	if c := cond(cr, CondColdRestorable); c == nil || c.Status != "True" {
		t.Errorf("monotonic condition flipped away from True: %+v", c)
	}
}

func TestLsnGTE(t *testing.T) {
	cases := []struct {
		a, b    string
		gte, ok bool
	}{
		{"0/1500000", "0/1500000", true, true},  // equal
		{"0/1500001", "0/1500000", true, true},  // greater (low word)
		{"0/1400000", "0/1500000", false, true}, // less
		{"1/0", "0/FFFFFFFF", true, true},       // high-word rollover dominates
		{"0/FFFFFFFF", "1/0", false, true},      // and the reverse
		{"garbage", "0/1", false, false},        // unparseable a
		{"0/1", "nope", false, false},           // unparseable b
		{"0/1", "0/1/2", false, false},          // malformed
	}
	for _, tc := range cases {
		gte, ok := lsnGTE(tc.a, tc.b)
		if gte != tc.gte || ok != tc.ok {
			t.Errorf("lsnGTE(%q,%q) = (%v,%v), want (%v,%v)", tc.a, tc.b, gte, ok, tc.gte, tc.ok)
		}
	}
}
