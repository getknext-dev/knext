package zone

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ---- fakes -----------------------------------------------------------------

type fakeAppDB struct {
	ensured map[string]ComposeSpec
	ready   map[string]bool
	deleted map[string]bool
	gone    map[string]bool // name -> DeleteAppDatabase reports gone
}

func newFakeAppDB() *fakeAppDB {
	return &fakeAppDB{ensured: map[string]ComposeSpec{}, ready: map[string]bool{}, deleted: map[string]bool{}, gone: map[string]bool{}}
}
func (f *fakeAppDB) EnsureAppDatabase(_ context.Context, s ComposeSpec) error {
	f.ensured[s.Zone] = s
	return nil
}
func (f *fakeAppDB) AppDatabaseReady(_ context.Context, name string) (bool, error) {
	return f.ready[name], nil
}
func (f *fakeAppDB) DeleteAppDatabase(_ context.Context, name string) (bool, error) {
	f.deleted[name] = true
	g, ok := f.gone[name]
	if !ok {
		g = true
	}
	return g, nil
}

type fakeSQL struct {
	replRoles    map[string]string // zone -> md5
	publications map[string][]string
	subs         map[string]string // "zone/sub" -> conninfo
	droppedSubs  []string
	droppedPubs  []string
	droppedSlots []string // "peer/slot"
	federated    []string // "zone/fromZone"
	droppedFed   []string
	slotInvalid  map[string]bool // "peer/slot" -> wal_status lost (invalidated)
	slotReadErr  map[string]bool // "peer/slot" -> SlotInvalidatedOnPeer returns an error (peer not ready)
	resynced     []string        // "zone/sub"
	resyncErr    bool            // ResyncSubscription fails (auto-resync could not heal)
	reads        []string        // "peer/slot" every SlotInvalidatedOnPeer read (proves no-wake gating)
}

func newFakeSQL() *fakeSQL {
	return &fakeSQL{
		replRoles: map[string]string{}, publications: map[string][]string{}, subs: map[string]string{},
		slotInvalid: map[string]bool{}, slotReadErr: map[string]bool{},
	}
}
func (f *fakeSQL) SlotInvalidatedOnPeer(_ context.Context, peer, slot string) (bool, error) {
	key := peer + "/" + slot
	f.reads = append(f.reads, key)
	if f.slotReadErr[key] {
		return false, context.DeadlineExceeded
	}
	return f.slotInvalid[key], nil
}
func (f *fakeSQL) ResyncSubscription(_ context.Context, zone, sub, _ string, _ []string) error {
	if f.resyncErr {
		return context.DeadlineExceeded
	}
	f.resynced = append(f.resynced, zone+"/"+sub)
	return nil
}
func (f *fakeSQL) EnsureReplRole(_ context.Context, zone, _, password string) error {
	f.replRoles[zone] = password
	return nil
}
func (f *fakeSQL) EnsurePublication(_ context.Context, zone, pub, _ string, tables []string) error {
	f.publications[zone+"/"+pub] = tables
	return nil
}
func (f *fakeSQL) DropPublication(_ context.Context, zone, pub string) error {
	f.droppedPubs = append(f.droppedPubs, zone+"/"+pub)
	return nil
}
func (f *fakeSQL) EnsureSubscription(_ context.Context, zone, sub, conn string, _ []string) error {
	f.subs[zone+"/"+sub] = conn
	return nil
}
func (f *fakeSQL) DropSubscription(_ context.Context, zone, sub string) error {
	f.droppedSubs = append(f.droppedSubs, zone+"/"+sub)
	return nil
}
func (f *fakeSQL) DropReplicationSlot(_ context.Context, peer, slot string) error {
	f.droppedSlots = append(f.droppedSlots, peer+"/"+slot)
	return nil
}
func (f *fakeSQL) EnsureFederation(_ context.Context, zone, fromZone, _, _, _ string, _ []string) error {
	f.federated = append(f.federated, zone+"/"+fromZone)
	return nil
}
func (f *fakeSQL) DropFederation(_ context.Context, zone, fromZone string) error {
	f.droppedFed = append(f.droppedFed, zone+"/"+fromZone)
	return nil
}

type fakeCluster struct {
	replSecrets   map[string]string // zone -> password
	computeGone   map[string]bool   // zone -> compute deployment absent
	asleep        map[string]bool   // zone -> ComputeAwake returns false (default: awake)
	wakeErr       map[string]bool   // zone -> WakeCompute returns an error (live but unwakeable)
	woken         []string
	statusUpdates int
	finalAdd      int
	finalRm       int
	events        []string
}

