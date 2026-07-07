package zone

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// ReservedNames must never be provisioned as zones — they collide with non-zone
// computes (template / warm / RO lanes) the apps-gateway routes specially. Same set
// the appdb operator and apps-gateway reserve.
var ReservedNames = map[string]bool{"tmpl": true, "warm": true, "ro": true}

// Reconcile makes reality match cr. Single entry point per CR, and the unit under
// test. Returns requeue=true when another pass is needed soon (composed DB not yet
// Ready, a dependency awaiting its peer's publication, or an incomplete deprovision).
// A spec validation failure is terminal (no requeue): the spec must change.
func (d *Deps) Reconcile(ctx context.Context, cr *Zone) (requeue bool, err error) {
	if verr := d.validate(ctx, cr); verr != nil {
		cr.Status.Phase = PhaseFailed
		cr.Status.Message = verr.Error()
		cr.Status.ObservedGeneration = cr.Generation
		d.setCondition(cr, CondComposed, "False", "InvalidSpec", verr.Error())
		d.Cluster.Event(cr, "Warning", "InvalidSpec", verr.Error())
		_ = d.Cluster.UpdateStatus(ctx, cr)
		return false, nil
	}
	if cr.deleting() {
		return d.reconcileDelete(ctx, cr)
	}
	return d.reconcileApply(ctx, cr)
}

// validate enforces the spec-level invariants BEFORE any external effect: a legal
// zone name, well-formed dependencies + tables, and the single-writer-per-replicated-
// table rule (ADR-0007 §5, cross-zone — needs the peer list).
func (d *Deps) validate(ctx context.Context, cr *Zone) error {
	if err := validateZoneName(cr.Name); err != nil {
		return err
	}
	seenPub := map[string]bool{}
	for _, p := range cr.Spec.Publishes {
		if !validSimpleIdent(p.Name) {
			return fmt.Errorf("invalid publication name %q", p.Name)
		}
		if seenPub[p.Name] {
			return fmt.Errorf("duplicate publication name %q", p.Name)
		}
		seenPub[p.Name] = true
		if len(p.Tables) == 0 {
			return fmt.Errorf("publication %q declares no tables", p.Name)
		}
		if err := validateTables(p.Tables); err != nil {
			return err
		}
	}
	seenDep := map[string]bool{}
	for _, dep := range cr.Spec.DataDependencies {
		if err := validateZoneName(dep.FromZone); err != nil {
			return fmt.Errorf("dataDependency fromZone: %w", err)
		}
		if dep.FromZone == cr.Name {
			return fmt.Errorf("dataDependency fromZone %q is this zone — a zone cannot depend on itself", dep.FromZone)
		}
		if dep.Mode != ModeReplicate && dep.Mode != ModeFederate {
			return fmt.Errorf("dataDependency on %q has invalid mode %q (want replicate|federate)", dep.FromZone, dep.Mode)
		}
		if seenDep[dep.FromZone] {
			return fmt.Errorf("duplicate dataDependency on zone %q", dep.FromZone)
		}
		seenDep[dep.FromZone] = true
		if len(dep.Tables) == 0 {
			return fmt.Errorf("dataDependency on %q declares no tables", dep.FromZone)
		}
		if err := validateTables(dep.Tables); err != nil {
			return err
		}
	}

	// Single-writer-per-replicated-table (§5) — cross-zone, so it needs the peer set.
	zones, err := d.Zones.ListZones(ctx)
	if err != nil {
		// Transient list failure: don't fail the spec (fail-open for this pass; the
		// next resync re-checks). This is a small fail-open window tracked in #147 —
		// a persistent lister outage would let a single-writer violation slip until it
		// recovers. Acceptable given the lister is the same in-cluster API the whole
		// operator depends on; #147 tracks hardening it (e.g. cache-backed check).
		return nil
	}
	if v := checkSingleWriter(cr, ensureSelf(zones, cr)); v != "" {
		return fmt.Errorf("%s", v)
	}
	return nil
}

