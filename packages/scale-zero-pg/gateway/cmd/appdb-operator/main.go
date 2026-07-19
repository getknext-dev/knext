// Command appdb-operator is the AppDatabase CRD controller (ADR-0004, #96): the
// v1.0 declarative provisioning interface for branch-per-app multi-tenancy. It
// reconciles each AppDatabase custom resource by reimplementing the proven logic of
// deploy/provision-app.sh in Go — branch the shared apps-template timeline, render
// the per-app compute (Deployment + Service + ConfigMap), mint the per-app
// credential Secret, and wire the apps-gateway routing — with a finalizer for safe
// deprovision and continuous reconciliation that heals drift.
//
// Ships in the same multi-binary image as the gateway; the Deployment overrides
// ENTRYPOINT to /appdb-operator. Config is env-only (12-factor); see APPDB_* below.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"syscall"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/alpheya/scale-zero-pg/gateway/internal/appdb"
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

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failure is fatal for a provisioner (would mint predictable ids).
		log.Fatalf("[appdb] crypto/rand: %v", err)
	}
	return hex.EncodeToString(b)
}

func main() {
	logger := log.New(os.Stdout, "", log.LstdFlags|log.Lmicroseconds|log.LUTC)

	namespace := env("APPDB_NAMESPACE", "scale-zero-pg")
	tenant := os.Getenv("APPDB_TENANT_ID")
	template := env("APPDB_TEMPLATE_TL", "a0000000000000000000000000000010")
	pgVersion := envInt("APPDB_PG_VERSION", 17)
	rolePrefix := env("APPDB_ROLE_PREFIX", "app_")
	gatewayHost := env("APPDB_GATEWAY_HOST", "pggw-apps.scale-zero-pg.svc")
	gatewayPort := envInt("APPDB_GATEWAY_PORT", 55432)
	gatewayROPort := envInt("APPDB_GATEWAY_RO_PORT", 55434) // DATABASE_URL_RO port (docs/connecting.md)
	pageserverURL := env("APPDB_PAGESERVER_URL", "http://pageserver:9898")
	pageserverHost := env("APPDB_PAGESERVER_HOST", "pageserver")
	skService := env("APPDB_SAFEKEEPER_SERVICE", "safekeeper")
	skPort := envInt("APPDB_SAFEKEEPER_PORT", 7676)
	skReplicas := envInt("APPDB_SAFEKEEPER_REPLICAS", 3)
	reclaimCM := env("APPDB_RECLAIM_CM", "apps-wal-reclaim-pending")
	resyncMs := envInt("APPDB_RESYNC_MS", 15000)
	healthAddr := env("APPDB_HEALTH_ADDR", ":9092")
	httpTimeout := time.Duration(envInt("APPDB_HTTP_TIMEOUT_MS", 10000)) * time.Millisecond
	// Bounds the warm-hold Dial/Ping (knext #388 review): a black-holed compute
	// must never stall reconciliation of every other AppDatabase behind it.
	warmHoldTimeout := time.Duration(envInt("APPDB_WARM_HOLD_TIMEOUT_MS", 5000)) * time.Millisecond

	if tenant == "" {
		logger.Fatal("[appdb] APPDB_TENANT_ID is required")
	}

	cfg, err := restConfig()
	if err != nil {
		logger.Fatalf("[appdb] kube config: %v", err)
	}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		logger.Fatalf("[appdb] clientset: %v", err)
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		logger.Fatalf("[appdb] dynamic client: %v", err)
	}

	render := appdb.DefaultRenderConfig(namespace)
	render.PageserverHost = pageserverHost
	render.PGVersion = strconv.Itoa(pgVersion)
	render.RolePrefix = rolePrefix
	render.ComputeImage = env("APPDB_COMPUTE_IMAGE", render.ComputeImage)
	render.InitImage = env("APPDB_INIT_IMAGE", render.InitImage)

	cluster := appdb.NewK8sCluster(cs, dyn, namespace, render, reclaimCM, logger)
	// The scheduled DB warm lockstep (knext #388, ADR-0030 addendum): while any
	// AppDatabase warmSchedule window is active the reconciler holds one
	// authenticated connection through the apps-gateway so the compute never goes
	// idle. The DSN comes from the operator-minted app-db-<app> Secret
	// (DatabaseURL); the dial is a real SCRAM connection (lib/pq) — never a
	// replica write (the gateway stays the sole scaler).
	holds := appdb.NewHoldManager(cluster.DatabaseURL, appdb.SQLDialer{ConnectTimeout: warmHoldTimeout}, warmHoldTimeout)

	deps := &appdb.Deps{
		Pageserver:    appdb.NewHTTPPageserver(pageserverURL, httpTimeout),
		Safekeeper:    appdb.NewHTTPSafekeeper(namespace, skService, skPort, skReplicas, httpTimeout),
		Cluster:       cluster,
		Holds:         holds,
		Tenant:        tenant,
		Template:      template,
		PGVersion:     pgVersion,
		RolePrefix:    rolePrefix,
		GatewayHost:   gatewayHost,
		GatewayPort:   gatewayPort,
		GatewayROPort: gatewayROPort,
		Namespace:     namespace,

		NewTimelineID: func() string { return randHex(16) }, // 32-hex, Neon timeline id
		NewPassword:   func() string { return randHex(18) },
		Now:           func() metav1.Time { return metav1.Now() },
	}

	ctrl := appdb.NewController(dyn, deps, namespace, time.Duration(resyncMs)*time.Millisecond, logger)

	// /healthz + /readyz for the Deployment probes; /metrics exposes the warm-hold
	// gauge (appdb_warm_hold_active{app=...} 1 per held app) so the
	// ComputePhantomKeepalive alert can subtract DELIBERATE warm holds from the
	// gateway's active-connection count (60-prometheus.yaml — a held window is
	// intended warming, not a phantom pool).
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		if ctrl.Healthy() {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ok"))
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("stale reconcile"))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, _ *http.Request) {
		held := holds.Held()
		apps := make([]string, 0, len(held))
		for app := range held {
			apps = append(apps, app)
		}
		sort.Strings(apps)
		w.Header().Set("content-type", "text/plain")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("# HELP appdb_warm_hold_active 1 while the appdb operator holds this app's compute warm for an active warmSchedule window (knext #388).\n"))
		_, _ = w.Write([]byte("# TYPE appdb_warm_hold_active gauge\n"))
		for _, app := range apps {
			_, _ = fmt.Fprintf(w, "appdb_warm_hold_active{app=%q} 1\n", app)
		}
	})
	srv := &http.Server{Addr: healthAddr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		logger.Printf("[appdb] health on %s", healthAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatalf("[appdb] health server: %v", err)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	logger.Printf("[appdb] operator starting (ns=%s tenant=%s template=%s pageserver=%s safekeepers=%d resync=%dms)",
		namespace, tenant, template, pageserverURL, skReplicas, resyncMs)

	runErr := ctrl.Run(ctx)
	shCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	_ = srv.Shutdown(shCtx)
	cancel()
	if runErr != nil {
		logger.Fatalf("[appdb] controller exited: %v", runErr)
	}
}

// restConfig resolves in-cluster config first, else the default kubeconfig rules
// (same pattern as cmd/pswatcher).
func restConfig() (*rest.Config, error) {
	if cfg, err := rest.InClusterConfig(); err == nil {
		return cfg, nil
	}
	loading := clientcmd.NewDefaultClientConfigLoadingRules()
	cc := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(loading, &clientcmd.ConfigOverrides{})
	return cc.ClientConfig()
}