func newFakeCluster() *fakeCluster {
	return &fakeCluster{
		replSecrets: map[string]string{}, computeGone: map[string]bool{},
		asleep: map[string]bool{}, wakeErr: map[string]bool{},
	}
}

func (c *fakeCluster) EnsureReplSecret(_ context.Context, zone, role string, newPw func() string) (string, string, error) {
	pw, ok := c.replSecrets[zone]
	if !ok {
		pw = newPw()
		c.replSecrets[zone] = pw
	}
	return pw, zoneMD5(pw, role), nil
}
func (c *fakeCluster) ReplSecret(_ context.Context, zone string) (string, string, bool, error) {
	pw, ok := c.replSecrets[zone]
	if !ok {
		return "", "", false, nil
	}
	return pw, zoneMD5(pw, replRoleName("repl_", zone)), true, nil
}
func (c *fakeCluster) DeleteReplSecret(_ context.Context, zone string) error {
	delete(c.replSecrets, zone)
	return nil
}
func (c *fakeCluster) ComputeExists(_ context.Context, zone string) (bool, error) {
	if c.computeGone[zone] {
		return false, nil
	}
	return true, nil
}
func (c *fakeCluster) ComputeAwake(_ context.Context, zone string) (bool, error) {
	return !c.asleep[zone], nil
}
func (c *fakeCluster) WakeCompute(_ context.Context, zone string) error {
	if c.wakeErr[zone] {
		return context.DeadlineExceeded
	}
	c.woken = append(c.woken, zone)
	return nil
}
func (c *fakeCluster) UpdateStatus(_ context.Context, _ *Zone) error { c.statusUpdates++; return nil }
func (c *fakeCluster) AddFinalizer(_ context.Context, cr *Zone) error {
	c.finalAdd++
	cr.Finalizers = append(cr.Finalizers, Finalizer)
	return nil
}
func (c *fakeCluster) RemoveFinalizer(_ context.Context, cr *Zone) error {
	c.finalRm++
	cr.Finalizers = nil
	return nil
}
func (c *fakeCluster) Event(_ *Zone, _, reason, _ string) { c.events = append(c.events, reason) }

type fakeLister struct {
	zones []*Zone
	err   error // when set, ListZones fails (a transient lister outage)
}

func (l *fakeLister) ListZones(_ context.Context) ([]*Zone, error) {
	if l.err != nil {
		return nil, l.err
	}
	return l.zones, nil
}

// ---- harness ---------------------------------------------------------------

func newDeps(lister *fakeLister) (*Deps, *fakeAppDB, *fakeSQL, *fakeCluster) {
	adb, sql, cl := newFakeAppDB(), newFakeSQL(), newFakeCluster()
	seq := 0
	d := &Deps{
		AppDB: adb, SQL: sql, Cluster: cl, Zones: lister,
		Namespace: "scale-zero-pg", GatewayHost: "pggw-apps.scale-zero-pg.svc", GatewayPort: 55432,
		ReplRolePrefix: "repl_",
		AutoResync:     true,
		NewPassword:    func() string { seq++; return "pw" },
		Now:            func() metav1.Time { return metav1.Now() },
	}
	return d, adb, sql, cl
}

// ---- tests -----------------------------------------------------------------

func TestReconcile_ComposeWaitsForDB(t *testing.T) {
	cr := &Zone{Name: "za", Namespace: "scale-zero-pg", Generation: 1}
	lister := &fakeLister{zones: []*Zone{cr}}
	d, adb, _, cl := newDeps(lister)
	// DB not ready yet.
	requeue, err := d.Reconcile(context.Background(), cr)
	if err != nil {
		t.Fatal(err)
	}
	if !requeue {
		t.Error("want requeue while AppDatabase is not Ready")
	}
	if _, ok := adb.ensured["za"]; !ok {
		t.Error("must compose an AppDatabase named after the zone")
	}
	if cr.Status.Phase != PhaseComposing {
		t.Errorf("phase=%q want Composing", cr.Status.Phase)
	}
	if cl.finalAdd != 1 {
		t.Errorf("finalizer must be added first (adds=%d)", cl.finalAdd)
	}
}

func TestReconcile_PublisherReconcilesRoleAndPublication(t *testing.T) {
	cr := &Zone{
		Name: "za", Namespace: "scale-zero-pg", Generation: 1, Finalizers: []string{Finalizer},
		Spec: ZoneSpec{Publishes: []Publication{{Name: "orders_pub", Tables: []string{"orders"}}}},
	}
	lister := &fakeLister{zones: []*Zone{cr}}
	d, adb, sql, _ := newDeps(lister)
	adb.ready["za"] = true

	requeue, err := d.Reconcile(context.Background(), cr)
	if err != nil {
		t.Fatal(err)
	}
	if requeue {
		t.Error("a publisher with no deps should reach Ready (no requeue)")
	}
	if _, ok := sql.replRoles["za"]; !ok {
		t.Error("publisher must get a repl role")
	}
	if _, ok := sql.publications["za/orders_pub"]; !ok {
		t.Error("publication must be created")
	}
	if cr.Status.Phase != PhaseReady {
		t.Errorf("phase=%q want Ready", cr.Status.Phase)
	}
}