// reconcileApply drives a Zone toward Ready. Every step is idempotent.
func (d *Deps) reconcileApply(ctx context.Context, cr *Zone) (bool, error) {
	// 1. Finalizer FIRST so delete always runs cross-zone hygiene (ADR-0007 §4d).
	if !cr.hasFinalizer() {
		if err := d.Cluster.AddFinalizer(ctx, cr); err != nil {
			return true, fmt.Errorf("add finalizer: %w", err)
		}
	}
	if cr.Status.Phase == "" {
		cr.Status.Phase = PhaseComposing
	}
	cr.Status.ZoneDB = cr.Name
	// NB: ObservedGeneration is set only at the END of a completed apply (below), never
	// here — the steady-state gate + genChanged both key off it, so recording it early
	// would make the operator think it had already reconciled the current spec.

	// 2. COMPOSE the in-zone AppDatabase (delegation, ADR-0006).
	tier := cr.Spec.Database.Tier
	if tier == "" {
		tier = "cold"
	}
	if err := d.AppDB.EnsureAppDatabase(ctx, ComposeSpec{
		Zone:         cr.Name,
		Tier:         tier,
		Quotas:       cr.Spec.Database.Quotas,
		ReadReplicas: cr.Spec.Database.ReadReplicas,
		OwnerUID:     cr.UID,
		OwnerName:    cr.Name,
	}); err != nil {
		return true, fmt.Errorf("compose appdatabase: %w", err)
	}
	ready, err := d.AppDB.AppDatabaseReady(ctx, cr.Name)
	if err != nil {
		return true, fmt.Errorf("check appdatabase ready: %w", err)
	}
	if !ready {
		cr.Status.Phase = PhaseComposing
		cr.Status.Message = "composed AppDatabase " + cr.Name + " provisioning"
		d.setCondition(cr, CondComposed, "False", "Composing", "waiting for the composed AppDatabase to be Ready")
		_ = d.Cluster.UpdateStatus(ctx, cr)
		return true, nil // requeue until the DB is up
	}
	d.setCondition(cr, CondComposed, "True", "Composed", "composed AppDatabase is Ready")

	// STEADY-STATE GATE (ADR-0007 §4c — preserve publisher/subscriber scale-to-zero).
	// A Ready zone whose spec is unchanged needs NO in-DB re-assertion: the repl role,
	// publications, and subscriptions are DURABLE on the timeline (they survive
	// scale-to-zero). Re-applying them every resync would exec into — and therefore
	// WAKE — the compute every tick, so a publishing/subscribing zone could never rest
	// at zero, negating exactly what the gateway-mediated wake (#140) delivers. Skip
	// entirely when settled; drift on a real spec change still heals (generation bumps
	// → this gate opens). NOTE: this trusts durability rather than re-reading the DB
	// each tick — detecting live DB drift would itself require a wake; a spec edit is
	// the re-sync trigger.
	if cr.Status.Phase == PhaseReady && cr.Status.ObservedGeneration == cr.Generation {
		return false, nil
	}

	// genChanged gates the compute-WAKING SQL. The publisher-side fabric (repl role +
	// publications) is applied only on first reconcile / spec change; thereafter it is
	// durable and re-asserting it would needlessly wake the compute. Consumer-side
	// (already-wired) dependencies are likewise skipped below.
	genChanged := cr.Status.ObservedGeneration != cr.Generation
	priorSubs := indexSubs(cr.Status.Subscriptions)
	replRole := replRoleName(d.ReplRolePrefix, cr.Name)

	// 3+4. Publisher-side fabric (repl role + publications) — durable; (re)assert only
	//      when the spec changed (or on first apply). The repl SECRET (a k8s object, no
	//      wake) is ensured here too so peers can always read this zone's credential.
	if genChanged {
		if cr.needsReplication() {
			_, replMD5, serr := d.Cluster.EnsureReplSecret(ctx, cr.Name, replRole, d.NewPassword)
			if serr != nil {
				return true, fmt.Errorf("ensure repl secret: %w", serr)
			}
			if err := d.SQL.EnsureReplRole(ctx, cr.Name, replRole, replMD5); err != nil {
				return true, fmt.Errorf("ensure repl role: %w", err)
			}
		}
		var pubNames []string
		for _, p := range cr.Spec.Publishes {
			if err := d.SQL.EnsurePublication(ctx, cr.Name, p.Name, replRole, p.Tables); err != nil {
				return true, fmt.Errorf("ensure publication %s: %w", p.Name, err)
			}
			pubNames = append(pubNames, p.Name)
		}
		sort.Strings(pubNames)
		cr.Status.Publications = pubNames
	}
	if len(cr.Spec.Publishes) > 0 {
		d.setCondition(cr, CondPublished, "True", "Published", fmt.Sprintf("%d publication(s) reconciled", len(cr.Status.Publications)))
	} else {
		d.setCondition(cr, CondPublished, "True", "NothingToPublish", "zone exports nothing (sovereignty default)")
	}

	// 5. SUBSCRIBE / FEDERATE per declared dependency (the governance-gated fabric).
	zones, err := d.Zones.ListZones(ctx)
	if err != nil {
		return true, fmt.Errorf("list zones: %w", err)
	}
	byName := indexZones(zones)

	var subs []SubscriptionStatus
	var slots []string
	allWired := true
	for _, dep := range cr.Spec.DataDependencies {
		prior := priorSubs[dep.FromZone]
		var st SubscriptionStatus
		// Already wired for this generation → trust the durable subscription/FDW and
		// do NOT re-exec (which would wake this zone's compute every resync).
		if !genChanged && prior != nil && (prior.State == SubStreaming || prior.State == SubFederated) {
			st = *prior
		} else {
			st = d.reconcileDependency(ctx, cr, dep, byName[dep.FromZone])
		}
		subs = append(subs, st)
		switch st.State {
		case SubStreaming:
			slots = append(slots, subName(dep.FromZone)) // a real slot exists on the peer
		case SubFederated:
			// no slot
		default: // pending / denied / error — not yet wired, no peer slot
			allWired = false
		}
	}
	sort.Strings(slots)
	cr.Status.Subscriptions = subs
	cr.Status.ReplicationSlots = slots

	// 6. Settle phase.
	degraded := false
	for _, s := range subs {
		if s.State == SubDenied || s.State == SubError {
			degraded = true
		}
	}
	requeue := false
	switch {
	case degraded:
		cr.Status.Phase = PhaseDegraded
		cr.Status.Message = "one or more dataDependencies could not be wired (see status.subscriptions)"
		d.setCondition(cr, CondFabric, "False", "DependencyDenied", cr.Status.Message)
		requeue = true // a peer may start publishing / appear later
	case !allWired:
		cr.Status.Phase = PhaseComposing
		cr.Status.Message = "dataDependencies pending (peer publication not yet visible)"
		d.setCondition(cr, CondFabric, "False", "Pending", cr.Status.Message)
		requeue = true
	default:
		cr.Status.Phase = PhaseReady
		cr.Status.Message = "zone ready; DB composed, publications + dependencies reconciled"
		d.setCondition(cr, CondFabric, "True", "Wired", "all dataDependencies reconciled")
	}
	// Record that we have reconciled THIS spec generation. Combined with the steady-
	// state gate at the top, a subsequent resync of a Ready+unchanged zone short-
	// circuits with no compute wake. (A Degraded/Composing zone re-enters on the next
	// resync — but the genChanged=false gate + already-wired skip mean it re-evaluates
	// dependencies WITHOUT waking the compute, waking only to wire a newly-grantable one.)
	cr.Status.ObservedGeneration = cr.Generation
	if err := d.Cluster.UpdateStatus(ctx, cr); err != nil {
		return true, fmt.Errorf("update status: %w", err)
	}
	return requeue, nil
}

