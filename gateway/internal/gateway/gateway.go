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
	"crypto/tls"
	"errors"
	"fmt"
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
// replCount is the subset of count that are REPLICATION (walreceiver) streams:
// an active replication connection means a subscriber is draining this compute as
// a publisher, so it must stay awake (ADR-0007 §4c). replCount <= count always;
// it is tracked separately so the "don't sleep while replicating" invariant is
// explicit and independently observable, not an emergent side effect of count.
type activeEntry struct {
	count     int
	replCount int
	timer     *time.Timer
	target    wake.Target
}

// PeerChecker reports the active connection count for a specific compute key
// across all gateway replicas (excluding this one). Keyed PER-APP so one busy
// app does not pin an unrelated idle app awake (issue #75). Nil means
// single-replica: no check.
type PeerChecker interface {
	ActiveConnections(ctx context.Context, key string) (int, error)
}

// systemAuthorizer is implemented by drivers (apps-gateway / template mode) that
// gate which (user, database) pairs may route+wake. The gateway calls Authorize
// BEFORE waking anything; a non-nil error is turned into a clean auth failure and
// the compute is never touched. Drivers that don't implement it (the primary
// single-DB pggw) accept every startup — their path is unchanged (issue #74).
type systemAuthorizer interface {
	Authorize(user, database string) error
}

// replicationAuthorizer is implemented by drivers that additionally gate
// REPLICATION (walreceiver) startups — the apps-gateway (template mode) via the
// per-zone repl_<zone> role (ADR-0007 §4c). A driver that gates ordinary traffic
// (systemAuthorizer) but does NOT implement this refuses replication rather than
// letting a walreceiver through unauthorized (see authorizeStartup). Drivers with
// no authorizer at all (single-DB pggw) accept both paths, unchanged (issue #74).
type replicationAuthorizer interface {
	AuthorizeReplication(user, database string) error
}

// Gateway accepts client connections, wakes compute, and pipes bytes.
type Gateway struct {
	driver  wake.Driver
	metrics *metrics.Metrics
	opts    wake.Opts
	idleMs  int
	floorMs int           // GW_AUTH_FAIL_FLOOR_MS: constant-floor delay on refusals
	connSem chan struct{} // nil = unlimited (GW_MAX_CONNS)
	tlsConf *tls.Config   // nil = TLS unconfigured: SSLRequest gets 'N'
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
	tlsConf, err := loadTLS(env)
	if err != nil {
		return nil, err
	}
	g := &Gateway{
		driver:  driver,
		metrics: metrics.NewMetrics(),
		opts: wake.Opts{
			ConnectTimeoutMs: envInt(env, "GW_CONNECT_TIMEOUT_MS", 1000),
			WakeTimeoutMs:    envInt(env, "GW_WAKE_TIMEOUT_MS", 60000),
			RetryMs:          envInt(env, "GW_RETRY_MS", 250),
		},
		idleMs:  envInt(env, "GW_IDLE_MS", 300000),
		floorMs: envInt(env, "GW_AUTH_FAIL_FLOOR_MS", 250),
		tlsConf: tlsConf,
		log:     log,
		active:  map[string]*activeEntry{},
	}
	if tlsConf != nil {
		log("[gw] TLS enabled on the Postgres wire (SSLRequest -> S); sslmode=disable still accepted")
	}
	if n := envInt(env, "GW_MAX_CONNS", 0); n > 0 {
		g.connSem = make(chan struct{}, n)
	}
	// Warm-pool driver: surface its gate state on the gauge. Other modes have
	// no gate, so this is a no-op for them.
	if wp, ok := driver.(interface{ AttachMetrics(wake.GateStateSink) }); ok {
		wp.AttachMetrics(g.metrics)
	}
	return g, nil
}

