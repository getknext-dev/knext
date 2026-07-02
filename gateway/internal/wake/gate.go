package wake

import (
	"net"
	"sync"
)

// gateCtl is the warm-pool gate: an in-process TCP listener the gated warm
// compute pod polls before it boots compute_ctl. Open = accepting (a TCP
// connect succeeds => the pod proceeds to attach). Closed = not listening
// (connect refused => the pod stays parked). Behind an interface so the
// warmpool driver can be table-tested without binding a real socket.
type gateCtl interface {
	Open() error
	Close() error
	IsOpen() bool
	SetOnState(func(bool))
}

// Gate is a real gateCtl backed by a net.Listener. While open it runs an accept
// loop that closes every accepted connection immediately: each accept releases
// exactly one waiter (the warm pod's `/dev/tcp` probe) without exchanging bytes.
type Gate struct {
	addr string

	mu      sync.Mutex
	ln      net.Listener
	onState func(bool)
}

// NewGate builds a closed gate that will bind addr (e.g. ":9091") on Open.
func NewGate(addr string) *Gate { return &Gate{addr: addr} }

// Open binds the gate listener and starts releasing waiters. Idempotent: a
// second Open while already open is a no-op (keeps the same bound port).
func (g *Gate) Open() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.ln != nil {
		return nil
	}
	ln, err := net.Listen("tcp", g.addr)
	if err != nil {
		return err
	}
	g.ln = ln
	if g.onState != nil {
		g.onState(true)
	}
	go g.acceptLoop(ln)
	return nil
}

// acceptLoop closes every accepted connection immediately: a successful accept
// is the whole signal (the warm pod's `/dev/tcp` probe just needs the connect
// to succeed), so no bytes are exchanged. Returns when the listener is closed.
func (g *Gate) acceptLoop(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return // listener closed
		}
		_ = c.Close()
	}
}

// Close stops accepting (the port goes to connection-refused). Idempotent.
func (g *Gate) Close() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.ln == nil {
		return nil
	}
	err := g.ln.Close()
	g.ln = nil
	if g.onState != nil {
		g.onState(false)
	}
	return err
}

// IsOpen reports whether the gate is currently accepting.
func (g *Gate) IsOpen() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.ln != nil
}

// SetOnState registers a callback fired on every open/close transition (metrics).
func (g *Gate) SetOnState(fn func(bool)) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.onState = fn
}

// Addr returns the bound listener address, or nil while closed. Tests use this
// to discover the ephemeral port when the gate binds ":0".
func (g *Gate) Addr() net.Addr {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.ln == nil {
		return nil
	}
	return g.ln.Addr()
}
