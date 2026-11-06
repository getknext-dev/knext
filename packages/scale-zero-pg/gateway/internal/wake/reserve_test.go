package wake

import (
	"net"
	"testing"

	"github.com/alpheya/scale-zero-pg/gateway/internal/testport"
)

// reservePort and listenReserved delegate to testport (shared with the gateway
// package's tests): a reserved port is held by a bound-not-listening socket until
// claimed, so there is no close->rebind window (#2689, #2690).
func reservePort(t *testing.T) (string, int) {
	t.Helper()
	return testport.Reserve(t)
}

func listenReserved(host string, port int) (net.Listener, error) {
	return testport.Listen(host, port)
}