func TestReconcile_SubscribeOnlyIfGranted(t *testing.T) {
	// Peer za publishes ONLY orders; zb depends on orders (granted) — should stream.
	za := &Zone{Name: "za", Generation: 1, Finalizers: []string{Finalizer},
		Spec: ZoneSpec{Publishes: []Publication{{Name: "orders_pub", Tables: []string{"orders"}}}}}
	zb := &Zone{Name: "zb", Generation: 1, Finalizers: []string{Finalizer},
		Spec: ZoneSpec{DataDependencies: []DataDependency{{FromZone: "za", Tables: []string{"orders"}, Mode: ModeReplicate}}}}
	lister := &fakeLister{zones: []*Zone{za, zb}}
	d, adb, sql, cl := newDeps(lister)
	adb.ready["za"], adb.ready["zb"] = true, true
	// za must reconcile first so its repl secret exists.
	if _, err := d.Reconcile(context.Background(), za); err != nil {
		t.Fatal(err)
	}
	if _, ok := cl.replSecrets["za"]; !ok {
		t.Fatal("za should have a repl secret after its reconcile")
	}
	requeue, err := d.Reconcile(context.Background(), zb)
	if err != nil {
		t.Fatal(err)
	}
	if requeue {
		t.Errorf("granted dependency should be wired; phase=%q msg=%q", zb.Status.Phase, zb.Status.Message)
	}
	if _, ok := sql.subs["zb/zone_sub_za"]; !ok {
		t.Error("subscription must be created on zb")
	}
	if len(zb.Status.Subscriptions) != 1 || zb.Status.Subscriptions[0].State != SubStreaming {
		t.Errorf("subscription state = %+v want streaming", zb.Status.Subscriptions)
	}
	if len(zb.Status.ReplicationSlots) != 1 || zb.Status.ReplicationSlots[0] != "zone_sub_za" {
		t.Errorf("status must record the peer slot: %v", zb.Status.ReplicationSlots)
	}
}

// MANDATORY negative: a dependency on a table the peer does NOT publish is DENIED,
// never silently wired (governance gate, §3).
func TestReconcile_SubscribeDeniedWhenNotPublished(t *testing.T) {
	za := &Zone{Name: "za", Generation: 1, Finalizers: []string{Finalizer},
		Spec: ZoneSpec{Publishes: []Publication{{Name: "orders_pub", Tables: []string{"orders"}}}}}
	zb := &Zone{Name: "zb", Generation: 1, Finalizers: []string{Finalizer},
		Spec: ZoneSpec{DataDependencies: []DataDependency{{FromZone: "za", Tables: []string{"customers"}, Mode: ModeReplicate}}}}
	lister := &fakeLister{zones: []*Zone{za, zb}}
	d, adb, sql, _ := newDeps(lister)
	adb.ready["za"], adb.ready["zb"] = true, true
	_, _ = d.Reconcile(context.Background(), za)
	_, err := d.Reconcile(context.Background(), zb)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := sql.subs["zb/zone_sub_za"]; ok {
		t.Fatal("must NOT create a subscription for an ungranted table")
	}
	if zb.Status.Phase != PhaseDegraded {
		t.Errorf("phase=%q want Degraded", zb.Status.Phase)
	}
	if len(zb.Status.Subscriptions) != 1 || zb.Status.Subscriptions[0].State != SubDenied {
		t.Errorf("subscription must be denied: %+v", zb.Status.Subscriptions)
	}
}

// Ordering gate: even when the peer's spec grants the tables, the subscription must
// WAIT (pending) until the peer's status reports the publication actually created —
// else the initial COPY snapshots an empty publication and loses pre-existing rows.
func TestReconcile_SubscribePendsUntilPeerStatusPublished(t *testing.T) {
	za := &Zone{Name: "za", Generation: 1, Finalizers: []string{Finalizer},
		Spec: ZoneSpec{Publishes: []Publication{{Name: "orders_pub", Tables: []string{"orders"}}}}}
	// za has NOT reconciled yet: spec grants, but status.Publications is empty.
	zb := &Zone{Name: "zb", Generation: 1, Finalizers: []string{Finalizer},
		Spec: ZoneSpec{DataDependencies: []DataDependency{{FromZone: "za", Tables: []string{"orders"}, Mode: ModeReplicate}}}}
	lister := &fakeLister{zones: []*Zone{za, zb}}
	d, adb, sql, cl := newDeps(lister)
	adb.ready["zb"] = true
	cl.replSecrets["za"] = "pw" // peer repl cred present, but publication not yet reported
	_, err := d.Reconcile(context.Background(), zb)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := sql.subs["zb/zone_sub_za"]; ok {
		t.Fatal("must NOT subscribe before the peer status reports the publication")
	}
	if zb.Status.Subscriptions[0].State != SubPending {
		t.Errorf("want pending until peer publishes, got %+v", zb.Status.Subscriptions)
	}
}