// reconcileDependency wires ONE dataDependency (subscribe or federate), enforcing the
// both-sides-agree governance gate (§3). It never returns an error — a failure to
// wire is reported as a subscription STATE (denied/error/pending), so one bad
// dependency degrades exactly itself and the reconcile continues (blast-radius bound).
func (d *Deps) reconcileDependency(ctx context.Context, cr *Zone, dep DataDependency, peer *Zone) SubscriptionStatus {
	st := SubscriptionStatus{FromZone: dep.FromZone, Mode: dep.Mode}

	// Peer must exist.
	if peer == nil {
		st.State = SubDenied
		st.Message = fmt.Sprintf("unknown peer zone %q (no Zone CR)", dep.FromZone)
		return st
	}
	// BOTH-SIDES-AGREE (§3): the peer must PUBLISH every requested table.
	if ungranted := checkBothSidesAgree(peer, dep.Tables); len(ungranted) > 0 {
		sort.Strings(ungranted)
		st.State = SubDenied
		st.Message = fmt.Sprintf("peer %q does not publish requested table(s): %s — declare them in %s.spec.publishes to grant",
			dep.FromZone, strings.Join(ungranted, ", "), dep.FromZone)
		return st
	}
	// The peer's repl credential (minted by the peer's own reconcile). If absent, the
	// peer has not reconciled its repl role yet — pending, retry next pass.
	peerPw, _, ok, err := d.Cluster.ReplSecret(ctx, dep.FromZone)
	if err != nil {
		st.State = SubError
		st.Message = fmt.Sprintf("read peer %q repl secret: %v", dep.FromZone, err)
		return st
	}
	if !ok {
		st.State = SubPending
		st.Message = fmt.Sprintf("peer %q replication credential not ready yet", dep.FromZone)
		return st
	}
	peerReplRole := replRoleName(d.ReplRolePrefix, dep.FromZone)
	conn := conninfo(d.GatewayHost, d.GatewayPort, dep.FromZone, peerReplRole, peerPw)

	switch dep.Mode {
	case ModeFederate:
		if err := d.SQL.EnsureFederation(ctx, cr.Name, dep.FromZone, conn, peerReplRole, peerPw, dep.Tables); err != nil {
			st.State = SubError
			st.Message = fmt.Sprintf("ensure federation: %v", err)
			return st
		}
		st.State = SubFederated
		st.Message = fmt.Sprintf("postgres_fdw foreign tables in schema %s", fdwSchema(dep.FromZone))
		return st
	default: // replicate
		pubs := pubsCovering(peer, dep.Tables)
		if len(pubs) == 0 {
			st.State = SubPending
			st.Message = "peer publishes the tables but no publication object covers them yet"
			return st
		}
		// ORDERING GATE: subscribe only once the peer's STATUS reports the covering
		// publications actually created (peer's reconcile persisted them AFTER a
		// successful CREATE PUBLICATION). Creating a subscription before the publication
		// exists makes the initial COPY snapshot an empty/absent publication — the
		// pre-existing rows are then lost (streaming only carries post-slot changes).
		if !subsetOf(pubs, peer.Status.Publications) {
			st.State = SubPending
			st.Message = fmt.Sprintf("waiting for peer %q to finish publishing (status.publications not yet populated)", dep.FromZone)
			return st
		}
		sub := subName(dep.FromZone)
		if err := d.SQL.EnsureSubscription(ctx, cr.Name, sub, conn, pubs); err != nil {
			st.State = SubError
			st.Message = fmt.Sprintf("ensure subscription: %v", err)
			return st
		}
		st.Name = sub
		st.State = SubStreaming
		st.Message = fmt.Sprintf("subscribed to %s via the apps-gateway (slot %s on peer)", strings.Join(pubs, ", "), sub)
		return st
	}
}

