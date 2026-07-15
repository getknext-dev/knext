package gateway

import (
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/proto"
)

// buildBackendError frames an ErrorResponse the way Postgres sends it.
func buildBackendError(code, msg string) []byte {
	return proto.BuildErrorResponse(code, msg)
}

// A freshly woken Postgres accepts TCP before it can serve sessions: the
// handshake gets FATAL 57P03 "the database system is starting up". The
// gateway must absorb those and retry until the backend truly answers —
// the client must NEVER see the 57P03.
func TestWakeRetriesWhileDatabaseStartingUp(t *testing.T) {
	var attempts int32
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
				defer c.Close()
				buf := make([]byte, 1024)
				if _, err := c.Read(buf); err != nil { // consume startup
					return
				}
				if atomic.AddInt32(&attempts, 1) <= 2 {
					// still in crash recovery: fatal + close, like real PG
					c.Write(buildBackendError("57P03", "the database system is starting up"))
					return
				}
				// ready: AuthenticationOk + ReadyForQuery
				c.Write([]byte{0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49})
				time.Sleep(200 * time.Millisecond)
			}(c)
		}
	}()

	gw, err := New(map[string]string{
		"GW_COMPUTE_MODE":       "static",
		"GW_TARGET":             backend.Addr().String(),
		"GW_CONNECT_TIMEOUT_MS": "200",
		"GW_WAKE_TIMEOUT_MS":    "5000",
		"GW_RETRY_MS":           "50",
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

	client, err := net.Dial("tcp", front.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := client.Write(proto.BuildStartup(map[string]string{"user": "u", "database": "d"})); err != nil {
		t.Fatal(err)
	}

	client.SetReadDeadline(time.Now().Add(5 * time.Second))
	got := make([]byte, 0, 64)
	buf := make([]byte, 64)
	for len(got) < 15 {
		n, err := client.Read(buf)
		if n > 0 {
			got = append(got, buf[:n]...)
		}
		if err != nil {
			break
		}
	}

	if len(got) == 0 {
		t.Fatal("client got nothing")
	}
	if got[0] == 'E' || strings.Contains(string(got), "57P03") || strings.Contains(string(got), "starting up") {
		t.Fatalf("client saw the starting-up FATAL instead of a retried handshake: %q", got)
	}
	if got[0] != 0x52 { // AuthenticationOk
		t.Fatalf("expected AuthenticationOk after retries, got %q", got)
	}
	if n := atomic.LoadInt32(&attempts); n < 3 {
		t.Fatalf("backend saw %d attempts, want >=3 (two 57P03 + one success)", n)
	}
}