// LOCK THE SCALE-TO-ZERO INVARIANT (ADR-0007 §4c): a Ready zone whose spec is
// unchanged (Generation == ObservedGeneration) must NOT exec any SQL — every SQL exec
// wakes the compute (DynSQL.exec calls wake first), so re-asserting the durable fabric
// every resync would prevent publishers/subscribers from ever resting at zero.
func TestReconcile_SteadyStateReadyDoesNotExecOrWake(t *testing.T) {
	za := &Zone{
		Name: "za", Generation: 3, Finalizers: []string{Finalizer},
		Spec:   ZoneSpec{Publishes: []Publication{{Name: "orders_pub", Tables: []string{"orders"}}}},
		Status: ZoneStatus{Phase: PhaseReady, ObservedGeneration: 3, Publications: []string{"orders_pub"}},
	}
	lister := &fakeLister{zones: []*Zone{za}}
	d, adb, sql, cl := newDeps(lister)
	adb.ready["za"] = true

	requeue, err := d.Reconcile(context.Background(), za)
	if err != nil {
		t.Fatal(err)
	}
	if requeue {
		t.Error("a settled Ready zone should not requeue")
	}
	if len(sql.replRoles) != 0 || len(sql.publications) != 0 || len(sql.subs) != 0 {
		t.Errorf("settled Ready zone MUST NOT exec SQL (=no compute wake): roles=%v pubs=%v subs=%v",
			sql.replRoles, sql.publications, sql.subs)
	}
	if len(cl.woken) != 0 {
		t.Errorf("settled Ready zone must not wake any compute: %v", cl.woken)
	}
	// A spec change (generation bump) must re-open the gate and re-assert.
	za.Generation = 4
	if _, err := d.Reconcile(context.Background(), za); err != nil {
		t.Fatal(err)
	}
	if len(sql.publications) == 0 {
		t.Error("a generation bump must re-assert the publication (drift-heal on spec change)")
	}
}

// #147 — FAIL CLOSED on a transient Zone-lister outage. A publisher whose spec would
// create publications must NOT be admitted while the peer set is unreadable (the
// single-writer guard cannot run) — the operator requeues instead of creating fabric,
// and never marks the zone terminally Failed.
func TestReconcile_ListErrorFailsClosed(t *testing.T) {
	cr := &Zone{
		Name: "za", Namespace: "scale-zero-pg", Generation: 1, Finalizers: []string{Finalizer},
		Spec: ZoneSpec{Publishes: []Publication{{Name: "orders_pub", Tables: []string{"orders"}}}},
	}
	lister := &fakeLister{zones: []*Zone{cr}, err: context.DeadlineExceeded}
	d, adb, sql, cl := newDeps(lister)
	adb.ready["za"] = true

	requeue, err := d.Reconcile(context.Background(), cr)
	if err != nil {
		t.Fatal(err)
	}
	if !requeue {
		t.Error("a transient lister outage must REQUEUE (retry), not proceed")
	}
	if len(sql.publications) != 0 || len(sql.replRoles) != 0 {
		t.Errorf("fail-closed: MUST NOT create fabric while the zone list is unreadable: pubs=%v roles=%v", sql.publications, sql.replRoles)
	}
	if cr.Status.Phase == PhaseFailed {
		t.Error("a transient lister outage must NOT terminally Fail the zone")
	}
	found := false
	for _, e := range cl.events {
		if e == "ZoneListUnavailable" {
			found = true
		}
	}
	if !found {
		t.Errorf("must emit a ZoneListUnavailable event: %v", cl.events)
	}
}

// #147 — a DELETE proceeds even while the lister is momentarily down (teardown needs
// no single-writer guard).
func TestReconcile_ListErrorStillAllowsDelete(t *testing.T) {
	now := metav1.Now()
	zb := &Zone{Name: "zb", Generation: 1, Finalizers: []string{Finalizer}, DeletionTimestamp: &now}
	lister := &fakeLister{zones: []*Zone{zb}, err: context.DeadlineExceeded}
	d, _, _, cl := newDeps(lister)
	if _, err := d.Reconcile(context.Background(), zb); err != nil {
		t.Fatal(err)
	}
	if cl.finalRm != 1 {
		t.Errorf("delete must complete despite the lister outage (finalRm=%d)", cl.finalRm)
	}
}

