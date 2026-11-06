//go:build unix

package testport

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"sync"
	"syscall"
	"testing"
)

// coldReservations holds ports reserved by Reserve until a driver claims them
// via Listen (keyed by "host:port").
var coldReservations sync.Map

// Reserve reserves a free localhost port WITHOUT a close->rebind window.
//
// The old helper listened on :0, closed the listener and handed back the number;
// the driver re-bound it later. In that gap another listener, or an ephemeral
// OUTBOUND source port drawn from the same range, could take the port, and the
// rebind failed with EADDRINUSE. Here the port stays owned by a BOUND but not
// LISTENING socket: a dial to it is refused (the compute looks asleep), other
// binders and the outbound autobind both skip it (no SO_REUSEADDR on the
// reservation, so a second bind conflicts), and Listen later calls
// listen() on this very socket, so the port never changes hands.
func Reserve(t *testing.T) (string, int) {
	t.Helper()
	syscall.ForkLock.RLock()
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM, 0)
	if err == nil {
		syscall.CloseOnExec(fd)
	}
	syscall.ForkLock.RUnlock()
	if err != nil {
		t.Fatalf("reserve port: socket: %v", err)
	}
	if err := syscall.Bind(fd, &syscall.SockaddrInet4{Addr: [4]byte{127, 0, 0, 1}}); err != nil {
		_ = syscall.Close(fd)
		t.Fatalf("reserve port: bind: %v", err)
	}
	sa, err := syscall.Getsockname(fd)
	if err != nil {
		_ = syscall.Close(fd)
		t.Fatalf("reserve port: getsockname: %v", err)
	}
	port := sa.(*syscall.SockaddrInet4).Port
	key := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	coldReservations.Store(key, fd)
	t.Cleanup(func() {
		// Only an UNCLAIMED reservation is still registered; a claimed one is now
		// owned by the listener returned from Listen.
		if v, ok := coldReservations.LoadAndDelete(key); ok {
			_ = syscall.Close(v.(int))
		}
	})
	return "127.0.0.1", port
}

// Listen binds host:port for a driver's Wake. If the port was reserved by
// Reserve it turns that socket into the listener (no rebind); otherwise it
// falls back to a plain net.Listen.
func Listen(host string, port int) (net.Listener, error) {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	v, ok := coldReservations.LoadAndDelete(addr)
	if !ok {
		return net.Listen("tcp", addr)
	}
	fd := v.(int)
	if err := syscall.SetNonblock(fd, true); err != nil {
		_ = syscall.Close(fd)
		return nil, fmt.Errorf("reserved port %s: set nonblock: %w", addr, err)
	}
	if err := syscall.Listen(fd, 128); err != nil {
		_ = syscall.Close(fd)
		return nil, fmt.Errorf("reserved port %s: listen: %w", addr, err)
	}
	f := os.NewFile(uintptr(fd), "reserved-"+addr)
	defer f.Close() // FileListener dups the descriptor; drop the original
	return net.FileListener(f)
}
