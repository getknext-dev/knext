// Package testvectors loads the shared zone-identity token vectors that the
// token verifier is tested against: packages/grpc/testdata/z7-token-vectors.json
// in the knext repository, the one file the Go and Rust verifiers and the
// zone-side signer all share. Only tests import it.
//
// The keys in that file are test material derived from public labels; nothing
// here is, or may ever be used as, a real key.
package testvectors

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// EnvPath overrides where the vectors are read from, for a copy of this
// template outside the knext repository.
const EnvPath = "KNEXT_Z7_VECTORS"

// File is the vectors file.
type File struct {
	Contract struct {
		MaxLifetimeSeconds  int64 `json:"maxLifetimeSeconds"`
		ClockSkewSeconds    int64 `json:"clockSkewSeconds"`
		DefaultSeenCapacity int   `json:"defaultSeenCapacity"`
		JTIChars            struct {
			Min int `json:"min"`
			Max int `json:"max"`
		} `json:"jtiChars"`
	} `json:"contract"`
	Verifier struct {
		Issuer   string `json:"issuer"`
		Audience string `json:"audience"`
	} `json:"verifier"`
	Reasons []string                   `json:"reasons"`
	Keys    map[string]Key             `json:"keys"`
	JWKS    map[string]json.RawMessage `json:"jwks"`
	Cases   []Case                     `json:"cases"`
	// Sequences present several tokens, in order, to ONE verifier: the replay rules.
	Sequences []Sequence `json:"sequences"`
}

// Key is one test key: Seed is the base64url Ed25519 seed (test material).
type Key struct {
	Label string `json:"label"`
	Seed  string `json:"seed"`
	KID   string `json:"kid"`
	X     string `json:"x"`
}

// Case is one token and what a verifier must make of it.
type Case struct {
	Name      string   `json:"name"`
	JWKS      string   `json:"jwks"`
	Procedure string   `json:"procedure"`
	Auth      string   `json:"auth"`
	Now       int64    `json:"now"`
	JWS       []string `json:"jws"`
	Expect    string   `json:"expect"`
	Sub       string   `json:"sub"`
	Reason    string   `json:"reason"`
}

// Sequence is a run of tokens presented to one verifier, each at its own clock
// reading. Capacity is the verifier's replay-set size (nil: its default).
type Sequence struct {
	Name      string `json:"name"`
	JWKS      string `json:"jwks"`
	Procedure string `json:"procedure"`
	Auth      string `json:"auth"`
	Capacity  *int   `json:"capacity"`
	Steps     []Step `json:"steps"`
}

// Step is one token in a Sequence and what the verifier must make of it.
type Step struct {
	Now    int64    `json:"now"`
	JWS    []string `json:"jws"`
	Expect string   `json:"expect"`
	Sub    string   `json:"sub"`
	Reason string   `json:"reason"`
}

// Token is the step's compact JWS.
func (s Step) Token() string { return strings.Join(s.JWS, ".") }

// Token is the compact JWS, and false for the case with no token at all.
func (c Case) Token() (string, bool) {
	if c.JWS == nil {
		return "", false
	}
	return strings.Join(c.JWS, "."), true
}

// Path is where the vectors are read from.
func Path() string {
	if p := os.Getenv(EnvPath); p != "" {
		return p
	}
	_, here, _, _ := runtime.Caller(0)
	// templates/go/internal/testvectors -> the repository root.
	return filepath.Join(filepath.Dir(here), "..", "..", "..", "..", "packages", "grpc", "testdata", "z7-token-vectors.json")
}

// Load reads the vectors, failing the test (never skipping it) if they are
// missing: a verifier test that cannot find its vectors proves nothing.
func Load(t testing.TB) *File {
	t.Helper()
	data, err := os.ReadFile(Path())
	if err != nil {
		t.Fatalf("read the shared token vectors (set %s for a copy outside the knext repository): %v", EnvPath, err)
	}
	var f File
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("parse the shared token vectors: %v", err)
	}
	if len(f.Cases) == 0 || len(f.JWKS) == 0 {
		t.Fatal("the shared token vectors hold no cases or no JWK Sets")
	}
	return &f
}

// Case returns the named case.
func (f *File) Case(t testing.TB, name string) Case {
	t.Helper()
	for _, c := range f.Cases {
		if c.Name == name {
			return c
		}
	}
	t.Fatalf("no vector case %q", name)
	return Case{}
}

// Token returns the named case's token.
func (f *File) Token(t testing.TB, name string) string {
	t.Helper()
	token, ok := f.Case(t, name).Token()
	if !ok {
		t.Fatalf("vector case %q has no token", name)
	}
	return token
}

// JWKSBytes returns the named JWK Set as it would be mounted.
func (f *File) JWKSBytes(t testing.TB, name string) []byte {
	t.Helper()
	set, ok := f.JWKS[name]
	if !ok {
		t.Fatalf("no vector JWK Set %q", name)
	}
	return set
}

// WriteJWKS writes the named JWK Set to path, replacing what is there.
func (f *File) WriteJWKS(t testing.TB, path, name string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, f.JWKSBytes(t, name), 0o600); err != nil {
		t.Fatal(err)
	}
}