// #146 — deprovision must RETRY (not strand) a slot on a LIVE but transiently-unwakeable
// peer: the reconcile requeues without removing the finalizer, so the next pass retries.
func TestReconcile_DeprovisionRetriesLivePeerNotStrand(t *testing.T) {
	now := metav1.Now()
	zb := &Zone{
		Name: "zb", Generation: 1, Finalizers: []string{Finalizer}, DeletionTimestamp: &now,
		Spec:   ZoneSpec{DataDependencies: []DataDependency{{FromZone: "za", Tables: []string{"orders"}, Mode: ModeReplicate}}},
		Status: ZoneStatus{Subscriptions: []SubscriptionStatus{{FromZone: "za", State: SubStreaming}}},
	}
	lister := &fakeLister{zones: []*Zone{zb}}
	d, _, sql, cl := newDeps(lister)
	cl.wakeErr["za"] = true // peer EXISTS (computeGone not set) but wake fails transiently

	requeue, err := d.Reconcile(context.Background(), zb)
	if err != nil {
		t.Fatal(err)
	}
	if !requeue {
		t.Error("a live-but-unwakeable peer must REQUEUE (retry), never give up")
	}
	if cl.finalRm != 0 {
		t.Error("finalizer must NOT be removed while a live peer still carries our slot (no strand)")
	}
	if len(sql.droppedSlots) != 0 {
		t.Errorf("slot not droppable this pass; must not claim it was: %v", sql.droppedSlots)
	}
	sawPending := false
	for _, e := range cl.events {
		if e == "PendingSlotReclaim" {
			sawPending = true
		}
	}
	if !sawPending {
		t.Errorf("must record a pending-reclaim event: %v", cl.events)
	}
}

// #146 — a GENUINELY-ABSENT peer (compute Deployment gone) is NOT a strand: its slot went
// with its timeline, so deprovision completes without waking anything.
func TestReconcile_DeprovisionAbsentPeerCompletes(t *testing.T) {
	now := metav1.Now()
	zb := &Zone{
		Name: "zb", Generation: 1, Finalizers: []string{Finalizer}, DeletionTimestamp: &now,
		Spec:   ZoneSpec{DataDependencies: []DataDependency{{FromZone: "za", Tables: []string{"orders"}, Mode: ModeReplicate}}},
		Status: ZoneStatus{Subscriptions: []SubscriptionStatus{{FromZone: "za", State: SubStreaming}}},
	}
	lister := &fakeLister{zones: []*Zone{zb}}
	d, _, sql, cl := newDeps(lister)
	cl.computeGone["za"] = true // peer genuinely deprovisioned

	requeue, err := d.Reconcile(context.Background(), zb)
	if err != nil {
		t.Fatal(err)
	}
	if requeue {
		t.Error("an absent peer has no slot to drop — deprovision should complete")
	}
	if len(cl.woken) != 0 {
		t.Errorf("must not wake an absent peer: %v", cl.woken)
	}
	if len(sql.droppedSlots) != 0 {
		t.Errorf("no slot on an absent peer: %v", sql.droppedSlots)
	}
	if cl.finalRm != 1 {
		t.Errorf("finalizer must be removed (rm=%d)", cl.finalRm)
	}
}

// RE-SYNC ACTUATOR — a settled Ready zone whose peer slot was INVALIDATED (wal_status=lost)
// auto re-syncs: the operator reads the peer slot (peer awake), detects lost, and DROP+
// CREATE SUBSCRIPTIONs with copy_data — flipping the misleading `streaming` truthfully.
func TestReconcile_InvalidatedSlotAutoResyncs(t *testing.T) {
	zb := &Zone{
		Name: "zb", Generation: 2, Finalizers: []string{Finalizer},
		Spec: ZoneSpec{DataDependencies: []DataDependency{{FromZone: "za", Tables: []string{"orders"}, Mode: ModeReplicate}}},
		Status: ZoneStatus{
			Phase: PhaseReady, ObservedGeneration: 2,
			Subscriptions: []SubscriptionStatus{{FromZone: "za", Name: "zone_sub_za", Mode: ModeReplicate, State: SubStreaming}},
		},
	}
	za := &Zone{Name: "za", Generation: 1, Finalizers: []string{Finalizer},
		Spec: ZoneSpec{Publishes: []Publication{{Name: "orders_pub", Tables: []string{"orders"}}}}}
	lister := &fakeLister{zones: []*Zone{za, zb}}
	d, adb, sql, cl := newDeps(lister)
	adb.ready["zb"], adb.ready["za"] = true, true
	cl.replSecrets["za"] = "pw"              // peer cred present (for the re-sync conn)
	sql.slotInvalid["za/zone_sub_za"] = true // the slot went lost

	requeue, err := d.Reconcile(context.Background(), zb)
	if err != nil {
		t.Fatal(err)
	}
	if len(sql.resynced) != 1 || sql.resynced[0] != "zb/zone_sub_za" {
		t.Errorf("must auto re-sync the invalidated subscription: %v", sql.resynced)
	}
	if zb.Status.Subscriptions[0].State != SubStreaming {
		t.Errorf("after a successful re-sync the state returns to streaming: %+v", zb.Status.Subscriptions)
	}
	_ = requeue
}

