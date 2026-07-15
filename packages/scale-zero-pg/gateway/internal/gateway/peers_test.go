package gateway

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

// The peer scrape must read the PER-APP active count from per_system, not the
// fleet-global active_connections scalar (issue #75). A peer busy with app "b"
// must report 0 for app "a".
func TestScrapeReadsPerSystemActiveNotGlobalScalar(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// active_connections (global) = 5, but per-app: a=0, b=5.
		_, _ = w.Write([]byte(`{"active_connections":5,"per_system":{"a":{"active":0},"b":{"active":5}}}`))
	}))
	defer srv.Close()

	host, portStr, _ := net.SplitHostPort(srv.Listener.Addr().String())
	port, _ := strconv.Atoi(portStr)
	p := &k8sPeers{metricsPort: port, http: &http.Client{Timeout: 2 * time.Second}}

	ctx := context.Background()
	if n, err := p.scrape(ctx, host, "a"); err != nil || n != 0 {
		t.Fatalf("scrape(a) = %d,%v; want 0 (idle app must not see the busy neighbour's count)", n, err)
	}
	if n, err := p.scrape(ctx, host, "b"); err != nil || n != 5 {
		t.Fatalf("scrape(b) = %d,%v; want 5", n, err)
	}
	if n, err := p.scrape(ctx, host, "absent"); err != nil || n != 0 {
		t.Fatalf("scrape(absent) = %d,%v; want 0 (no key -> 0, not error)", n, err)
	}
}
