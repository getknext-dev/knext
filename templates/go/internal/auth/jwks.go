package auth

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

// jwksFile is the zone's JWK Set as mounted. Kubernetes updates a ConfigMap
// volume in place, so the file is re-read when its modification time or size
// changes, and at least every JWKSRereadInterval regardless: a warm pod picks
// up a rotated key without a restart. A file that disappears, grows past
// MaxJWKSBytes or stops parsing fails closed; the keys of the last good read
// are not kept.
type jwksFile struct {
	path string
	now  func() time.Time

	mu     sync.Mutex
	loaded bool
	mtime  time.Time
	size   int64
	readAt time.Time
	cached map[string]ed25519.PublicKey
	err    error
}

func (f *jwksFile) keys() (map[string]ed25519.PublicKey, error) {
	info, err := os.Stat(f.path)
	if !jwksMounted(info, err) {
		return nil, ErrNoJWKS
	}
	if info.Size() > MaxJWKSBytes {
		return nil, fmt.Errorf("%w: larger than %d bytes", ErrBadJWKS, MaxJWKSBytes)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	now := f.now()
	if f.loaded && info.ModTime().Equal(f.mtime) && info.Size() == f.size && now.Sub(f.readAt) < JWKSRereadInterval {
		return f.cached, f.err
	}
	f.loaded = false
	data, err := readAtMost(f.path, MaxJWKSBytes)
	if err != nil {
		return nil, err
	}
	keys, err := parseJWKS(data)
	f.loaded, f.mtime, f.size, f.readAt, f.cached, f.err = true, info.ModTime(), info.Size(), now, keys, err
	return keys, err
}

// jwksMounted reports whether a stat found a non-empty regular file.
func jwksMounted(info os.FileInfo, err error) bool {
	return err == nil && info.Mode().IsRegular() && info.Size() > 0
}

func readAtMost(path string, limit int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, ErrNoJWKS
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, ErrNoJWKS
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("%w: larger than %d bytes", ErrBadJWKS, limit)
	}
	return data, nil
}

// parseJWKS returns the usable keys of an RFC 7517 JWK Set, by kid. A key is
// usable when it is an Ed25519 OKP key of 32 bytes whose kid is the one
// derived from it (keyID); any other entry is ignored, so a token naming it
// is refused as an unknown key. alg and use are informational.
func parseJWKS(data []byte) (map[string]ed25519.PublicKey, error) {
	var set struct {
		Keys []map[string]json.RawMessage `json:"keys"`
	}
	if err := json.Unmarshal(data, &set); err != nil || set.Keys == nil {
		return nil, fmt.Errorf("%w: not a JWK Set", ErrBadJWKS)
	}
	keys := make(map[string]ed25519.PublicKey, len(set.Keys))
	for _, k := range set.Keys {
		if jwkString(k, "kty") != "OKP" {
			continue
		}
		if jwkString(k, "crv") != "Ed25519" {
			continue
		}
		raw, err := segment(jwkString(k, "x"))
		if err != nil || len(raw) != ed25519.PublicKeySize {
			continue
		}
		kid := jwkString(k, "kid")
		if kid != keyID(raw) {
			continue
		}
		keys[kid] = ed25519.PublicKey(raw)
	}
	return keys, nil
}

func jwkString(k map[string]json.RawMessage, name string) string {
	var s string
	if json.Unmarshal(k[name], &s) != nil {
		return ""
	}
	return s
}

// keyID is the kid of a raw Ed25519 public key: base64url, unpadded, of the
// first 16 bytes of its SHA-256.
func keyID(raw []byte) string {
	sum := sha256.Sum256(raw)
	return base64.RawURLEncoding.EncodeToString(sum[:16])
}