// RE-SYNC ACTUATOR (truthful status) — when auto-resync CANNOT heal, the status flips to
// NeedsResync (never a misleading `streaming`) and the zone requeues.
func TestReconcile_InvalidatedSlotFlipsToNeedsResyncWhenResyncFails(t *testing.T) {
	zb := &Zone{
		Name: "zb", Generation: 2, Finalizers: []string{Finalizer},
		Spec: ZoneSpec{DataDependencies: []DataDependency{{FromZone: "za", Tables: []string{"orders"}, Mode: ModeReplicate}}},
		Status: ZoneStatus{
			Phase: PhaseReady, ObservedGeneration: 2,
			Subscriptions: []SubscriptionStatus{{FromZone: "za", Name: "zone_sub_za", Mode: ModeReplicate, State: SubStreaming}},
		},
	}
	za := &Zone{Name: "za", Generation: 1, Finalizers: []string{Finalizer},
		Spec: ZoneSpec{Publishes: []Publication{{Name: "orders_pub", Tables: []string{"orders"}}}}}
	lister := &fakeLister{zones: []*Zone{za, zb}}
	d, adb, sql, cl := newDeps(lister)
	adb.ready["zb"], adb.ready["za"] = true, true
	cl.replSecrets["za"] = "pw"
	sql.slotInvalid["za/zone_sub_za"] = true
	sql.resyncErr = true // the re-sync cannot complete this pass

	requeue, err := d.Reconcile(context.Background(), zb)
	if err != nil {
		t.Fatal(err)
	}
	if zb.Status.Subscriptions[0].State != SubNeedsResync {
		t.Errorf("a failed re-sync must leave a TRUTHFUL needs_resync state, never streaming: %+v", zb.Status.Subscriptions)
	}
	if !requeue {
		t.Error("a still-broken subscription must requeue")
	}
}

// RE-SYNC ACTUATOR — the SCALE-TO-ZERO GUARD (#145): a settled Ready zone whose peer is
// ASLEEP must NOT be read at all (no force-wake) and must NOT requeue — it rests at zero.
func TestReconcile_SettledZoneWithSleepingPeerDoesNotWakeOrRead(t *testing.T) {
	zb := &Zone{
		Name: "zb", Generation: 2, Finalizers: []string{Finalizer},
		Spec: ZoneSpec{DataDependencies: []DataDependency{{FromZone: "za", Tables: []string{"orders"}, Mode: ModeReplicate}}},
		Status: ZoneStatus{
			Phase: PhaseReady, ObservedGeneration: 2,
			Subscriptions: []SubscriptionStatus{{FromZone: "za", Name: "zone_sub_za", Mode: ModeReplicate, State: SubStreaming}},
		},
	}
	lister := &fakeLister{zones: []*Zone{zb}}
	d, adb, sql, cl := newDeps(lister)
	adb.ready["zb"] = true
	cl.asleep["za"] = true // the peer publisher is at rest

	requeue, err := d.Reconcile(context.Background(), zb)
	if err != nil {
		t.Fatal(err)
	}
	if requeue {
		t.Error("a settled zone with a sleeping peer must rest (no requeue)")
	}
	if len(sql.reads) != 0 {
		t.Errorf("MUST NOT read a sleeping peer's slot (would force-wake it, #145): %v", sql.reads)
	}
	if len(cl.woken) != 0 {
		t.Errorf("MUST NOT wake a sleeping peer: %v", cl.woken)
	}
	if len(sql.resynced) != 0 {
		t.Errorf("no re-sync when peer asleep: %v", sql.resynced)
	}
}

