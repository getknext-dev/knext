package appdb

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// ReservedNames must never be provisioned as apps — they route to non-app computes
// (template / warm / RO lanes). Kept in lock-step with provision-app.sh RESERVED_NAMES
// and the apps-gateway GW_RESERVED_SYSTEMS.
var ReservedNames = map[string]bool{"tmpl": true, "warm": true, "ro": true}

// Reconcile makes reality match cr. It is the single entry point the controller
// calls per CR, and the unit under test. It mutates cr.Status and drives the ports.
// Returns requeue=true when another pass is needed soon (compute not yet available,
// or an incomplete safekeeper reclaim awaiting recovery). A validation failure is
// terminal (no requeue): the spec must change.
func (d *Deps) Reconcile(ctx context.Context, cr *AppDatabase) (requeue bool, err error) {
	app := cr.Spec.AppName
	if verr := validateAppName(app); verr != nil {
		cr.Status.Phase = PhaseFailed
		cr.Status.Message = verr.Error()
		cr.Status.ObservedGeneration = cr.Generation
		d.setCondition(cr, CondProvisioned, "False", "InvalidAppName", verr.Error())
		d.Cluster.Event(cr, "Warning", "InvalidAppName", verr.Error())
		_ = d.Cluster.UpdateStatus(ctx, cr)
		return false, nil
	}
	if cr.deleting() {
		return d.reconcileDelete(ctx, cr)
	}
	return d.reconcileApply(ctx, cr)
}

