package gateway

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/proto"
	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// fakeCompute is an in-process minimal Postgres server: it answers a
// StartupMessage with AuthenticationOk + ReadyForQuery, and echoes one row for a
// Query. It is started/stopped out-of-band to simulate cold start / scale-to-zero.
type fakeCompute struct {
	mu   sync.Mutex
	ln   net.Listener
	port int
}

func (fc *fakeCompute) start() error {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	if fc.ln != nil {
		return nil
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", fc.port))
	if err != nil {
		return err
	}
	fc.ln = ln
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go serveCompute(conn)
		}
	}()
	return nil
}

func (fc *fakeCompute) stop() {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	if fc.ln != nil {
		fc.ln.Close()
		fc.ln = nil
	}
}

func (fc *fakeCompute) running() bool {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	return fc.ln != nil
}

func serveCompute(conn net.Conn) {
	defer conn.Close()
	started := false
	buf := make([]byte, 4096)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			d := buf[:n]
			if !started {
				started = true // consumed StartupMessage
				conn.Write([]byte{0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49})
			} else if d[0] == 0x51 { // Query
				row := []byte("it-works")
				rd := append([]byte{0x44, 0, 0, 0, 0, 0, 1}, []byte{0, 0, 0, byte(len(row))}...)
				rd = append(rd, row...)
				binary.BigEndian.PutUint32(rd[1:5], uint32(len(rd)-1))
				cc := append([]byte{0x43, 0, 0, 0, 0}, []byte("SELECT 1\x00")...)
				binary.BigEndian.PutUint32(cc[1:5], uint32(len(cc)-1))
				out := append(append(rd, cc...), []byte{0x5a, 0, 0, 0, 5, 0x49}...)
				conn.Write(out)
			}
		}
		if err != nil {
			return
		}
	}
}

// pgConn accumulates bytes received from the gateway.
type pgConn struct {
	c   net.Conn
	mu  sync.Mutex
	buf []byte
}

func dialGateway(t *testing.T, addr string) *pgConn {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatalf("dial gateway: %v", err)
	}
	pc := &pgConn{c: c}
	go func() {
		b := make([]byte, 4096)
		for {
			n, err := c.Read(b)
			if n > 0 {
				pc.mu.Lock()
				pc.buf = append(pc.buf, b[:n]...)
				pc.mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	return pc
}

func (p *pgConn) received() []byte {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]byte{}, p.buf...)
}

