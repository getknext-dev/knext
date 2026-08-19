package appdb

import (
	"net/url"
	"strings"
	"testing"
)

// The platform-minted DSN host MUST be fully qualified. At the cluster default
// ndots:5 a short name like "pggw-apps.scale-zero-pg.svc" (3 dots) is resolved by
// walking the pod's search path first — several wasted UDP round-trips on exactly
// the first flows a fresh pod makes, which is where the EAI_AGAIN conntrack race
// bites (docs/benchmarks/cold-start-ledger.md, lever 1).
func TestDefaultGatewayHostIsFullyQualified(t *testing.T) {
	const want = "pggw-apps.scale-zero-pg.svc.cluster.local"
	if DefaultGatewayHost != want {
		t.Fatalf("DefaultGatewayHost = %q, want the fully-qualified %q — a short name walks the ndots:5 search path on every fresh-pod resolution", DefaultGatewayHost, want)
	}
	// The absolute (trailing-dot) form was deliberately rejected for client-compat
	// caution — see the const's comment. Guard it, so nobody "completes" the FQDN.
	if strings.HasSuffix(DefaultGatewayHost, ".") {
		t.Fatalf("DefaultGatewayHost = %q must NOT carry a trailing dot (client-compat caution)", DefaultGatewayHost)
	}
}

// End-to-end through the minting path: with the operator's default gateway host,
// the DATABASE_URL written into the per-app Secret carries the FQDN.
func TestMintedWriterDSNUsesFullyQualifiedHost(t *testing.T) {
	h := newHarness()
	h.d.GatewayHost = DefaultGatewayHost

	cr := &AppDatabase{Name: "shop", Generation: 1, Spec: AppDatabaseSpec{AppName: "shop"}}
	mustReconcile(t, h, cr)

	dsn := h.cl.writerDSN["shop"]
	if dsn == "" {
		t.Fatalf("no DATABASE_URL minted: %v", h.cl.writerDSN)
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse minted DSN %q: %v", dsn, err)
	}
	if got, want := u.Hostname(), "pggw-apps.scale-zero-pg.svc.cluster.local"; got != want {
		t.Fatalf("minted DATABASE_URL host = %q, want %q (DSN=%q)", got, want, dsn)
	}
}

// The RO key is derived from the writer DSN, so it inherits the FQDN host — assert
// it rather than assume it (the derivation rewrites only the port).
func TestDerivedROKeyKeepsFullyQualifiedHost(t *testing.T) {
	writer := "postgres://app_shop:pw@" + DefaultGatewayHost + ":55432/shop?sslmode=disable"
	got := roDSN(writer, 55432, 55434)
	u, err := url.Parse(got)
	if err != nil {
		t.Fatalf("parse %q: %v", got, err)
	}
	if u.Hostname() != DefaultGatewayHost {
		t.Fatalf("derived DATABASE_URL_RO host = %q, want %q", u.Hostname(), DefaultGatewayHost)
	}
}