// reconcileApply provisions/heals an AppDatabase toward Ready. Every step is
// idempotent and intent-first (the durable owner of record — status.timelineId and
// the compute ConfigMap — is persisted BEFORE the pageserver branch), so a crash at
// any point converges on re-run with no orphan branch (issue #76).
func (d *Deps) reconcileApply(ctx context.Context, cr *AppDatabase) (bool, error) {
	app := cr.Spec.AppName
	role := d.RolePrefix + app

	// Controller ownerReference stamped on every child so k8s cascade-GC reaps them on
	// CR delete (defense-in-depth over the finalizer, #122). Nil when the CR has no UID
	// (dangling-owner guard); each apply then leaves ownerReferences untouched.
	owner := cr.ownerRef()

	// 1. Finalizer FIRST — before any external resource exists, so delete always
	//    runs safe deprovision (issue #91). Persisted on the object, not status.
	if !cr.hasFinalizer() {
		if err := d.Cluster.AddFinalizer(ctx, cr); err != nil {
			return true, fmt.Errorf("add finalizer: %w", err)
		}
	}

	if cr.Status.Phase == "" {
		cr.Status.Phase = PhaseProvisioning
	}

	// 2. Resolve the timeline id. Mint a FRESH random id on first create and persist
	//    it to status BEFORE the branch (crash-safe owner of record). A re-created CR
	//    (same appName, new object) starts with empty status -> fresh id, dodging the
	//    safekeeper tombstone of the prior lifecycle's timeline (provision-app.sh rule).
	tl := cr.Status.TimelineID
	if tl == "" {
		tl = d.NewTimelineID()
		cr.Status.TimelineID = tl
		cr.Status.Phase = PhaseProvisioning
		if err := d.Cluster.UpdateStatus(ctx, cr); err != nil {
			return true, fmt.Errorf("persist timeline intent: %w", err)
		}
	}

	// 3. Per-app credential Secret — idempotent. Minted BEFORE the branch so a crash
	//    never leaves a branch without a recoverable owner (issue #76). Re-provision
	//    keeps the SAME password so a live app is never locked out (issue #74).
	secExists, err := d.Cluster.SecretExists(ctx, app)
	if err != nil {
		return true, fmt.Errorf("check secret: %w", err)
	}
	if !secExists {
		pw := d.NewPassword()
		// issue #117: precompute a SCRAM-SHA-256 verifier (non-reversible) for the spec's
		// encrypted_password — the app role is SCRAM from boot, no plaintext on the compute.
		verifier, verr := scramSHA256Verifier(pw)
		if verr != nil {
			return true, fmt.Errorf("scram verifier: %w", verr)
		}
		dsn := fmt.Sprintf("postgres://%s:%s@%s:%d/%s?sslmode=disable", role, pw, d.GatewayHost, d.GatewayPort, app)
		if err := d.Cluster.CreateSecret(ctx, app, role, pw, verifier, dsn, owner); err != nil {
			return true, fmt.Errorf("mint credential: %w", err)
		}
	}

	// 3a. Back-fill the ownerReference on an already-existing Secret (live apps minted
	//     before ownerRefs, or by provision-app.sh) so k8s cascade-GC covers them too
	//     (#122). Idempotent; never touches PGPASSWORD/DATABASE_URL.
	if err := d.Cluster.EnsureSecretOwnerRef(ctx, app, owner); err != nil {
		return true, fmt.Errorf("ensure secret ownerRef: %w", err)
	}

	// 3b. Reconcile the read-only DSN key (DATABASE_URL_RO) on the per-app Secret to
	//     match the read-replica-pool request (ADR-0006 #119). Emitted only when
	//     roPool.enabled — which knext maps from NextApp.spec.database.readReplicas.
	//     Idempotent and password-preserving. This gives an external driver (the
	//     knext operator) a first-class RO DSN key to inject rather than hand-deriving
	//     the two-DSN pattern (docs/connecting.md), keeping the contract in one place.
	//     The RO DSN targets the apps-gateway RO port; standing up the per-app RO
	//     SERVING endpoint is a tracked read-scaling/gateway follow-up (see the
	//     AppDatabase API reference) — the key is the stable contract, emitted here.
	if err := d.Cluster.EnsureSecretROKey(ctx, app, cr.Spec.ROPool.Enabled, d.GatewayPort, d.GatewayROPort); err != nil {
		return true, fmt.Errorf("reconcile RO secret key: %w", err)
	}

	// 4. INTENT-FIRST compute apply: ConfigMap (carries TIMELINE_ID) + Deployment +
	//    Service, at the tier's replica count. Applied BEFORE the branch; a Deployment
	//    at 0 starts nothing. This also HEALS drift — a hand-deleted Deployment is
	//    re-applied here on the next pass.
	quotas := cr.Spec.Quotas.resolved()
	if err := d.Cluster.ApplyCompute(ctx, ComputeSpec{
		App:        app,
		TenantID:   d.Tenant,
		TimelineID: tl,
		Replicas:   cr.desiredReplicas(),
		Quotas:     quotas,
		OwnerRef:   owner,
	}); err != nil {
		return true, fmt.Errorf("apply compute: %w", err)
	}

	// 4b. Per-app READ-ONLY compute (issue #127). When roPool.enabled, provision this
	//     app's OWN read-only compute (compute-ro-<app>) attached to the app's OWN
	//     timeline — the real, tenant-isolated serving endpoint DATABASE_URL_RO (step
	//     3b) points at via the apps-gateway RO listener. When disabled, tear any prior
	//     RO compute down (idempotent). This makes the forward-declared RO contract key
	//     LIVE without ever collapsing reads onto a shared pool: app A's reads route to
	//     compute-ro-A, never compute-ro-B or the primary compute-ro.
	if cr.Spec.ROPool.Enabled {
		if err := d.Cluster.ApplyROCompute(ctx, ROComputeSpec{
			App:         app,
			TenantID:    d.Tenant,
			TimelineID:  tl,
			MinReplicas: cr.Spec.ROPool.MinReplicas,
			MaxReplicas: cr.Spec.ROPool.MaxReplicas,
			OwnerRef:    owner,
		}); err != nil {
			return true, fmt.Errorf("apply ro compute: %w", err)
		}
	} else if err := d.Cluster.DeleteROCompute(ctx, app); err != nil {
		return true, fmt.Errorf("teardown ro compute: %w", err)
	}

	// 4c. Scheduled DB warm lockstep (knext #388, ADR-0030 addendum). While any
	//    spec.warmSchedule window is active, hold ONE authenticated connection
	//    through the apps-gateway so this app's compute stays at 1 for the whole
	//    window — the gateway's idle scale-to-zero only arms with ZERO connections,
	//    so the hold is the warm tier (a replica-pinning CronJob would still be
	//    parked by the gateway 60s after the last query: two writers, the defect
	//    ADR-0030 §Context records). The owner declares the SAME windows on the
	//    knext NextApp (pod floor) — both sides evaluate identical cron semantics
	//    against cluster clocks, so pod floor and DB hold flip together. This side
	//    flips within one resync tick of a boundary (APPDB_RESYNC_MS, default 15s)
	//    — no per-CR RequeueAfter machinery exists in this lean loop, and the tick
	//    IS the boundary requeue. Outside every window the hold is released and
	//    the gateway parks the compute on its ordinary idle window. Warming is
	//    BEST-EFFORT: a hold failure degrades to the normal cold-wake path and
	//    surfaces loudly (Warning event + WarmHold condition), it NEVER fails
	//    provisioning. Schedule-less CRs skip this entirely (byte-identical
	//    back-compat); Holds==nil (a schedule-less install) likewise.
	if len(cr.Spec.WarmSchedule) > 0 && d.Holds != nil {
		d.reconcileWarmHold(ctx, cr, app)
	}

	// 5. Ensure the branch exists on the pageserver (durable). Idempotent on tl.
	exists, err := d.Pageserver.TimelineExists(ctx, d.Tenant, tl)
	if err != nil {
		return true, fmt.Errorf("check timeline: %w", err)
	}
	if !exists {
		lsn, err := d.Pageserver.TemplateLastLSN(ctx, d.Tenant, d.Template)
		if err != nil {
			return true, fmt.Errorf("read template lsn: %w", err)
		}
		if lsn == "" {
			return true, fmt.Errorf("template %s has no last_record_lsn (is the plane initialized? run provision-app.sh init-plane)", d.Template)
		}
		if err := d.Pageserver.Branch(ctx, d.Tenant, tl, d.Template, lsn, d.PGVersion); err != nil {
			return true, fmt.Errorf("branch timeline: %w", err)
		}
		// Persist the branch point (this app's ancestor LSN) so the cold-restorability
		// check below can compare it against the template's advancing remote_consistent_lsn
		// without re-reading the branch (docs/runbook-dr.md §9d-bis).
		cr.Status.AncestorLSN = lsn
		d.Cluster.Event(cr, "Normal", "Branched", fmt.Sprintf("timeline %s branched from template@%s", tl, lsn))
	}

	// 5b. Back-fill the branch point for an ADOPTED branch. If the branch already exists
	//     but status.ancestorLsn was never persisted — branched by provision-app.sh
	//     (break-glass), pre-dating the field, or an operator crash between the branch and
	//     its status write — read it from the branch's OWN pageserver detail so the
	//     cold-restorability check (6b) covers EVERY app, not just ones this operator
	//     freshly branched (#209). Fresh branches already set AncestorLSN in step 5, so
	//     this is a no-op for them. A read error (or an absent field) is benign: leave it
	//     empty and re-check next pass — never fail provisioning on it.
	if cr.Status.AncestorLSN == "" {
		if anc, aerr := d.Pageserver.TimelineAncestorLSN(ctx, d.Tenant, tl); aerr == nil && anc != "" {
			cr.Status.AncestorLSN = anc
		}
	}

	// 6. Observe compute readiness and settle status.
	avail, err := d.Cluster.DeploymentAvailable(ctx, app)
	if err != nil {
		return true, fmt.Errorf("check deployment: %w", err)
	}
	cr.Status.ComputeReady = avail
	cr.Status.ObservedGeneration = cr.Generation
	cr.Status.SecretName = "app-db-" + app // external-driver contract: the output Secret name (#119)
	d.setCondition(cr, CondProvisioned, "True", "Provisioned", "branch + compute objects reconciled")

	// 6b. Cold-restorability (ancestor-durability; docs/runbook-dr.md §9d-bis). A freshly
	//     branched app reads its unmodified pages from the TEMPLATE at its ancestor LSN; a
	//     COLD restore (fresh cluster, object-storage bucket only) can only materialize
	//     them once the TEMPLATE's layers up to that LSN are durably uploaded — i.e. the
	//     template's remote_consistent_lsn has caught up to this branch's ancestor LSN. For
	//     the first seconds-to-minutes of an app's life that tail may be un-uploaded, so the
	//     app is briefly NOT cold-restorable. We SURFACE this as a machine-readable
	//     condition + event so an operator/knext can see + alert on it; we do NOT delay
	//     Ready (the app is fully usable now — this is disaster-restore coverage, not
	//     serving). The property is MONOTONIC (remote_consistent_lsn only advances), so once
	//     True we stop polling. AncestorLSN is set in step 5 for fresh branches and
	//     back-filled in step 5b for adopted ones, so every app is covered; it is only ever
	//     empty transiently (a pageserver read still pending) — the check is skipped that
	//     pass and re-evaluated on the next.
	coldRestorableRequeue := false
	if cr.Status.AncestorLSN != "" && !isConditionTrue(cr, CondColdRestorable) {
		rc, rcErr := d.Pageserver.TemplateRemoteConsistentLSN(ctx, d.Tenant, d.Template)
		switch {
		case rcErr != nil:
			// A pageserver blip must never fail provisioning; re-check next pass.
			d.setCondition(cr, CondColdRestorable, "Unknown", "PageserverUnavailable",
				fmt.Sprintf("could not read template remote_consistent_lsn: %v", rcErr))
			coldRestorableRequeue = true
		default:
			gte, ok := lsnGTE(rc, cr.Status.AncestorLSN)
			switch {
			case !ok:
				d.setCondition(cr, CondColdRestorable, "Unknown", "UnparseableLSN",
					fmt.Sprintf("could not compare template remote_consistent_lsn %q to ancestor %q", rc, cr.Status.AncestorLSN))
				coldRestorableRequeue = true
			case gte:
				d.setCondition(cr, CondColdRestorable, "True", "AncestorDurable",
					fmt.Sprintf("template remote_consistent_lsn %s covers branch point %s; a cold restore can materialize this app", rc, cr.Status.AncestorLSN))
				d.Cluster.Event(cr, "Normal", "ColdRestorable", "ancestor WAL is durable in object storage; app is cold-restorable")
			default:
				d.setCondition(cr, CondColdRestorable, "False", "AncestorWALNotYetDurable",
					fmt.Sprintf("template remote_consistent_lsn %s has not reached branch point %s; NOT cold-restorable until the template WAL tail flushes (self-heals in minutes)", rc, cr.Status.AncestorLSN))
				coldRestorableRequeue = true
			}
		}
	}

	roNote := ""
	if cr.Spec.ROPool.Enabled {
		// The DATABASE_URL_RO key (step 3b) is now LIVE: it points at this app's own
		// read-only compute (compute-ro-<app>, step 4b) fronted by the apps-gateway RO
		// listener. Reads route to the app's OWN RO compute — tenant-isolated (#127).
		roNote = " (roPool enabled; DATABASE_URL_RO live -> compute-ro-" + app + ")"
	}

	requeue := false
	if cr.desiredReplicas() == 0 {
		// Cold tier: provisioned == Ready. The compute wakes 0->1 on connect via the
		// apps-gateway; an available replica at rest is not expected.
		cr.Status.Phase = PhaseReady
		cr.Status.Message = "provisioned; compute wakes on connect" + roNote
		d.setCondition(cr, CondReady, "True", "Provisioned", "cold tier; compute wakes on connect")
	} else if avail {
		cr.Status.Phase = PhaseReady
		cr.Status.Message = "provisioned; warm compute available" + roNote
		d.setCondition(cr, CondReady, "True", "ComputeAvailable", "warm compute has an available replica")
	} else {
		cr.Status.Phase = PhaseProvisioning
		cr.Status.Message = "warm compute starting" + roNote
		d.setCondition(cr, CondReady, "False", "ComputeStarting", "waiting for a warm replica")
		requeue = true
	}
	if err := d.Cluster.UpdateStatus(ctx, cr); err != nil {
		return true, fmt.Errorf("update status: %w", err)
	}
	return requeue || coldRestorableRequeue, nil
}

