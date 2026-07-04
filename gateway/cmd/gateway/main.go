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
	"syscall"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/gateway"
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

	// Peer-aware idle: with 2+ replicas, only sleep when the whole fleet is
	// at zero. Selector/namespace/self-IP come from the Deployment (downward
	// API); outside a cluster this stays nil and idle behaves single-replica.
	peers, err := gateway.NewK8sPeers(
		os.Getenv("GW_POD_NAMESPACE"), os.Getenv("GW_PEER_SELECTOR"), os.Getenv("GW_POD_IP"), metricsPort)
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

	// Read-only pool lane (issue #66): a SECOND listener on GW_RO_PORT routes
	// the DATABASE_URL_RO DSN to the compute-ro Deployment (0->N->0), reusing
	// the full wake/idle/TLS machinery via a GW_RO_*-remapped env. Absent
	// GW_RO_PORT, the RO lane is off and nothing changes for writer-only
	// deployments. No SQL parsing, no single-writer ceremony — the app opts in
	// by pointing reads at this port.
	if roPortStr := os.Getenv("GW_RO_PORT"); roPortStr != "" {
		roGw, err := gateway.New(wake.ROEnv(env), func(msg string) { logger.Println(msg) })
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
		defer func() { _ = roLn.Close(); _ = roGw.Close() }()
	}

	metricsSrv := &http.Server{Addr: ":" + strconv.Itoa(metricsPort), Handler: gw.Metrics().Handler()}
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

	_ = ln.Close()
	_ = gw.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = metricsSrv.Shutdown(ctx)
}
