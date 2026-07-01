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

	ln, err := net.Listen("tcp", ":"+strconv.Itoa(port))
	if err != nil {
		logger.Fatalf("[gw] listen: %v", err)
	}
	logger.Printf("[gw] listening on :%d mode=%s idle_ms=%d", port, gw.Driver().Mode(), envInt("GW_IDLE_MS", 300000))
	go gw.Serve(ln)

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