// reconcileWarmHold applies the scheduled warm-window decision for one app:
// ensure the hold while a window is active, release it otherwise, and surface
// the state on the WarmHold condition (never gating). Called only when the CR
// declares a warmSchedule and a Holds actuator is wired.
//
// Warning events are gated on the CondWarmHold TRANSITION, not fired on every
// ~15s resync pass while the bad state persists — mirroring the
// ColdRestorable !isConditionTrue guard below (issue #388 review: unbounded
// Event objects on a persistently invalid schedule or a persistently
// unreachable compute). The condition itself is still refreshed every pass
// (never stale); only the duplicate Event object is suppressed.
func (d *Deps) reconcileWarmHold(ctx context.Context, cr *AppDatabase, app string) {
	active, invalid := warmScheduleActive(cr.Spec.WarmSchedule, d.Now().Time)

	// Snapshot BEFORE this pass mutates the condition, so the gates below
	// compare against what was true on the LAST reconcile, not this one.
	prevReason := ""
	if pc := findCondition(cr, CondWarmHold); pc != nil {
		prevReason = pc.Reason
	}

	allInvalid := len(invalid) > 0 && len(invalid) == len(cr.Spec.WarmSchedule)
	// No admission webhook guards this CRD, so a window that fails to parse is
	// LOUD (Warning event) the first time it's seen — never a silently skipped
	// warm window. When EVERY window is invalid, that state is reflected on
	// CondWarmHold, so gate on the TRANSITION into it (persistently-bad
	// schedule must not spam an Event per resync, #388 review). A mix of
	// valid+invalid windows has no single aggregate condition state to gate
	// on (the app is still warming via the valid window), so it stays
	// unconditionally loud — a rarer misconfiguration.
	if len(invalid) > 0 && (!allInvalid || prevReason != "InvalidWarmWindow") {
		for _, w := range invalid {
			d.Cluster.Event(cr, "Warning", "InvalidWarmWindow",
				fmt.Sprintf("warmSchedule window {start:%q end:%q timezone:%q} is not valid 5-field cron/IANA-tz — it warms nothing; fix or remove it", w.Start, w.End, w.Timezone))
		}
	}
	switch {
	case !active:
		d.Holds.ReleaseHold(app) // idempotent; the gateway parks the compute on idle
		if allInvalid {
			d.setCondition(cr, CondWarmHold, "False", "InvalidWarmWindow", "every warmSchedule window failed to parse; nothing is held warm")
		} else {
			d.setCondition(cr, CondWarmHold, "False", "WindowInactive", "no warmSchedule window is active; compute sleeps at zero and wakes on connect")
		}
	default:
		if err := d.Holds.EnsureHold(ctx, app); err != nil {
			// Defense-in-depth (#388 review): EnsureHold's error may wrap a
			// malformed DSN (net/url can echo a postgres://role:pw@... userinfo
			// verbatim). Redact BEFORE this text reaches the condition, the
			// Event, or (via the controller's error log) stdout.
			safeErr := redactDSN(err.Error())
			d.setCondition(cr, CondWarmHold, "False", "HoldFailed",
				fmt.Sprintf("warm window active but the hold could not be established (degraded to cold-wake this pass; retried next resync): %s", safeErr))
			if prevReason != "HoldFailed" {
				d.Cluster.Event(cr, "Warning", "WarmHoldFailed",
					fmt.Sprintf("could not hold compute-%s warm for the active window (cold wake still works; retrying): %s", app, safeErr))
			}
			return
		}
		d.setCondition(cr, CondWarmHold, "True", "WindowActive",
			"a warmSchedule window is active; holding one gateway connection so the compute stays warm (no DB cold start during the window)")
	}
}

