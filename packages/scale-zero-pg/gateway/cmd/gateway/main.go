// Command gateway is the wake-on-connect Postgres proxy.
package main

import (
	"context"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/gateway"
	"github.com/alpheya/scale-zero-pg/gateway/internal/metrics"
	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func main() {
	logger := log.New(os.Stderr, "", 0)
	env := wake.EnvFromOS()

	gw, err := gateway.New(env, func(msg string) { logger.Println(msg) })
	if err != nil {
		logger.Fatalf("[gw] %v", err)
	}

	port := envInt("GW_PORT", 55432)
	metricsPort := envInt("GW_METRICS_PORT", 9090)

	// F6: fail-closed by construction. Resolve the peer-scrape bearer token BEFORE
	// serving /metrics.json. An empty GW_PEER_TOKEN with no explicit
	// GW_PEER_AUTH_DISABLED=true opt-out aborts the boot — never a silent open.
	peerAuth, err := metrics.ResolvePeerAuth(os.Getenv)
	if err != nil {
		logger.Fatalf("[gw] %v", err)
	}
	if peerAuth.Disabled() {
		logger.Printf("[gw] WARN: GW_PEER_AUTH_DISABLED=true — /metrics.json peer idle-scrape is UNAUTHENTICATED. Dev-only; NEVER run this in a shared/production cluster.")
	}

	// Peer-aware idle: with 2+ replicas, only sleep when the whole fleet is
	// at zero. Selector/namespace/self-IP come from the Deployment (downward
	// API); outside a cluster this stays nil and idle behaves single-replica.
	peers, err := gateway.NewK8sPeers(
		os.Getenv("GW_POD_NAMESPACE"), os.Getenv("GW_PEER_SELECTOR"), os.Getenv("GW_POD_IP"), metricsPort, os.Getenv("GW_PEER_TOKEN"))
	if err != nil {
		logger.Fatalf("[gw] peer checker: %v", err)
	}
	if peers != nil {
		gw.Peers = peers
		logger.Printf("[gw] peer-aware idle enabled (selector=%s)", os.Getenv("GW_PEER_SELECTOR"))
	}

	ln, err := net.Listen("tcp", ":"+strconv.Itoa(port))
	if err != nil {
		logger.Fatalf("[gw] listen: %v", err)
	}
	logger.Printf("[gw] listening on :%d mode=%s idle_ms=%d", port, gw.Driver().Mode(), envInt("GW_IDLE_MS", 300000))
	go gw.Serve(ln)

	// RO lane handles, wired below if GW_RO_PORT is set; drained on SIGTERM
	// alongside the writer lane (issue #1016).
	var roLnActive net.Listener
	var roGwActive *gateway.Gateway

	// Read-only pool lane (issue #66): a SECOND listener on GW_RO_PORT routes
	// the DATABASE_URL_RO DSN to a read-only compute (0->N->0), reusing the full
	// wake/idle/TLS machinery via a GW_RO_*-remapped env. Absent GW_RO_PORT, the
	// RO lane is off and nothing changes for writer-only deployments. No SQL
	// parsing, no single-writer ceremony — the app opts in by pointing reads here.
	//
	// The RO lane MIRRORS the writer lane's mode (issue #127):
	//   - kubectl base  (primary pggw):  ROEnv         -> single fixed compute-ro.
	//   - template base (apps  pggw):    ROTemplateEnv -> PER-APP compute-ro-<app>,
	//     so app A's reads NEVER reach app B's (or the shared primary) pool. Using
	//     the kubectl ROEnv on the apps-gateway would be a cross-tenant data leak.
	if roPortStr := os.Getenv("GW_RO_PORT"); roPortStr != "" {
		roEnv := wake.ROEnv(env)
		if os.Getenv("GW_COMPUTE_MODE") == "template" {
			roEnv = wake.ROTemplateEnv(env)
			logger.Printf("[gw-ro] template mode: per-app RO routing (compute-ro-<app>), tenant-isolated")
		}
		roGw, err := gateway.New(roEnv, func(msg string) { logger.Println(msg) })
		if err != nil {
			logger.Fatalf("[gw-ro] %v", err)
		}
		if peers != nil {
			roGw.Peers = peers
		}
		roPort := envInt("GW_RO_PORT", 55434)
		roLn, err := net.Listen("tcp", ":"+strconv.Itoa(roPort))
		if err != nil {
			logger.Fatalf("[gw-ro] listen: %v", err)
		}
		logger.Printf("[gw-ro] read-only pool listening on :%d deploy=%s wake_replicas=%d idle_ms=%d",
			roPort, os.Getenv("GW_RO_DEPLOYMENT"), envInt("GW_RO_WAKE_REPLICAS", 1),
			envInt("GW_RO_IDLE_MS", envInt("GW_IDLE_MS", 300000)))
		go roGw.Serve(roLn)
		roLnActive, roGwActive = roLn, roGw
	}

	metricsSrv := &http.Server{Addr: ":" + strconv.Itoa(metricsPort), Handler: gw.Metrics().HandlerWithPeerAuth(peerAuth)}
	go func() {
		if err := metricsSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Printf("[gw] metrics server: %v", err)
		}
	}()
	logger.Printf("[gw] metrics on :%d/metrics", metricsPort)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig
	logger.Println("[gw] shutting down")

	// Stop accepting new connections on BOTH lanes first, then gracefully drain
	// in-flight proxied sessions — bounded by GW_DRAIN_DEADLINE_MS — so no
	// in-flight Postgres session is reset on scale-down/redeploy (issue #1016).
	// terminationGracePeriodSeconds in deploy/10-gateway.yaml must cover this.
	_ = ln.Close()
	if roLnActive != nil {
		_ = roLnActive.Close()
	}
	drainMs := envInt("GW_DRAIN_DEADLINE_MS", 25000)
	drainCtx, drainCancel := context.WithTimeout(context.Background(), time.Duration(drainMs)*time.Millisecond)
	logger.Printf("[gw] draining in-flight connections (deadline %dms)", drainMs)
	if roGwActive != nil {
		var wg sync.WaitGroup
		wg.Add(1)
		go func() { defer wg.Done(); _ = roGwActive.Drain(drainCtx) }()
		_ = gw.Drain(drainCtx)
		wg.Wait()
	} else {
		_ = gw.Drain(drainCtx)
	}
	drainCancel()
	logger.Println("[gw] drain complete")

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = metricsSrv.Shutdown(ctx)
}
