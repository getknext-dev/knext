package appdb

import (
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
)

// scramIterations is Postgres's default SCRAM-SHA-256 iteration count. Matching it
// keeps the precomputed verifier byte-compatible with one Postgres would produce for
// the same password via `ALTER ROLE ... PASSWORD` (issue #117).
const scramIterations = 4096

// scramSHA256Verifier precomputes a PostgreSQL SCRAM-SHA-256 password verifier for
// password, in the exact on-disk format Postgres stores (RFC 5802):
//
//	SCRAM-SHA-256$<iters>:<base64(salt)>$<base64(StoredKey)>:<base64(ServerKey)>
//
// compute_ctl stores a value in this recognised format VERBATIM as the role's
// encrypted_password (only a bare md5-hex value gets the "md5" prefix), so injecting
// this into the compute spec gives the app role a SCRAM verifier FROM BOOT — no
// post-boot ALTER, no cold-wake md5 window, and NO tenant plaintext ever lands on the
// compute (the verifier is non-reversible). PBKDF2 is the Go stdlib crypto/pbkdf2 (not
// hand-rolled). A fresh 16-byte random salt is drawn per call; because the per-app
// Secret is created-once and preserved on re-provision, the verifier is stable across
// reboots (compute_ctl re-applies the same value every boot — idempotent).
func scramSHA256Verifier(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("scram salt: %w", err)
	}
	return scramVerifierWithSalt(password, salt, scramIterations)
}

// scramVerifierWithSalt is the deterministic core (salt + iters injected) so tests can
// pin a salt and cross-check against a known-answer / round-trip.
func scramVerifierWithSalt(password string, salt []byte, iters int) (string, error) {
	salted, err := pbkdf2.Key(sha256.New, password, salt, iters, sha256.Size)
	if err != nil {
		return "", fmt.Errorf("pbkdf2: %w", err)
	}
	clientKey := hmacSHA256(salted, []byte("Client Key"))
	storedKey := sha256.Sum256(clientKey)
	serverKey := hmacSHA256(salted, []byte("Server Key"))
	b64 := base64.StdEncoding.EncodeToString
	return fmt.Sprintf("SCRAM-SHA-256$%d:%s$%s:%s",
		iters, b64(salt), b64(storedKey[:]), b64(serverKey)), nil
}

func hmacSHA256(key, msg []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(msg)
	return m.Sum(nil)
}