func (p *pgConn) waitFor(t *testing.T, pred func([]byte) bool, timeout time.Duration) []byte {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		b := p.received()
		if pred(b) {
			return b
		}
		if time.Now().After(deadline) {
			t.Fatalf("timeout waiting for bytes (got %d)", len(b))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("freePort: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port
}

func TestE2EWakeOnConnectFullLoop(t *testing.T) {
	dir := t.TempDir()
	flag := filepath.Join(dir, "compute-on")
	fc := &fakeCompute{port: freePort(t)}
	defer fc.stop()

	// Poller: the exec wake/sleep commands only touch/rm the flag file; this
	// goroutine turns that into a ~150ms "cold start" of the fake compute.
	stopPoller := make(chan struct{})
	var starting int32
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stopPoller:
				return
			case <-ticker.C:
				want := fileExists(flag)
				if want && !fc.running() && atomic.CompareAndSwapInt32(&starting, 0, 1) {
					go func() {
						time.Sleep(150 * time.Millisecond)
						if fileExists(flag) {
							fc.start()
						}
						atomic.StoreInt32(&starting, 0)
					}()
				} else if !want && fc.running() && atomic.LoadInt32(&starting) == 0 {
					fc.stop()
				}
			}
		}
	}()
	defer close(stopPoller)

	env := wake.Env{
		"GW_COMPUTE_MODE":        "exec",
		"GW_TARGET":              fmt.Sprintf("127.0.0.1:%d", fc.port),
		"GW_WAKE_CMD":            "touch " + flag,
		"GW_SLEEP_CMD":           "rm -f " + flag,
		"GW_IDLE_MS":             "400",
		"GW_WAKE_TIMEOUT_MS":     "5000",
		"GW_CONNECT_TIMEOUT_MS":  "200",
		"GW_RETRY_MS":            "50",
	}
	gw, err := New(env, func(string) {})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go gw.Serve(ln)
	addr := ln.Addr().String()

	if fileExists(flag) {
		t.Fatalf("compute should start OFF")
	}

	// 1. SSL declined with 'N'
	c := dialGateway(t, addr)
	c.c.Write(proto.BuildSSLRequest())
	ssl := c.waitFor(t, func(b []byte) bool { return len(b) >= 1 }, 5*time.Second)
	if ssl[0] != 'N' {
		t.Fatalf("SSL reply = %q, want N", ssl[0])
	}

	// 2. Startup while compute down -> wake -> AuthenticationOk (R) + ReadyForQuery (Z)
	t0 := time.Now()
	c.c.Write(proto.BuildStartup(map[string]string{"user": "app", "database": "testdb"}))
	c.waitFor(t, func(b []byte) bool { return bytes.IndexByte(b, 0x52) >= 0 && bytes.IndexByte(b, 0x5a) >= 0 }, 5*time.Second)
	if !fileExists(flag) {
		t.Fatalf("wake cmd did not run")
	}
	if gw.Metrics().Wakes() != 1 {
		t.Fatalf("wakes_total = %d, want 1", gw.Metrics().Wakes())
	}
	t.Logf("cold connect woke compute in %dms", time.Since(t0).Milliseconds())

	// 3. Query flows through the pipe
	q := append([]byte{0x51, 0, 0, 0, 0}, []byte("SELECT 1\x00")...)
	binary.BigEndian.PutUint32(q[1:5], uint32(len(q)-1))
	before := len(c.received())
	c.c.Write(q)
	all := c.waitFor(t, func(b []byte) bool { return len(b) > before && bytes.Contains(b, []byte("it-works")) }, 5*time.Second)
	if !bytes.Contains(all, []byte("it-works")) {
		t.Fatalf("query row not piped back")
	}

	// 4. Second concurrent connection: no second wake
	c2 := dialGateway(t, addr)
	c2.c.Write(proto.BuildStartup(map[string]string{"user": "app", "database": "testdb"}))
	c2.waitFor(t, func(b []byte) bool { return bytes.IndexByte(b, 0x5a) >= 0 }, 5*time.Second)
	if gw.Metrics().Wakes() != 1 {
		t.Fatalf("warm connect must not wake: wakes_total = %d", gw.Metrics().Wakes())
	}
	if gw.Metrics().Active() != 2 {
		t.Fatalf("active_connections = %d, want 2", gw.Metrics().Active())
	}

	// 5. Disconnect both -> idle window -> compute scaled to zero
	c.c.Close()
	c2.c.Close()
	time.Sleep(1200 * time.Millisecond)
	if fileExists(flag) {
		t.Fatalf("sleep cmd did not run after idle")
	}
	if fc.running() {
		t.Fatalf("fake compute still running after idle")
	}
	if gw.Metrics().Sleeps() != 1 {
		t.Fatalf("sleeps_total = %d, want 1", gw.Metrics().Sleeps())
	}

	// 6. Reconnect wakes it again (full 0->1->0->1 loop)
	c3 := dialGateway(t, addr)
	c3.c.Write(proto.BuildStartup(map[string]string{"user": "app", "database": "testdb"}))
	c3.waitFor(t, func(b []byte) bool { return bytes.IndexByte(b, 0x5a) >= 0 }, 5*time.Second)
	if gw.Metrics().Wakes() != 2 {
		t.Fatalf("reconnect after zero: wakes_total = %d, want 2", gw.Metrics().Wakes())
	}
	c3.c.Close()
}
