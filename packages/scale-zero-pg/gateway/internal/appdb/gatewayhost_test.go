package appdb

import (
	"net/url"
	"strings"
	"testing"

	"github.com/lib/pq"
)

// The rooted (absolute) name every platform-minted DSN must carry.
const wantGatewayHost = "pggw-apps.scale-zero-pg.svc.cluster.local."

// The minted DSN host MUST be ROOTED, not merely qualified. At the cluster default
// ndots:5 a 4-dot name ("...svc.cluster.local") is still resolved by walking the
// whole 3-entry search path first — qualifying without the trailing dot makes each
// wasted attempt longer while eliminating none of them. Only the trailing dot makes
// the resolver skip the search path (docs/benchmarks/cold-start-ledger.md, lever 1).
func TestDefaultGatewayHostIsRooted(t *testing.T) {
	if DefaultGatewayHost != wantGatewayHost {
		t.Fatalf("DefaultGatewayHost = %q, want the rooted %q", DefaultGatewayHost, wantGatewayHost)
	}
	// The trailing dot IS the invariant. Deliberately NOT asserting a minimum dot
	// count: a rooted SHORT name ("pggw-apps.scale-zero-pg.svc.") is absolute and
	// perfectly correct, so a dot-count floor would encode the wrong model.
	if !strings.HasSuffix(DefaultGatewayHost, ".") {
		t.Fatalf("DefaultGatewayHost = %q has NO trailing dot — at ndots:5 it still walks the full search path, which is the entire cost this is meant to remove", DefaultGatewayHost)
	}
}

// End-to-end through the minting path: with the operator's default gateway host,
// the DATABASE_URL written into the per-app Secret carries the rooted name.
func TestMintedWriterDSNUsesRootedHost(t *testing.T) {
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
	if got := u.Hostname(); got != wantGatewayHost {
		t.Fatalf("minted DATABASE_URL host = %q, want %q (DSN=%q)", got, wantGatewayHost, dsn)
	}
}

// The RO key is derived from the writer DSN, so it must inherit the rooted host —
// assert it rather than assume it (the derivation rewrites only the port).
func TestDerivedROKeyKeepsRootedHost(t *testing.T) {
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

// Consumer compat, half 1 of 3 (the half runnable in this module): the operator's
// OWN warm-hold dial goes through lib/pq. Prove lib/pq's DSN parsing carries the
// rooted host byte-for-byte into the conninfo it dials — if it stripped or mangled
// the trailing dot, the rooted form would be a silent no-op for this consumer.
// (node-postgres and ioredis read DATABASE_URL verbatim and hand the host to
// getaddrinfo; that half is proved by the OKE run, not here.)
func TestLibPQPreservesRootedHost(t *testing.T) {
	dsn := "postgres://app_shop:pw@" + DefaultGatewayHost + ":55432/shop?sslmode=disable"

	conninfo, err := pq.ParseURL(dsn)
	if err != nil {
		t.Fatalf("lib/pq rejected a rooted-host DSN %q: %v", dsn, err)
	}
	// lib/pq emits single-quoted keyword/value pairs, so match its actual form —
	// what is being asserted is that the ROOT LABEL survives, not the quoting.
	if !strings.Contains(conninfo, "host='"+wantGatewayHost+"'") {
		t.Fatalf("lib/pq conninfo = %q, want it to carry host='%s' verbatim (trailing dot intact)", conninfo, wantGatewayHost)
	}
}

// The warm-hold dialer appends connect_timeout to the Secret's DSN before handing
// it to lib/pq; that string surgery must not disturb the rooted host either.
func TestWarmHoldDSNRewriteKeepsRootedHost(t *testing.T) {
	dsn := "postgres://app_shop:pw@" + DefaultGatewayHost + ":55432/shop?sslmode=disable"

	got := SQLDialer{}.dsnWithTimeout(dsn)
	if !strings.Contains(got, "@"+wantGatewayHost+":55432/") {
		t.Fatalf("dsnWithTimeout(%q) = %q — the rooted host did not survive", dsn, got)
	}
	if _, err := pq.ParseURL(got); err != nil {
		t.Fatalf("lib/pq rejected the warm-hold DSN %q: %v", got, err)
	}
}
