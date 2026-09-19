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
	standbyStatusURL := env("PSW_STANDBY_STATUS_URL", standbyBase+"/v1/status")
	// The generation view is resolved against the CURRENTLY-ROUTED pageserver — the
	// client Service the gateway and computes actually dial, whose selector a failover
	// flips — NOT a fixed primary URL. The primary is the node that is down in the very
	// failover this watcher exists for, and post-failover it is the DEMOTED node
	// holding the OLD (lower) generation, so seeding from it under-writes (#1098).
	routedBase := env("PSW_ROUTED_BASE_URL", "http://"+clientSvc+":9898")
	tenant := os.Getenv("PSW_TENANT_ID")
	// The apps tenant (a fixed well-known id, see deploy/83) is where EVERY per-app
	// AppDatabase lives as a timeline. The flipped `pageserver` Service routes it too,
	// so pswatcher must promote it alongside the base tenant on failover — promotion
	// scope == routing scope (#1098). Optional: empty on a base-only plane.
	appsTenant := os.Getenv("PSW_APPS_TENANT_ID")
	genCM := env("PSW_GEN_CONFIGMAP", "pageserver-generation")
	// Bounce EVERY compute that resolves through the flipped Service by the stable
	// plane label plane=compute (base writer, warm, base RO pool, and the
	// operator-rendered per-app writer + RO all carry it). The old app=compute
	// matched only the base writer, leaving per-app computes (app=compute-<app>)
	// pinned to the dead pageserver (#1097).
	computeSel := env("PSW_COMPUTE_SELECTOR", "plane=compute")
	primarySel := env("PSW_PRIMARY_SELECTOR", "app=pageserver")
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
	probeTimeout := time.Duration(probeTimeoutMs) * time.Millisecond
	prober := pswatcher.NewHTTPProber(statusURL, probeTimeout)
	// Post-failover the watcher re-anchors onto the promoted standby (issue #25).
	standbyProber := pswatcher.NewHTTPProber(standbyStatusURL, probeTimeout)
	promoter := pswatcher.NewHTTPPromoter(standbyBase, 10*time.Second)
	metrics := pswatcher.NewMetrics()

	// Routed-tenant set = base tenant + apps tenant (if configured). The base is
	// always first (never-skippable floor + seed gen source). Derived by the
	// unit-tested helper so the ordering/de-dup contract has a test, not a comment.
	tenants := pswatcher.RoutedTenants(tenant, appsTenant)

	ctrl := pswatcher.NewController(prober, standbyProber, promoter, k8s, pswatcher.Config{
		Tenant:          tenant,
		Tenants:         tenants,
		ClientService:   clientSvc,
		StandbyApp:      standbyApp,
		ComputeSelector: computeSel,
		PrimarySelector: primarySel,
		FailThreshold:   threshold,
		BaseGeneration:  baseGen,
	}, metrics)
	// The routed-pageserver generation view. Two consumers, both fail-closed: the
	// startup ledger seed/heal (recovers a pruned/empty key) and the SECOND VANTAGE
	// that must corroborate a standby not-found before a non-base routed tenant may
	// be skipped on failover (#1098).
	ctrl.SetGenerationViewer(pswatcher.NewHTTPGenerationViewer(routedBase, probeTimeout))
	ctrl.SetLogger(logger.Printf)

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

	// Seed/heal the durable ledger before the first tick so any failover reads a
	// recovered generation (#1098). Non-fatal: a refusal (the key is absent AND the
	// routed view could not recover a real generation) is logged and the key is left
	// absent, so the fail-closed readers (55-storage-init, provision-app.sh) refuse to
	// attach rather than attach at an invented floor.
	if err := ctrl.SeedLedger(ctx); err != nil {
		logger.Printf("[pswatcher] ledger seed/heal: %v (continuing; readers fail-closed on an unreadable ledger)", err)
	}

	logger.Printf("[pswatcher] watching %s (primary=%s standby=%s routed-view=%s tenants=%v threshold=%d poll=%dms)",
		clientSvc, statusURL, standbyBase, routedBase, tenants, threshold, pollMs)

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
