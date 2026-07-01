// Package metrics exposes JSON + Prometheus text metrics and /healthz. STUB — red.
package metrics

import "net/http"

// Metrics holds gateway counters. STUB.
type Metrics struct{}

// NewMetrics constructs a Metrics. STUB.
func NewMetrics() *Metrics { return &Metrics{} }

func (m *Metrics) ConnOpen(key string)          {}
func (m *Metrics) ConnClose(key string)         {}
func (m *Metrics) Wake(key string, ms int64)    {}
func (m *Metrics) WakeFailure()                 {}
func (m *Metrics) Sleep()                        {}
func (m *Metrics) Wakes() int                    { return 0 }
func (m *Metrics) Active() int                   { return 0 }
func (m *Metrics) Sleeps() int                   { return 0 }
func (m *Metrics) Connections() int              { return 0 }
func (m *Metrics) WakeFailures() int             { return 0 }

// PromText renders Prometheus text. STUB.
func (m *Metrics) PromText() string { return "" }

// Handler returns the metrics HTTP handler. STUB.
func (m *Metrics) Handler() http.Handler { return http.NewServeMux() }