// RE-SYNC ACTUATOR — a HEALTHY settled zone (peer awake, slot valid) polls once and stays
// asleep-eligible: no re-sync, no requeue, no status churn.
func TestReconcile_SettledHealthyZonePollsCleanNoResync(t *testing.T) {
	zb := &Zone{
		Name: "zb", Generation: 2, Finalizers: []string{Finalizer},
		Spec: ZoneSpec{DataDependencies: []DataDependency{{FromZone: "za", Tables: []string{"orders"}, Mode: ModeReplicate}}},
		Status: ZoneStatus{
			Phase: PhaseReady, ObservedGeneration: 2,
			Subscriptions: []SubscriptionStatus{{FromZone: "za", Name: "zone_sub_za", Mode: ModeReplicate, State: SubStreaming}},
		},
	}
	lister := &fakeLister{zones: []*Zone{zb}}
	d, adb, sql, _ := newDeps(lister)
	adb.ready["zb"] = true // peer awake (default), slot valid (default not invalid)

	requeue, err := d.Reconcile(context.Background(), zb)
	if err != nil {
		t.Fatal(err)
	}
	if requeue {
		t.Error("a healthy settled zone should not requeue")
	}
	if len(sql.reads) != 1 {
		t.Errorf("should read the peer slot exactly once: %v", sql.reads)
	}
	if len(sql.resynced) != 0 {
		t.Errorf("no re-sync for a healthy slot: %v", sql.resynced)
	}
}

func TestReconcile_UnknownPeerDenied(t *testing.T) {
	zb := &Zone{Name: "zb", Generation: 1, Finalizers: []string{Finalizer},
		Spec: ZoneSpec{DataDependencies: []DataDependency{{FromZone: "ghost", Tables: []string{"x"}, Mode: ModeReplicate}}}}
	lister := &fakeLister{zones: []*Zone{zb}}
	d, adb, _, _ := newDeps(lister)
	adb.ready["zb"] = true
	_, _ = d.Reconcile(context.Background(), zb)
	if zb.Status.Subscriptions[0].State != SubDenied {
		t.Errorf("unknown peer must be denied: %+v", zb.Status.Subscriptions)
	}
}

func TestReconcile_FederateProvisionsFDW(t *testing.T) {
	za := &Zone{Name: "za", Generation: 1, Finalizers: []string{Finalizer},
		Spec: ZoneSpec{Publishes: []Publication{{Name: "cust_pub", Tables: []string{"customers"}}}}}
	zb := &Zone{Name: "zb", Generation: 1, Finalizers: []string{Finalizer},
		Spec: ZoneSpec{DataDependencies: []DataDependency{{FromZone: "za", Tables: []string{"customers"}, Mode: ModeFederate}}}}
	lister := &fakeLister{zones: []*Zone{za, zb}}
	d, adb, sql, _ := newDeps(lister)
	adb.ready["za"], adb.ready["zb"] = true, true
	_, _ = d.Reconcile(context.Background(), za)
	_, err := d.Reconcile(context.Background(), zb)
	if err != nil {
		t.Fatal(err)
	}
	if len(sql.federated) != 1 || sql.federated[0] != "zb/za" {
		t.Errorf("federation must be provisioned: %v", sql.federated)
	}
	if zb.Status.Subscriptions[0].State != SubFederated {
		t.Errorf("want federated state: %+v", zb.Status.Subscriptions)
	}
	if zb.Status.Phase != PhaseReady {
		t.Errorf("phase=%q want Ready", zb.Status.Phase)
	}
}

// MANDATORY negative: single-writer violation is a terminal spec failure.
func TestReconcile_SingleWriterFailsFast(t *testing.T) {
	za := &Zone{Name: "za", Generation: 1, Spec: ZoneSpec{Publishes: []Publication{{Name: "p", Tables: []string{"orders"}}}}}
	zb := &Zone{Name: "zb", Generation: 1, Spec: ZoneSpec{Publishes: []Publication{{Name: "q", Tables: []string{"orders"}}}}}
	lister := &fakeLister{zones: []*Zone{za, zb}}
	d, adb, _, _ := newDeps(lister)
	adb.ready["za"], adb.ready["zb"] = true, true
	requeue, err := d.Reconcile(context.Background(), za)
	if err != nil {
		t.Fatal(err)
	}
	if requeue {
		t.Error("a spec violation is terminal (no requeue)")
	}
	if za.Status.Phase != PhaseFailed {
		t.Errorf("phase=%q want Failed", za.Status.Phase)
	}
}

func TestReconcile_InvalidMode(t *testing.T) {
	zb := &Zone{Name: "zb", Generation: 1,
		Spec: ZoneSpec{DataDependencies: []DataDependency{{FromZone: "za", Tables: []string{"x"}, Mode: "mirror"}}}}
	lister := &fakeLister{zones: []*Zone{zb}}
	d, _, _, _ := newDeps(lister)
	_, _ = d.Reconcile(context.Background(), zb)
	if zb.Status.Phase != PhaseFailed {
		t.Errorf("invalid mode must fail the spec: phase=%q", zb.Status.Phase)
	}
}

