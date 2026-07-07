// Command zone-operator is the Zone CRD controller (ADR-0007, #139 v2-2): the
// zone-scaling axis (docs/SCALING.md §4). It reconciles each Zone custom resource by
// COMPOSING an AppDatabase (the zone's strong-consistency in-zone DB + RO pool,
// ADR-0006 delegation) and layering the cross-zone fabric on top — a per-zone
// REPLICATION role, publications (the declared export boundary), and per declared
// dataDependency a logical-replication subscription (mode: replicate, whose conninfo
// points at the apps-gateway so the merged #140 replication-wake wakes a sleeping
// publisher) or postgres_fdw foreign tables (mode: federate). A finalizer runs
// cross-zone deprovision hygiene (drop sub/pub/slot on peers) before the composed
// AppDatabase reclaims the timeline.
//
// Ships in the same multi-binary image as the gateway; the Deployment overrides
// ENTRYPOINT to /zone-operator. Config is env-only (12-factor); see ZONE_* below.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/alpheya/scale-zero-pg/gateway/internal/zone"
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
		log.Fatalf("[zone] crypto/rand: %v", err)
	}
	return hex.EncodeToString(b)
}

func main() {
	logger := log.New(os.Stdout, "", log.LstdFlags|log.Lmicroseconds|log.LUTC)

	namespace := env("ZONE_NAMESPACE", "scale-zero-pg")
	gatewayHost := env("ZONE_GATEWAY_HOST", "pggw-apps.scale-zero-pg.svc")
	gatewayPort := envInt("ZONE_GATEWAY_PORT", 55432)
	replRolePrefix := env("ZONE_REPL_ROLE_PREFIX", "repl_") // lock-step with apps-gateway GW_REPL_ROLE_PREFIX (#140)
	resyncMs := envInt("ZONE_RESYNC_MS", 15000)
	wakeTimeoutSec := envInt("ZONE_WAKE_TIMEOUT_SEC", 120)
	healthAddr := env("ZONE_HEALTH_ADDR", ":9093")

	cfg, err := restConfig()
	if err != nil {
		logger.Fatalf("[zone] kube config: %v", err)
	}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		logger.Fatalf("[zone] clientset: %v", err)
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		logger.Fatalf("[zone] dynamic client: %v", err)
	}

	cluster := zone.NewK8sCluster(cs, dyn, namespace, wakeTimeoutSec, logger)
	deps := &zone.Deps{
		AppDB:   zone.NewDynAppDB(dyn, namespace),
		SQL:     zone.NewDynSQL(cs, cfg, namespace, gatewayHost, gatewayPort, cluster.WakeCompute),
		Cluster: cluster,
		Zones:   cluster,

		Namespace:      namespace,
		GatewayHost:    gatewayHost,
		GatewayPort:    gatewayPort,
		ReplRolePrefix: replRolePrefix,

		NewPassword: func() string { return randHex(18) },
		Now:         func() metav1.Time { return metav1.Now() },
	}

	ctrl := zone.NewController(dyn, deps, namespace, time.Duration(resyncMs)*time.Millisecond, logger)

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
	srv := &http.Server{Addr: healthAddr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		logger.Printf("[zone] health on %s", healthAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatalf("[zone] health server: %v", err)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	logger.Printf("[zone] operator starting (ns=%s gateway=%s:%d replPrefix=%s resync=%dms)",
		namespace, gatewayHost, gatewayPort, replRolePrefix, resyncMs)

	runErr := ctrl.Run(ctx)
	shCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	_ = srv.Shutdown(shCtx)
	cancel()
	if runErr != nil {
		logger.Fatalf("[zone] controller exited: %v", runErr)
	}
}

// restConfig resolves in-cluster config first, else the default kubeconfig rules.
func restConfig() (*rest.Config, error) {
	if cfg, err := rest.InClusterConfig(); err == nil {
		return cfg, nil
	}
	loading := clientcmd.NewDefaultClientConfigLoadingRules()
	cc := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(loading, &clientcmd.ConfigOverrides{})
	return cc.ClientConfig()
}
