package gateway

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/proto"
	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// notFoundScaler mimics the apps-gateway's ServiceAccount scaling a Deployment
// that does not exist: the k8s API returns exactly this error, whose text (object
// name + kind) is what leaked to clients before issue #92. It also records which
// deployments a wake actually tried to scale, so tests can prove authz let a pair
// through to the wake path (vs refusing it pre-wake).
type notFoundScaler struct {
	mu     sync.Mutex
	scaled []string
}

func (s *notFoundScaler) Scale(_ context.Context, _, dep string, _ int32) error {
	s.mu.Lock()
	s.scaled = append(s.scaled, dep)
	s.mu.Unlock()
	return fmt.Errorf("deployments.apps %q not found", dep)
}

func (s *notFoundScaler) scaledDeployments() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.scaled...)
}

// newAppsGatewayScaled builds a template-mode (apps-gateway) Gateway whose compute
// wake ALWAYS fails "not found" — the non-existent-app path — with the injected
// scaler, and points the target template at a refused port so TryConnect fails
// fast before the wake attempt.
func newAppsGatewayScaled(t *testing.T, scaler *notFoundScaler, floorMs string) (*Gateway, string) {
	t.Helper()
	env := wake.Env{
		"GW_COMPUTE_MODE":            "template",
		"GW_K8S_DEPLOYMENT_TEMPLATE": "compute-{system}",
		"GW_TARGET_TEMPLATE":         "127.0.0.1:1", // refused -> TryConnect fails fast
		"GW_CONNECT_TIMEOUT_MS":      "100",
		"GW_AUTH_FAIL_FLOOR_MS":      floorMs,
	}
	gw, err := New(env, func(string) {})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	d, err := wake.MakeDriverWithScaler(env, scaler)
	if err != nil {
		t.Fatalf("MakeDriverWithScaler: %v", err)
	}
	gw.driver = d
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	go gw.Serve(ln)
	return gw, ln.Addr().String()
}

// errorResponse dials the gateway, sends one StartupMessage, and returns the
// ErrorResponse ('E') packet the gateway wrote back.
func errorResponse(t *testing.T, addr, user, db string) []byte {
	t.Helper()
	pc := dialGateway(t, addr)
	defer pc.c.Close()
	pc.c.Write(proto.BuildStartup(map[string]string{"user": user, "database": db}))
	b := pc.waitFor(t, func(b []byte) bool {
		return bytes.IndexByte(b, 'E') >= 0 && len(b) > 6
	}, 5*time.Second)
	// Trim to the 'E' packet start (SSL 'N' etc. never precede it here).
	if i := bytes.IndexByte(b, 'E'); i > 0 {
		b = b[i:]
	}
	return b
}

// Issue #92: on the apps-gateway a wrong pair, a reserved name, and a
// syntactically-VALID pair for a NON-existent app must all return the
// byte-identical ErrorResponse — no "deployment not found", no internal k8s
// object name, no distinction between "app absent" and "wrong password". All
// three cases share the SAME user (app_ghost) so byte-equality is exact.
func TestAppsGatewayRefusalsAreByteIdentical(t *testing.T) {
	_, addr := newAppsGatewayScaled(t, &notFoundScaler{}, "10")

	wrongPair := errorResponse(t, addr, "app_ghost", "orders") // app_ghost != app_orders
	reserved := errorResponse(t, addr, "app_ghost", "tmpl")    // reserved system name
	unknownApp := errorResponse(t, addr, "app_ghost", "ghost") // valid pair, app does not exist

	if !bytes.Equal(wrongPair, unknownApp) {
		t.Fatalf("existence oracle: unknown-app response differs from wrong-pair\n wrong-pair=%q\n unknown-app=%q", wrongPair, unknownApp)
	}
	if !bytes.Equal(reserved, unknownApp) {
		t.Fatalf("existence oracle: reserved response differs from unknown-app\n reserved=%q\n unknown-app=%q", reserved, unknownApp)
	}

	// The wire bytes must be exactly the uniform 28P01 password failure and must
	// NOT contain any internal object name.
	want := proto.BuildErrorResponse(wake.AuthFailureCode, wake.UniformAuthFailure("app_ghost"))
	if !bytes.Equal(unknownApp, want) {
		t.Fatalf("refusal = %q, want uniform %q", unknownApp, want)
	}
	for _, leak := range []string{"compute-", "deployments.apps", "not found", "unavailable"} {
		if bytes.Contains(unknownApp, []byte(leak)) {
			t.Fatalf("refusal leaks internal detail %q: %q", leak, unknownApp)
		}
	}
	if proto.ErrorCode(unknownApp) != "28P01" {
		t.Fatalf("SQLSTATE = %q, want 28P01", proto.ErrorCode(unknownApp))
	}
}

// The constant-floor delay must apply to BOTH the pre-wake authz refusal and the
// non-existent-app wake failure, so the two gateway-side refusals are also
// timing-comparable (issue #92): an attacker cannot separate "reserved/wrong
// pair" (µs) from "valid pair, unknown app" (k8s round-trip) by latency.
func TestAppsGatewayRefusalsRespectTimingFloor(t *testing.T) {
	const floor = 200 * time.Millisecond
	_, addr := newAppsGatewayScaled(t, &notFoundScaler{}, "200")

	measure := func(user, db string) time.Duration {
		start := time.Now()
		errorResponse(t, addr, user, db)
		return time.Since(start)
	}
	if d := measure("app_ghost", "orders"); d < floor {
		t.Fatalf("authz refusal returned in %v, below the %v floor", d, floor)
	}
	if d := measure("app_ghost", "ghost"); d < floor {
		t.Fatalf("unknown-app refusal returned in %v, below the %v floor", d, floor)
	}
}
