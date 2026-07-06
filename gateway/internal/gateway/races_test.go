package gateway

import (
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/proto"
	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// Sys-design review finding #3 (TOCTOU): a connection that arrives while the
// scale-down is already in flight must not leave the compute dead. The
// gateway must re-check its counts after Sleep completes and wake the compute
// back if a connection arrived mid-sleep.
func TestSleepRaceWakesBackWhenConnectionArrivesMidSleep(t *testing.T) {
	dir := t.TempDir()
	slept := filepath.Join(dir, "slept")
	woke := filepath.Join(dir, "woke")

	env := wake.Env{
		"GW_COMPUTE_MODE": "exec",
		"GW_TARGET":       "127.0.0.1:1",
		"GW_WAKE_CMD":     "touch " + woke,
		// slow sleep: the race window is the Sleep call itself
		"GW_SLEEP_CMD": "touch " + slept + " && sleep 0.4",
		"GW_IDLE_MS":   "60",
	}
	gw, err := New(env, nil)
	if err != nil {
		t.Fatal(err)
	}
	target := gw.Driver().Resolve("db")

	gw.connStarted(target, false)
	gw.connEnded(target, false) // arms the idle timer

	// wait until the sleep command has started
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(slept); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("sleep never started")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// a client arrives while Sleep is in flight
	gw.connStarted(target, false)

	// after Sleep completes, the gateway must notice and wake back
	deadline = time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(woke); err == nil {
			break // woke back — race healed
		}
		if time.Now().After(deadline) {
			t.Fatal("compute left scaled to zero under a live connection (TOCTOU)")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Sys-design review finding #14: a backend that accepts TCP and then drops the
// connection during the handshake (Terminating pod, restart) must be retried
// like a starting-up backend — the client must not get a dead pipe.
func TestHandshakeRetriesOnBackendEOF(t *testing.T) {
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
				buf := make([]byte, 1024)
				_, _ = c.Read(buf) // consume startup
				if atomic.AddInt32(&attempts, 1) <= 2 {
					_ = c.Close() // dying pod: EOF, no reply
					return
				}
				_, _ = c.Write([]byte{0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49})
				time.Sleep(200 * time.Millisecond)
				_ = c.Close()
			}(c)
		}
	}()

	gw, err := New(wake.Env{
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
	_, _ = client.Write(proto.BuildStartup(map[string]string{"user": "u", "database": "d"}))

	_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 32)
	n, err := client.Read(buf)
	if err != nil || n == 0 {
		t.Fatalf("client got no reply after backend EOFs (err=%v)", err)
	}
	if buf[0] != 0x52 {
		t.Fatalf("expected AuthenticationOk after EOF retries, got %q", buf[:n])
	}
	if a := atomic.LoadInt32(&attempts); a < 3 {
		t.Fatalf("backend saw %d attempts, want >=3", a)
	}
}
