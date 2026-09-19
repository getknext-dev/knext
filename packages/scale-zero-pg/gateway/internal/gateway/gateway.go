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
	floorMs int // GW_AUTH_FAIL_FLOOR_MS: constant-floor delay on refusals
	// roleApplySettleMs (GW_ROLE_APPLY_SETTLE_MS) closes the cold-boot role-apply
	// race (#132). compute_ctl opens the Postgres socket a beat BEFORE it (re)applies
	// the per-app spec roles/passwords on every boot, so the very first connection
	// during a 0->1 cold wake can transiently see 28P01 (it self-heals next request).
	// On a GENUINE cold wake of a per-app front door (a systemAuthorizer driver — the
	// path where compute_ctl re-applies per-app roles), the gateway holds the client
	// for this bounded window BEFORE replaying the startup, so the role is applied by
	// the time the single auth attempt runs. It is NOT an auth retry: a wrong password
	// still fails on that one attempt (no masking). Default 250ms >> the ~85ms apply
	// window observed live on OKE (#158); clamped to the wake deadline. Warm connects
	// (woke==false) and the base single-DB cloud_admin path skip it entirely, so steady
	// state is byte-for-byte unchanged. 0 disables the gate. NOTE: this makes the race
	// NEGLIGIBLE (settle >> the apply window), not deterministically zero — the
	// deterministic compute_ctl-/status readiness gate is tracked as #174.
	roleApplySettleMs int
	// statusProbe (issue #174) is the OPT-IN deterministic upgrade to the #132
	// settle: when configured (GW_STATUS_PORT + a JWT) it polls compute_ctl's
	// /status endpoint on a cold wake until the compute reports "running" (spec
	// applied) instead of sleeping a fixed roleApplySettleMs. nil = not configured
	// (the default/current deployment) — the bounded settle is used, unchanged.
	statusProbe *statusProbe
	connSem     chan struct{} // nil = unlimited (GW_MAX_CONNS)
	tlsConf     *tls.Config   // nil = TLS unconfigured: SSLRequest gets 'N'
	log         func(string)

	// wakeLimiter enforces the per-app wake budget (issue #116, ADR-0008). nil =
	// budget off (GW_WAKE_BUDGET unset/0) — the wake path is unchanged. When set,
	// g.opts.WakeGuard consults it before every 0->1 scale.
	wakeLimiter *wake.WakeLimiter

	// Peers guards the idle decision when running 2+ replicas: sleep only
	// when the whole fleet is at zero, not just this pod. Fail-safe: any
	// peer error postpones sleep rather than risking a live connection.
	Peers PeerChecker

	mu     sync.Mutex
	active map[string]*activeEntry
	closed bool

	// wg tracks every connection enrolled for graceful drain. Add(1) happens
	// ONCE per connection at handle-entry (registerConn), under g.mu together with
	// the g.closed check — so it is refused, never raced, once Drain has marked the
	// gateway closed (the sync.WaitGroup Add-from-zero contract). Done() runs once,
	// in the once-guarded connReg.cleanup, on whichever exit path the connection
	// takes. Drain waits on it so an in-flight session — INCLUDING one still waking
	// a cold compute or handshaking — is allowed to finish on SIGTERM instead of
	// being reset (issue #1016).
	wg sync.WaitGroup
	// live holds every connection currently enrolled for drain (from accept, not
	// just those already piping), so Drain can force-close whatever is left when
	// its deadline expires — cancelling an in-progress wake and closing the conns.
	live    map[uint64]*connReg
	liveSeq uint64

	// onConnRegistered, when non-nil, fires inside registerConn right after wg.Add
	// while g.mu is held. Test-only seam to observe the accept->wg window; nil in
	// production.
	onConnRegistered func()
}

// connReg is one connection's drain enrollment, created at handle-entry. It owns
// the single wg.Done for the connection (via the once-guarded cleanup) and lets
// Drain force-close a connection at any phase — including while it is still waking
// a cold compute (no backend conn yet) or handshaking. All mutable fields are
// guarded by mu because Drain's force-close races the owning goroutine.
type connReg struct {
	g  *Gateway
	id uint64

	mu         sync.Mutex
	client     net.Conn           // client side; reassigned on a TLS upgrade
	conn       net.Conn           // backend side; nil until the wake connects
	cancelWake context.CancelFunc // cancels an in-progress ConnectWithWake
	// metrics accounting owed to cleanup once proxy has opened the compute slot.
	opened      bool
	target      wake.Target
	replication bool

	once sync.Once
}