// reconcileDelete runs safe deprovision under the finalizer, then removes it so the
// CR object can be deleted. Mirrors provision-app.sh destroy (safe-by-default):
// remove k8s objects, then two-sided timeline delete unless keepTimelineOnDelete.
func (d *Deps) reconcileDelete(ctx context.Context, cr *AppDatabase) (bool, error) {
	if !cr.hasFinalizer() {
		return false, nil // our work is done; k8s will remove the object
	}
	app := cr.Spec.AppName
	cr.Status.Phase = PhaseDeleting
	_ = d.Cluster.UpdateStatus(ctx, cr) // best-effort; object may be mid-deletion

	// Drop any scheduled warm hold FIRST (#388): a deprovisioned app must not keep
	// a connection (and its compute) alive. Idempotent, nil-safe.
	if d.Holds != nil {
		d.Holds.ReleaseHold(app)
	}

	// Remove the per-app read-only compute first (Deployment/Service/HPA), so a
	// deprovisioned app leaves no orphaned read replicas (#127). Idempotent.
	if err := d.Cluster.DeleteROCompute(ctx, app); err != nil {
		return true, fmt.Errorf("delete ro compute objects: %w", err)
	}

	// Remove the k8s objects (Deployment/Service/ConfigMap/Secret), ignore-not-found.
	if err := d.Cluster.DeleteCompute(ctx, app); err != nil {
		return true, fmt.Errorf("delete compute objects: %w", err)
	}

	tl := cr.Status.TimelineID
	if cr.Spec.KeepTimelineOnDelete {
		if tl != "" {
			msg := fmt.Sprintf("timeline %s RETAINED per keepTimelineOnDelete; now an orphan — reclaim with: provision-app.sh reclaim-orphans", tl)
			d.Cluster.Event(cr, "Warning", "TimelineRetained", msg)
		}
		if err := d.Cluster.RemoveFinalizer(ctx, cr); err != nil {
			return true, fmt.Errorf("remove finalizer: %w", err)
		}
		return false, nil
	}

	if tl == "" {
		// Nothing branched (crash before status.timelineId, or never provisioned).
		if err := d.Cluster.RemoveFinalizer(ctx, cr); err != nil {
			return true, fmt.Errorf("remove finalizer: %w", err)
		}
		return false, nil
	}

	// Safe two-sided reclaim (pageserver + every safekeeper).
	if d.reclaimTimeline(ctx, tl) {
		_ = d.Cluster.ClearReclaimPending(ctx, tl)
		d.Cluster.Event(cr, "Normal", "TimelineReclaimed", fmt.Sprintf("timeline %s reclaimed (no orphan)", tl))
		if err := d.Cluster.RemoveFinalizer(ctx, cr); err != nil {
			return true, fmt.Errorf("remove finalizer: %w", err)
		}
		return false, nil
	}
	// Incomplete: a safekeeper is down. The failure is durably recorded (reclaim
	// ledger). Keep the finalizer and REQUEUE — the operator retries until the
	// safekeeper recovers, so the CR disappears only once the plane is truly clean.
	// (provision-app.sh reclaim-orphans is the independent backstop.)
	cr.Status.Message = fmt.Sprintf("timeline %s reclaim incomplete (safekeeper down); retrying", tl)
	_ = d.Cluster.UpdateStatus(ctx, cr)
	d.Cluster.Event(cr, "Warning", "ReclaimIncomplete", cr.Status.Message)
	return true, nil
}

