// Command function is a knext zone function: a connect-go v2 server for the
// contract in proto/, reachable only from its zone, over HTTP/2 cleartext
// (h2c) or HTTP/1.1 on $PORT.
//
// Every RPC except the gRPC health check needs a bearer token from the
// owning zone, verified against the zone's JWKS (mounted as a volume) and the
// issuer and audience in $KNEXT_TOKEN_ISSUER and $KNEXT_TOKEN_AUDIENCE. The
// check fails closed: with no JWKS mounted, or either variable unset, every
// other RPC is refused.
package main

import (
	"context"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"

	"example.com/function/internal/auth"
	"example.com/function/internal/rpc"
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
	cfg := config(os.Getenv)
	cfg.Logger = logger
	fn, err := rpc.New(cfg)
	if err != nil {
		return err
	}
	if _, err := os.Stat(cfg.JWKSPath); err != nil {
		logger.Warn("no JWKS is mounted: every RPC except the health check will be refused",
			"jwks", cfg.JWKSPath)
	}
	if cfg.Issuer == "" || cfg.Audience == "" {
		logger.Warn("the token issuer or audience is not set: every RPC except the health check will be refused",
			"issuer_env", auth.EnvIssuer, "audience_env", auth.EnvAudience)
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

// config is the function's configuration from its environment: the port,
// and the issuer and audience the operator sets for the token check.
func config(getenv func(string) string) rpc.Config {
	return rpc.Config{
		Addr:     listenAddr(getenv),
		JWKSPath: auth.DefaultJWKSPath,
		Issuer:   getenv(auth.EnvIssuer),
		Audience: getenv(auth.EnvAudience),
	}
}

// listenAddr is ":$PORT", or ":8080" when PORT is unset (Knative sets it).
func listenAddr(getenv func(string) string) string {
	if port := getenv("PORT"); port != "" {
		return ":" + port
	}
	return ":8080"
}
