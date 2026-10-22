package main

import (
	"os"
	"strings"
	"testing"

	"github.com/alpheya/scale-zero-pg/gateway/internal/appdb"
)

var identityEnv = []string{
	"APPDB_COMPUTE_IMAGE", "APPDB_INIT_IMAGE",
	"APPDB_COMPUTE_UID", "APPDB_COMPUTE_GID", "APPDB_INIT_UID", "APPDB_INIT_GID",
}

func clearIdentityEnv(t *testing.T) {
	t.Helper()
	for _, k := range identityEnv {
		t.Setenv(k, "")
	}
}

// With nothing set, the image overrides and uids stay at the pinned defaults.
func TestApplyImageEnvDefaults(t *testing.T) {
	clearIdentityEnv(t)
	got := appdb.DefaultRenderConfig("ns")
	if err := applyImageEnv(&got); err != nil {
		t.Fatalf("applyImageEnv with no env: %v", err)
	}
	if want := appdb.DefaultRenderConfig("ns"); got != want {
		t.Fatalf("no env changed the config:\n got %+v\nwant %+v", got, want)
	}
}

// The images and the identity they run as are overridden together, each image
// with its own pair.
func TestApplyImageEnvOverrides(t *testing.T) {
	clearIdentityEnv(t)
	t.Setenv("APPDB_COMPUTE_IMAGE", "registry.example.com/pg@sha256:aa")
	t.Setenv("APPDB_INIT_IMAGE", "registry.example.com/init@sha256:bb")
	t.Setenv("APPDB_COMPUTE_UID", "26")
	t.Setenv("APPDB_COMPUTE_GID", "27")
	t.Setenv("APPDB_INIT_UID", "65532")
	t.Setenv("APPDB_INIT_GID", "65533")
	c := appdb.DefaultRenderConfig("ns")
	if err := applyImageEnv(&c); err != nil {
		t.Fatalf("applyImageEnv: %v", err)
	}
	if c.ComputeImage != "registry.example.com/pg@sha256:aa" || c.InitImage != "registry.example.com/init@sha256:bb" {
		t.Errorf("image overrides not applied: %q / %q", c.ComputeImage, c.InitImage)
	}
	if c.ComputeUID != 26 || c.ComputeGID != 27 || c.InitUID != 65532 || c.InitGID != 65533 {
		t.Errorf("identity overrides not applied: compute %d:%d init %d:%d", c.ComputeUID, c.ComputeGID, c.InitUID, c.InitGID)
	}
}

// A bad value fails at start-up and names the variable and the value: runAsNonRoot
// forbids uid 0 and a non-numeric id cannot be rendered.
func TestApplyImageEnvRejectsBadIdentity(t *testing.T) {
	for _, key := range []string{"APPDB_COMPUTE_UID", "APPDB_COMPUTE_GID", "APPDB_INIT_UID", "APPDB_INIT_GID"} {
		for _, bad := range []string{"0", "-1", "postgres", "1000x", "1.5", "99999999999999999999"} {
			clearIdentityEnv(t)
			t.Setenv(key, bad)
			c := appdb.DefaultRenderConfig("ns")
			err := applyImageEnv(&c)
			if err == nil {
				t.Errorf("%s=%q was accepted, want a start-up error", key, bad)
				continue
			}
			if !strings.Contains(err.Error(), key) || !strings.Contains(err.Error(), bad) {
				t.Errorf("%s=%q: error %q does not name the variable and the value", key, bad, err)
			}
		}
	}
}

// main() itself is not unit-testable, so scan it: the image overrides must flow
// through applyImageEnv (which also carries their uid/gid), never be read raw
// again, or an overridden image would silently run as the default uid.
func TestMainAppliesImageOverridesOnlyThroughApplyImageEnv(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	s := string(src)
	if n := strings.Count(s, "applyImageEnv(&render)"); n != 1 {
		t.Errorf("main() must call applyImageEnv(&render) exactly once, found %d", n)
	}
	for _, key := range []string{"APPDB_COMPUTE_IMAGE", "APPDB_INIT_IMAGE"} {
		if n := strings.Count(s, `"`+key+`"`); n != 1 {
			t.Errorf("%s must be read in exactly one place (applyImageEnv), found %d", key, n)
		}
	}
}

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