// setClient swaps the tracked client conn (used when handle upgrades to TLS) so a
// force-close tears down the encrypted conn the session is actually using.
func (r *connReg) setClient(c net.Conn) {
	r.mu.Lock()
	r.client = c
	r.mu.Unlock()
}

// bindWake records the cancel func for the in-flight wake so Drain can abort it.
func (r *connReg) bindWake(cancel context.CancelFunc) {
	r.mu.Lock()
	r.cancelWake = cancel
	r.mu.Unlock()
}

// bindBackend records the compute conn and the metrics accounting owed on close,
// once the wake has connected. From here force-close also closes the backend.
func (r *connReg) bindBackend(conn net.Conn, target wake.Target, replication bool) {
	r.mu.Lock()
	r.conn = conn
	r.opened = true
	r.target = target
	r.replication = replication
	r.mu.Unlock()
}

// markOpened records that proxy has taken the compute slot (connStarted+ConnOpen)
// so cleanup releases it exactly once even if the wake then fails before a backend
// conn exists.
func (r *connReg) markOpened(target wake.Target, replication bool) {
	r.mu.Lock()
	r.opened = true
	r.target = target
	r.replication = replication
	r.mu.Unlock()
}

// setBackend updates the tracked backend conn (a handshake retry may swap it) so
// force-close always closes the conn the gateway is actually blocked on.
func (r *connReg) setBackend(conn net.Conn) {
	r.mu.Lock()
	r.conn = conn
	r.mu.Unlock()
}

// cleanup runs exactly once on whatever exit path the connection takes: it
// releases the compute slot (if opened), removes the live entry, closes both
// conns, and fires the single wg.Done that pairs with the handle-entry wg.Add.
func (r *connReg) cleanup() {
	r.once.Do(func() {
		r.mu.Lock()
		client, conn := r.client, r.conn
		opened, target, replication := r.opened, r.target, r.replication
		r.mu.Unlock()
		if opened {
			r.g.metrics.ConnClose(target.Key)
			r.g.connEnded(target, replication)
		}
		r.g.unregisterLive(r.id)
		if client != nil {
			_ = client.Close()
		}
		if conn != nil {
			_ = conn.Close()
		}
		r.g.wg.Done()
	})
}

