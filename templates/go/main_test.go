package main

import "testing"

func TestListenAddr(t *testing.T) {
	for port, want := range map[string]string{"": ":8080", "9000": ":9000"} {
		if got := listenAddr(func(string) string { return port }); got != want {
			t.Errorf("PORT=%q: listenAddr = %q; want %q", port, got, want)
		}
	}
}

// The issuer and audience the token check holds tokens to come from the env
// the operator sets on the function; unset, they stay empty, and the check
// then refuses every RPC except the health check.
func TestConfigFromEnv(t *testing.T) {
	env := map[string]string{
		"PORT":                 "9000",
		"KNEXT_TOKEN_ISSUER":   "knext:zone:shop/storefront",
		"KNEXT_TOKEN_AUDIENCE": "knext:fn:shop/orders",
	}
	cfg := config(func(k string) string { return env[k] })
	if cfg.Addr != ":9000" || cfg.Issuer != env["KNEXT_TOKEN_ISSUER"] || cfg.Audience != env["KNEXT_TOKEN_AUDIENCE"] {
		t.Fatalf("config = %+v; want the env's port, issuer and audience", cfg)
	}
	if cfg.JWKSPath != "/var/run/knext/jwks/jwks.json" {
		t.Fatalf("JWKSPath = %q; want the mounted volume's path", cfg.JWKSPath)
	}
	empty := config(func(string) string { return "" })
	if empty.Issuer != "" || empty.Audience != "" {
		t.Fatalf("config with no env = %+v; want no issuer and no audience", empty)
	}
}
