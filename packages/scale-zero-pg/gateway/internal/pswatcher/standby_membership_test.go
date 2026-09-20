package pswatcher

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// fakeMembership models a standby membership oracle: which tenants the standby
// HOLDS (in any location mode — Attached* or Secondary), or a read failure.
type fakeMembership struct {
	held map[string]bool
	err  error // the oracle is unreadable for EVERY tenant
	// errFor makes the oracle unreadable for SPECIFIC tenants only — needed to
	// discriminate the oracle-error branch from the base tenant's never-skippable
	// abort, which otherwise masks it (#1120 review).
	errFor map[string]error
}

func (f *fakeMembership) HoldsTenant(_ context.Context, tenant string) (bool, error) {
	if f.err != nil {
		return false, f.err
	}
	if err := f.errFor[tenant]; err != nil {
		// held=false alongside the error, as an honest HTTP oracle returns: a caller
		// that drops the error reads this as "not held", which is the exact conflation
		// the failover pre-flight must refuse.
		return false, err
	}
	return f.held[tenant], nil
}

// allHeld is the LIVE-ACCURATE default for tests that are not about tenant
// coverage: a standby warmed for every routed tenant (the supported posture).
type allHeld struct{}

func (allHeld) HoldsTenant(_ context.Context, _ string) (bool, error) { return true, nil }

// D2 round 2 — the P0 the first round shipped: the WRONG ORACLE.
//
// LIVE-VERIFIED on gke szpg-f5, standby-0, whose routed tenants are warm
// **Secondaries**:
//
//	GET /v1/tenant/<T>                 -> 503 "Tenant not yet active"
//	GET /v1/tenant/<T>/location_config -> 404 (even when held as Secondary)
//	GET /v1/location_config            -> 200 {"tenant_shards":[["<T>",null],…]}
//
// So the generation view (GET /v1/tenant/<T>) — the round-1 pre-flight oracle —
// ERRORS on every warm Secondary, which aborts the FIRST routed tenant and leaves
// automatic failover permanently dead on the real plane. Only the plane-wide
// location_config listing sees a Secondary. This test pins that distinction: one
// server, the live status codes, and the two oracles disagreeing.
func TestMembershipOracleSeesSecondaryTheGenerationViewRejects(t *testing.T) {
	const tenant = "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0"
	mux := http.NewServeMux()
	// The live Secondary semantics: the per-tenant endpoints do NOT answer for a
	// tenant that is held as a Secondary.
	mux.HandleFunc("/v1/tenant/", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"msg":"Tenant not yet active"}`)
	})
	// …but the plane-wide listing DOES, Secondaries included.
	mux.HandleFunc("/v1/location_config", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"tenant_shards":[["`+tenant+`",null]]}`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// The OLD oracle: errors, so a pre-flight built on it aborts every failover.
	if _, _, err := NewHTTPGenerationViewer(srv.URL, 5*time.Second).Generation(context.Background(), tenant); err == nil {
		t.Fatal("GET /v1/tenant/<T> must be an ERROR for a warm Secondary (503) — if this ever passes, re-check the live plane before reinstating it as the failover oracle")
	}

	// The oracle the failover pre-flight must use.
	held, err := NewHTTPTenantMembershipViewer(srv.URL, 5*time.Second).HoldsTenant(context.Background(), tenant)
	if err != nil {
		t.Fatalf("the membership oracle must READ a standby whose tenants are warm Secondaries: %v", err)
	}
	if !held {
		t.Fatal("a tenant listed in /v1/location_config tenant_shards is HELD (as a Secondary) — reporting not-held here kills automatic failover on the real plane")
	}
}

// The membership oracle's three outcomes, against the real body shape. held=false
// is reserved for a 200 that simply does NOT list the tenant; every unreadable
// answer is an ERROR, never "absent" — "we could not check" is not "it is not
// there", and the failover's fail-closed abort depends on that distinction.
func TestMembershipOracleDistinguishesAbsentFromUnreadable(t *testing.T) {
	const tenant = "a000a000a000a000a000a000a000a000"
	cases := []struct {
		name      string
		status    int
		body      string
		wantHeld  bool
		wantError bool
	}{
		{
			name: "listed as a shard -> held",
			body: `{"tenant_shards":[["` + tenant + `",null],["b111b111b111b111b111b111b111b111",null]]}`,
			// a Secondary carries a null config; an attached one carries an object.
			wantHeld: true,
		},
		{
			name:     "listed with a location config object -> held",
			body:     `{"tenant_shards":[["` + tenant + `",{"mode":"AttachedSingle","generation":7}]]}`,
			wantHeld: true,
		},
		{
			name:     "200 but not listed -> NOT held (the only honest absence)",
			body:     `{"tenant_shards":[["b111b111b111b111b111b111b111b111",null]]}`,
			wantHeld: false,
		},
		{
			name:     "200 with an empty list -> NOT held",
			body:     `{"tenant_shards":[]}`,
			wantHeld: false,
		},
		{
			name:      "non-2xx -> ERROR, never absent",
			status:    http.StatusInternalServerError,
			body:      `nope`,
			wantError: true,
		},
		{
			name:      "404 -> ERROR, never absent (an endpoint that is not there proves nothing about the tenant)",
			status:    http.StatusNotFound,
			body:      `{}`,
			wantError: true,
		},
		{
			name:      "unparseable body -> ERROR",
			body:      `{"tenant_shards":`,
			wantError: true,
		},
		{
			name:      "no tenant_shards field -> ERROR (unreadable, not empty)",
			body:      `{"other":1}`,
			wantError: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/location_config" {
					t.Errorf("the membership oracle must read the plane-wide /v1/location_config listing (the only one a Secondary appears in), got %s", r.URL.Path)
				}
				if tc.status != 0 {
					w.WriteHeader(tc.status)
				}
				_, _ = io.WriteString(w, tc.body)
			}))
			defer srv.Close()

			held, err := NewHTTPTenantMembershipViewer(srv.URL, 5*time.Second).HoldsTenant(context.Background(), tenant)
			if tc.wantError {
				if err == nil {
					t.Fatalf("want ERROR (unreadable is never absent), got held=%v err=nil", held)
				}
				if held {
					t.Fatal("an errored read must never report held=true")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if held != tc.wantHeld {
				t.Fatalf("held=%v, want %v", held, tc.wantHeld)
			}
		})
	}
}

