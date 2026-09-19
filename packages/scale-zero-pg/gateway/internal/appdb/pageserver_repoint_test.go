package appdb

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// flipProxy is a tiny stable-address TCP front for two interchangeable backends.
// It models a Kubernetes Service whose selector is re-pointed on a pswatcher
// failover: the front address (the Service ClusterIP/DNS) never changes, but the
// pod behind it does. Each ACCEPTED front connection is wired, at accept time, to
// whichever upstream is current — so a long-lived keep-alive front connection stays
// pinned to the upstream it was born with, exactly as the operator's pooled TCP
// connection stayed pinned to the demoted pageserver pod (confirmed live 2026-09-19).
type flipProxy struct {
	ln       net.Listener
	mu       sync.Mutex
	upstream string
	conns    int32 // number of front connections accepted
}

func newFlipProxy(t *testing.T, upstream string) *flipProxy {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	p := &flipProxy{ln: ln, upstream: upstream}
	go p.serve()
	t.Cleanup(func() { _ = ln.Close() })
	return p
}

func (p *flipProxy) addr() string { return p.ln.Addr().String() }

func (p *flipProxy) setUpstream(addr string) {
	p.mu.Lock()
	p.upstream = addr
	p.mu.Unlock()
}

func (p *flipProxy) serve() {
	for {
		c, err := p.ln.Accept()
		if err != nil {
			return
		}
		atomic.AddInt32(&p.conns, 1)
		go p.handle(c)
	}
}

func (p *flipProxy) handle(front net.Conn) {
	p.mu.Lock()
	up := p.upstream
	p.mu.Unlock()
	back, err := net.Dial("tcp", up)
	if err != nil {
		_ = front.Close()
		return
	}
	go func() { _, _ = io.Copy(back, front); _ = back.Close() }()
	_, _ = io.Copy(front, back)
	_ = front.Close()
}

// timelineListServer returns a pageserver /v1/tenant/<t>/timeline listing that either
// contains tl or does not — the two distinguishable backend identities.
func timelineListServer(t *testing.T, hasTL bool, tl string) *httptest.Server {
	t.Helper()
	body := "[]"
	if hasTL {
		body = `[{"timeline_id":"` + tl + `"}]`
	}
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(s.Close)
	return s
}

// TestPageserverClientPicksUpServiceRepoint proves the operator's long-lived
// pageserver client is NOT pinned to a stale backend across a Service re-point:
// after the front is flipped from backend A (tl absent) to backend B (tl present),
// the SAME client must observe the new backend within a bounded time and WITHOUT
// being reconstructed. With Go's default keep-alive transport the pooled connection
// stays wired to A and this never converges — the #1096 bug.
func TestPageserverClientPicksUpServiceRepoint(t *testing.T) {
	const tl = "tl-abc"
	backendA := timelineListServer(t, false, tl) // tl absent
	backendB := timelineListServer(t, true, tl)  // tl present

	proxy := newFlipProxy(t, backendA.Listener.Addr().String())
	ps := NewHTTPPageserver("http://"+proxy.addr(), 2*time.Second)
	ctx := context.Background()

	// Before the re-point: the client sees backend A (tl absent).
	ok, err := ps.TimelineExists(ctx, "tenant", tl)
	if err != nil {
		t.Fatalf("pre-flip TimelineExists: %v", err)
	}
	if ok {
		t.Fatalf("pre-flip: expected tl absent on backend A")
	}

	// Re-point the Service to backend B (same client, no reconstruction).
	proxy.setUpstream(backendB.Listener.Addr().String())

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		ok, err = ps.TimelineExists(ctx, "tenant", tl)
		if err != nil {
			t.Fatalf("post-flip TimelineExists: %v", err)
		}
		if ok {
			return // converged onto the new backend without a restart
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("client stayed pinned to the demoted backend after Service re-point (stale-conn pinning, #1096)")
}

// TestPageserverClientOpensFreshConnPerRequest pins the chosen transport config:
// keep-alives are disabled, so every request opens a fresh front connection. This
// is what guarantees a Service re-point is picked up promptly. With the default
// transport the operator reuses a single pooled connection (conns == 1) and this
// assertion goes red — the mutation-proof for the fix.
func TestPageserverClientOpensFreshConnPerRequest(t *testing.T) {
	const tl = "tl-xyz"
	backend := timelineListServer(t, false, tl)
	proxy := newFlipProxy(t, backend.Listener.Addr().String())
	ps := NewHTTPPageserver("http://"+proxy.addr(), 2*time.Second)
	ctx := context.Background()

	const n = 3
	for i := 0; i < n; i++ {
		if _, err := ps.TimelineExists(ctx, "tenant", tl); err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
	}
	if got := atomic.LoadInt32(&proxy.conns); got != n {
		t.Fatalf("expected %d fresh front connections (no keep-alive reuse), got %d", n, got)
	}
}
