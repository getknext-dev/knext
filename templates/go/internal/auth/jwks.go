package auth

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"os"
	"slices"
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

// privateJWKMembers hold private or symmetric key material (RFC 7517, RFC
// 7518 §6.2.2, §6.3.2, §6.4). A published JWK Set holds public keys only.
var privateJWKMembers = []string{"d", "p", "q", "dp", "dq", "qi", "oth", "k"}

// parseJWKS returns the usable keys of an RFC 7517 JWK Set, by kid. A key is
// usable when it is an Ed25519 OKP key of 32 bytes whose kid is the one
// derived from it (keyID) and which is a strong point (strongKey); any other
// entry is ignored, so a token naming it is refused as an unknown key. alg
// and use are informational. A set in which any JWK carries private key
// material is refused whole: whatever published it leaked a private key, and
// that must surface rather than be quietly skipped.
func parseJWKS(data []byte) (map[string]ed25519.PublicKey, error) {
	var set struct {
		Keys []map[string]json.RawMessage `json:"keys"`
	}
	if err := json.Unmarshal(data, &set); err != nil || set.Keys == nil {
		return nil, fmt.Errorf("%w: not a JWK Set", ErrBadJWKS)
	}
	for _, k := range set.Keys {
		for _, member := range privateJWKMembers {
			if _, ok := k[member]; ok {
				return nil, fmt.Errorf("%w: a JWK carries the private member %q", ErrBadJWKS, member)
			}
		}
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
		if !strongKey(raw) {
			continue
		}
		keys[kid] = ed25519.PublicKey(raw)
	}
	return keys, nil
}

// edwards25519 over math/big, enough to vet a public key (RFC 8032 §5.1.3).
// crypto/ed25519 verifies with any 32 bytes that decode, including a point of
// small order, for which R = identity, S = 0 is a valid signature of many
// messages (of every message, for the identity itself). Public keys are
// public, so variable time is fine.
var (
	fieldP = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 255), big.NewInt(19))
	// curveD is -121665/121666 mod p.
	curveD = new(big.Int).Mod(new(big.Int).Mul(big.NewInt(-121665),
		new(big.Int).ModInverse(big.NewInt(121666), fieldP)), fieldP)
)

// strongKey reports whether raw is the canonical encoding of a point of the
// curve outside its small-order subgroup: y < p, y on the curve, and [8]A is
// not the identity. Which of the two x the sign bit picks does not matter
// here: A and -A have the same order.
func strongKey(raw []byte) bool {
	be := slices.Clone(raw)
	be[31] &= 0x7f
	slices.Reverse(be)
	y := new(big.Int).SetBytes(be)
	if y.Cmp(fieldP) >= 0 {
		return false
	}
	x := curveX(y)
	if x == nil {
		return false
	}
	return !smallOrder(x, y)
}

// curveX returns an x with (x, y) on the curve, -x^2 + y^2 = 1 + d x^2 y^2,
// or nil when there is none.
func curveX(y *big.Int) *big.Int {
	yy := new(big.Int).Mul(y, y)
	u := new(big.Int).Sub(yy, big.NewInt(1))
	v := new(big.Int).Add(new(big.Int).Mul(curveD, yy), big.NewInt(1))
	xx := new(big.Int).Mul(u, new(big.Int).ModInverse(v.Mod(v, fieldP), fieldP))
	return new(big.Int).ModSqrt(xx.Mod(xx, fieldP), fieldP)
}

// smallOrder reports whether [8](x, y) is the identity (0, 1).
func smallOrder(x, y *big.Int) bool {
	for range 3 {
		x, y = double(x, y)
	}
	return x.Sign() == 0 && y.Cmp(big.NewInt(1)) == 0
}

// double is the twisted Edwards addition law (a = -1) for (x, y) + (x, y):
// complete on this curve, because d is not a square mod p.
func double(x, y *big.Int) (*big.Int, *big.Int) {
	mod := func(n *big.Int) *big.Int { return n.Mod(n, fieldP) }
	xy := mod(new(big.Int).Mul(x, y))
	t := mod(new(big.Int).Mul(curveD, new(big.Int).Mul(xy, xy)))
	one := big.NewInt(1)
	x3 := new(big.Int).Mul(new(big.Int).Lsh(xy, 1),
		new(big.Int).ModInverse(mod(new(big.Int).Add(one, t)), fieldP))
	y3 := new(big.Int).Mul(new(big.Int).Add(new(big.Int).Mul(y, y), new(big.Int).Mul(x, x)),
		new(big.Int).ModInverse(mod(new(big.Int).Sub(one, t)), fieldP))
	return mod(x3), mod(y3)
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