// loadTLS builds the front-door TLS config from GW_TLS_CERT_FILE +
// GW_TLS_KEY_FILE. Both unset -> nil (TLS disabled, SSLRequest gets 'N').
// Set-but-unloadable or half-configured -> error, so New() fails fast at
// startup with a clear message rather than silently serving plaintext.
func loadTLS(env wake.Env) (*tls.Config, error) {
	cert, key := env["GW_TLS_CERT_FILE"], env["GW_TLS_KEY_FILE"]
	if cert == "" && key == "" {
		return nil, nil
	}
	if cert == "" || key == "" {
		return nil, fmt.Errorf("TLS half-configured: set BOTH GW_TLS_CERT_FILE and GW_TLS_KEY_FILE (cert=%q key=%q)", cert, key)
	}
	pair, err := tls.LoadX509KeyPair(cert, key)
	if err != nil {
		return nil, fmt.Errorf("loading TLS cert/key (GW_TLS_CERT_FILE=%s GW_TLS_KEY_FILE=%s): %w", cert, key, err)
	}
	return &tls.Config{
		Certificates: []tls.Certificate{pair},
		MinVersion:   tls.VersionTLS12,
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

// capConn releases its GW_MAX_CONNS slot exactly once, on Close. Every code
// path (handshake errors, pipe cleanup, timeouts) closes the client conn, so
// the slot's lifetime is the connection's lifetime — not handle()'s, which
// returns as soon as the pipe goroutines start.
type capConn struct {
	net.Conn
	release *sync.Once
	sem     chan struct{}
}

func (c *capConn) Close() error {
	c.release.Do(func() { <-c.sem })
	return c.Conn.Close()
}

// Serve runs the accept loop until ln is closed.
func (g *Gateway) Serve(ln net.Listener) {
	for {
		client, err := ln.Accept()
		if err != nil {
			return
		}
		if tcp, ok := client.(*net.TCPConn); ok {
			_ = tcp.SetNoDelay(true)
		}
		if g.connSem != nil {
			select {
			case g.connSem <- struct{}{}:
				client = &capConn{Conn: client, release: &sync.Once{}, sem: g.connSem}
			default:
				// At capacity: refuse cleanly instead of unbounded goroutines.
				g.metrics.RejectConn()
				go func(c net.Conn) {
					_, _ = c.Write(proto.BuildErrorResponse("53300", "gateway connection limit reached"))
					_ = c.Close()
				}(client)
				continue
			}
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
	start := time.Now()
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
			case proto.TypeSSL:
				if g.tlsConf != nil {
					// Accept TLS: reply 'S', wrap the conn, and restart the loop
					// reading the real StartupMessage over the encrypted channel.
					// After 'S' the client sends a TLS ClientHello, not plaintext,
					// so there is no buffered rest to preserve.
					if _, err := client.Write([]byte("S")); err != nil {
						_ = client.Close()
						return
					}
					tlsConn := tls.Server(client, g.tlsConf)
					_ = tlsConn.SetDeadline(time.Now().Add(handshakeTimeout))
					if err := tlsConn.Handshake(); err != nil {
						g.log("[gw] TLS handshake failed: " + err.Error())
						_ = tlsConn.Close()
						return
					}
					_ = tlsConn.SetDeadline(time.Time{})
					client = tlsConn
					buf = nil
					continue // client now sends the real StartupMessage over TLS
				}
				// TLS unconfigured: decline like GSSEnc (plaintext continues).
				buf = append([]byte(nil), rest...) // keep whatever followed
				if _, err := client.Write([]byte("N")); err != nil {
					_ = client.Close()
					return
				}
				continue
			case proto.TypeGSSEnc:
				// GSS encryption is never offered; always decline.
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
				// A REPLICATION (walreceiver) startup routes+wakes the SAME
				// per-zone compute-<zone> as an ordinary connect (ADR-0007 §4c
				// option ii, gateway-mediated replication-wake): this is what lets
				// a subscriber wake a sleeping publisher. It differs only in (a)
				// which role authorizes it (repl_<zone>, not app_<zone>) and (b)
				// that it holds the compute awake as a live replication stream.
				replication := proto.IsReplication(msg.Params)
				// Tenant access control (issue #74): in template mode the driver
				// authorizes the (user, database) pair from the startup packet
				// BEFORE any wake. An unauthorized pair (cross-app, cloud_admin,
				// wrong role for a replication startup, or a reserved/internal
				// system name) gets a clean 28P01 and the compute is never woken —
				// no info leak, no side effect.
				if err := g.authorizeStartup(msg.Params["user"], systemID, replication); err != nil {
					// Uniform refusal + constant-floor delay so a wrong pair /
					// reserved name is timing- and byte-indistinguishable from
					// the non-existent-app wake failure below (issue #92).
					g.authFloor(start)
					g.fail(client, wake.AuthFailureCode, err.Error())
					return
				}
				target := g.driver.Resolve(systemID)
				startup := append([]byte(nil), packet...)
				// Branch-per-app: the DSN database routes to the per-app compute,
				// but every branch serves one physical DB (postgres). Rewrite the
				// replayed startup so the backend gets a database it actually has.
				if rw, ok := g.driver.(servedDatabaseRewriter); ok {
					startup = rewriteStartupDatabase(startup, msg.Params, rw.ServedDatabase())
				}
				pending := append([]byte(nil), rest...)
				_ = client.SetReadDeadline(time.Time{})
				g.proxy(client, startup, pending, target, msg.Params, replication, start)
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

// authorizeStartup enforces the tenant boundary BEFORE any wake. An ordinary
// startup uses Authorize (app_<zone> role); a REPLICATION startup uses
// AuthorizeReplication (repl_<zone> role, ADR-0007 §4c). A driver that gates
// ordinary traffic but does NOT implement replication authz REFUSES replication
// uniformly rather than silently falling through to an unauthorized wake — so a
// future authorizer can never accidentally leave the replication port open.
// Drivers with no authorizer (single-DB pggw, exec) accept both, unchanged.
func (g *Gateway) authorizeStartup(user, database string, replication bool) error {
	if replication {
		if az, ok := g.driver.(replicationAuthorizer); ok {
			return az.AuthorizeReplication(user, database)
		}
		if _, ok := g.driver.(systemAuthorizer); ok {
			// Tenant-gated gateway with no replication authz: fail closed, uniform.
			return &wake.AuthError{Msg: wake.UniformAuthFailure(user)}
		}
		return nil
	}
	if az, ok := g.driver.(systemAuthorizer); ok {
		return az.Authorize(user, database)
	}
	return nil
}

func (g *Gateway) fail(client net.Conn, code, message string) {
	g.log("[gw] startup error: " + message)
	_, _ = client.Write(proto.BuildErrorResponse(code, message))
	_ = client.Close()
}

// authFloor blocks until at least floorMs has elapsed since the connection was
// accepted, but ONLY on the apps-gateway (a systemAuthorizer driver). It gives
// every gateway-side refusal — a pre-wake authz reject and a fast "app not found"
// wake failure alike — a common minimum latency, so an attacker cannot use timing
// to tell "reserved/wrong-pair" (µs) from "valid pair, unknown app" (a few ms of
// k8s round-trip) apart (issue #92). It does NOT (and cannot cheaply) mask the
// multi-second cold-wake latency of a REAL app — that channel is documented in
// docs/connecting.md. Single-DB pggw (no authorizer) is never delayed.
func (g *Gateway) authFloor(start time.Time) {
	if _, ok := g.driver.(systemAuthorizer); !ok || g.floorMs <= 0 {
		return
	}
	if rem := time.Duration(g.floorMs)*time.Millisecond - time.Since(start); rem > 0 {
		time.Sleep(rem)
	}
}

// computeUnavailable writes the client-facing error for a wake/resolve failure.
// On the apps-gateway (template mode) the real cause is logged server-side only
// and the client gets the SAME uniform 28P01 password-failure used for authz
// refusals — so a non-existent app is indistinguishable from a wrong password and
// no internal k8s object name reaches the wire (issue #92). The single-DB pggw
// (no authorizer, closed NetworkPolicy, one known DB) keeps the descriptive
// transient message that aids its operators.
func (g *Gateway) computeUnavailable(client net.Conn, params map[string]string, start time.Time, err error) {
	if _, ok := g.driver.(systemAuthorizer); ok {
		g.authFloor(start)
		_, _ = client.Write(proto.BuildErrorResponse(wake.AuthFailureCode, wake.UniformAuthFailure(params["user"])))
	} else {
		_, _ = client.Write(proto.BuildErrorResponse("57P03", "compute unavailable: "+err.Error()))
	}
	_ = client.Close()
}

// proxy wakes the compute, replays the startup packet, then pipes both ways. When
// replication is true the client is a subscriber's walreceiver: the wake target is
// the same per-zone compute, but the connection is tracked as a live replication
// stream so the compute (a publisher) is NOT scaled to zero while WAL is flowing
// (ADR-0007 §4c). Post-handshake the pipe is protocol-agnostic, so the CopyBoth
// replication stream flows through the same byte pump as ordinary query traffic.
func (g *Gateway) proxy(client net.Conn, startupPacket, pendingRest []byte, target wake.Target, params map[string]string, replication bool, start time.Time) {
	g.connStarted(target, replication)
	g.metrics.ConnOpen(target.Key)
	if replication {
		g.metrics.ReplicationConn()
		g.log("[gw] " + target.Key + ": replication stream opening (db=" + params["database"] + " user=" + params["user"] + ") — holding publisher awake while WAL flows")
	}

	conn, woke, wakeMs, err := wake.ConnectWithWake(context.Background(), g.driver, target, g.opts, func() {
		g.log("[gw] " + target.Key + ": compute asleep, waking (db=" + params["database"] + " user=" + params["user"] + ")")
	})
	if err != nil {
		g.metrics.WakeFailure()
		g.metrics.ConnClose(target.Key)
		g.connEnded(target, replication)
		g.log("[gw] " + target.Key + ": " + err.Error())
		g.computeUnavailable(client, params, start, err)
		return
	}
	if woke {
		g.metrics.Wake(target.Key, wakeMs)
		g.log("[gw] " + target.Key + ": awake in " + strconv.FormatInt(wakeMs, 10) + "ms")
	}

	if tcp, ok := conn.(*net.TCPConn); ok {
		_ = tcp.SetNoDelay(true)
	}

	// Readiness handshake: a freshly started Postgres accepts TCP before it
	// can serve and FATALs the startup with 57P03 ("the database system is
	// starting up"). Absorb those and retry the handshake until the backend
	// answers for real — the client must never see the transient FATAL.
	conn, firstReply, err := g.handshakeUntilReady(conn, startupPacket, target)
	if err != nil {
		g.metrics.WakeFailure()
		g.metrics.ConnClose(target.Key)
		g.connEnded(target, replication)
		g.log("[gw] " + target.Key + ": " + err.Error())
		g.computeUnavailable(client, params, start, err)
		return
	}
	if len(firstReply) > 0 {
		if _, err := client.Write(firstReply); err != nil {
			g.metrics.ConnClose(target.Key)
			g.connEnded(target, replication)
			_ = client.Close()
			_ = conn.Close()
			return
		}
	}
	if len(pendingRest) > 0 {
		_, _ = conn.Write(pendingRest)
	}

	var once sync.Once
	cleanup := func() {
		once.Do(func() {
			g.metrics.ConnClose(target.Key)
			g.connEnded(target, replication)
			_ = client.Close()
			_ = conn.Close()
		})
	}
	go func() { _, _ = io.Copy(conn, client); cleanup() }()
	go func() { _, _ = io.Copy(client, conn); cleanup() }()
}

// handshakeUntilReady writes the startup packet and peeks at the backend's
// first reply. While the reply is FATAL 57P03 (crash recovery / starting up),
// it reconnects and retries until the wake deadline. On success it returns
// the (possibly new) backend conn plus the first reply bytes to forward.
func (g *Gateway) handshakeUntilReady(conn net.Conn, startupPacket []byte, target wake.Target) (net.Conn, []byte, error) {
	deadline := time.Now().Add(time.Duration(g.opts.WakeTimeoutMs) * time.Millisecond)
	retry := time.Duration(g.opts.RetryMs) * time.Millisecond
	for {
		if _, err := conn.Write(startupPacket); err != nil {
			_ = conn.Close()
			return nil, nil, err
		}
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		typ, raw, err := proto.ReadBackendMessage(conn)
		_ = conn.SetReadDeadline(time.Time{})
		if err != nil {
			if ne, ok := err.(net.Error); ok && ne.Timeout() && len(raw) > 0 {
				// Slow but alive: hand what arrived to the pipe.
				return conn, raw, nil
			}
			if len(raw) == 0 {
				// EOF / reset with nothing read: a dying (Terminating) or
				// restarting backend. Retry like a starting-up backend.
				_ = conn.Close()
				if time.Now().After(deadline) {
					return nil, nil, errors.New("backend kept dropping the handshake past the wake deadline")
				}
				time.Sleep(retry)
				next, _, _, cerr := wake.ConnectWithWake(context.Background(), g.driver, target, g.opts, nil)
				if cerr != nil {
					return nil, nil, cerr
				}
				conn = next
				continue
			}
			// Partial reply then error: forward what we have; the pipe's
			// close handling reports the rest.
			return conn, raw, nil
		}
		if typ != 'E' || proto.ErrorCode(raw) != "57P03" {
			return conn, raw, nil // genuinely ready (auth request, error, anything)
		}
		_ = conn.Close()
		if time.Now().After(deadline) {
			return nil, nil, errors.New("backend kept reporting 57P03 (starting up) past the wake deadline")
		}
		time.Sleep(retry)
		next, _, _, err := wake.ConnectWithWake(context.Background(), g.driver, target, g.opts, nil)
		if err != nil {
			return nil, nil, err
		}
		conn = next
		if tcp, ok := conn.(*net.TCPConn); ok {
			_ = tcp.SetNoDelay(true)
		}
	}
}

// connStarted increments the active count and cancels any pending sleep. When
// replication is true it also bumps replCount, marking this compute as feeding a
// live WAL stream to a subscriber (ADR-0007 §4c): such a compute must not sleep.
func (g *Gateway) connStarted(target wake.Target, replication bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	e := g.active[target.Key]
	if e == nil {
		e = &activeEntry{target: target}
		g.active[target.Key] = e
	}
	e.count++
	if replication {
		e.replCount++
	}
	if e.timer != nil {
		e.timer.Stop()
		e.timer = nil
	}
}

// connEnded decrements the active count and, once BOTH the total and the
// replication counts hit zero, schedules a sleep. The explicit replCount guard
// makes "never sleep while a replication stream is live" a stated invariant rather
// than an accident of count bookkeeping — a caught-up-then-disconnected walreceiver
// releases its replCount, and only then does the publisher become sleep-eligible.
func (g *Gateway) connEnded(target wake.Target, replication bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	e := g.active[target.Key]
	if e == nil {
		return
	}
	e.count--
	if replication && e.replCount > 0 {
		e.replCount--
	}
	if e.count <= 0 && e.replCount <= 0 && g.driver.CanSleep() && g.idleMs > 0 && !g.closed {
		g.scheduleSleep(e, target)
	}
}

// scheduleSleep arms the idle timer. Caller must hold g.mu. When the timer
// fires, sleep proceeds only if this pod still has zero connections AND the
// peer fleet reports zero; otherwise the timer re-arms for another window.
func (g *Gateway) scheduleSleep(e *activeEntry, target wake.Target) {
	e.timer = time.AfterFunc(time.Duration(g.idleMs)*time.Millisecond, func() {
		g.mu.Lock()
		if e.count > 0 || e.replCount > 0 || g.closed {
			g.mu.Unlock()
			return
		}
		g.mu.Unlock()

		if g.Peers != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			// Per-app (issue #75): ask peers only about THIS compute key, so a
			// busy neighbouring app never postpones this idle app's sleep.
			n, err := g.Peers.ActiveConnections(ctx, target.Key)
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

		// Final local re-check right before the (slow) scale API call — the
		// peer check above took time.
		g.mu.Lock()
		if e.count > 0 || e.replCount > 0 || g.closed {
			g.mu.Unlock()
			return
		}
		g.mu.Unlock()

		if err := g.driver.Sleep(context.Background(), target); err != nil {
			g.log("[gw] " + target.Key + ": sleep failed: " + err.Error())
			return
		}
		g.metrics.Sleep()
		g.log("[gw] " + target.Key + ": idle " + strconv.Itoa(g.idleMs) + "ms -> scaled to zero")

		// TOCTOU heal: a connection may have arrived while Sleep was in
		// flight. If so, wake the compute right back — the arriving client is
		// held by its own wake retry loop and recovers seamlessly.
		g.mu.Lock()
		arrived := e.count > 0 && !g.closed
		g.mu.Unlock()
		if arrived {
			g.log("[gw] " + target.Key + ": connection arrived during scale-down, waking back")
			if err := g.driver.Wake(context.Background(), target); err != nil {
				g.log("[gw] " + target.Key + ": wake-back failed: " + err.Error())
			}
		}
	})
}
