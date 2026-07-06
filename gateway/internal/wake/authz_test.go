package wake

import "testing"

// authorizer is the optional interface template mode implements (issue #74).
type authorizer interface {
	Authorize(user, database string) error
}

func newTemplateAuthorizer(t *testing.T, env Env) authorizer {
	t.Helper()
	env["GW_COMPUTE_MODE"] = "template"
	if env["GW_K8S_DEPLOYMENT_TEMPLATE"] == "" {
		env["GW_K8S_DEPLOYMENT_TEMPLATE"] = "compute-{system}"
	}
	d, err := MakeDriverWithScaler(env, &fakeScaler{})
	if err != nil {
		t.Fatalf("MakeDriverWithScaler: %v", err)
	}
	az, ok := d.(authorizer)
	if !ok {
		t.Fatal("template driver must implement Authorize (issue #74)")
	}
	return az
}

// The tenant boundary: user must be app_<database>; reserved/malformed names and
// the shared cloud_admin are refused. This is the core security matrix.
func TestTemplateAuthorizeMatrix(t *testing.T) {
	az := newTemplateAuthorizer(t, Env{})
	cases := []struct {
		name      string
		user, db  string
		wantAllow bool
	}{
		{"matching app pair", "app_orders", "orders", true},
		{"another matching pair", "app_mta", "mta", true},
		{"cloud_admin to an app", "cloud_admin", "orders", false},
		{"cross-app A->B", "app_mta", "mtb", false},
		{"reserved: template compute", "app_tmpl", "tmpl", false},
		{"reserved: warm compute", "app_warm", "warm", false},
		{"reserved: ro compute", "app_ro", "ro", false},
		{"charset: uppercase", "app_Orders", "Orders", false},
		{"charset: dot", "app_a.b", "a.b", false},
		{"charset: slash injection", "app_a/b", "a/b", false},
		{"charset: leading dash", "app_-x", "-x", false},
		{"empty database", "app_", "", false},
		{"empty user", "", "orders", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := az.Authorize(c.user, c.db)
			if c.wantAllow && err != nil {
				t.Fatalf("Authorize(%q,%q) = %v, want allow", c.user, c.db, err)
			}
			if !c.wantAllow && err == nil {
				t.Fatalf("Authorize(%q,%q) = nil, want refusal", c.user, c.db)
			}
		})
	}
}

// The role prefix and reserved set are configurable (GW_APP_ROLE_PREFIX,
// GW_RESERVED_SYSTEMS) so the boundary can be tuned without code changes.
func TestTemplateAuthorizeConfigurablePrefixAndReserved(t *testing.T) {
	az := newTemplateAuthorizer(t, Env{
		"GW_APP_ROLE_PREFIX":  "tenant-",
		"GW_RESERVED_SYSTEMS": "admin,system",
	})
	if err := az.Authorize("tenant-shop", "shop"); err != nil {
		t.Fatalf("custom prefix pair refused: %v", err)
	}
	if err := az.Authorize("app_shop", "shop"); err == nil {
		t.Fatal("default prefix should be refused once prefix is overridden")
	}
	if err := az.Authorize("tenant-admin", "admin"); err == nil {
		t.Fatal("custom reserved name 'admin' must be refused")
	}
	// tmpl is no longer reserved under the custom set, but must still be a valid
	// per-app pair to pass.
	if err := az.Authorize("tenant-tmpl", "tmpl"); err != nil {
		t.Fatalf("tmpl not reserved under custom set, valid pair should pass: %v", err)
	}
}

// AuthError must NOT leak whether the target app exists: authorization is a pure
// function of the (user,database) pair and never consults cluster state, so a
// provisioned and an unprovisioned database yield the IDENTICAL UniformAuthFailure
// refusal — no "database does not exist" oracle for tenant enumeration (issue #92).
func TestAuthErrorDoesNotLeakExistence(t *testing.T) {
	az := newTemplateAuthorizer(t, Env{})
	// Same wrong user, one db that could exist and one that clearly does not:
	// both must refuse with the byte-identical message (no existence signal).
	e1 := az.Authorize("cloud_admin", "orders")
	e2 := az.Authorize("cloud_admin", "definitely-not-provisioned")
	if e1 == nil || e2 == nil {
		t.Fatal("both should be refused")
	}
	if e1.Error() != e2.Error() {
		t.Fatalf("existence oracle: %q != %q", e1.Error(), e2.Error())
	}
	if got, want := e1.Error(), UniformAuthFailure("cloud_admin"); got != want {
		t.Fatalf("refusal = %q, want the uniform %q", got, want)
	}
}

