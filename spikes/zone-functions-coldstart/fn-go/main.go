// Z2 spike: a trivial Connect function (connect-go v2) served on the Knative
// $PORT, HTTP/1.1 and h2c on the same listener. Knative decides which one the
// queue-proxy speaks from the container port NAME (http1 vs h2c).
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"connectrpc.com/connect/v2"
	"connectrpc.com/connect/v2/connecthttp"

	zonefnv1 "github.com/getknext-dev/knext/spikes/zone-functions-coldstart/fn-go/gen/zonefn/v1"
	"github.com/getknext-dev/knext/spikes/zone-functions-coldstart/fn-go/gen/zonefn/v1/zonefnv1connect"
)

var started = time.Now()

type protoKey struct{}

type pingServer struct {
	zonefnv1connect.UnimplementedPingServiceHandler
}

func (pingServer) Ping(ctx context.Context, req *zonefnv1.PingRequest) (*zonefnv1.PingResponse, error) {
	proto, _ := ctx.Value(protoKey{}).(string)
	return &zonefnv1.PingResponse{
		Msg:      req.GetMsg(),
		Lang:     "go",
		UptimeMs: time.Since(started).Milliseconds(),
		Proto:    proto,
	}, nil
}

func main() {
	server := connect.NewServer()
	zonefnv1connect.RegisterPingServiceHandler(server, pingServer{})
	mux := http.NewServeMux()
	connecthttp.Mount(mux, server)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })

	withProto := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mux.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), protoKey{}, r.Proto)))
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	p := new(http.Protocols)
	p.SetHTTP1(true)
	p.SetUnencryptedHTTP2(true)
	s := &http.Server{
		Addr:              ":" + port,
		Handler:           withProto,
		Protocols:         p,
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("fn-go listening on :%s after %s", port, time.Since(started))
	if err := s.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}
