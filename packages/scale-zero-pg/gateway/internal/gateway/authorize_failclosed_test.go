package gateway

import (
	"context"
	"errors"
	"testing"

	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// appOnlyAuthorizer is a driver that gates ORDINARY tenant traffic
// (systemAuthorizer) but deliberately does NOT implement replicationAuthorizer.
// It models the dangerous shape authorizeStartup must fail closed against: a
// future/partial apps-gateway that knows how to authorize app connections but was
// never taught to authorize REPLICATION startups. Such a driver must refuse
// replication uniformly, never fall through to an unauthorized wake.
//
// The production templateDriver implements BOTH interfaces, so the fail-closed
// branch (gateway.go, replication + systemAuthorizer-but-not-replicationAuthorizer)
// was only covered indirectly. This stub exercises it directly (#141).
type appOnlyAuthorizer struct {
	woke bool
}

func (d *appOnlyAuthorizer) Mode() string { return "template" }
func (d *appOnlyAuthorizer) Resolve(string) wake.Target {
	return wake.Target{Host: "127.0.0.1", Port: 1, Key: "x"}
}
func (d *appOnlyAuthorizer) Wake(context.Context, wake.Target) error  { d.woke = true; return nil }
func (d *appOnlyAuthorizer) Sleep(context.Context, wake.Target) error { return nil }
func (d *appOnlyAuthorizer) CanSleep() bool                           { return true }

// Authorize marks this a systemAuthorizer. Ordinary (non-replication) traffic is
// accepted so the test can prove the refusal below is REPLICATION-specific, not a
// blanket deny.
func (d *appOnlyAuthorizer) Authorize(user, database string) error { return nil }

// A systemAuthorizer driver that does NOT implement AuthorizeReplication MUST
// fail closed on a REPLICATION startup — a uniform *wake.AuthError, and crucially
// no wake — rather than silently accepting an unauthorized walreceiver.
func TestAuthorizeStartupFailsClosedForReplicationWithoutReplAuthorizer(t *testing.T) {
	d := &appOnlyAuthorizer{}
	gw := gatewayWithDriver(t, d)

	// Sanity: this stub really is NOT a replicationAuthorizer, so we are exercising
	// the fail-closed branch and not the AuthorizeReplication path.
	if _, ok := any(d).(replicationAuthorizer); ok {
		t.Fatal("stub must NOT implement replicationAuthorizer for this test to cover the fail-closed branch")
	}

	err := gw.authorizeStartup("repl_zone-eu", "zone-eu", true)
	if err == nil {
		t.Fatal("replication startup was accepted by a driver with no replication authz — MUST fail closed")
	}
	var ae *wake.AuthError
	if !errors.As(err, &ae) {
		t.Fatalf("err = %T (%v), want *wake.AuthError (uniform refusal)", err, err)
	}
	if want := wake.UniformAuthFailure("repl_zone-eu"); ae.Msg != want {
		t.Fatalf("refusal msg = %q, want uniform %q", ae.Msg, want)
	}
	if d.woke {
		t.Fatal("driver was woken on a refused replication startup — refusal must be PRE-wake")
	}
}

// The same stub must still ACCEPT an ordinary (non-replication) startup via its
// Authorize — proving the fail-closed refusal above is replication-specific and
// not a blanket deny of the driver.
func TestAuthorizeStartupAllowsOrdinaryTrafficForAppOnlyAuthorizer(t *testing.T) {
	d := &appOnlyAuthorizer{}
	gw := gatewayWithDriver(t, d)
	if err := gw.authorizeStartup("app_zone-eu", "zone-eu", false); err != nil {
		t.Fatalf("ordinary startup refused by a systemAuthorizer that permits it: %v", err)
	}
}

// A driver with NO authorizer at all (the single-DB pggw / static path) must
// accept BOTH ordinary and replication startups unchanged — the fail-closed
// branch is gated on being a systemAuthorizer, so unrelated drivers are untouched.
func TestAuthorizeStartupNoAuthorizerAcceptsReplication(t *testing.T) {
	// oracleDriver is defined in oracle_test.go and IS a systemAuthorizer, so we
	// use a bare non-authorizing stub here.
	d := &plainDriver{}
	gw := gatewayWithDriver(t, d)
	if err := gw.authorizeStartup("anyone", "anydb", true); err != nil {
		t.Fatalf("non-authorizer driver must accept replication unchanged: %v", err)
	}
	if err := gw.authorizeStartup("anyone", "anydb", false); err != nil {
		t.Fatalf("non-authorizer driver must accept ordinary traffic unchanged: %v", err)
	}
}

// plainDriver implements only wake.Driver — neither systemAuthorizer nor
// replicationAuthorizer — modelling the single-DB pggw / static path.
type plainDriver struct{}

func (plainDriver) Mode() string { return "static" }
func (plainDriver) Resolve(string) wake.Target {
	return wake.Target{Host: "127.0.0.1", Port: 1, Key: "x"}
}
func (plainDriver) Wake(context.Context, wake.Target) error  { return nil }
func (plainDriver) Sleep(context.Context, wake.Target) error { return nil }
func (plainDriver) CanSleep() bool                           { return false }
