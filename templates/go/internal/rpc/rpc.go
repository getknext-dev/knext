// Package rpc wires the function: the connect-go v2 server with its
// interceptors (OTel, panic recovery, the token check), the gRPC health
// service, and an HTTP server that speaks HTTP/2 cleartext (h2c) and
// HTTP/1.1 on one port.
package rpc

import (
	"context"
	"errors"
	"iter"
	"log/slog"
	"net"
	"net/http"
	"time"

	"connectrpc.com/connect/v2"
	"connectrpc.com/connect/v2/connecthttp"
	"connectrpc.com/grpchealth/v2"
	"connectrpc.com/otelconnect"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"example.com/function/gen/example/v1/examplev1connect"
	"example.com/function/internal/auth"
	"example.com/function/internal/items"
)

// MaxRequestBytes bounds one request message.
const MaxRequestBytes = 4 << 20

// ShutdownGrace is how long in-flight calls get to finish after SIGTERM.
const ShutdownGrace = 25 * time.Second

// Config is the function's runtime configuration.
type Config struct {
	// Addr is the listen address, ":8080" when empty.
	Addr string
	// JWKSPath is the mounted JWKS file the token check reads.
	JWKSPath string
	// Logger defaults to slog.Default().
	Logger *slog.Logger
	// TracerProvider defaults to the global OTel provider.
	TracerProvider trace.TracerProvider
}

// Function is the assembled server.
type Function struct {
	HTTP   *http.Server
	rpc    *connect.Server
	logger *slog.Logger
}

// New assembles the function with the token check reading the JWKS mounted
// at cfg.JWKSPath. This is the only constructor the binary uses.
func New(cfg Config) (*Function, error) {
	return newFunction(cfg, auth.MountedJWKS(cfg.JWKSPath))
}

func newFunction(cfg Config, verifier auth.Verifier) (*Function, error) {
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	otelOptions := []otelconnect.Option{
		otelconnect.WithPropagator(propagation.NewCompositeTextMapPropagator(
			propagation.TraceContext{}, propagation.Baggage{},
		)),
	}
	if cfg.TracerProvider != nil {
		otelOptions = append(otelOptions, otelconnect.WithTracerProvider(cfg.TracerProvider))
	}
	otelInterceptor, err := otelconnect.NewServerInterceptor(otelOptions...)
	if err != nil {
		return nil, err
	}

	// Interceptors run in argument order, the first outermost: every call is
	// traced (refusals included), a panic is contained, and the token is
	// checked before any request payload is read.
	rpc := connect.NewServer(
		otelInterceptor,
		recoverInterceptor,
		auth.NewInterceptor(verifier),
	)
	examplev1connect.RegisterExampleServiceHandler(rpc, items.NewService())
	grpchealth.Register(rpc, grpchealth.NewStaticChecker(examplev1connect.ExampleServiceName))

	mux := http.NewServeMux()
	connecthttp.Mount(mux, rpc, connecthttp.WithReadMaxBytes(MaxRequestBytes))

	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true)
	addr := cfg.Addr
	if addr == "" {
		addr = ":8080"
	}
	return &Function{
		HTTP: &http.Server{
			Addr:              addr,
			Handler:           mux,
			Protocols:         protocols,
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       120 * time.Second,
		},
		rpc:    rpc,
		logger: logger,
	}, nil
}

// Specs lists every registered procedure.
func (f *Function) Specs() iter.Seq[connect.Spec] {
	return f.rpc.Specs()
}

// Serve serves on ln until ctx is done, then drains in-flight calls for up to
// ShutdownGrace. It returns nil after a clean shutdown.
func (f *Function) Serve(ctx context.Context, ln net.Listener) error {
	errs := make(chan error, 1)
	go func() { errs <- f.HTTP.Serve(ln) }()
	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), ShutdownGrace)
	defer cancel()
	if err := f.HTTP.Shutdown(shutdownCtx); err != nil {
		return err
	}
	if err := <-errs; !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// recoverInterceptor answers a panicking handler with CodeInternal, without
// the panic value, and logs it.
func recoverInterceptor(next connect.ServerFunc) connect.ServerFunc {
	return func(ctx context.Context, spec connect.Spec, stream connect.ServerStream) (err error) {
		defer func() {
			if r := recover(); r != nil {
				slog.ErrorContext(ctx, "handler panicked", "procedure", spec.Procedure, "panic", r)
				err = connect.NewError(connect.CodeInternal, "internal error")
			}
		}()
		return next(ctx, spec, stream)
	}
}
