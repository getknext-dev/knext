package gateway

import (
	"net"
	"testing"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/proto"
	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// DevOps review: goroutine-per-connection with no ceiling can OOM the 128Mi
// gateway under a connection storm. With GW_MAX_CONNS set, the N+1th
// concurrent connection must get a clean 53300 ErrorResponse (and count in
// the rejected metric), and a slot must free up when a connection closes.
func TestMaxConnsRejectsExcessWithBackpressure(t *testing.T) {
	// backend that completes the handshake and then holds the connection open
	backend, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	go func() {
		for {
			c, err := backend.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				buf := make([]byte, 1024)
				_, _ = c.Read(buf) // startup
				_, _ = c.Write([]byte{0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49})
				_, _ = c.Read(buf) // hold until client closes
				_ = c.Close()
			}(c)
		}
	}()

	gw, err := New(wake.Env{
		"GW_COMPUTE_MODE": "static",
		"GW_TARGET":       backend.Addr().String(),
		"GW_MAX_CONNS":    "2",
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	front, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer front.Close()
	go gw.Serve(front)

	dial := func() net.Conn {
		c, err := net.Dial("tcp", front.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		_, _ = c.Write(proto.BuildStartup(map[string]string{"user": "u", "database": "d"}))
		return c
	}
	readSome := func(c net.Conn) []byte {
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		buf := make([]byte, 256)
		n, _ := c.Read(buf)
		return buf[:n]
	}

	c1, c2 := dial(), dial()
	defer c1.Close()
	if b := readSome(c1); len(b) == 0 || b[0] != 0x52 {
		t.Fatalf("conn1 did not complete handshake: %q", b)
	}
	if b := readSome(c2); len(b) == 0 || b[0] != 0x52 {
		t.Fatalf("conn2 did not complete handshake: %q", b)
	}

	// 3rd concurrent connection: clean 53300, not a hang or crash
	c3 := dial()
	b := readSome(c3)
	if len(b) == 0 || b[0] != 'E' {
		t.Fatalf("conn3 expected ErrorResponse, got %q", b)
	}
	if proto.ErrorCode(b) != "53300" {
		t.Fatalf("conn3 expected SQLSTATE 53300, got %q (%q)", proto.ErrorCode(b), b)
	}
	c3.Close()
	if got := gw.Metrics().Rejected(); got != 1 {
		t.Fatalf("rejected_connections_total = %d, want 1", got)
	}

	// free a slot; a new connection must succeed
	c2.Close()
	time.Sleep(100 * time.Millisecond)
	c4 := dial()
	defer c4.Close()
	if b := readSome(c4); len(b) == 0 || b[0] != 0x52 {
		t.Fatalf("conn4 should get the freed slot, got %q", b)
	}
}