// reconcileDelete runs cross-zone deprovision hygiene under the finalizer, in the
// mandated order (ADR-0007 §4d): drop THIS zone's subscriptions (subscriber side
// first, so peer slots stop being re-pinned) → drop the orphaned slots on each peer
// (waking a sleeping peer) → drop this zone's publications + federations → delete the
// composed AppDatabase (its finalizer reclaims the timeline) → remove our finalizer.
func (d *Deps) reconcileDelete(ctx context.Context, cr *Zone) (bool, error) {
	if !cr.hasFinalizer() {
		return false, nil
	}
	cr.Status.Phase = PhaseDeleting
	_ = d.Cluster.UpdateStatus(ctx, cr)

	// If THIS zone's compute is already gone (e.g. the composed AppDatabase was
	// deleted out-of-band), its catalog objects (subscriptions/publications/FDW) went
	// with it — there is nothing to drop in-DB. Skip straight to peer-slot cleanup +
	// object teardown so the finalizer NEVER wedges on "deployment not found".
	selfExists, err := d.Cluster.ComputeExists(ctx, cr.Name)
	if err != nil {
		return true, fmt.Errorf("check compute exists: %w", err)
	}

	// 1. Subscriber side: drop each subscription on THIS zone (safe if peer down).
	if selfExists {
		for _, dep := range cr.Spec.DataDependencies {
			if dep.Mode == ModeFederate {
				if err := d.SQL.DropFederation(ctx, cr.Name, dep.FromZone); err != nil {
					return true, fmt.Errorf("drop federation for %s: %w", dep.FromZone, err)
				}
				continue
			}
			if err := d.SQL.DropSubscription(ctx, cr.Name, subName(dep.FromZone)); err != nil {
				return true, fmt.Errorf("drop subscription for %s: %w", dep.FromZone, err)
			}
		}
	}

	// 2. Peer side: drop the orphaned slot on each replicate peer that we ACTUALLY
	//    wired (status shows a streaming subscription). A slot left on a live peer
	//    re-creates the unbounded-pin risk (§4a) — mandatory. Skip peers we never wired
	//    (pending/denied): there is no slot on them, so waking them would be pointless.
	wired := wiredPeers(cr.Status.Subscriptions)
	for _, dep := range cr.Spec.DataDependencies {
		if dep.Mode == ModeFederate || !wired[dep.FromZone] {
			continue
		}
		if err := d.Cluster.WakeCompute(ctx, dep.FromZone); err != nil {
			// Peer gone/unreachable: nothing to pin a slot on. Log + continue.
			d.Cluster.Event(cr, "Warning", "PeerWakeFailed",
				fmt.Sprintf("could not wake peer %s to drop slot %s: %v (peer may be deprovisioned)", dep.FromZone, subName(dep.FromZone), err))
			continue
		}
		if err := d.SQL.DropReplicationSlot(ctx, dep.FromZone, subName(dep.FromZone)); err != nil {
			return true, fmt.Errorf("drop slot %s on peer %s: %w", subName(dep.FromZone), dep.FromZone, err)
		}
	}

	// 3. Drop this zone's own publications (consumers' subscriptions break by design;
	//    deprovision is authoritative). Skip if the compute is already gone.
	if selfExists {
		for _, p := range cr.Spec.Publishes {
			if err := d.SQL.DropPublication(ctx, cr.Name, p.Name); err != nil {
				return true, fmt.Errorf("drop publication %s: %w", p.Name, err)
			}
		}
	}

	// 4. Delete the per-zone repl Secret.
	if err := d.Cluster.DeleteReplSecret(ctx, cr.Name); err != nil {
		return true, fmt.Errorf("delete repl secret: %w", err)
	}

	// 5. Delete the composed AppDatabase; wait for its own finalizer to reclaim the
	//    timeline before we release the Zone (so the Zone disappears only once clean).
	gone, err := d.AppDB.DeleteAppDatabase(ctx, cr.Name)
	if err != nil {
		return true, fmt.Errorf("delete composed appdatabase: %w", err)
	}
	if !gone {
		cr.Status.Message = "composed AppDatabase reclaiming timeline; retrying"
		_ = d.Cluster.UpdateStatus(ctx, cr)
		return true, nil
	}

	if err := d.Cluster.RemoveFinalizer(ctx, cr); err != nil {
		return true, fmt.Errorf("remove finalizer: %w", err)
	}
	d.Cluster.Event(cr, "Normal", "Deprovisioned", "cross-zone fabric torn down; composed AppDatabase reclaimed")
	return false, nil
}

