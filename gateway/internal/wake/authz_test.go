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
// provisioned and an unprovisioned database yield the SAME generic "authentication
// failed" refusal — no "database does not exist" oracle for tenant enumeration.
func TestAuthErrorDoesNotLeakExistence(t *testing.T) {
	az := newTemplateAuthorizer(t, Env{})
	// Same wrong user, one db that could exist and one that clearly does not:
	// both must refuse with the identical message (no existence signal).
	e1 := az.Authorize("cloud_admin", "orders")
	e2 := az.Authorize("cloud_admin", "definitely-not-provisioned")
	if e1 == nil || e2 == nil {
		t.Fatal("both should be refused")
	}
	const generic = "authentication failed"
	for _, e := range []error{e1, e2} {
		if got := e.Error(); len(got) < len(generic) || got[:len(generic)] != generic {
			t.Fatalf("refusal %q must use the generic %q phrasing (no existence oracle)", got, generic)
		}
	}
}
