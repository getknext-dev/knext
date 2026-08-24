package appdb

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// Hold behaviour ACROSS A CREDENTIAL ROTATION (knext #798, half 2).
//
// The gap this closes: every consumer half of `provision-app.sh rotate-cred` was
// tested, but nothing exercised a `tier: warm` app's HELD connection across the
// rotation. The hold is long-lived and authenticated, the operator reads the DSN
// from the app-db-<app> Secret that rotate-cred overwrites, and the running compute
// keeps enforcing the OLD SCRAM verifier until it is bounced — three moving parts
// whose interaction was assumed rather than asserted.
//
// The behaviour asserted here, stated plainly because it is a DESIGN CHOICE and not
// an accident:
//
//   - a healthy hold is NOT re-dialled when the Secret rotates. Proactively
//     re-dialling would be actively harmful without a bounce: the new password does
//     not yet authenticate against the running compute, so a working hold would be
//     traded for a failing one.
//   - when the hold DOES die (a bounce, a gateway rollout, a partition), the re-dial
//     reads the DSN AGAIN, so it picks up the rotated credential. The DSN is never
//     cached from the first dial.
//   - a re-dial that fails because the compute still holds the old verifier surfaces
//     as an error and DROPS the app from Held(), so appdb_warm_hold_active falls and
//     the degradation is visible — never silently reported as warm.
//
// Which is why `rotate-cred <app> --bounce` is the sanctioned sequence for a warm
// app (docs/operations.md "Rotating an app credential", drills/tier-warm-drill.md):
// it lands the new verifier on the compute and kills the hold in one step, so the
// very next reconcile pass re-dials with the matching credential.

// rotatingDSN is the app-db-<app> Secret's DATABASE_URL as the operator sees it: a
// LIVE read (K8sCluster.DatabaseURL does a fresh Secret GET per call), so a rotation
// between two reads returns two different DSNs. reads counts how often the manager
// actually consults it.
type rotatingDSN struct {
	dsn   string
	reads int
}

func (r *rotatingDSN) read(context.Context, string) (string, error) {
	r.reads++
	return r.dsn, nil
}

const (
	dsnBeforeRotation = "postgres://app_shop:oldpw@pggw-apps.scale-zero-pg.svc.cluster.local.:55432/shop?sslmode=disable"
	dsnAfterRotation  = "postgres://app_shop:newpw@pggw-apps.scale-zero-pg.svc.cluster.local.:55432/shop?sslmode=disable"
)

func TestHoldManager_RedialAfterRotationUsesTheRotatedDSN(t *testing.T) {
	// The sanctioned warm-app sequence: rotate-cred --bounce. The Secret carries the
	// new password AND the compute restarts, so the hold's ping fails and the manager
	// re-dials — with the CURRENT DSN, not the one it first dialled.
	secret := &rotatingDSN{dsn: dsnBeforeRotation}
	dial := &fakeDialer{}
	m := NewHoldManager(secret.read, dial, 0)

	if err := m.EnsureHold(context.Background(), "shop"); err != nil {
		t.Fatalf("EnsureHold (pre-rotation): %v", err)
	}

	// rotate-cred writes the new password; --bounce recreates the compute, killing
	// the held connection.
	secret.dsn = dsnAfterRotation
	dial.conns[0].pingErr = errors.New("server closed the connection unexpectedly")

	if err := m.EnsureHold(context.Background(), "shop"); err != nil {
		t.Fatalf("EnsureHold (post-rotation redial): %v", err)
	}
	if len(dial.dialed) != 2 {
		t.Fatalf("dialed %d times, want 2 (the dead hold must be re-established)", len(dial.dialed))
	}
	if dial.dialed[1] != dsnAfterRotation {
		t.Fatalf("redial used DSN %q, want the ROTATED %q — the DSN must be re-read from the Secret on every dial, never cached from the first one, or a warm app never recovers from a rotation",
			dial.dialed[1], dsnAfterRotation)
	}
	if !m.Held()["shop"] {
		t.Fatal("Held() lost shop after the post-rotation redial")
	}
}

