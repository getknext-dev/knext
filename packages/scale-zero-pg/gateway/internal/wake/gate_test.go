package wake

import (
	"io"
	"net"
	"testing"
	"time"
)

// dialGate attempts a TCP connect to the gate's current address.
func dialGate(t *testing.T, g *Gate) (net.Conn, error) {
	t.Helper()
	addr := g.Addr()
	if addr == nil {
		return nil, io.EOF
	}
	return net.DialTimeout("tcp", addr.String(), 500*time.Millisecond)
}

func TestGateOpenAcceptsThenCloseRefuses(t *testing.T) {
	g := NewGate("127.0.0.1:0")
	if g.IsOpen() {
		t.Fatal("new gate reports open")
	}
	if err := g.Open(); err != nil {
		t.Fatalf("Open: %v", err)
	}
	if !g.IsOpen() {
		t.Fatal("gate not open after Open")
	}
	// A waiter (the warm pod's /dev/tcp probe) connects: accept must succeed
	// and the gate must close it immediately (release-one-waiter, no bytes).
	c, err := dialGate(t, g)
	if err != nil {
		t.Fatalf("dial open gate: %v", err)
	}
	_ = c.SetReadDeadline(time.Now().Add(time.Second))
	buf := make([]byte, 1)
	if _, err := c.Read(buf); err != io.EOF {
		t.Fatalf("expected EOF from accept-then-close gate, got %v", err)
	}
	_ = c.Close()

	// Closing the gate takes the port to connection-refused.
	addrBefore := g.Addr().String()
	if err := g.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if g.IsOpen() {
		t.Fatal("gate open after Close")
	}
	if _, err := net.DialTimeout("tcp", addrBefore, 300*time.Millisecond); err == nil {
		t.Fatal("closed gate still accepts connections")
	}
}

func TestGateOpenIsIdempotent(t *testing.T) {
	g := NewGate("127.0.0.1:0")
	if err := g.Open(); err != nil {
		t.Fatalf("Open1: %v", err)
	}
	addr1 := g.Addr().String()
	if err := g.Open(); err != nil {
		t.Fatalf("Open2: %v", err)
	}
	if g.Addr().String() != addr1 {
		t.Fatalf("second Open rebound the listener (%s -> %s)", addr1, g.Addr().String())
	}
	_ = g.Close()
	// Double close must be safe too.
	if err := g.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

func TestGateReopenAfterClose(t *testing.T) {
	g := NewGate("127.0.0.1:0")
	if err := g.Open(); err != nil {
		t.Fatalf("Open: %v", err)
	}
	_ = g.Close()
	if err := g.Open(); err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if !g.IsOpen() {
		t.Fatal("gate not open after reopen")
	}
	if c, err := dialGate(t, g); err != nil {
		t.Fatalf("dial reopened gate: %v", err)
	} else {
		_ = c.Close()
	}
	_ = g.Close()
}

func TestGateOnStateFiresOnTransitions(t *testing.T) {
	g := NewGate("127.0.0.1:0")
	var states []bool
	g.SetOnState(func(open bool) { states = append(states, open) })
	if err := g.Open(); err != nil {
		t.Fatalf("Open: %v", err)
	}
	if err := g.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if len(states) != 2 || states[0] != true || states[1] != false {
		t.Fatalf("onState transitions = %v, want [true false]", states)
	}
}