// FIX 1 — the per-URL prober must decode the location CONFIG (entry[1]), not just the
// shard id, because "listed" and "warm Secondary" are NOT the same thing.
//
// `[["<T>",null]]`                              -> held as a SECONDARY (HA armed)
// `[["<T>",{"mode":"AttachedSingle",…}]]`       -> held ATTACHED (a stale ex-primary
//
//	location, NOT a warm standby)
//
// The second shape is exactly what an ex-primary whose PVC survived the failover
// reloads, at the OLD generation. A membership-only read reports it as warm.
func TestMembershipAtReportsHoldModeNotJustMembership(t *testing.T) {
	const tenant = "c000c000c000c000c000c000c000c000"
	cases := []struct {
		name                   string
		body                   string
		wantHeld, wantAttached bool
		wantError              bool
	}{
		{
			name:     "null location config -> held as a warm SECONDARY",
			body:     `{"tenant_shards":[["` + tenant + `",null]]}`,
			wantHeld: true,
		},
		{
			name:         "AttachedSingle config -> held, but ATTACHED (not warm)",
			body:         `{"tenant_shards":[["` + tenant + `",{"mode":"AttachedSingle","generation":7}]]}`,
			wantHeld:     true,
			wantAttached: true,
		},
		{
			name:         "AttachedMulti config -> held, ATTACHED",
			body:         `{"tenant_shards":[["` + tenant + `",{"mode":"AttachedMulti","generation":9}]]}`,
			wantHeld:     true,
			wantAttached: true,
		},
		{
			name:     "an explicit Secondary config object -> held, NOT attached",
			body:     `{"tenant_shards":[["` + tenant + `",{"mode":"Secondary","secondary_conf":{"warm":true}}]]}`,
			wantHeld: true,
		},
		{
			name: "not listed -> not held, not attached",
			body: `{"tenant_shards":[["b111b111b111b111b111b111b111b111",null]]}`,
		},
		{
			name:      "a matching entry with NO config element -> ERROR (the mode is unreadable, and unreadable is never 'warm')",
			body:      `{"tenant_shards":[["` + tenant + `"]]}`,
			wantError: true,
		},
		{
			name:      "a config that is neither null nor an object -> ERROR",
			body:      `{"tenant_shards":[["` + tenant + `",7]]}`,
			wantError: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/location_config" {
					t.Errorf("want the plane-wide /v1/location_config listing, got %s", r.URL.Path)
				}
				_, _ = io.WriteString(w, tc.body)
			}))
			defer srv.Close()

			held, attached, err := NewHTTPTenantMembershipAt(5*time.Second).HoldsTenantAt(context.Background(), srv.URL, tenant)
			if tc.wantError {
				if err == nil {
					t.Fatalf("want ERROR, got held=%v attached=%v err=nil", held, attached)
				}
				if held {
					t.Fatal("an errored read must never report held=true")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if held != tc.wantHeld {
				t.Fatalf("held=%v, want %v", held, tc.wantHeld)
			}
			if attached != tc.wantAttached {
				t.Fatalf("attached=%v, want %v — an ATTACHED hold reported as a Secondary is a FALSE 'HA armed' signal", attached, tc.wantAttached)
			}
		})
	}
}

// The failover pre-flight oracle keeps its MEMBERSHIP semantics: it asks "does the
// standby hold this tenant at all", Secondary or Attached. Mode-awareness is a
// reporting change in the warm loop, not a change to what aborts a failover.
func TestFailoverMembershipOracleStillCountsAnAttachedHoldAsHeld(t *testing.T) {
	const tenant = "d000d000d000d000d000d000d000d000"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"tenant_shards":[["`+tenant+`",{"mode":"AttachedSingle","generation":3}]]}`)
	}))
	defer srv.Close()

	held, err := NewHTTPTenantMembershipViewer(srv.URL, 5*time.Second).HoldsTenant(context.Background(), tenant)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !held {
		t.Fatal("the failover pre-flight asks about MEMBERSHIP in any location mode — narrowing it to Secondaries would abort failovers onto a legitimately attached standby")
	}
}

// A transport failure (nothing listening) is an ERROR, not an absence.
func TestMembershipOracleTransportFailureIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close() // nothing is listening now

	held, err := NewHTTPTenantMembershipViewer(url, 200*time.Millisecond).HoldsTenant(context.Background(), "f0f0")
	if err == nil {
		t.Fatalf("an unreachable standby must be an ERROR, got held=%v err=nil", held)
	}
	if held {
		t.Fatal("an unreachable standby must never report held=true")
	}
	if errors.Is(err, context.Canceled) {
		t.Fatal("unexpected cancellation")
	}
}
