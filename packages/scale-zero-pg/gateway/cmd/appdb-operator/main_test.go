package main

import (
	"testing"

	"github.com/alpheya/scale-zero-pg/gateway/internal/appdb"
)

// Half 1: with no APPDB_GATEWAY_HOST set, the operator mints DSNs against the
// ROOTED apps-gateway name (trailing dot) — the only form that skips the ndots:5
// search-path walk on a fresh pod's first resolutions; a 4-dot name without the dot
// still walks it (docs/benchmarks/cold-start-ledger.md, lever 1).
func TestGatewayHostDefaultIsRooted(t *testing.T) {
	t.Setenv("APPDB_GATEWAY_HOST", "") // env() treats "" as unset -> default

	got := gatewayHostFromEnv()
	if want := "pggw-apps.scale-zero-pg.svc.cluster.local."; got != want {
		t.Fatalf("gatewayHostFromEnv() with no env = %q, want %q", got, want)
	}
	if got != appdb.DefaultGatewayHost {
		t.Fatalf("the operator default (%q) drifted from appdb.DefaultGatewayHost (%q)", got, appdb.DefaultGatewayHost)
	}
}

// Half 2: an explicit APPDB_GATEWAY_HOST is passed through VERBATIM — a cluster
// with a custom DNS zone (or a different gateway Service) overrides the default and
// nothing rewrites, qualifies or auto-roots what the operator was given.
func TestGatewayHostEnvOverrideIsVerbatim(t *testing.T) {
	for _, want := range []string{
		"pggw-apps.scale-zero-pg.svc.mycorp.internal.", // custom cluster DNS zone, rooted
		"pggw-apps.scale-zero-pg.svc.mycorp.internal",  // same, NOT rooted — still verbatim
		"pggw-apps.other-ns.svc",                       // short name, deliberately
		"10.0.0.5",                                     // literal address
	} {
		t.Setenv("APPDB_GATEWAY_HOST", want)
		if got := gatewayHostFromEnv(); got != want {
			t.Errorf("APPDB_GATEWAY_HOST=%q -> gatewayHostFromEnv() = %q, want it verbatim", want, got)
		}
	}
}
