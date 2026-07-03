// Command pswatcher is the pageserver auto-failover controller. It watches the
// primary pageserver's liveness and, on sustained failure, automatically runs
// the proven failover runbook: promote the warm-Secondary standby at
// generation+1, flip the client Service selector to it, and bounce the compute
// so a cold wake re-attaches to the promoted standby. Ships in the same image
// as the gateway; the Deployment overrides ENTRYPOINT to /pswatcher.
//
// Config is env-only (12-factor); see PSW_* below.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/alpheya/scale-zero-pg/gateway/internal/pswatcher"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func main() {
	logger := log.New(os.Stdout, "", log.LstdFlags|log.Lmicroseconds|log.LUTC)

	namespace := env("PSW_NAMESPACE", "scale-zero-pg")
	statusURL := env("PSW_PRIMARY_STATUS_URL", "http://pageserver-primary:9898/v1/status")
	standbyBase := env("PSW_STANDBY_BASE_URL", "http://pageserver-standby:9898")
	clientSvc := env("PSW_CLIENT_SERVICE", "pageserver")
	standbyApp := env("PSW_STANDBY_SELECTOR_APP", "pageserver-standby")
	tenant := os.Getenv("PSW_TENANT_ID")
	genCM := env("PSW_GEN_CONFIGMAP", "pageserver-generation")
	computeSel := env("PSW_COMPUTE_SELECTOR", "app=compute")
	pollMs := envInt("PSW_POLL_MS", 2000)
	threshold := envInt("PSW_FAIL_THRESHOLD", 3)
	baseGen := envInt("PSW_BASE_GENERATION", 1)
	probeTimeoutMs := envInt("PSW_PROBE_TIMEOUT_MS", 2000)
	healthAddr := env("PSW_HEALTH_ADDR", ":9091")

	if tenant == "" {
		logger.Fatal("[pswatcher] PSW_TENANT_ID is required")
	}

	k8s, err := pswatcher.NewK8sClient(namespace, genCM)
	if err != nil {
		logger.Fatalf("[pswatcher] kube client: %v", err)
	}
	prober := pswatcher.NewHTTPProber(statusURL, time.Duration(probeTimeoutMs)*time.Millisecond)
	promoter := pswatcher.NewHTTPPromoter(standbyBase, 10*time.Second)
	metrics := pswatcher.NewMetrics()

	ctrl := pswatcher.NewController(prober, promoter, k8s, pswatcher.Config{
		Tenant:          tenant,
		ClientService:   clientSvc,
		StandbyApp:      standbyApp,
		ComputeSelector: computeSel,
		FailThreshold:   threshold,
		BaseGeneration:  baseGen,
	}, metrics)

	// /healthz + /metrics: liveness of the watcher itself + promotion counter.
	srv := &http.Server{Addr: healthAddr, Handler: metrics.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		logger.Printf("[pswatcher] health/metrics on %s", healthAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatalf("[pswatcher] health server: %v", err)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	logger.Printf("[pswatcher] watching %s (primary=%s standby=%s tenant=%s threshold=%d poll=%dms)",
		clientSvc, statusURL, standbyBase, tenant, threshold, pollMs)

	ticker := time.NewTicker(time.Duration(pollMs) * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			logger.Print("[pswatcher] shutting down")
			shCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			_ = srv.Shutdown(shCtx)
			cancel()
			return
		case <-ticker.C:
			failedOver, err := ctrl.Tick(ctx)
			if err != nil {
				logger.Printf("[pswatcher] tick error: %v", err)
				continue
			}
			if failedOver {
				logger.Printf("[pswatcher] FAILOVER: promoted standby %q, flipped %q, bounced %q (promotions=%d)",
					standbyApp, clientSvc, computeSel, metrics.Promotions())
			}
		}
	}
}
