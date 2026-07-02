// Package gateway is the wake-on-connect Postgres proxy server.
//
// Accept -> decline SSL/GSS -> parse StartupMessage -> resolve compute from the
// database name -> wake it if asleep -> replay startup bytes -> pipe. After the
// handshake the gateway is a dumb byte pipe: auth and queries flow through
// untouched. When the last connection for a compute closes and stays closed for
// GW_IDLE_MS, the compute is scaled back to zero (modes that can).
package gateway

import (
	"context"
	"io"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/metrics"
	"github.com/alpheya/scale-zero-pg/gateway/internal/proto"
	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

const handshakeTimeout = 30 * time.Second

// activeEntry tracks live connections + a pending sleep timer per compute key.
type activeEntry struct {
	count  int
	timer  *time.Timer
	target wake.Target
}

// PeerChecker reports the fleet-wide active connection count across all
// gateway replicas (excluding this one). Nil means single-replica: no check.
type PeerChecker interface {
	ActiveConnections(ctx context.Context) (int, error)
}

// Gateway accepts client connections, wakes compute, and pipes bytes.
type Gateway struct {
	driver  wake.Driver
	metrics *metrics.Metrics
	opts    wake.Opts
	idleMs  int
	log     func(string)

	// Peers guards the idle decision when running 2+ replicas: sleep only
	// when the whole fleet is at zero, not just this pod. Fail-safe: any
	// peer error postpones sleep rather than risking a live connection.
	Peers PeerChecker

	mu     sync.Mutex
	active map[string]*activeEntry
	closed bool
}

// New builds a Gateway from injected env config.
func New(env wake.Env, log func(string)) (*Gateway, error) {
	driver, err := wake.MakeDriver(env)
	if err != nil {
		return nil, err
	}
	if log == nil {
		log = func(string) {}
	}
	return &Gateway{
		driver:  driver,
		metrics: metrics.NewMetrics(),
		opts: wake.Opts{
			ConnectTimeoutMs: envInt(env, "GW_CONNECT_TIMEOUT_MS", 1000),
			WakeTimeoutMs:    envInt(env, "GW_WAKE_TIMEOUT_MS", 60000),
			RetryMs:          envInt(env, "GW_RETRY_MS", 250),
		},
		idleMs: envInt(env, "GW_IDLE_MS", 300000),
		log:    log,
		active: map[string]*activeEntry{},
	}, nil
}

func envInt(env wake.Env, key string, def int) int {
	if v, ok := env[key]; ok && v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// Metrics returns the metrics registry.
func (g *Gateway) Metrics() *metrics.Metrics { return g.metrics }

// Driver returns the compute driver.
func (g *Gateway) Driver() wake.Driver { return g.driver }

// Serve runs the accept loop until ln is closed.
func (g *Gateway) Serve(ln net.Listener) {
	for {
		client, err := ln.Accept()
		if err != nil {
			return
		}
		go g.handle(client)
	}
}

// Close marks the gateway closed (idle timers stop scheduling new sleeps).
func (g *Gateway) Close() error {
	g.mu.Lock()
	g.closed = true
	for _, e := range g.active {
		if e.timer != nil {
			e.timer.Stop()
			e.timer = nil
		}
	}
	g.mu.Unlock()
	return nil
}

// handle reads the initial packet(s), declines SSL/GSS, then proxies a startup.
func (g *Gateway) handle(client net.Conn) {
	if tcp, ok := client.(*net.TCPConn); ok {
		_ = tcp.SetNoDelay(true)
	}
	var buf []byte
	readBuf := make([]byte, 4096)

	for {
		// Process whatever complete packets we already have.
		for {
			packet, rest, ok, err := proto.ReadInitialPacket(buf)
			if err != nil {
				g.fail(client, "08P01", err.Error())
				return
			}
			if !ok {
				break // need more bytes
			}
			msg, err := proto.ParseInitialPacket(packet)
			if err != nil {
				g.fail(client, "08P01", err.Error())
				return
			}
			switch msg.Type {
			case proto.TypeSSL, proto.TypeGSSEnc:
				buf = append([]byte(nil), rest...) // keep whatever followed
				if _, err := client.Write([]byte("N")); err != nil {
					_ = client.Close()
					return
				}
				continue // client now sends the real StartupMessage
			case proto.TypeCancel:
				_ = client.Close()
				return
			case proto.TypeStartup:
				systemID := msg.Params["database"]
				if systemID == "" {
					systemID = "postgres"
				}
				target := g.driver.Resolve(systemID)
				startup := append([]byte(nil), packet...)
				pending := append([]byte(nil), rest...)
				_ = client.SetReadDeadline(time.Time{})
				g.proxy(client, startup, pending, target, msg.Params)
				return
			}
		}

		_ = client.SetReadDeadline(time.Now().Add(handshakeTimeout))
		n, err := client.Read(readBuf)
		if n > 0 {
			buf = append(buf, readBuf[:n]...)
		}
		if err != nil {
			_ = client.Close()
			return
		}
	}
}

func (g *Gateway) fail(client net.Conn, code, message string) {
	g.log("[gw] startup error: " + message)
	_, _ = client.Write(proto.BuildErrorResponse(code, message))
	_ = client.Close()
}

// proxy wakes the compute, replays the startup packet, then pipes both ways.
func (g *Gateway) proxy(client net.Conn, startupPacket, pendingRest []byte, target wake.Target, params map[string]string) {
	g.connStarted(target)
	g.metrics.ConnOpen(target.Key)

	conn, woke, wakeMs, err := wake.ConnectWithWake(context.Background(), g.driver, target, g.opts, func() {
		g.log("[gw] " + target.Key + ": compute asleep, waking (db=" + params["database"] + " user=" + params["user"] + ")")
	})
	if err != nil {
		g.metrics.WakeFailure()
		g.metrics.ConnClose(target.Key)
		g.connEnded(target)
		g.log("[gw] " + target.Key + ": " + err.Error())
		_, _ = client.Write(proto.BuildErrorResponse("57P03", "compute unavailable: "+err.Error()))
		_ = client.Close()
		return
	}
	if woke {
		g.metrics.Wake(target.Key, wakeMs)
		g.log("[gw] " + target.Key + ": awake in " + strconv.FormatInt(wakeMs, 10) + "ms")
	}

	if tcp, ok := conn.(*net.TCPConn); ok {
		_ = tcp.SetNoDelay(true)
	}
	if _, err := conn.Write(startupPacket); err != nil {
		g.metrics.ConnClose(target.Key)
		g.connEnded(target)
		_ = client.Close()
		_ = conn.Close()
		return
	}
	if len(pendingRest) > 0 {
		_, _ = conn.Write(pendingRest)
	}

	var once sync.Once
	cleanup := func() {
		once.Do(func() {
			g.metrics.ConnClose(target.Key)
			g.connEnded(target)
			_ = client.Close()
			_ = conn.Close()
		})
	}
	go func() { _, _ = io.Copy(conn, client); cleanup() }()
	go func() { _, _ = io.Copy(client, conn); cleanup() }()
}

// connStarted increments the active count and cancels any pending sleep.
func (g *Gateway) connStarted(target wake.Target) {
	g.mu.Lock()
	defer g.mu.Unlock()
	e := g.active[target.Key]
	if e == nil {
		e = &activeEntry{target: target}
		g.active[target.Key] = e
	}
	e.count++
	if e.timer != nil {
		e.timer.Stop()
		e.timer = nil
	}
}

// connEnded decrements the active count and, if it hits zero, schedules a sleep.
func (g *Gateway) connEnded(target wake.Target) {
	g.mu.Lock()
	defer g.mu.Unlock()
	e := g.active[target.Key]
	if e == nil {
		return
	}
	e.count--
	if e.count <= 0 && g.driver.CanSleep() && g.idleMs > 0 && !g.closed {
		g.scheduleSleep(e, target)
	}
}

// scheduleSleep arms the idle timer. Caller must hold g.mu. When the timer
// fires, sleep proceeds only if this pod still has zero connections AND the
// peer fleet reports zero; otherwise the timer re-arms for another window.
func (g *Gateway) scheduleSleep(e *activeEntry, target wake.Target) {
	e.timer = time.AfterFunc(time.Duration(g.idleMs)*time.Millisecond, func() {
		g.mu.Lock()
		if e.count > 0 || g.closed {
			g.mu.Unlock()
			return
		}
		g.mu.Unlock()

		if g.Peers != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			n, err := g.Peers.ActiveConnections(ctx)
			cancel()
			if err != nil || n > 0 {
				if err != nil {
					g.log("[gw] " + target.Key + ": peer check failed (" + err.Error() + "), postponing sleep")
				} else {
					g.log("[gw] " + target.Key + ": " + strconv.Itoa(n) + " active connection(s) on peer gateways, postponing sleep")
				}
				g.mu.Lock()
				if e.count == 0 && !g.closed {
					g.scheduleSleep(e, target) // try again next window
				}
				g.mu.Unlock()
				return
			}
		}

		if err := g.driver.Sleep(context.Background(), target); err != nil {
			g.log("[gw] " + target.Key + ": sleep failed: " + err.Error())
			return
		}
		g.metrics.Sleep()
		g.log("[gw] " + target.Key + ": idle " + strconv.Itoa(g.idleMs) + "ms -> scaled to zero")
	})
}
