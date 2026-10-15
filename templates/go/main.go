// Command function is a knext zone function: a connect-go v2 server for the
// contract in proto/, reachable only from its zone, over HTTP/2 cleartext
// (h2c) or HTTP/1.1 on $PORT.
//
// Every RPC except the gRPC health check needs a bearer token from the
// owning zone. The check fails closed: with no JWKS mounted, every other RPC
// is refused.
package main

import (
	"context"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"

	"example.com/function/internal/auth"
	"example.com/function/internal/server"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)
	if err := run(logger); err != nil {
		logger.Error("function stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	fn, err := server.New(server.Config{
		Addr:     listenAddr(os.Getenv),
		JWKSPath: auth.DefaultJWKSPath,
		Logger:   logger,
	})
	if err != nil {
		return err
	}
	if _, err := os.Stat(auth.DefaultJWKSPath); err != nil {
		logger.Warn("no JWKS is mounted: every RPC except the health check will be refused",
			"jwks", auth.DefaultJWKSPath)
	}

	// Knative sends SIGTERM before it removes a pod; Serve drains in-flight
	// calls before returning.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	ln, err := net.Listen("tcp", fn.HTTP.Addr)
	if err != nil {
		return err
	}
	logger.Info("serving", "addr", ln.Addr().String())
	return fn.Serve(ctx, ln)
}

// listenAddr is ":$PORT", or ":8080" when PORT is unset (Knative sets it).
func listenAddr(getenv func(string) string) string {
	if port := getenv("PORT"); port != "" {
		return ":" + port
	}
	return ":8080"
}