// setCondition updates-or-appends a status condition, stamping lastTransitionTime
// only when the status value flips (k8s convention).
func (d *Deps) setCondition(cr *Zone, condType, status, reason, message string) {
	now := d.Now()
	for i := range cr.Status.Conditions {
		c := &cr.Status.Conditions[i]
		if c.Type != condType {
			continue
		}
		if c.Status != status {
			c.LastTransitionTime = &now
		}
		c.Status, c.Reason, c.Message = status, reason, message
		return
	}
	cr.Status.Conditions = append(cr.Status.Conditions, Condition{
		Type: condType, Status: status, Reason: reason, Message: message, LastTransitionTime: &now,
	})
}

// validateZoneName enforces an RFC1123 DNS label + rejects reserved system names —
// identical rules to the appdb operator's validateAppName (a zone IS an app).
func validateZoneName(z string) error {
	if z == "" {
		return fmt.Errorf("zone name required")
	}
	if len(z) > 63 {
		return fmt.Errorf("invalid zone name %q: max 63 chars (RFC1123 label)", z)
	}
	if strings.HasPrefix(z, "-") || strings.HasSuffix(z, "-") {
		return fmt.Errorf("invalid zone name %q: must not start or end with '-'", z)
	}
	for _, r := range z {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
			return fmt.Errorf("invalid zone name %q: only lowercase [a-z0-9-] allowed (RFC1123 label)", z)
		}
	}
	if ReservedNames[z] {
		return fmt.Errorf("zone name %q is reserved (routes to a non-zone compute) — pick another", z)
	}
	return nil
}