// reclaimTimeline DELETEs tl off the pageserver and every safekeeper. Returns true
// iff fully reclaimed; on any safekeeper failure it records the pending ordinals to
// the reclaim ledger (never silently swallowed, issue #91) and returns false.
func (d *Deps) reclaimTimeline(ctx context.Context, tl string) bool {
	// Pageserver DELETE: a 404 (already gone) is success for our purposes; the real
	// impl treats not-found as nil.
	_ = d.Pageserver.DeleteTimeline(ctx, d.Tenant, tl)
	var failed []string
	for ord := 0; ord < d.Safekeeper.Replicas(); ord++ {
		if err := d.Safekeeper.DeleteTimeline(ctx, ord, d.Tenant, tl); err != nil {
			failed = append(failed, strconv.Itoa(ord))
		}
	}
	if len(failed) > 0 {
		_ = d.Cluster.RecordReclaimPending(ctx, tl, strings.Join(failed, ","))
		return false
	}
	return true
}

// setCondition updates-or-appends a status condition, stamping lastTransitionTime
// only when the status value actually flips (k8s convention).
func (d *Deps) setCondition(cr *AppDatabase, condType, status, reason, message string) {
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

// dsnUserinfoRE matches a URL userinfo segment (scheme://user:password@) that
// may be embedded anywhere in free text — e.g. a Dial/Ping error that wraps a
// malformed postgres:// DSN, which net/url can echo verbatim including the
// password (review finding, #388).
var dsnUserinfoRE = regexp.MustCompile(`://[^\s/@]+:[^\s/@]+@`)

// redactDSN strips any embedded DSN userinfo (role:password) from free-form
// text before it reaches a status Condition, a Kubernetes Event, or a log
// line. Defense-in-depth: EnsureHold's error should never legitimately
// contain the DSN, but if a driver/url error wraps one, the password must
// never surface in cluster-visible or logged text.
func redactDSN(s string) string {
	return dsnUserinfoRE.ReplaceAllString(s, "://[REDACTED]@")
}

// isConditionTrue reports whether the named status condition is present and "True".
func isConditionTrue(cr *AppDatabase, condType string) bool {
	for i := range cr.Status.Conditions {
		if cr.Status.Conditions[i].Type == condType {
			return cr.Status.Conditions[i].Status == "True"
		}
	}
	return false
}

// findCondition returns the named status condition, or nil if absent. Used to
// snapshot a condition's prior state before a reconcile pass recomputes it
// (transition-gating for Warning events, e.g. reconcileWarmHold).
func findCondition(cr *AppDatabase, condType string) *Condition {
	for i := range cr.Status.Conditions {
		if cr.Status.Conditions[i].Type == condType {
			return &cr.Status.Conditions[i]
		}
	}
	return nil
}

// lsnGTE reports whether Neon LSN a >= b. Neon prints an LSN as "hi/lo" in hex — a
// 64-bit WAL position split into a high and low 32-bit word (e.g. "1/A3B4C8"). ok is
// false when either side does not parse into exactly two hex words; the caller treats
// that as "unknown" rather than emitting a false durability verdict.
func lsnGTE(a, b string) (gte, ok bool) {
	av, aok := parseLSN(a)
	bv, bok := parseLSN(b)
	if !aok || !bok {
		return false, false
	}
	return av >= bv, true
}

// parseLSN reconstructs the 64-bit value of a Neon "hi/lo" hex LSN. ok is false for any
// string that is not exactly two slash-separated hex words.
func parseLSN(s string) (uint64, bool) {
	hiStr, loStr, found := strings.Cut(s, "/")
	if !found || strings.Contains(loStr, "/") {
		return 0, false
	}
	hi, err1 := strconv.ParseUint(hiStr, 16, 64)
	lo, err2 := strconv.ParseUint(loStr, 16, 64)
	if err1 != nil || err2 != nil {
		return 0, false
	}
	return hi<<32 | lo, true
}

// roDSN derives the read-only DSN from the writer DSN by swapping ONLY the gateway
// listener port (writerPort -> roPort). The read-only pool shares the app's role,
// password, host and database — it differs only by which gateway port fronts it
// (docs/connecting.md two-DSN pattern). If the writer DSN does not contain the
// writer port, it is returned unchanged (defensive — never fabricate an endpoint).
//
// SAFETY (fail-closed, non-negotiable): because only the PORT is swapped, the RO
// DSN's HOST is always the SAME host as the writer — the app's own apps-gateway
// (pggw-apps). It therefore can NEVER resolve to the shared primary RO pool
// (compute-ro, which is fronted by the DIFFERENT primary gateway pggw:55434 on the
// primary timeline) — that would be cross-tenant data exposure. Today pggw-apps
// runs no RO listener, so the RO DSN fails CLOSED (connection refused) until the
// per-app RO serving endpoint ships. Refused-until-ready is safe; a leak is not.
// _verify-operator.sh asserts the RO DSN refuses rather than returns data.
func roDSN(writerDSN string, writerPort, roPort int) string {
	from := fmt.Sprintf(":%d/", writerPort)
	to := fmt.Sprintf(":%d/", roPort)
	return strings.Replace(writerDSN, from, to, 1)
}

// validateAppName enforces an RFC1123 DNS label and rejects reserved system names
// (issues #79/#74) — identical rules to provision-app.sh validate_app_name.
func validateAppName(app string) error {
	if app == "" {
		return fmt.Errorf("app name required")
	}
	if len(app) > 63 {
		return fmt.Errorf("invalid app name %q: max 63 chars (RFC1123 label)", app)
	}
	if strings.HasPrefix(app, "-") || strings.HasSuffix(app, "-") {
		return fmt.Errorf("invalid app name %q: must not start or end with '-'", app)
	}
	for _, r := range app {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
			return fmt.Errorf("invalid app name %q: only lowercase [a-z0-9-] allowed (RFC1123 label)", app)
		}
	}
	if ReservedNames[app] {
		return fmt.Errorf("app name %q is reserved (routes to a non-app compute) — pick another", app)
	}
	return nil
}