func TestHoldManager_HealthyHoldIsNotRedialedOnRotation(t *testing.T) {
	// rotate-cred WITHOUT --bounce: the Secret changes under a live, healthy hold.
	// The manager must keep it. The running compute still enforces the OLD verifier,
	// so re-dialling on the new password would fail auth and trade a working hold for
	// a broken one — this is why the no-bounce form leaves warming undisturbed and
	// the credential applies on the next bounce/wake.
	secret := &rotatingDSN{dsn: dsnBeforeRotation}
	dial := &fakeDialer{}
	m := NewHoldManager(secret.read, dial, 0)

	if err := m.EnsureHold(context.Background(), "shop"); err != nil {
		t.Fatalf("EnsureHold (pre-rotation): %v", err)
	}
	readsAfterFirstDial := secret.reads

	secret.dsn = dsnAfterRotation
	for i := 0; i < 3; i++ {
		if err := m.EnsureHold(context.Background(), "shop"); err != nil {
			t.Fatalf("EnsureHold pass %d after a no-bounce rotation: %v", i, err)
		}
	}

	if len(dial.dialed) != 1 {
		t.Fatalf("dialed %d times, want 1 — a healthy hold must survive a Secret rotation untouched", len(dial.dialed))
	}
	if dial.conns[0].closed {
		t.Fatal("a healthy hold was closed after a rotation — the window would go cold for no reason")
	}
	if secret.reads != readsAfterFirstDial {
		t.Fatalf("the Secret was re-read %d extra time(s) while the hold was healthy — the liveness path must not touch the Secret at all",
			secret.reads-readsAfterFirstDial)
	}
	if !m.Held()["shop"] {
		t.Fatal("Held() lost shop while its hold was healthy")
	}
}

func TestHoldManager_RedialRejectedByOldVerifierDropsTheAppLoudly(t *testing.T) {
	// The hazard the no-bounce path leaves open, asserted rather than assumed: the
	// hold dies for an unrelated reason (gateway rollout) AFTER a no-bounce rotation.
	// The re-dial now carries the new password while the compute still enforces the
	// old verifier, so it is rejected (SQLSTATE 28P01). That must surface as an error
	// and drop the app out of Held() — appdb_warm_hold_active goes to 0 and the alert
	// path sees it — rather than leaving a dead hold reported as warm.
	secret := &rotatingDSN{dsn: dsnBeforeRotation}
	live := &fakeHoldConn{}
	dials := 0
	dial := dialerFunc(func(_ context.Context, dsn string) (HoldConn, error) {
		dials++
		if dsn == dsnAfterRotation {
			return nil, errors.New(`pq: password authentication failed for user "app_shop" (28P01)`)
		}
		return live, nil
	})
	m := NewHoldManager(secret.read, dial, 0)

	if err := m.EnsureHold(context.Background(), "shop"); err != nil {
		t.Fatalf("EnsureHold (pre-rotation): %v", err)
	}

	secret.dsn = dsnAfterRotation                         // rotate-cred, no --bounce
	live.pingErr = errors.New("connection reset by peer") // gateway rollout kills the hold

	err := m.EnsureHold(context.Background(), "shop")
	if err == nil {
		t.Fatal("EnsureHold: err = nil after a redial the compute's old verifier rejects — the failure must surface")
	}
	if !strings.Contains(err.Error(), "28P01") {
		t.Fatalf("EnsureHold error = %v, want the auth rejection propagated verbatim (the operator's event/condition text is how an owner learns to bounce)", err)
	}
	if m.Held()["shop"] {
		t.Fatal("Held() still reports shop as warm after the redial was rejected — the gauge would claim a hold that does not exist")
	}
	if !live.closed {
		t.Fatal("the dead hold was not closed before the redial")
	}
	if dials != 2 {
		t.Fatalf("dialed %d times, want 2 (one pre-rotation, one rejected redial)", dials)
	}
}
