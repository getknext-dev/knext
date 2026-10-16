package auth

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	knextv1 "example.com/function/gen/knext/v1"
)

// A zone identity token is a JWS in compact form, header
// {"alg":"EdDSA","typ":"JWT","kid":"<kid>"} and claims iss, aud, method, sub,
// iat and exp. It is parsed here by hand, on the standard library alone, and
// strictly: the algorithm is fixed (never taken from the header), base64url
// must be canonical and unpadded, JSON must be valid UTF-8 with no duplicate
// member names, and every claim is required with its exact type. The
// signature is verified before any claim is read.

// claims are a token's verified claims.
type claims struct {
	iss, aud, method, sub string
	iat, exp              int64
}

func malformed(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrMalformed, fmt.Sprintf(format, args...))
}

// verifyToken parses token and verifies its signature with the key its kid
// names in keys, returning its claims for check.
func verifyToken(token string, keys map[string]ed25519.PublicKey) (claims, error) {
	segments := strings.Split(token, ".")
	if len(segments) != 3 {
		return claims{}, malformed("%d segments, want 3", len(segments))
	}
	h, p, s := segments[0], segments[1], segments[2]
	headerJSON, err := segment(h)
	if err != nil {
		return claims{}, err
	}
	payloadJSON, err := segment(p)
	if err != nil {
		return claims{}, err
	}
	signature, err := segment(s)
	if err != nil {
		return claims{}, err
	}

	header, err := object(headerJSON)
	if err != nil {
		return claims{}, err
	}
	for name := range header {
		if name != "alg" && name != "typ" && name != "kid" {
			return claims{}, malformed("header member %q", name)
		}
	}
	typ, err := stringMember(header, "typ")
	if err != nil {
		return claims{}, err
	}
	if typ != "JWT" {
		return claims{}, malformed("typ %q", typ)
	}
	kid, err := stringMember(header, "kid")
	if err != nil {
		return claims{}, err
	}
	if kid == "" {
		return claims{}, malformed("empty kid")
	}
	if alg, err := stringMember(header, "alg"); err != nil || alg != "EdDSA" {
		return claims{}, ErrBadAlg
	}

	key, ok := keys[kid]
	if !ok {
		return claims{}, ErrUnknownKID
	}
	if len(signature) != ed25519.SignatureSize || !ed25519.Verify(key, []byte(h+"."+p), signature) {
		return claims{}, ErrBadSignature
	}

	payload, err := object(payloadJSON)
	if err != nil {
		return claims{}, err
	}
	var c claims
	for _, m := range []struct {
		name string
		to   *string
	}{{"iss", &c.iss}, {"aud", &c.aud}, {"method", &c.method}, {"sub", &c.sub}} {
		if *m.to, err = stringMember(payload, m.name); err != nil {
			return claims{}, err
		}
	}
	if c.iat, err = intMember(payload, "iat"); err != nil {
		return claims{}, err
	}
	if c.exp, err = intMember(payload, "exp"); err != nil {
		return claims{}, err
	}
	return c, nil
}

// check holds verified claims to the function: lifetime and clock, issuer,
// audience, method, and a user for an AUTH_USER RPC.
func (c claims) check(now int64, issuer, audience, procedure string, mode knextv1.Auth) error {
	skew := int64(ClockSkew / time.Second)
	maxLifetime := uint64(MaxTokenLifetime / time.Second)
	// exp > iat makes the uint64 difference exact, whatever the values.
	if c.exp <= c.iat || uint64(c.exp)-uint64(c.iat) > maxLifetime {
		return ErrLifetime
	}
	if c.exp <= now-skew {
		return ErrExpired
	}
	if c.iat > now+skew {
		return ErrNotYetValid
	}
	if c.iss != issuer {
		return ErrWrongIssuer
	}
	if c.aud != audience {
		return ErrWrongAudience
	}
	if c.method != procedure {
		return ErrWrongMethod
	}
	if mode == knextv1.Auth_AUTH_USER && c.sub == "" {
		return ErrMissingSubject
	}
	return nil
}

// strictBase64 is unpadded base64url that also refuses non-zero trailing bits.
var strictBase64 = base64.RawURLEncoding.Strict()

// segment decodes one base64url segment. encoding/base64 skips CR and LF even
// in strict mode, so the alphabet is checked first.
func segment(s string) ([]byte, error) {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !('A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '-' || c == '_') {
			return nil, malformed("byte %#x in a base64url segment", c)
		}
	}
	b, err := strictBase64.DecodeString(s)
	if err != nil {
		return nil, malformed("base64url: %v", err)
	}
	return b, nil
}

// object decodes a JSON object into its members by exact name, refusing
// invalid UTF-8, a duplicate member name and anything but one object.
func object(data []byte) (map[string]json.RawMessage, error) {
	if !utf8.Valid(data) {
		return nil, malformed("JSON is not UTF-8")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil, malformed("not a JSON object")
	}
	members := map[string]json.RawMessage{}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, malformed("JSON: %v", err)
		}
		name, ok := tok.(string)
		if !ok {
			return nil, malformed("JSON member name")
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, malformed("JSON: %v", err)
		}
		if _, dup := members[name]; dup {
			return nil, malformed("duplicate member %q", name)
		}
		members[name] = value
	}
	if tok, err := dec.Token(); err != nil || tok != json.Delim('}') {
		return nil, malformed("unterminated JSON object")
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, malformed("data after the JSON object")
	}
	return members, nil
}

// stringMember is a required JSON string member.
func stringMember(members map[string]json.RawMessage, name string) (string, error) {
	raw, ok := members[name]
	if !ok {
		return "", malformed("missing %q", name)
	}
	var s string
	if len(raw) == 0 || raw[0] != '"' || json.Unmarshal(raw, &s) != nil {
		return "", malformed("%q is not a string", name)
	}
	return s, nil
}

// intMember is a required JSON integer member: digits only, no fraction or
// exponent, within int64.
func intMember(members map[string]json.RawMessage, name string) (int64, error) {
	raw, ok := members[name]
	if !ok {
		return 0, malformed("missing %q", name)
	}
	text := string(raw)
	digits := strings.TrimPrefix(text, "-")
	if digits == "" || strings.Trim(digits, "0123456789") != "" || (len(digits) > 1 && digits[0] == '0') {
		return 0, malformed("%q is not an integer", name)
	}
	n, err := strconv.ParseInt(text, 10, 64)
	if err != nil {
		return 0, malformed("%q: %v", name, err)
	}
	return n, nil
}
