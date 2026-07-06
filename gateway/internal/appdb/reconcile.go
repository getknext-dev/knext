package appdb

import (
	"context"
	"crypto/md5" //nolint:gosec // md5(password||role) is Neon compute_ctl's encrypted_password format, not a security hash
	"encoding/hex"
	"fmt"
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
		sum := appMD5(pw, role)
		dsn := fmt.Sprintf("postgres://%s:%s@%s:%d/%s?sslmode=disable", role, pw, d.GatewayHost, d.GatewayPort, app)
		if err := d.Cluster.CreateSecret(ctx, app, role, pw, sum, dsn); err != nil {
			return true, fmt.Errorf("mint credential: %w", err)
		}
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
		}); err != nil {
			return true, fmt.Errorf("apply ro compute: %w", err)
		}
	} else if err := d.Cluster.DeleteROCompute(ctx, app); err != nil {
		return true, fmt.Errorf("teardown ro compute: %w", err)
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
		d.Cluster.Event(cr, "Normal", "Branched", fmt.Sprintf("timeline %s branched from template@%s", tl, lsn))
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
	return requeue, nil
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

// appMD5 is compute_ctl's encrypted_password: the RAW 32-hex md5(password||rolename)
// with NO "md5" prefix (matches provision-app.sh app_md5 and the cloud_admin verifier).
func appMD5(password, role string) string {
	sum := md5.Sum([]byte(password + role)) //nolint:gosec // format required by Neon compute_ctl
	return hex.EncodeToString(sum[:])
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
