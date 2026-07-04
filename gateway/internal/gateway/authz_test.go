package gateway

import (
	"net"
	"testing"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/proto"
	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// startupResult dials the gateway, sends a StartupMessage, and returns the
// SQLSTATE of the ErrorResponse (or "" if the first reply was not an error).
func startupResult(t *testing.T, gw *Gateway, user, db string) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go gw.Serve(ln)

	client, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	_, _ = client.Write(proto.BuildStartup(map[string]string{"user": user, "database": db}))

	_ = client.SetReadDeadline(time.Now().Add(3 * time.Second))
	buf := make([]byte, 256)
	n, _ := client.Read(buf)
	if n == 0 || buf[0] != 'E' {
		return ""
	}
	return proto.ErrorCode(buf[:n])
}

func newAppsGateway(t *testing.T) *Gateway {
	t.Helper()
	// GW_TARGET_TEMPLATE is unreachable on purpose: if authz let a startup
	// through, the wake path would surface a DIFFERENT code (57P03), never 28P01.
	gw, err := New(wake.Env{
		"GW_COMPUTE_MODE":            "template",
		"GW_K8S_DEPLOYMENT_TEMPLATE": "compute-{system}",
		"GW_TARGET_TEMPLATE":         "127.0.0.1:1",
		"GW_WAKE_TIMEOUT_MS":         "150",
		"GW_CONNECT_TIMEOUT_MS":      "50",
		"GW_RETRY_MS":                "50",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return gw
}

// Issue #74: the apps-gateway must REFUSE unauthorized (user,database) startups
// with a clean 28P01, BEFORE any wake. cloud_admin, cross-app, reserved system
// names, and malformed database names are the attacks the review found.
func TestAppsGatewayRefusesUnauthorizedStartups(t *testing.T) {
	cases := []struct{ name, user, db string }{
		{"cloud_admin cross-tenant", "cloud_admin", "mtb"},
		{"app_a reaching app_b", "app_mta", "mtb"},
		{"reserved template compute", "app_tmpl", "tmpl"},
		{"reserved warm compute", "app_warm", "warm"},
		{"reserved ro compute", "app_ro", "ro"},
		{"invalid charset (dot)", "app_bad", "bad.name"},
		{"invalid charset (upper)", "app_Bad", "Bad"},
		{"empty user", "", "orders"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if code := startupResult(t, newAppsGateway(t), tc.user, tc.db); code != "28P01" {
				t.Fatalf("(user=%q db=%q) SQLSTATE = %q, want 28P01 (refused pre-wake)", tc.user, tc.db, code)
			}
		})
	}
}

// A legitimate per-app pair (user app_<db>) must pass authorization and proceed
// to the wake path — so it must NOT get a 28P01 (it gets 57P03 from the
// unreachable target instead, which is fine — authz let it through).
func TestAppsGatewayAllowsMatchingAppPair(t *testing.T) {
	if code := startupResult(t, newAppsGateway(t), "app_orders", "orders"); code == "28P01" {
		t.Fatalf("matching app pair (app_orders/orders) was refused by authz; it must be allowed")
	}
}