// Deprovision hygiene (§4d): subscriber side dropped, peer slot dropped (peer woken),
// publications dropped, AppDatabase deleted, finalizer removed — in that order.
func TestReconcile_DeprovisionHygiene(t *testing.T) {
	now := metav1.Now()
	za := &Zone{Name: "za", Generation: 1, Finalizers: []string{Finalizer},
		Spec: ZoneSpec{Publishes: []Publication{{Name: "cust_pub", Tables: []string{"customers"}}}}}
	zb := &Zone{
		Name: "zb", Generation: 1, Finalizers: []string{Finalizer}, DeletionTimestamp: &now,
		Spec: ZoneSpec{
			Publishes:        []Publication{{Name: "orders_pub", Tables: []string{"orders"}}},
			DataDependencies: []DataDependency{{FromZone: "za", Tables: []string{"customers"}, Mode: ModeReplicate}},
		},
		// A live (streaming) subscription to za — so deprovision drops the peer slot.
		Status: ZoneStatus{Subscriptions: []SubscriptionStatus{{FromZone: "za", State: SubStreaming}}},
	}
	lister := &fakeLister{zones: []*Zone{za, zb}}
	d, adb, sql, cl := newDeps(lister)

	requeue, err := d.Reconcile(context.Background(), zb)
	if err != nil {
		t.Fatal(err)
	}
	if requeue {
		t.Error("deprovision with a gone AppDatabase should complete")
	}
	if len(sql.droppedSubs) != 1 || sql.droppedSubs[0] != "zb/zone_sub_za" {
		t.Errorf("subscription must be dropped: %v", sql.droppedSubs)
	}
	if len(cl.woken) != 1 || cl.woken[0] != "za" {
		t.Errorf("peer must be woken to drop its slot: %v", cl.woken)
	}
	if len(sql.droppedSlots) != 1 || sql.droppedSlots[0] != "za/zone_sub_za" {
		t.Errorf("peer slot must be dropped: %v", sql.droppedSlots)
	}
	if len(sql.droppedPubs) != 1 || sql.droppedPubs[0] != "zb/orders_pub" {
		t.Errorf("own publication must be dropped: %v", sql.droppedPubs)
	}
	if !adb.deleted["zb"] {
		t.Error("composed AppDatabase must be deleted")
	}
	if cl.finalRm != 1 {
		t.Errorf("finalizer must be removed (rm=%d)", cl.finalRm)
	}
}

// Deprovision must complete (not wedge) even when the composed AppDatabase — and
// thus the compute + its catalog objects — is already gone (out-of-band delete).
func TestReconcile_DeprovisionToleratesGoneCompute(t *testing.T) {
	now := metav1.Now()
	zb := &Zone{
		Name: "zb", Generation: 1, Finalizers: []string{Finalizer}, DeletionTimestamp: &now,
		Spec: ZoneSpec{
			Publishes:        []Publication{{Name: "orders_pub", Tables: []string{"orders"}}},
			DataDependencies: []DataDependency{{FromZone: "za", Tables: []string{"customers"}, Mode: ModeReplicate}},
		},
	}
	lister := &fakeLister{zones: []*Zone{zb}}
	d, _, sql, cl := newDeps(lister)
	cl.computeGone["zb"] = true // this zone's compute already gone

	requeue, err := d.Reconcile(context.Background(), zb)
	if err != nil {
		t.Fatalf("deprovision must not error when compute is gone: %v", err)
	}
	if requeue {
		t.Error("deprovision should complete, not wedge, when the compute is gone")
	}
	if len(sql.droppedSubs) != 0 || len(sql.droppedPubs) != 0 {
		t.Error("must NOT attempt in-DB drops when the compute is gone")
	}
	if cl.finalRm != 1 {
		t.Errorf("finalizer must still be removed (rm=%d)", cl.finalRm)
	}
}

func TestReconcile_DeprovisionWaitsForTimelineReclaim(t *testing.T) {
	now := metav1.Now()
	zb := &Zone{Name: "zb", Generation: 1, Finalizers: []string{Finalizer}, DeletionTimestamp: &now}
	lister := &fakeLister{zones: []*Zone{zb}}
	d, adb, _, cl := newDeps(lister)
	adb.gone["zb"] = false // AppDatabase still reclaiming

	requeue, err := d.Reconcile(context.Background(), zb)
	if err != nil {
		t.Fatal(err)
	}
	if !requeue {
		t.Error("must requeue until the composed AppDatabase is gone")
	}
	if cl.finalRm != 0 {
		t.Error("finalizer must NOT be removed while the timeline is still reclaiming")
	}
}
