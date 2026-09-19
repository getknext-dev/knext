package gateway

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/alpheya/scale-zero-pg/gateway/internal/wake"
)

// F5 phase 3 (ADR-0003): New wires the BACKEND TLS client into the wake Opts,
// so every backend dial (warm fast path + cold-wake poll) goes out as TLS. The
// shipped default is ON — a manifest that forgets GW_COMPUTE_TLS is encrypted,
// not plaintext (fail-closed by construction).
func TestNewWiresBackendTLSOnByDefault(t *testing.T) {
	ca, crt, key := testCerts(t)
	gw, err := New(wake.Env{
		"GW_COMPUTE_MODE":             "static",
		"GW_TARGET":                   "127.0.0.1:1",
		"GW_COMPUTE_CA_FILE":          ca,
		"GW_COMPUTE_CLIENT_CERT_FILE": crt,
		"GW_COMPUTE_CLIENT_KEY_FILE":  key,
	}, func(string) {})
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

// The ordinary missing-Secret case: both backend cert volumes are mounted
// optional:true, so a certless cluster would otherwise start a READY gateway
// that fails 100% of its connections. New must fail so the process exits
// non-zero and crashloops visibly until cert-manager issues the Secret.
func TestNewFailsFastWhenBackendCertsAreNotMounted(t *testing.T) {
	ca, crt, key := testCerts(t)
	absent := t.TempDir()

	for _, tc := range []struct {
		name         string
		ca, crt, key string
	}{
		{"CA not mounted", filepath.Join(absent, "ca.crt"), crt, key},
		{"client cert not mounted", ca, filepath.Join(absent, "tls.crt"), key},
		{"client key not mounted", ca, crt, filepath.Join(absent, "tls.key")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := New(wake.Env{
				"GW_COMPUTE_MODE":             "static",
				"GW_TARGET":                   "127.0.0.1:1",
				"GW_COMPUTE_CA_FILE":          tc.ca,
				"GW_COMPUTE_CLIENT_CERT_FILE": tc.crt,
				"GW_COMPUTE_CLIENT_KEY_FILE":  tc.key,
			}, func(string) {})
			if err == nil {
				t.Fatalf("New succeeded with %s — a Ready gateway that fails every backend dial", tc.name)
			}
		})
	}

	// The dev opt-out still boots on a certless cluster, without loading anything.
	if _, err := New(wake.Env{
		"GW_COMPUTE_MODE":             "static",
		"GW_TARGET":                   "127.0.0.1:1",
		"GW_COMPUTE_TLS":              "false",
		"GW_COMPUTE_CA_FILE":          filepath.Join(absent, "ca.crt"),
		"GW_COMPUTE_CLIENT_CERT_FILE": filepath.Join(absent, "tls.crt"),
		"GW_COMPUTE_CLIENT_KEY_FILE":  filepath.Join(absent, "tls.key"),
	}, func(string) {}); err != nil {
		t.Fatalf("GW_COMPUTE_TLS=false must still boot on a certless cluster: %v", err)
	}
}
