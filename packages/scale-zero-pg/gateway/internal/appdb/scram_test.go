package appdb

import (
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/base64"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// Known-answer vs an independent reference (Python hashlib.pbkdf2_hmac) for a fixed
// salt — guards the exact SCRAM-SHA-256 verifier format Postgres stores (issue #117).
// A verifier that stores verbatim but was computed wrong = broken auth for a tenant,
// so this pins the algorithm, not just the shape.
func TestScramVerifierKnownAnswer(t *testing.T) {
	salt := make([]byte, 16)
	for i := range salt {
		salt[i] = byte(i)
	}
	got, err := scramVerifierWithSalt("testpw", salt, 4096)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	// Reference produced by: python3 hashlib.pbkdf2_hmac('sha256', b'testpw', bytes(range(16)), 4096)
	want := "SCRAM-SHA-256$4096:AAECAwQFBgcICQoLDA0ODw==$QrhMnRxNx5mRkqBsrQ9lHSZWruDBcaYycFp7Ykj4OKI=:Xx3Wxoij424IayeN5aWi0aKFkzudLl8ZToeis0byFSQ="
	if got != want {
		t.Fatalf("verifier mismatch:\n got=%s\nwant=%s", got, want)
	}
}

// Round-trip: parse a fresh verifier and re-derive StoredKey/ServerKey from the known
// password + parsed salt — proves the verifier actually corresponds to the password
// (the "authenticates" guarantee, minus a live server).
func TestScramVerifierRoundTrips(t *testing.T) {
	const pw = "s3cr'et-π-\"quote"
	v, err := scramSHA256Verifier(pw)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	if !regexp.MustCompile(`^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$`).MatchString(v) {
		t.Fatalf("verifier format wrong: %s", v)
	}
	// Parse SCRAM-SHA-256$<iters>:<salt>$<stored>:<server>
	body := strings.TrimPrefix(v, "SCRAM-SHA-256$")
	iterSalt, keys, _ := strings.Cut(body, "$")
	iterStr, saltB64, _ := strings.Cut(iterSalt, ":")
	storedB64, serverB64, _ := strings.Cut(keys, ":")
	iters, _ := strconv.Atoi(iterStr)
	salt, _ := base64.StdEncoding.DecodeString(saltB64)

	salted, err := pbkdf2.Key(sha256.New, pw, salt, iters, sha256.Size)
	if err != nil {
		t.Fatalf("pbkdf2: %v", err)
	}
	ck := hmac.New(sha256.New, salted)
	ck.Write([]byte("Client Key"))
	wantStored := sha256.Sum256(ck.Sum(nil))
	sk := hmac.New(sha256.New, salted)
	sk.Write([]byte("Server Key"))
	wantServer := sk.Sum(nil)

	if got := base64.StdEncoding.EncodeToString(wantStored[:]); got != storedB64 {
		t.Errorf("StoredKey mismatch: verifier=%s rederived=%s", storedB64, got)
	}
	if got := base64.StdEncoding.EncodeToString(wantServer); got != serverB64 {
		t.Errorf("ServerKey mismatch: verifier=%s rederived=%s", serverB64, got)
	}
}
