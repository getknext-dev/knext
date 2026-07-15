// Command writer-autoscaler is the writer vertical-autoscaler (issue #103). It
// watches each writer compute's CPU+memory pressure (via metrics-server) and
// applies the proven #67 in-place pod resize (the pods/resize subresource) within
// operator-configured min/max bounds — growing/shrinking a RUNNING Postgres writer
// with ZERO restart. Per-app aware: one selector covers the primary `compute` and
// every per-app `compute-<app>` writer.
//
// Hard invariant: it NEVER bounces a live writer. CPU and memory limits actuate
// live; shared_buffers is boot-fixed, so a writer that is memory-bound AT its max
// limit is FLAGGED (annotated) for an operator maintenance-window bounce, never
// bounced here. See docs/operations.md "Writer vertical-autoscaler".
//
// Ships in the same multi-binary image as the gateway; the Deployment overrides
// ENTRYPOINT to /writer-autoscaler. Config is env-only (12-factor); see WAS_* below.
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

	"k8s.io/apimachinery/pkg/api/resource"

	"github.com/alpheya/scale-zero-pg/gateway/internal/writerscaler"
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

func envFloat(key string, def float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}

// qtyMilli parses a CPU quantity string (e.g. "250m", "2") to millicores.
func qtyMilli(logger *log.Logger, key, val string) int64 {
	q, err := resource.ParseQuantity(val)
	if err != nil {
		logger.Fatalf("[writer-autoscaler] %s=%q is not a valid CPU quantity: %v", key, val, err)
	}
	return q.MilliValue()
}

// qtyBytes parses a memory quantity string (e.g. "256Mi", "1Gi") to bytes.
func qtyBytes(logger *log.Logger, key, val string) int64 {
	q, err := resource.ParseQuantity(val)
	if err != nil {
		logger.Fatalf("[writer-autoscaler] %s=%q is not a valid memory quantity: %v", key, val, err)
	}
	return q.Value()
}

func main() {
	logger := log.New(os.Stdout, "", log.LstdFlags|log.Lmicroseconds|log.LUTC)

	namespace := env("WAS_NAMESPACE", "scale-zero-pg")
	// WRITERS only: plane=compute is shared with per-app read replicas, which carry
	// role=ro — so exclude them. The base RO pool (app=compute-ro) has no plane label
	// and is excluded already. This is a WRITER autoscaler; read scaling is the RO
	// pool's job (HPA on compute-ro).
	selector := env("WAS_SELECTOR", "plane=compute,role!=ro")
	container := env("WAS_CONTAINER", "compute")
	pollMs := envInt("WAS_POLL_MS", 15000)
	healthAddr := env("WAS_HEALTH_ADDR", ":9092")

	cfg := writerscaler.Config{
		Bounds: writerscaler.Bounds{
			MinCPUMilli:  qtyMilli(logger, "WAS_MIN_CPU", env("WAS_MIN_CPU", "250m")),
			MaxCPUMilli:  qtyMilli(logger, "WAS_MAX_CPU", env("WAS_MAX_CPU", "2")),
			CPUStepMilli: qtyMilli(logger, "WAS_CPU_STEP", env("WAS_CPU_STEP", "250m")),
			MinMemBytes:  qtyBytes(logger, "WAS_MIN_MEM", env("WAS_MIN_MEM", "256Mi")),
			MaxMemBytes:  qtyBytes(logger, "WAS_MAX_MEM", env("WAS_MAX_MEM", "1Gi")),
			MemStepBytes: qtyBytes(logger, "WAS_MEM_STEP", env("WAS_MEM_STEP", "256Mi")),
			UpRatio:      envFloat("WAS_UP_RATIO", 0.80),
			DownRatio:    envFloat("WAS_DOWN_RATIO", 0.30),
		},
		UpHold:   envInt("WAS_UP_HOLD", 3),   // ~45s sustained at the 15s poll before scale-up
		DownHold: envInt("WAS_DOWN_HOLD", 8), // ~2min sustained idle before scale-down (conservative)
		Cooldown: envInt("WAS_COOLDOWN", 4),  // ~60s after any resize before the next (anti-flap)
	}

	k8s, err := writerscaler.NewK8sClient(namespace, selector, container)
	if err != nil {
		logger.Fatalf("[writer-autoscaler] kube client: %v", err)
	}
	metrics := writerscaler.NewMetrics()
	ctrl := writerscaler.NewController(k8s, cfg, metrics, logger)

	// Fail-soft metrics-server preflight: log its absence but keep running so a
	// transient outage doesn't crashloop the controller (the tick logs each miss).
	if _, uerr := k8s.Usage(context.Background()); uerr != nil {
		logger.Printf("[writer-autoscaler] WARN metrics preflight failed (will retry each tick): %v", uerr)
	}

	srv := &http.Server{Addr: healthAddr, Handler: metrics.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		logger.Printf("[writer-autoscaler] health/metrics on %s", healthAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatalf("[writer-autoscaler] health server: %v", err)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	logger.Printf("[writer-autoscaler] watching selector=%q ns=%s poll=%dms bounds=[cpu %dm..%dm/+%dm mem %dMi..%dMi/+%dMi] up>=%.2f down<=%.2f holds up=%d down=%d cooldown=%d",
		selector, namespace, pollMs,
		cfg.MinCPUMilli, cfg.MaxCPUMilli, cfg.CPUStepMilli,
		cfg.MinMemBytes>>20, cfg.MaxMemBytes>>20, cfg.MemStepBytes>>20,
		cfg.UpRatio, cfg.DownRatio, cfg.UpHold, cfg.DownHold, cfg.Cooldown)

	ticker := time.NewTicker(time.Duration(pollMs) * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			logger.Print("[writer-autoscaler] shutting down")
			shCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			_ = srv.Shutdown(shCtx)
			cancel()
			return
		case <-ticker.C:
			n, err := ctrl.Tick(ctx)
			if err != nil {
				logger.Printf("[writer-autoscaler] tick error: %v", err)
				continue
			}
			if n > 0 {
				logger.Printf("[writer-autoscaler] tick actuated %d resize(s)", n)
			}
		}
	}
}
