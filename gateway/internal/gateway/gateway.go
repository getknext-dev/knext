// Package gateway is the wake-on-connect Postgres proxy server. STUB — red.
package gateway

import (
	"net"

	"github.com/alpheya/scale-zero-pg/gateway/internal/metrics"
	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// Gateway accepts client connections, wakes compute, and pipes bytes. STUB.
type Gateway struct {
	driver  wake.Driver
	metrics *metrics.Metrics
}

// New builds a Gateway from env. STUB.
func New(env wake.Env, log func(string)) (*Gateway, error) {
	return &Gateway{metrics: metrics.NewMetrics()}, nil
}

// Serve runs the accept loop on ln. STUB.
func (g *Gateway) Serve(ln net.Listener) {}

// Metrics returns the metrics registry.
func (g *Gateway) Metrics() *metrics.Metrics { return g.metrics }

// Driver returns the compute driver.
func (g *Gateway) Driver() wake.Driver { return g.driver }

// Close stops the gateway. STUB.
func (g *Gateway) Close() error { return nil }