// Every refusal class (malformed name, reserved name, wrong pair) must return the
// IDENTICAL UniformAuthFailure keyed only on the client-supplied user — so an
// attacker cannot even tell WHICH validation rule tripped, and (with the gateway
// wake-failure path, tested in package gateway) a non-existent app is
// indistinguishable from a wrong password (issue #92).
func TestAuthorizeRefusalsAreUniformByUser(t *testing.T) {
	az := newTemplateAuthorizer(t, Env{})
	user := "app_ghost"
	want := UniformAuthFailure(user)
	// All three use the SAME user, so all three must be byte-identical.
	cases := map[string]string{
		"malformed db": "Bad.Name",
		"reserved db":  "tmpl",
		"wrong pair":   "orders", // app_ghost != app_orders
	}
	for name, db := range cases {
		err := az.Authorize(user, db)
		if err == nil {
			t.Fatalf("%s: expected refusal", name)
		}
		if got := err.Error(); got != want {
			t.Fatalf("%s: refusal = %q, want uniform %q", name, got, want)
		}
	}
}

// replAuthorizer is the optional interface template mode implements for
// gateway-mediated replication-wake (ADR-0007 §4c).
type replAuthorizer interface {
	AuthorizeReplication(user, database string) error
}

func newTemplateReplAuthorizer(t *testing.T, env Env) replAuthorizer {
	t.Helper()
	env["GW_COMPUTE_MODE"] = "template"
	if env["GW_K8S_DEPLOYMENT_TEMPLATE"] == "" {
		env["GW_K8S_DEPLOYMENT_TEMPLATE"] = "compute-{system}"
	}
	d, err := MakeDriverWithScaler(env, &fakeScaler{})
	if err != nil {
		t.Fatalf("MakeDriverWithScaler: %v", err)
	}
	az, ok := d.(replAuthorizer)
	if !ok {
		t.Fatal("template driver must implement AuthorizeReplication (ADR-0007 §4c)")
	}
	return az
}

// A REPLICATION startup authorizes against the per-zone REPLICATION role
// repl_<zone> (ADR-0007 §4b), NOT the per-app app_<zone> role. The app role
// (which cannot drive a subscription) is refused on the replication path, and the
// repl role is refused on the ordinary path — clean role separation.
func TestTemplateAuthorizeReplicationMatrix(t *testing.T) {
	replAz := newTemplateReplAuthorizer(t, Env{})
	ordAz := newTemplateAuthorizer(t, Env{})
	cases := []struct {
		name          string
		user, db      string
		replAllow     bool
		ordinaryAllow bool
	}{
		{"repl role on its zone", "repl_zone-eu", "zone-eu", true, false},
		{"app role on replication path", "app_zone-eu", "zone-eu", false, true},
		{"cloud_admin replication", "cloud_admin", "zone-eu", false, false},
		{"cross-zone repl role", "repl_zone-us", "zone-eu", false, false},
		{"reserved zone name (tmpl)", "repl_tmpl", "tmpl", false, false},
		{"malformed zone name", "repl_Bad.Zone", "Bad.Zone", false, false},
		{"empty user", "", "zone-eu", false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := replAz.AuthorizeReplication(c.user, c.db); (err == nil) != c.replAllow {
				t.Fatalf("AuthorizeReplication(%q,%q) allow=%v, want %v (err=%v)", c.user, c.db, err == nil, c.replAllow, err)
			}
			if err := ordAz.Authorize(c.user, c.db); (err == nil) != c.ordinaryAllow {
				t.Fatalf("Authorize(%q,%q) allow=%v, want %v (err=%v)", c.user, c.db, err == nil, c.ordinaryAllow, err)
			}
		})
	}
}

// The replication role prefix is configurable (GW_REPL_ROLE_PREFIX) so an operator
// can align it with the Zone operator's minted role name without a code change.
func TestTemplateAuthorizeReplicationConfigurablePrefix(t *testing.T) {
	az := newTemplateReplAuthorizer(t, Env{"GW_REPL_ROLE_PREFIX": "wal_"})
	if err := az.AuthorizeReplication("wal_zone-eu", "zone-eu"); err != nil {
		t.Fatalf("custom repl prefix pair refused: %v", err)
	}
	if err := az.AuthorizeReplication("repl_zone-eu", "zone-eu"); err == nil {
		t.Fatal("default repl prefix must be refused once prefix is overridden")
	}
}

// Replication refusals must be the same UniformAuthFailure as ordinary ones — the
// replication front door must not become an existence/role oracle (issue #92).
func TestAuthorizeReplicationRefusalsAreUniform(t *testing.T) {
	az := newTemplateReplAuthorizer(t, Env{})
	user := "repl_ghost"
	want := UniformAuthFailure(user)
	for name, db := range map[string]string{
		"malformed":  "Bad.Zone",
		"reserved":   "tmpl",
		"wrong zone": "zone-eu", // repl_ghost != repl_zone-eu
	} {
		err := az.AuthorizeReplication(user, db)
		if err == nil {
			t.Fatalf("%s: expected refusal", name)
		}
		if got := err.Error(); got != want {
			t.Fatalf("%s: refusal = %q, want uniform %q", name, got, want)
		}
	}
}
