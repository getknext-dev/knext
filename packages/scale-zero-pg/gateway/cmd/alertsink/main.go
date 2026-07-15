// Command alertsink is a webhook receiver that LOGS every alert delivery —
// the verifiable end of the pager path. The alert-fire drill greps this log
// for the alertname, proving Prometheus -> Alertmanager -> receiver end to
// end. Replace with Slack/PagerDuty in production; keep this in dev/CI.
package main

import (
	"io"
	"log"
	"net/http"
	"os"
	"time"
)

func handler(logger *log.Logger) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			logger.Printf("[sink] read error: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		logger.Printf("[sink] %s %s %s", r.Method, r.URL.Path, string(body))
		w.WriteHeader(http.StatusOK)
	})
	return mux
}

func main() {
	logger := log.New(os.Stdout, "", log.LstdFlags|log.Lmicroseconds|log.LUTC)
	addr := ":8080"
	if v := os.Getenv("SINK_ADDR"); v != "" {
		addr = v
	}
	srv := &http.Server{
		Addr:              addr,
		Handler:           handler(logger),
		ReadHeaderTimeout: 5 * time.Second,
	}
	logger.Printf("[sink] listening on %s", addr)
	if err := srv.ListenAndServe(); err != nil {
		logger.Fatal(err)
	}
}