// indexSubs maps fromZone → its prior SubscriptionStatus (for the already-wired skip).
func indexSubs(subs []SubscriptionStatus) map[string]*SubscriptionStatus {
	m := make(map[string]*SubscriptionStatus, len(subs))
	for i := range subs {
		m[subs[i].FromZone] = &subs[i]
	}
	return m
}

// wiredPeers is the set of peers this zone holds a live (streaming) subscription to —
// i.e. the peers that carry a slot this zone must drop on deprovision.
func wiredPeers(subs []SubscriptionStatus) map[string]bool {
	out := map[string]bool{}
	for _, s := range subs {
		if s.State == SubStreaming {
			out[s.FromZone] = true
		}
	}
	return out
}

// subsetOf reports whether every element of want is present in have.
func subsetOf(want, have []string) bool {
	set := make(map[string]bool, len(have))
	for _, h := range have {
		set[h] = true
	}
	for _, w := range want {
		if !set[w] {
			return false
		}
	}
	return true
}

func indexZones(zones []*Zone) map[string]*Zone {
	m := make(map[string]*Zone, len(zones))
	for _, z := range zones {
		m[z.Name] = z
	}
	return m
}

// ensureSelf returns zones with cr guaranteed present (the live cr may be newer than
// the lister's cache) so the single-writer guard always sees this zone's publishes.
func ensureSelf(zones []*Zone, cr *Zone) []*Zone {
	for _, z := range zones {
		if z.Name == cr.Name {
			out := make([]*Zone, len(zones))
			copy(out, zones)
			for i := range out {
				if out[i].Name == cr.Name {
					out[i] = cr
				}
			}
			return out
		}
	}
	return append(append([]*Zone{}, zones...), cr)
}
