package gateway

import (
	"strings"
	"testing"

	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// F5 phase 3 (ADR-0003): New wires the BACKEND TLS client into the wake Opts,
// so every backend dial (warm fast path + cold-wake poll) goes out as TLS. The
// shipped default is ON — a manifest that forgets GW_COMPUTE_TLS is encrypted,
// not plaintext (fail-closed by construction).
func TestNewWiresBackendTLSOnByDefault(t *testing.T) {
	gw, err := New(wake.Env{"GW_COMPUTE_MODE": "static", "GW_TARGET": "127.0.0.1:1"}, func(string) {})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	b := gw.opts.BackendTLS
	if b == nil {
		t.Fatalf("backend TLS must default ON — New left Opts.BackendTLS nil, so the gateway->compute dial stays plaintext")
	}
	if b.CAFile == "" || b.CertFile == "" || b.KeyFile == "" {
		t.Fatalf("backend TLS wired without the cert paths: %+v", b)
	}
}

// The documented dev opt-out (local/kind, no cert-manager) disables it.
func TestNewBackendTLSDevOptOut(t *testing.T) {
	gw, err := New(wake.Env{"GW_COMPUTE_MODE": "static", "GW_TARGET": "127.0.0.1:1", "GW_COMPUTE_TLS": "false"}, func(string) {})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if gw.opts.BackendTLS != nil {
		t.Fatalf("GW_COMPUTE_TLS=false must disable the backend TLS client")
	}
}

// Half-configured backend TLS fails FAST at startup, like the front-door
// loadTLS guard — never a half-secure dial.
func TestNewRejectsHalfConfiguredBackendTLS(t *testing.T) {
	_, err := New(wake.Env{
		"GW_COMPUTE_MODE":            "static",
		"GW_TARGET":                  "127.0.0.1:1",
		"GW_COMPUTE_CLIENT_KEY_FILE": "  ",
	}, func(string) {})
	if err == nil {
		t.Fatalf("expected New to fail fast on a blanked GW_COMPUTE_CLIENT_KEY_FILE")
	}
	if !strings.Contains(err.Error(), "GW_COMPUTE_CLIENT_KEY_FILE") {
		t.Fatalf("error must name the offending knob, got: %v", err)
	}
}
