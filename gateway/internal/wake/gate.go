package wake

import (
	"errors"
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

var errGateStub = errors.New("gate: not implemented")

// Open binds the gate listener and starts releasing waiters. Idempotent.
func (g *Gate) Open() error { return errGateStub }

// Close stops accepting (the port goes to connection-refused). Idempotent.
func (g *Gate) Close() error { return errGateStub }

// IsOpen reports whether the gate is currently accepting.
func (g *Gate) IsOpen() bool { return false }

// SetOnState registers a callback fired on every open/close transition (metrics).
func (g *Gate) SetOnState(fn func(bool)) {}

// Addr returns the bound listener address, or nil while closed. Tests use this
// to discover the ephemeral port when the gate binds ":0".
func (g *Gate) Addr() net.Addr { return nil }