// forceClose is called by Drain on its deadline: cancel any in-progress wake and
// close both conns so the owning goroutine unblocks and reaches cleanup. It does
// NOT call wg.Done — the owning goroutine still owns that via cleanup.
func (r *connReg) forceClose() {
	r.mu.Lock()
	cancel, client, conn := r.cancelWake, r.client, r.conn
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if client != nil {
		_ = client.Close()
	}
	if conn != nil {
		_ = conn.Close()
	}
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
	// F5 phase 3 (ADR-0003): the BACKEND leg (gateway->compute). Default ON —
	// GW_COMPUTE_TLS=false is the plaintext dev opt-out. Half-configured fails
	// fast here, exactly like the front-door loadTLS above.
	backendTLS, err := wake.NewBackendTLSFromEnv(env)
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
			// Bounded idempotent retry/backoff around the 0->1 scale call (issue #190):
			// a transient apiserver blip is retried within the wake budget instead of
			// failing the client's cold wake. Base backoff + attempt cap are tunable;
			// the wake deadline (GW_WAKE_TIMEOUT_MS) is the hard ceiling regardless.
			WakeRetryBaseMs: envInt(env, "GW_WAKE_RETRY_BASE_MS", 200),
			WakeMaxAttempts: envInt(env, "GW_WAKE_MAX_ATTEMPTS", 8),
			// Every backend dial (warm fast path AND cold-wake poll) is a TLS
			// client dial when this is non-nil — the wrap lives inside
			// TryConnect, so a handshake failure is retried by the wake loop.
			BackendTLS: backendTLS,
		},
		idleMs:            envInt(env, "GW_IDLE_MS", 300000),
		floorMs:           envInt(env, "GW_AUTH_FAIL_FLOOR_MS", 250),
		roleApplySettleMs: envInt(env, "GW_ROLE_APPLY_SETTLE_MS", 250),
		statusProbe:       newStatusProbeFromEnv(env),
		tlsConf:           tlsConf,
		log:               log,
		active:            map[string]*activeEntry{},
	}
	// Observability for the wake-scale retry (issue #190): each retried transient
	// blip bumps pggw_wake_retries_total and logs the target + attempt, so a
	// 'retried-then-succeeded' wake is visible (retries rise, failures flat) and
	// distinguishable from a 'failed-after-retries' wake (the final error is logged
	// + pggw_wake_failures_total rises). Shared, stateless — safe across connections.
	g.opts.OnWakeRetry = func(t wake.Target, attempt int, err error) {
		g.metrics.WakeRetry()
		g.log("[gw] " + t.Key + ": transient wake scale error (attempt " + strconv.Itoa(attempt) +
			"), retrying within wake budget: " + err.Error())
	}
	// Single-flight concurrent 0->1 wakes per compute (issue #1018): a cold fan-out
	// of N connections to ONE sleeping compute shares a SINGLE wake — one budget
	// token, one GetScale->UpdateScale — instead of each connection running its own.
	// This stops false 53400 budget refusals on a legitimate wide cold start and the
	// apiserver 409-conflict retry storm from N racing scale writes. Shared across
	// all connections (and inherited by the sleep-race wake-back's retryOpts), so
	// every wake to a given Target.Key coalesces; the coalescer is ctx-observing, so
	// a drain force-close still aborts a waiting caller promptly (#1017).
	g.opts.Coalescer = wake.NewWakeCoalescer()
	if g.statusProbe != nil {
		log("[gw] cold-boot readiness: deterministic compute_ctl /status gate ENABLED (port " +
			strconv.Itoa(g.statusProbe.port) + ", ready=\"" + g.statusProbe.ready +
			"\"); GW_ROLE_APPLY_SETTLE_MS is the bounded fallback (#174)")
	}
	if tlsConf != nil {
		log("[gw] TLS enabled on the Postgres wire (SSLRequest -> S); sslmode=disable still accepted")
	}
	if n := envInt(env, "GW_MAX_CONNS", 0); n > 0 {
		g.connSem = make(chan struct{}, n)
	}
	// Per-app wake budget (issue #116, ADR-0008): a token-bucket on the WAKE
	// primitive. When set, the WakeGuard refuses a 0->1 scale for any app that has
	// burned its budget — a foreign/unauth pod can wake a sleeping app but cannot
	// force unbounded churn. Keyed on the compute Target.Key, which is per-app in
	// template mode (compute-<app>) — so the budget is genuinely per-tenant.
	if g.wakeLimiter = wake.NewWakeLimiterFromEnv(env); g.wakeLimiter != nil {
		g.opts.WakeGuard = func(key string) error {
			if g.wakeLimiter.Allow(key) {
				return nil
			}
			return wake.ErrWakeBudgetExceeded
		}
		log(fmt.Sprintf("[gw] per-app wake budget enabled (GW_WAKE_BUDGET=%d over GW_WAKE_WINDOW_MS=%d) — over-budget wakes refused (issue #116)",
			envInt(env, "GW_WAKE_BUDGET", 0), envInt(env, "GW_WAKE_WINDOW_MS", 60000)))
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

// envInt reads an integer GW_* knob from the injected env, returning def when the
// key is absent, empty, or unparseable — so a malformed override degrades to the
// compiled-in default rather than failing startup.
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

// Close marks the gateway closed (idle timers stop scheduling new sleeps). It is
// the immediate, non-blocking stop; use Drain for a graceful, bounded shutdown
// that lets in-flight sessions finish.
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

// Drain performs a graceful, bounded shutdown mirroring the app runtime's
// gracefulShutdown contract (packages/kn-next/src/adapters/shutdown.ts): stop
// scheduling sleeps, then wait for every in-flight proxied session to finish so
// no in-flight Postgres query/transaction/COPY/replication stream is reset on
// SIGTERM. The wait is bounded by ctx; when it expires the remaining sessions'
// client+compute conns are force-closed so the process exits within the pod's
// terminationGracePeriodSeconds instead of hanging. Safe to call with zero
// in-flight connections (returns nil immediately). The caller closes the
// listener first so no NEW connections are accepted while Drain runs (issue
// #1016).
func (g *Gateway) Drain(ctx context.Context) error {
	_ = g.Close() // mark closed, stop pending idle timers

	done := make(chan struct{})
	go func() {
		g.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		return nil
	case <-ctx.Done():
		// Deadline hit: force-close every enrolled connection — cancelling an
		// in-progress wake AND closing both conns — so the owning goroutine (a
		// pipe, a blocked handshake read, or a polling wake) unblocks, runs its
		// cleanup, and the process can exit within terminationGracePeriodSeconds.
		g.mu.Lock()
		regs := make([]*connReg, 0, len(g.live))
		for _, r := range g.live {
			regs = append(regs, r)
		}
		g.mu.Unlock()
		for _, r := range regs {
			r.forceClose()
		}
		g.wg.Wait() // goroutines now unblock; cleanup runs the single wg.Done each
		return ctx.Err()
	}
}

// registerConn enrolls a freshly-accepted connection for graceful drain. Under
// g.mu it refuses new work once the gateway is closed (draining) — returning
// (nil, false) so the caller closes the client and returns — and otherwise does
// the single wg.Add(1) for the connection plus a live-set entry. Doing Add under
// the same lock that sets/reads g.closed makes the Add happen-before any Drain
// Wait that observed closed, which is the sync.WaitGroup Add-from-zero contract.
func (g *Gateway) registerConn(client net.Conn) (*connReg, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.closed {
		return nil, false
	}
	g.wg.Add(1)
	if g.live == nil {
		g.live = map[uint64]*connReg{}
	}
	g.liveSeq++
	id := g.liveSeq
	r := &connReg{g: g, id: id, client: client}
	g.live[id] = r
	if g.onConnRegistered != nil {
		g.onConnRegistered()
	}
	return r, true
}

// unregisterLive removes a connection from the live set once it has fully closed.
func (g *Gateway) unregisterLive(id uint64) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.live, id)
}

