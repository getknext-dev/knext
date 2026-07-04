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
// to the wake path. Since issue #92, a wake FAILURE now also returns the uniform
// 28P01 (so a non-existent app is indistinguishable from a wrong password), so
// SQLSTATE alone can no longer prove authz let the pair through. Instead we prove
// it by observing that a wake was ATTEMPTED (the scaler was asked to scale
// compute-orders) — a refused pair never reaches the scaler.
func TestAppsGatewayAllowsMatchingAppPair(t *testing.T) {
	scaler := &notFoundScaler{}
	_, addr := newAppsGatewayScaled(t, scaler, "10")

	// Refused pair: authz rejects pre-wake, so the scaler is never called.
	errorResponse(t, addr, "cloud_admin", "orders")
	if got := scaler.scaledDeployments(); len(got) != 0 {
		t.Fatalf("refused pair reached the wake path (scaled %v); must be refused pre-wake", got)
	}

	// Matching pair: authz allows it, so the wake path scales compute-orders.
	errorResponse(t, addr, "app_orders", "orders")
	found := false
	for _, d := range scaler.scaledDeployments() {
		if d == "compute-orders" {
			found = true
		}
	}
	if !found {
		t.Fatalf("matching pair (app_orders/orders) did not reach the wake path; scaled=%v", scaler.scaledDeployments())
	}
}