// handle reads the initial packet(s), declines SSL/GSS, then proxies a startup.
// The connection is enrolled for graceful drain at ENTRY (registerConn), before
// any wake/handshake, so a SIGTERM during a cold wake still drains it. A closed
// gateway refuses the connection outright. The single wg.Done is owned by
// reg.cleanup: handle fires it on every non-piping exit via the deferred guard,
// and hands ownership to the pipe goroutines once piping starts (piping=true).
func (g *Gateway) handle(client net.Conn) {
	reg, ok := g.registerConn(client)
	if !ok {
		_ = client.Close() // draining: refuse new work
		return
	}
	piping := false
	defer func() {
		if !piping {
			reg.cleanup()
		}
	}()

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
					reg.setClient(tlsConn) // force-close must tear down the TLS conn
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
				piping = g.proxy(client, startup, pending, target, msg.Params, replication, start, reg)
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

// fail writes a single Postgres ErrorResponse (the given SQLSTATE + message) to the
// client and closes the connection. Used for pre-wake startup errors (protocol
// parse failures, authz refusals) — the compute is never touched on this path.
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

// settleColdWake closes the cold-boot role-apply race (#132) by holding the client
// for the role-apply settle window when, and ONLY when, this was a genuine 0->1 cold
// wake (woke) of a per-app front door — a systemAuthorizer driver, the path where
// compute_ctl re-applies the per-app spec role on every boot a beat after the socket
// opens. compute_ctl opens the port BEFORE it applies the role, so the first
// connection can transiently 28P01; a bounded pause here lets the role land before
// the single auth attempt runs. It is NOT an auth retry — a wrong password still
// fails promptly on that one attempt, so a genuine credential failure is never
// masked. The base single-DB cloud_admin path (no authorizer) and every warm connect
// (woke==false) are never delayed, so steady state is byte-for-byte unchanged. The
// wait is clamped to the remaining wake-deadline budget so it can never push a
// connection past GW_WAKE_TIMEOUT_MS.
func (g *Gateway) settleColdWake(woke bool, target wake.Target, start time.Time) {
	if !woke || g.roleApplySettleMs <= 0 {
		return
	}
	if _, ok := g.driver.(systemAuthorizer); !ok {
		return
	}
	settle := time.Duration(g.roleApplySettleMs) * time.Millisecond
	rem := time.Duration(g.opts.WakeTimeoutMs)*time.Millisecond - time.Since(start)
	if rem <= 0 {
		return // deadline already spent — never delay further
	}
	if rem < settle {
		settle = rem // clamp so settle + wake never exceeds the wake deadline
	}
	g.log("[gw] " + target.Key + ": cold wake — settling " + strconv.FormatInt(settle.Milliseconds(), 10) + "ms for per-app role apply (#132)")
	time.Sleep(settle)
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

// wakeBudgetSQLSTATE is the SQLSTATE returned when a wake is refused because the
// app burned its per-app wake budget (issue #116). 53400 (configuration_limit_
// _exceeded) marks it as a transient, retryable limit — distinct from a 28P01 auth
// refusal and a 57P03/28P01 wake failure — so a legitimate client that momentarily
// exceeds the budget backs off and retries, while the compute is never scaled.
const wakeBudgetSQLSTATE = "53400"

// wakeBudgetRefused writes the clean wake-budget refusal. It shares the apps-gateway
// constant-floor delay (authFloor) so its timing matches every other gateway-side
// refusal. The message is deliberately generic ("wake rate limit"): it names no
// tenant/app and reveals nothing an over-budget caller does not already know (its
// own burst just tripped the limit on a database it is already targeting).
func (g *Gateway) wakeBudgetRefused(client net.Conn, start time.Time) {
	g.authFloor(start)
	_, _ = client.Write(proto.BuildErrorResponse(wakeBudgetSQLSTATE, "wake rate limit exceeded for this database; retry shortly"))
	_ = client.Close()
}

// proxy wakes the compute, replays the startup packet, then pipes both ways. When
// replication is true the client is a subscriber's walreceiver: the wake target is
// the same per-zone compute, but the connection is tracked as a live replication
// stream so the compute (a publisher) is NOT scaled to zero while WAL is flowing
// (ADR-0007 §4c). Post-handshake the pipe is protocol-agnostic, so the CopyBoth
// replication stream flows through the same byte pump as ordinary query traffic.
// proxy returns piping=true once the two io.Copy goroutines have started and taken
// over ownership of reg.cleanup (the single wg.Done); it returns false on every
// pre-piping failure, leaving handle's deferred guard to run reg.cleanup. reg was
// enrolled for drain at handle-entry, so the whole wake+handshake below is already
// covered by Drain — a SIGTERM here force-closes the conns and cancels the wake.
func (g *Gateway) proxy(client net.Conn, startupPacket, pendingRest []byte, target wake.Target, params map[string]string, replication bool, start time.Time, reg *connReg) bool {
	g.connStarted(target, replication)
	g.metrics.ConnOpen(target.Key)
	// The compute slot is now taken; cleanup owes ConnClose+connEnded on every exit.
	reg.markOpened(target, replication)
	if replication {
		g.metrics.ReplicationConn()
		g.log("[gw] " + target.Key + ": replication stream opening (db=" + params["database"] + " user=" + params["user"] + ") — holding publisher awake while WAL flows")
	}

	// Cancelable wake context so a drain deadline aborts an in-progress cold wake
	// instead of waiting the full GW_WAKE_TIMEOUT_MS (force-close calls cancel).
	wakeCtx, cancelWake := context.WithCancel(context.Background())
	defer cancelWake()
	reg.bindWake(cancelWake)

	conn, woke, wakeMs, err := wake.ConnectWithWake(wakeCtx, g.driver, target, g.opts, func() {
		g.log("[gw] " + target.Key + ": compute asleep, waking (db=" + params["database"] + " user=" + params["user"] + ")")
	})
	if err != nil {
		// Wake budget exhausted (issue #116): a DELIBERATE refusal to scale, NOT a
		// cold-start failure. Count it separately (so it never trips the wake-failure
		// pager) and return a clean, transient refusal the client can retry — the
		// compute was never touched. Slot release + close + wg.Done run in cleanup.
		if errors.Is(err, wake.ErrWakeBudgetExceeded) {
			g.metrics.WakeBudgetExceeded(target.Key)
			g.log("[gw] " + target.Key + ": wake budget exceeded — refusing to scale (issue #116; db=" + params["database"] + " user=" + params["user"] + ")")
			g.wakeBudgetRefused(client, start)
			return false
		}
		g.metrics.WakeFailure()
		g.log("[gw] " + target.Key + ": " + err.Error())
		g.computeUnavailable(client, params, start, err)
		return false
	}
	// Backend connected: record it so a drain-deadline force-closes it too.
	reg.bindBackend(conn, target, replication)
	if woke {
		g.metrics.Wake(target.Key, wakeMs)
		g.log("[gw] " + target.Key + ": awake in " + strconv.FormatInt(wakeMs, 10) + "ms")
	}

	// Cold-boot role-apply race (#132/#174): on a genuine cold wake of a per-app
	// front door, gate the startup replay on compute_ctl readiness so the per-app
	// role is applied by the time the single auth attempt below runs. Deterministic
	// when the /status probe is configured (poll until "running"), else the bounded
	// time-settle. No-op on warm connects and the base single-DB path.
	g.gateColdWake(woke, target, start)

	if tcp, ok := conn.(*net.TCPConn); ok {
		_ = tcp.SetNoDelay(true)
	}

	// Readiness handshake: a freshly started Postgres accepts TCP before it
	// can serve and FATALs the startup with 57P03 ("the database system is
	// starting up"). Absorb those and retry the handshake until the backend
	// answers for real — the client must never see the transient FATAL. The wake
	// ctx is threaded through so a drain deadline aborts a reconnect mid-handshake.
	conn, firstReply, err := g.handshakeUntilReady(wakeCtx, reg, conn, startupPacket, target)
	if err != nil {
		g.metrics.WakeFailure()
		g.log("[gw] " + target.Key + ": " + err.Error())
		g.computeUnavailable(client, params, start, err)
		return false
	}
	if len(firstReply) > 0 {
		if _, err := client.Write(firstReply); err != nil {
			return false
		}
	}
	if len(pendingRest) > 0 {
		_, _ = conn.Write(pendingRest)
	}

	// Piping starts: the two goroutines take over reg.cleanup (the single wg.Done
	// paired with the handle-entry wg.Add). handle sees piping=true and does not
	// run cleanup itself.
	go func() { _, _ = io.Copy(conn, client); reg.cleanup() }()
	go func() { _, _ = io.Copy(client, conn); reg.cleanup() }()
	return true
}

// handshakeUntilReady writes the startup packet and peeks at the backend's
// first reply. While the reply is FATAL 57P03 (crash recovery / starting up),
// it reconnects and retries until the wake deadline. On success it returns
// the (possibly new) backend conn plus the first reply bytes to forward.
func (g *Gateway) handshakeUntilReady(ctx context.Context, reg *connReg, conn net.Conn, startupPacket []byte, target wake.Target) (net.Conn, []byte, error) {
	deadline := time.Now().Add(time.Duration(g.opts.WakeTimeoutMs) * time.Millisecond)
	retry := time.Duration(g.opts.RetryMs) * time.Millisecond
	// Readiness reconnects belong to an ALREADY-authorized, already-budgeted wake
	// (the token was spent when proxy first woke this compute). Re-checking the
	// budget here would let a slow cold start burn a second token and could refuse
	// a legitimate in-flight wake mid-handshake — so these retries skip the guard.
	retryOpts := g.opts
	retryOpts.WakeGuard = nil
	for {
		if _, err := conn.Write(startupPacket); err != nil {
			_ = conn.Close()
			return nil, nil, err
		}
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		typ, raw, err := proto.ReadBackendMessage(conn)
		_ = conn.SetReadDeadline(time.Time{})
		if err != nil {
			// A drain force-close cancels ctx and closes conn: abort promptly
			// rather than treating it as a starting-up backend to reconnect to.
			if ctx.Err() != nil {
				_ = conn.Close()
				return nil, nil, ctx.Err()
			}
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
				next, _, _, cerr := wake.ConnectWithWake(ctx, g.driver, target, retryOpts, nil)
				if cerr != nil {
					return nil, nil, cerr
				}
				conn = next
				reg.setBackend(conn) // track the swapped conn for force-close
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
		// A drain force-close cancels ctx during the sleep above. Unlike the
		// interruptible read at the top of the loop, that sleep is not ctx-guarded
		// and the reconnect below can succeed without observing ctx (a backend in
		// crash recovery still accepts TCP, so ConnectWithWake's early-success path
		// returns a live conn regardless of ctx). Check here so the force-close is
		// honored promptly instead of spinning until the wake deadline.
		if ctx.Err() != nil {
			return nil, nil, ctx.Err()
		}
		next, _, _, err := wake.ConnectWithWake(ctx, g.driver, target, retryOpts, nil)
		if err != nil {
			return nil, nil, err
		}
		conn = next
		reg.setBackend(conn) // track the swapped conn for force-close
		// Belt-and-suspenders: ConnectWithWake's early-success (TryConnect) path can
		// return without observing ctx, so re-check before looping back into another
		// interruptible read — a force-close during the dial must abort here too.
		if ctx.Err() != nil {
			_ = conn.Close()
			return nil, nil, ctx.Err()
		}
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
	shouldSleep := e.count <= 0 && e.replCount <= 0 && g.driver.CanSleep() && g.idleMs > 0 && !g.closed
	g.mu.Unlock()
	if !shouldSleep {
		g.mu.Lock() // restore the deferred Unlock's invariant
		return
	}
	// Resolve the per-app idle window WITHOUT holding g.mu — it may Get the compute
	// Deployment's annotation (#779), and a slow/failing apiserver must never block
	// connection accounting. Falls back to GW_IDLE_MS. Read per-arm (never cached),
	// so an operator idleDelay edit takes effect on the NEXT arm.
	windowMs := g.idleWindowMs(target)
	g.mu.Lock()
	// Re-check under the lock: a connection may have arrived while we resolved the
	// window, or Drain may have closed the gateway.
	if e.count <= 0 && e.replCount <= 0 && g.driver.CanSleep() && g.idleMs > 0 && !g.closed {
		g.scheduleSleep(e, target, windowMs)
	}
}

// idleWindowSource is an OPTIONAL driver capability: given a resolved target it
// returns the per-app idle window (from the compute Deployment's metadata
// annotation, #779) in ms. ok=false means "no per-app override" — an absent
// annotation, a malformed value, a transient Get error, or a driver that cannot
// read it — and the caller falls back to the fleet-default GW_IDLE_MS. It NEVER
// breaks the idle path: a flaky apiserver degrades to the fleet default.
type idleWindowSource interface {
	IdleDelayMs(ctx context.Context, t wake.Target) (int, bool)
}

// idleWindowMs resolves the idle window (ms) for a target at ARM time: the per-app
// override stamped by the operator on the compute Deployment when present and valid,
// else the fleet default g.idleMs. Read per-arm (never cached), so an operator edit
// to spec.idleDelay takes effect on the NEXT arm without cancelling any in-flight
// timer. Must NOT be called while holding g.mu (it may do a network Get).
func (g *Gateway) idleWindowMs(target wake.Target) int {
	src, ok := g.driver.(idleWindowSource)
	if !ok {
		return g.idleMs
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if ms, ok := src.IdleDelayMs(ctx, target); ok {
		return ms
	}
	return g.idleMs
}

// scheduleSleep arms the idle timer for windowMs. Caller must hold g.mu. When the
// timer fires, sleep proceeds only if this pod still has zero connections AND the
// peer fleet reports zero; otherwise the timer re-arms for another window.
func (g *Gateway) scheduleSleep(e *activeEntry, target wake.Target, windowMs int) {
	e.timer = time.AfterFunc(time.Duration(windowMs)*time.Millisecond, func() {
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
					g.metrics.PeerCheckFailure()
					g.log("[gw] " + target.Key + ": peer check failed (" + err.Error() + "), postponing sleep")
				} else {
					g.log("[gw] " + target.Key + ": " + strconv.Itoa(n) + " active connection(s) on peer gateways, postponing sleep")
				}
				// Re-resolve the per-app idle window for the NEXT arm outside the
				// lock (#779): an operator idleDelay edit takes effect here without
				// cancelling this in-flight timer.
				window := g.idleWindowMs(target)
				g.mu.Lock()
				if e.count == 0 && !g.closed {
					g.scheduleSleep(e, target, window) // try again next window
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
			g.metrics.SleepFailure()
			g.log("[gw] " + target.Key + ": sleep failed: " + err.Error())
			return
		}
		g.metrics.Sleep()
		g.log("[gw] " + target.Key + ": idle " + strconv.Itoa(windowMs) + "ms -> scaled to zero")

		// TOCTOU heal: a connection may have arrived while Sleep was in
		// flight. If so, wake the compute right back — the arriving client is
		// held by its own wake retry loop and recovers seamlessly.
		g.mu.Lock()
		arrived := e.count > 0 && !g.closed
		g.mu.Unlock()
		if arrived {
			g.log("[gw] " + target.Key + ": connection arrived during scale-down, waking back")
			if err := g.driver.Wake(context.Background(), target); err != nil {
				g.metrics.WakeBackFailure()
				g.log("[gw] " + target.Key + ": wake-back failed: " + err.Error())
			}
		}
	})
}
