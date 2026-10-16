/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package controller

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	mrand "math/rand"
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/event"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// The zone signing key and its JWKS (ADR-0004 Amendment 1 Decisions 8 to 11,
// and the #2051 token contract). These are the PURE halves: key material, the
// JWKS, the rotation planner and its crash-safety, the render and the status.
// zone_signing_key_envtest_test.go drives the same rules through a real
// Reconcile against an apiserver.

// --- key material -------------------------------------------------------------

// The kid is base64url (no padding) of the first 16 bytes of SHA-256 over the
// raw 32-byte public key. Computed here independently of the implementation,
// over the RFC 8032 test-vector-1 public key.
func TestZoneKeyIDFollowsTheContract(t *testing.T) {
	raw, err := hex.DecodeString("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	want := base64.RawURLEncoding.EncodeToString(sum[:16])
	if got := ZoneKeyID(ed25519.PublicKey(raw)); got != want {
		t.Fatalf("ZoneKeyID = %q, want %q", got, want)
	}
	if strings.ContainsAny(want, "=+/") {
		t.Fatalf("the contract kid is base64url without padding: %q", want)
	}
}

func TestNewZoneKeyIsPKCS8Ed25519WithMatchingKid(t *testing.T) {
	k, err := newZoneKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	block, rest := pem.Decode(k.pem)
	if block == nil || block.Type != "PRIVATE KEY" || len(strings.TrimSpace(string(rest))) != 0 {
		t.Fatalf("want exactly one PKCS#8 \"PRIVATE KEY\" PEM block, got %q", k.pem)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		t.Fatalf("not PKCS#8: %v", err)
	}
	priv, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		t.Fatalf("PKCS#8 key is %T, want ed25519.PrivateKey", parsed)
	}
	pub := priv.Public().(ed25519.PublicKey)
	if k.kid != ZoneKeyID(pub) {
		t.Fatalf("kid %q does not match the key's public half (%q)", k.kid, ZoneKeyID(pub))
	}
	again, err := parseZoneKey(k.pem, k.kid)
	if err != nil || again.kid != k.kid {
		t.Fatalf("round trip: %v %q", err, again.kid)
	}
	other, _ := newZoneKey(rand.Reader)
	if other.kid == k.kid {
		t.Fatalf("two generated keys share a kid")
	}
}

func TestParseZoneKeyRefusesAMismatchedKidOrANonEd25519Key(t *testing.T) {
	k, _ := newZoneKey(rand.Reader)
	if _, err := parseZoneKey(k.pem, "AAAAAAAAAAAAAAAAAAAAAA"); err == nil {
		t.Fatalf("a kid that does not match the key must be refused")
	}
	if _, err := parseZoneKey([]byte("not a pem"), k.kid); err == nil {
		t.Fatalf("garbage must be refused")
	}
	if _, err := parseZoneKey(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: []byte{1, 2, 3}}), k.kid); err == nil {
		t.Fatalf("a non-PKCS#8 block must be refused")
	}
}

// The JWKS carries PUBLIC keys only, in RFC 7517 / RFC 8037 OKP form, sorted by
// kid so the signing switch (which does not change the key SET) does not
// rewrite the file.
func TestZoneJWKSShapeAndOrder(t *testing.T) {
	a, _ := newZoneKey(rand.Reader)
	b, _ := newZoneKey(rand.Reader)
	ab, err := buildZoneJWKS(a.pub, b.pub)
	if err != nil {
		t.Fatal(err)
	}
	ba, _ := buildZoneJWKS(b.pub, a.pub)
	if string(ab) != string(ba) {
		t.Fatalf("the JWKS must not depend on argument order:\n%s\n%s", ab, ba)
	}
	var set struct {
		Keys []map[string]any `json:"keys"`
	}
	if err := json.Unmarshal(ab, &set); err != nil {
		t.Fatal(err)
	}
	if len(set.Keys) != 2 {
		t.Fatalf("want 2 keys, got %d", len(set.Keys))
	}
	if set.Keys[0]["kid"].(string) > set.Keys[1]["kid"].(string) {
		t.Fatalf("keys not sorted by kid")
	}
	for _, jwk := range set.Keys {
		if jwk["kty"] != "OKP" || jwk["crv"] != "Ed25519" || jwk["alg"] != "EdDSA" || jwk["use"] != "sig" {
			t.Fatalf("bad JWK members: %v", jwk)
		}
		if _, has := jwk["d"]; has {
			t.Fatalf("a JWKS must never carry the private member d: %v", jwk)
		}
		x, err := base64.RawURLEncoding.DecodeString(jwk["x"].(string))
		if err != nil || len(x) != ed25519.PublicKeySize {
			t.Fatalf("x is not base64url(no pad) of a 32-byte key: %v", jwk["x"])
		}
		if jwk["kid"] != ZoneKeyID(x) {
			t.Fatalf("kid %v does not derive from x", jwk["kid"])
		}
		if len(jwk) != 6 {
			t.Fatalf("unexpected JWK members: %v", jwk)
		}
	}
	for _, k := range []zoneKey{a, b} {
		if strings.Contains(string(ab), base64.RawURLEncoding.EncodeToString(k.priv.Seed())) ||
			strings.Contains(string(ab), base64.StdEncoding.EncodeToString(k.priv.Seed())) {
			t.Fatalf("private seed leaked into the JWKS")
		}
	}
}

// --- the Secret round trip -------------------------------------------------------

func TestSigningKeySetRoundTripsThroughTheSecret(t *testing.T) {
	cur, _ := newZoneKey(rand.Reader)
	nxt, _ := newZoneKey(rand.Reader)
	t0 := time.Date(2026, 10, 16, 12, 0, 0, 123456789, time.UTC)
	in := signingKeySet{
		current: &cur, next: &nxt,
		currentSince: t0, nextPublishedAt: t0.Add(time.Second), rotationNonce: "n1",
	}
	sec := &corev1.Secret{}
	in.applyTo(sec)
	if string(sec.Data[signingKeyCurrentKey]) != string(cur.pem) || string(sec.Data[signingKeyCurrentKid]) != cur.kid {
		t.Fatalf("current slot not written per the contract")
	}
	if _, ok := sec.Data[signingKeyPreviousKey]; ok {
		t.Fatalf("an absent previous key must not be written")
	}
	for k, v := range sec.Annotations {
		if strings.Contains(v, "PRIVATE") || strings.Contains(v, string(cur.pem)) {
			t.Fatalf("key material in annotation %s", k)
		}
	}
	out, err := readSigningKeySecret(sec)
	if err != nil {
		t.Fatal(err)
	}
	if out.current.kid != cur.kid || out.next.kid != nxt.kid || out.previous != nil {
		t.Fatalf("slots did not round trip: %+v", out)
	}
	// Nanosecond precision: a truncated timestamp would make the wait start
	// EARLIER than the real publish and could switch signing early.
	if !out.nextPublishedAt.Equal(t0.Add(time.Second)) || !out.currentSince.Equal(t0) || out.rotationNonce != "n1" {
		t.Fatalf("annotations did not round trip exactly: %+v", out)
	}
	// Moving on clears the slot and the annotation.
	out.next = nil
	out.nextPublishedAt = time.Time{}
	out.applyTo(sec)
	if _, ok := sec.Data[signingKeyNextKey]; ok {
		t.Fatalf("a cleared next slot must be deleted from the Secret")
	}
	if _, ok := sec.Annotations[annSigningKeyNextPublishedAt]; ok {
		t.Fatalf("a cleared timestamp must be deleted from the Secret")
	}
}

func TestReadSigningKeySecretRefusesAnInconsistentSecret(t *testing.T) {
	cur, _ := newZoneKey(rand.Reader)
	other, _ := newZoneKey(rand.Reader)
	cases := map[string]func(*corev1.Secret){
		"no current key": func(s *corev1.Secret) { delete(s.Data, signingKeyCurrentKey) },
		"kid mismatch":   func(s *corev1.Secret) { s.Data[signingKeyCurrentKid] = []byte(other.kid) },
		"next and previous both set": func(s *corev1.Secret) {
			s.Data[signingKeyNextKey], s.Data[signingKeyNextKid] = other.pem, []byte(other.kid)
			s.Data[signingKeyPreviousKey], s.Data[signingKeyPreviousKid] = other.pem, []byte(other.kid)
		},
		"half a slot":   func(s *corev1.Secret) { s.Data[signingKeyNextKey] = other.pem },
		"bad timestamp": func(s *corev1.Secret) { s.Annotations[annSigningKeyCurrentSince] = "yesterday" },
	}
	for name, mut := range cases {
		t.Run(name, func(t *testing.T) {
			sec := &corev1.Secret{}
			signingKeySet{current: &cur, currentSince: time.Now()}.applyTo(sec)
			mut(sec)
			_, err := readSigningKeySecret(sec)
			if err == nil {
				t.Fatalf("an inconsistent Secret must be refused")
			}
			if strings.Contains(err.Error(), string(cur.pem)) || strings.Contains(err.Error(), "PRIVATE KEY") {
				t.Fatalf("the parse error must never carry key material: %v", err)
			}
		})
	}
}

// --- the planner ----------------------------------------------------------------

func testKeys(t *testing.T, n int) []zoneKey {
	t.Helper()
	out := make([]zoneKey, n)
	for i := range out {
		k, err := newZoneKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		out[i] = k
	}
	return out
}

func mustJWKS(t *testing.T, keys ...*zoneKey) string {
	t.Helper()
	var pubs []ed25519.PublicKey
	for _, k := range keys {
		pubs = append(pubs, k.pub)
	}
	b, err := buildZoneJWKS(pubs...)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

var testCfg = ZoneSigningKeyConfig{PropagationBound: 90 * time.Second}

func TestPlannerSteadyStateAndCreation(t *testing.T) {
	k := testKeys(t, 1)
	now := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)

	if s := planZoneKeyStep(zoneKeyWorld{}, zoneKeyInputs{now: now, cfg: testCfg}); s.action != zkCreateSecret {
		t.Fatalf("no Secret: want %s, got %s", zkCreateSecret, s.action)
	}
	w := zoneKeyWorld{secretFound: true, keys: signingKeySet{current: &k[0], currentSince: now}}
	if s := planZoneKeyStep(w, zoneKeyInputs{now: now, cfg: testCfg}); s.action != zkPublishJWKS {
		t.Fatalf("no JWKS: want %s, got %s", zkPublishJWKS, s.action)
	}
	w.jwksFound, w.jwks = true, `{"keys":[]}`
	if s := planZoneKeyStep(w, zoneKeyInputs{now: now, cfg: testCfg}); s.action != zkPublishJWKS {
		t.Fatalf("a drifted JWKS is rewritten from the Secret: got %s", s.action)
	}
	w.jwks = mustJWKS(t, &k[0])
	s := planZoneKeyStep(w, zoneKeyInputs{now: now, cfg: testCfg})
	if s.action != zkWait || s.wait != 0 {
		t.Fatalf("converged, no rotation scheduled: want Wait(0), got %s(%s)", s.action, s.wait)
	}
	w.keys.currentSince = time.Time{}
	if s := planZoneKeyStep(w, zoneKeyInputs{now: now, cfg: testCfg}); s.action != zkStampCurrentSince {
		t.Fatalf("missing current-since is stamped: got %s", s.action)
	}
}

func TestPlannerRotationRequestByNonce(t *testing.T) {
	k := testKeys(t, 1)
	now := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
	w := zoneKeyWorld{secretFound: true, jwksFound: true, jwks: mustJWKS(t, &k[0]),
		keys: signingKeySet{current: &k[0], currentSince: now, rotationNonce: "a"}}
	if s := planZoneKeyStep(w, zoneKeyInputs{now: now, cfg: testCfg, requestedNonce: "a"}); s.action != zkWait {
		t.Fatalf("an already-consumed nonce must not rotate again: got %s", s.action)
	}
	if s := planZoneKeyStep(w, zoneKeyInputs{now: now, cfg: testCfg, requestedNonce: ""}); s.action != zkWait {
		t.Fatalf("no request: got %s", s.action)
	}
	if s := planZoneKeyStep(w, zoneKeyInputs{now: now, cfg: testCfg, requestedNonce: "b"}); s.action != zkStartRotation {
		t.Fatalf("a new nonce starts a rotation: got %s", s.action)
	}
}

func TestPlannerScheduledRotation(t *testing.T) {
	k := testKeys(t, 1)
	t0 := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
	cfg := ZoneSigningKeyConfig{PropagationBound: 90 * time.Second, RotationInterval: 24 * time.Hour}
	w := zoneKeyWorld{secretFound: true, jwksFound: true, jwks: mustJWKS(t, &k[0]),
		keys: signingKeySet{current: &k[0], currentSince: t0}}
	s := planZoneKeyStep(w, zoneKeyInputs{now: t0.Add(24*time.Hour - time.Nanosecond), cfg: cfg})
	if s.action != zkWait || s.wait != time.Nanosecond {
		t.Fatalf("1ns before the interval: want Wait(1ns), got %s(%s)", s.action, s.wait)
	}
	if s := planZoneKeyStep(w, zoneKeyInputs{now: t0.Add(24 * time.Hour), cfg: cfg}); s.action != zkStartRotation {
		t.Fatalf("at the interval: want StartRotation, got %s", s.action)
	}
}

// The load-bearing rule: signing switches ONLY once the JWKS this pass
// observed holds the new key AND the propagation bound has passed since it was
// published. Never one nanosecond earlier.
func TestPlannerNeverSwitchesBeforeThePropagationBound(t *testing.T) {
	k := testKeys(t, 2)
	pub := time.Date(2026, 10, 16, 12, 0, 0, 500, time.UTC)
	staged := signingKeySet{current: &k[0], next: &k[1], currentSince: pub.Add(-time.Hour), rotationNonce: "x"}

	w := zoneKeyWorld{secretFound: true, jwksFound: true, jwks: mustJWKS(t, &k[0]), keys: staged}
	if s := planZoneKeyStep(w, zoneKeyInputs{now: pub.Add(time.Hour), cfg: testCfg, requestedNonce: "x"}); s.action != zkPublishJWKS {
		t.Fatalf("staged key not yet in the JWKS: want PublishJWKS, got %s", s.action)
	}
	w.jwks = mustJWKS(t, &k[0], &k[1])
	if s := planZoneKeyStep(w, zoneKeyInputs{now: pub, cfg: testCfg, requestedNonce: "x"}); s.action != zkMarkPublished {
		t.Fatalf("published but not stamped: want MarkPublished, got %s", s.action)
	}
	w.keys.nextPublishedAt = pub
	for _, early := range []time.Duration{0, time.Second, 89 * time.Second, testCfg.PropagationBound - time.Nanosecond} {
		s := planZoneKeyStep(w, zoneKeyInputs{now: pub.Add(early), cfg: testCfg, requestedNonce: "x"})
		if s.action != zkWait || s.wait != testCfg.PropagationBound-early {
			t.Fatalf("at +%s: want Wait(%s), got %s(%s)", early, testCfg.PropagationBound-early, s.action, s.wait)
		}
	}
	if s := planZoneKeyStep(w, zoneKeyInputs{now: pub.Add(testCfg.PropagationBound), cfg: testCfg, requestedNonce: "x"}); s.action != zkSwitchSigning {
		t.Fatalf("at the bound: want SwitchSigning, got %s", s.action)
	}
	// A JWKS that lost the staged key (edited, or re-created) is re-published
	// and the wait restarts: an old timestamp never licenses a switch.
	w.jwks = mustJWKS(t, &k[0])
	if s := planZoneKeyStep(w, zoneKeyInputs{now: pub.Add(24 * time.Hour), cfg: testCfg, requestedNonce: "x"}); s.action != zkPublishJWKS {
		t.Fatalf("lost staged key: want PublishJWKS, got %s", s.action)
	}
	w.jwks = mustJWKS(t, &k[0], &k[1])
	w.nextFreshlyPublished = true
	if s := planZoneKeyStep(w, zoneKeyInputs{now: pub.Add(24 * time.Hour), cfg: testCfg, requestedNonce: "x"}); s.action != zkMarkPublished {
		t.Fatalf("re-published this pass: the timestamp must be reset, got %s", s.action)
	}
}

func TestPlannerRetiresOnlyAfterTheOverlap(t *testing.T) {
	k := testKeys(t, 2)
	sw := time.Date(2026, 10, 16, 13, 0, 0, 7, time.UTC)
	w := zoneKeyWorld{secretFound: true, jwksFound: true, jwks: mustJWKS(t, &k[0], &k[1]),
		keys: signingKeySet{current: &k[1], previous: &k[0], currentSince: sw}}
	if s := planZoneKeyStep(w, zoneKeyInputs{now: sw, cfg: testCfg}); s.action != zkStampSwitched {
		t.Fatalf("missing switched-at is stamped: got %s", s.action)
	}
	w.keys.switchedAt = sw
	for _, early := range []time.Duration{0, 59 * time.Minute, ZoneKeyOverlap - time.Nanosecond} {
		s := planZoneKeyStep(w, zoneKeyInputs{now: sw.Add(early), cfg: testCfg})
		if s.action != zkWait || s.wait != ZoneKeyOverlap-early {
			t.Fatalf("at +%s: want Wait(%s), got %s(%s)", early, ZoneKeyOverlap-early, s.action, s.wait)
		}
	}
	if s := planZoneKeyStep(w, zoneKeyInputs{now: sw.Add(ZoneKeyOverlap), cfg: testCfg}); s.action != zkRetirePrevious {
		t.Fatalf("at the overlap: want RetirePrevious, got %s", s.action)
	}
	// During the overlap a JWKS missing the previous key is restored.
	w.jwks = mustJWKS(t, &k[1])
	if s := planZoneKeyStep(w, zoneKeyInputs{now: sw.Add(time.Minute), cfg: testCfg}); s.action != zkPublishJWKS {
		t.Fatalf("previous key lost from the JWKS during the overlap: got %s", s.action)
	}
}

func TestPlannerDefersARotationRequestedMidRotation(t *testing.T) {
	k := testKeys(t, 2)
	now := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
	for name, keys := range map[string]signingKeySet{
		"propagating": {current: &k[0], next: &k[1], nextPublishedAt: now, currentSince: now, rotationNonce: "a"},
		"overlap":     {current: &k[1], previous: &k[0], switchedAt: now, currentSince: now, rotationNonce: "a"},
	} {
		w := zoneKeyWorld{secretFound: true, jwksFound: true, jwks: mustJWKS(t, &k[0], &k[1]), keys: keys}
		s := planZoneKeyStep(w, zoneKeyInputs{now: now.Add(time.Second), cfg: testCfg, requestedNonce: "b"})
		if s.action == zkStartRotation {
			t.Fatalf("%s: a new request must wait for the in-flight rotation to finish", name)
		}
		st := zoneKeyStatusFrom(w, zoneKeyInputs{now: now, cfg: testCfg, requestedNonce: "b"}, s, "orders")
		if !st.pending {
			t.Fatalf("%s: the deferred request must be reported as pending", name)
		}
	}
}

// --- crash safety: a simulated store with a crash after ANY write ----------------

// simStore persists the two objects, exactly as the apiserver would: each write
// is atomic and a crash loses every in-memory change not yet written. It also
// records, independently of the implementation, WHEN each kid first appeared in
// the persisted JWKS, so the invariants below are checked against the store's
// own history rather than against the planner's annotations.
type simStore struct {
	secretFound bool
	secret      *corev1.Secret
	jwksFound   bool
	jwks        string
	inJWKSSince map[string]time.Time
}

func (s *simStore) load(t *testing.T) zoneKeyWorld {
	t.Helper()
	w := zoneKeyWorld{secretFound: s.secretFound, jwksFound: s.jwksFound, jwks: s.jwks}
	if s.secretFound {
		keys, err := readSigningKeySecret(s.secret)
		if err != nil {
			t.Fatalf("store holds an unreadable Secret: %v", err)
		}
		w.keys = keys
	}
	return w
}

func jwksKidSet(t *testing.T, raw string) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	if raw == "" {
		return out
	}
	var set struct {
		Keys []struct {
			Kid string `json:"kid"`
		} `json:"keys"`
	}
	if err := json.Unmarshal([]byte(raw), &set); err != nil {
		t.Fatalf("store JWKS unparseable: %v", err)
	}
	for _, k := range set.Keys {
		out[k.Kid] = true
	}
	return out
}

// TestRotationIsCrashSafeAtEveryWrite drives the REAL pass loop (runZoneKeyPass,
// the one reconcileZoneSigningKey runs) against a simulated store, with a crash
// before or after any write and a clock that moves WHILE a write is in flight:
// the apiserver commits a write some time after it is issued, and the operator
// sees the confirmation some time after that. The invariants are checked
// against the store's own history (when each kid was committed to the JWKS,
// when each switch was committed), never against the implementation's
// annotations.
func TestRotationIsCrashSafeAtEveryWrite(t *testing.T) {
	rng := mrand.New(mrand.NewSource(2051))
	cfg := ZoneSigningKeyConfig{PropagationBound: 90 * time.Second}
	errCrash := errors.New("simulated crash")
	gen := func() (zoneKey, error) { return newZoneKey(rand.Reader) }
	// latency is how long one leg of a write (issue to commit, or commit to
	// confirmation) takes: often instant, sometimes milliseconds, sometimes far
	// longer than any healthy apiserver, so a stamp taken at the wrong moment
	// is off by enough to cross the bound.
	latency := func() time.Duration {
		switch rng.Intn(4) {
		case 0:
			return 0
		case 1:
			return time.Duration(rng.Intn(50)) * time.Millisecond
		default:
			return time.Duration(rng.Intn(45000)) * time.Millisecond
		}
	}
	totalSwitches, totalRetires, chaosRetires := 0, 0, 0
	for run := 0; run < 300; run++ {
		store := &simStore{inJWKSSince: map[string]time.Time{}}
		now := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
		clock := func() time.Time { return now }
		nonce := ""
		switches, retires := 0, 0
		var lastSwitchCommitted time.Time

		// commit persists the world's object for write at the current time,
		// checking the invariants against the store's history. issued is when
		// the write left the operator.
		commit := func(pass int, w *zoneKeyWorld, write zoneKeyWrite, issued time.Time) {
			prevCurrent, prevPrevious := "", ""
			if store.secretFound {
				old, _ := readSigningKeySecret(store.secret)
				prevCurrent = old.current.kid
				if old.previous != nil {
					prevPrevious = old.previous.kid
				}
			}
			switch write {
			case zkWriteSecret:
				sec := &corev1.Secret{}
				if store.secret != nil {
					sec = store.secret.DeepCopy()
				}
				w.keys.applyTo(sec)
				store.secret, store.secretFound = sec, true
				// INVARIANT 1: signing switches to a key only once the persisted
				// JWKS has held it for the propagation bound, measured from the
				// JWKS write's COMMIT to the switch write's ISSUE.
				if prevCurrent != "" && w.keys.current.kid != prevCurrent {
					since, ok := store.inJWKSSince[w.keys.current.kid]
					if !ok || issued.Sub(since) < cfg.PropagationBound {
						t.Fatalf("run %d pass %d: signing switched to %s %s after its JWKS write was committed (bound %s)",
							run, pass, w.keys.current.kid, issued.Sub(since), cfg.PropagationBound)
					}
					switches++
					lastSwitchCommitted = now
				}
				// INVARIANT 2: the previous key is dropped only once the overlap
				// has passed since the switch was COMMITTED.
				if prevPrevious != "" && (w.keys.previous == nil || w.keys.previous.kid != prevPrevious) {
					if issued.Sub(lastSwitchCommitted) < ZoneKeyOverlap {
						t.Fatalf("run %d pass %d: previous key retired %s after the switch was committed (overlap %s)",
							run, pass, issued.Sub(lastSwitchCommitted), ZoneKeyOverlap)
					}
					retires++
				}
			case zkWriteJWKS:
				store.jwks, store.jwksFound = w.jwks, true
				kids := jwksKidSet(t, store.jwks)
				for kid := range store.inJWKSSince {
					if !kids[kid] {
						delete(store.inJWKSSince, kid)
					}
				}
				for kid := range kids {
					if _, ok := store.inJWKSSince[kid]; !ok {
						store.inJWKSSince[kid] = now
					}
				}
				// INVARIANT 3: the published JWKS never names more than two keys
				// and always names the key the Secret signs with.
				if len(kids) > 2 {
					t.Fatalf("run %d: JWKS holds %d keys", run, len(kids))
				}
				if store.secretFound {
					cur, _ := readSigningKeySecret(store.secret)
					if !kids[cur.current.kid] {
						t.Fatalf("run %d: JWKS dropped the signing key", run)
					}
				}
			default:
				t.Fatalf("unknown write %v", write)
			}
		}

		// pass runs one reconcile pass. crashMode 0: no crash; 1: the operator
		// dies before write #crashAt is committed; 2: write #crashAt is
		// committed but the operator dies before it sees the confirmation.
		pass := func(pass, crashAt, crashMode int) {
			w := store.load(t)
			in := zoneKeyInputs{now: clock(), cfg: cfg, requestedNonce: nonce}
			writes := 0
			persist := func(write zoneKeyWrite, _ zoneKeyAction) error {
				if crashMode == 1 && writes == crashAt {
					return errCrash
				}
				issued := now
				now = now.Add(latency()) // in flight to the apiserver
				commit(pass, &w, write, issued)
				now = now.Add(latency()) // the confirmation in flight back
				writes++
				if crashMode == 2 && writes > crashAt {
					return errCrash
				}
				return nil
			}
			if _, _, err := runZoneKeyPass(&w, &in, clock, gen, persist); err != nil && !errors.Is(err, errCrash) {
				t.Fatalf("run %d pass %d: %v", run, pass, err)
			}
		}

		for p := 0; p < 120; p++ {
			if rng.Intn(6) == 0 {
				nonce = fmt.Sprintf("n%d", p)
			}
			pass(p, rng.Intn(5), rng.Intn(3))
			// Time moves between passes: sometimes a little, sometimes past a bound.
			switch rng.Intn(4) {
			case 0:
				now = now.Add(time.Duration(rng.Intn(30)) * time.Second)
			case 1:
				now = now.Add(time.Duration(60+rng.Intn(60)) * time.Second)
			case 2:
				now = now.Add(time.Duration(rng.Intn(70)) * time.Minute)
			default:
				now = now.Add(time.Duration(rng.Intn(5)) * time.Millisecond)
			}
		}
		chaosRetires += retires

		// Settle: no new request, no crash, time past every bound. Every
		// rotation that started must now complete, so each switch has its retire.
		for p := 0; p < 12; p++ {
			pass(1000+p, 0, 0)
			now = now.Add(ZoneKeyOverlap + cfg.PropagationBound + time.Second)
		}
		settled := store.load(t)
		if settled.keys.next != nil || settled.keys.previous != nil {
			t.Fatalf("run %d: crash-free passes past every bound left a rotation unfinished", run)
		}
		// Every run requests rotations, so every run must complete at least one
		// full rotation (switch AND retire), and retire once per switch.
		if switches == 0 || retires == 0 {
			t.Fatalf("run %d: no full rotation completed (switches %d, retires %d); the run proves nothing",
				run, switches, retires)
		}
		if retires != switches {
			t.Fatalf("run %d: %d switches but %d retires: a switched rotation never retired its previous key",
				run, switches, retires)
		}
		totalSwitches += switches
		totalRetires += retires
	}
	if totalSwitches == 0 || totalRetires == 0 || chaosRetires == 0 {
		t.Fatalf("the simulation never exercised both invariants (switches %d, retires %d, retires under crashes %d); "+
			"it proves nothing", totalSwitches, totalRetires, chaosRetires)
	}
}

// --- redaction --------------------------------------------------------------------

func TestRedactKeyMaterialRemovesEveryEncoding(t *testing.T) {
	k, _ := newZoneKey(rand.Reader)
	sec := &corev1.Secret{}
	signingKeySet{current: &k, currentSince: time.Now()}.applyTo(sec)
	asJSON, _ := json.Marshal(sec) // Secret data marshals as base64(PEM)
	// Every marker, embedded as-is: the PEM, each base64 alphabet with and
	// without padding of the PEM, the seed and the 64-byte private key.
	msg := fmt.Sprintf("admission webhook denied the request: %s; raw=%s; all=%s",
		asJSON, k.pem, strings.Join(keyLeakMarkers(k), " | "))
	got := redactKeyMaterial(msg, []*zoneKey{&k})
	for _, leak := range keyLeakMarkers(k) {
		if strings.Contains(got, leak) {
			t.Fatalf("redacted message still carries key material %q:\n%s", leak[:12], got)
		}
	}
	if !strings.Contains(got, "admission webhook denied the request") {
		t.Fatalf("redaction must keep the rest of the message: %s", got)
	}
	// A PEM block the caller did not name is still removed.
	foreign := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: []byte("0123456789abcdef")}))
	if strings.Contains(redactKeyMaterial("x "+foreign+" y", nil), "BEGIN PRIVATE KEY") {
		t.Fatalf("an unnamed PEM block must be removed")
	}
	err := redactZoneKeyError(errors.New(msg), []*zoneKey{&k})
	for _, leak := range keyLeakMarkers(k) {
		if strings.Contains(err.Error(), leak) {
			t.Fatalf("redactZoneKeyError leaked key material")
		}
	}
	// Each encoding on its own, so one needle never hides another's absence.
	for _, leak := range keyLeakMarkers(k) {
		if got := redactKeyMaterial("<"+leak+">", []*zoneKey{&k}); strings.Contains(got, leak) {
			t.Fatalf("an isolated encoding survived redaction: %q", leak[:12])
		}
	}
}

// keyLeakMarkers are the strings whose presence anywhere means a private key
// leaked: the PEM itself, a base64 body line, and the PEM, the seed and the
// 64-byte private key in every base64 alphabet, with and without padding (how
// a Secret's data appears in JSON, and how a webhook or a tool may re-encode it).
func keyLeakMarkers(k zoneKey) []string {
	out := []string{
		string(k.pem),
		strings.Split(strings.TrimSpace(string(k.pem)), "\n")[1], // the first base64 body line
	}
	for _, raw := range [][]byte{k.pem, k.priv.Seed(), k.priv} {
		for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
			out = append(out, enc.EncodeToString(raw))
		}
	}
	return out
}

// --- render: the zone's Knative Service ----------------------------------------

func boundZone() zoneBindings {
	return zoneBindings{entries: []zoneBinding{{name: "pricing", service: "pricing", state: bindingBound}}}
}

func TestApplyZoneIdentityRendersNothingWithoutABoundFunction(t *testing.T) {
	app := &appsv1alpha1.NextApp{ObjectMeta: metav1.ObjectMeta{Name: "orders", Namespace: "shop"}}
	ksvc := &servingv1.Service{}
	ksvc.Spec.Template.Spec.Containers = []corev1.Container{{Image: "img"}}
	before := ksvc.DeepCopy()
	for _, b := range []zoneBindings{
		{},
		{entries: []zoneBinding{{name: "pricing", service: "pricing", state: bindingFunctionNotFound}}},
		{entries: []zoneBinding{{name: "pricing", service: "pricing", state: bindingCrossZone}}},
		{crdMissing: true},
	} {
		if c := applyZoneIdentity(ksvc, app, b); c != nil {
			t.Fatalf("collisions with no bound function: %v", c)
		}
		if !reflect.DeepEqual(before, ksvc) {
			t.Fatalf("no bound function must leave the Knative Service byte-identical (%+v)", b)
		}
	}
}

func TestApplyZoneIdentityMountsTheKeyAsADirectoryVolume(t *testing.T) {
	app := &appsv1alpha1.NextApp{ObjectMeta: metav1.ObjectMeta{Name: "orders", Namespace: "shop"}}
	ksvc := &servingv1.Service{}
	ksvc.Spec.Template.Spec.Containers = []corev1.Container{{Image: "img", Env: []corev1.EnvVar{{Name: "A", Value: "1"}}}}
	if c := applyZoneIdentity(ksvc, app, boundZone()); c != nil {
		t.Fatalf("unexpected collisions: %v", c)
	}
	vols := ksvc.Spec.Template.Spec.Volumes
	if len(vols) != 1 || vols[0].Name != ZoneSigningKeyVolumeName || vols[0].Secret == nil {
		t.Fatalf("want exactly the signing-key Secret volume, got %+v", vols)
	}
	sv := vols[0].Secret
	if sv.SecretName != ZoneSigningKeySecretName("orders") {
		t.Fatalf("mounts %q, want the zone's own key", sv.SecretName)
	}
	if sv.Optional == nil || !*sv.Optional {
		t.Fatalf("the key volume is optional: an absent Secret leaves the zone serving and its signer failing closed")
	}
	if sv.DefaultMode == nil || *sv.DefaultMode != 0o444 {
		t.Fatalf("defaultMode must be 0444 (the app runs non-root and Knative disables fsGroup), got %v", sv.DefaultMode)
	}
	var items []string
	for _, it := range sv.Items {
		if it.Key != it.Path {
			t.Fatalf("item %q projected as %q", it.Key, it.Path)
		}
		items = append(items, it.Key)
	}
	want := []string{signingKeyCurrentKey, signingKeyCurrentKid, signingKeyPreviousKey, signingKeyPreviousKid}
	if !reflect.DeepEqual(items, want) {
		t.Fatalf("projected items %v, want %v (the staged next key never reaches the zone)", items, want)
	}
	mounts := ksvc.Spec.Template.Spec.Containers[0].VolumeMounts
	if len(mounts) != 1 || mounts[0].MountPath != ZoneSigningKeyMountDir || !mounts[0].ReadOnly || mounts[0].SubPath != "" ||
		mounts[0].Name != ZoneSigningKeyVolumeName {
		t.Fatalf("want one read-only directory mount at %s with no subPath, got %+v", ZoneSigningKeyMountDir, mounts)
	}
	env := ksvc.Spec.Template.Spec.Containers[0].Env
	if envValue(env, ZoneIssuerEnv) != "knext:zone:shop/orders" || env[0].Name != "A" {
		t.Fatalf("want %s=knext:zone:shop/orders appended, got %v", ZoneIssuerEnv, env)
	}
	for _, e := range env {
		if e.ValueFrom != nil {
			t.Fatalf("the key never travels through env: %+v", e)
		}
	}
}

func TestApplyZoneIdentityKeepsAUserIssuerAndReportsIt(t *testing.T) {
	app := &appsv1alpha1.NextApp{ObjectMeta: metav1.ObjectMeta{Name: "orders", Namespace: "shop"}}
	ksvc := &servingv1.Service{}
	ksvc.Spec.Template.Spec.Containers = []corev1.Container{{Image: "img", Env: []corev1.EnvVar{{Name: ZoneIssuerEnv, Value: "mine"}}}}
	c := applyZoneIdentity(ksvc, app, boundZone())
	if !reflect.DeepEqual(c, []string{ZoneIssuerEnv}) {
		t.Fatalf("want the collision reported, got %v", c)
	}
	env := ksvc.Spec.Template.Spec.Containers[0].Env
	if len(env) != 1 || env[0].Value != "mine" {
		t.Fatalf("the user's value is kept, never overwritten or duplicated: %v", env)
	}
}

// --- render: the function never sees a private key, and learns iss/aud ---------

func TestFunctionRenderSetsTheVerifierIdentityAndNoPrivateKey(t *testing.T) {
	bs := &appsv1alpha1.BackendService{
		ObjectMeta: metav1.ObjectMeta{Name: "pricing", Namespace: "shop"},
		Spec: appsv1alpha1.BackendServiceSpec{
			Zone: "orders", Image: "img",
			Env: []corev1.EnvVar{
				{Name: "A", Value: "1"},
				{Name: FunctionTokenAudienceEnv, Value: "knext:fn:shop/other"},
				{Name: "KNEXT_TOKEN_EXTRA", Value: "x"},
			},
		},
	}
	ksvc := &servingv1.Service{}
	if err := buildFunctionKsvc(bs, 0, ksvc); err != nil {
		t.Fatal(err)
	}
	env := ksvc.Spec.Template.Spec.Containers[0].Env
	if envValue(env, FunctionTokenIssuerEnv) != "knext:zone:shop/orders" {
		t.Fatalf("issuer: %v", env)
	}
	if envValue(env, FunctionTokenAudienceEnv) != "knext:fn:shop/pricing" {
		t.Fatalf("audience must be the operator's, never the spec's: %v", env)
	}
	seen := map[string]int{}
	for _, e := range env {
		seen[e.Name]++
	}
	if seen[FunctionTokenAudienceEnv] != 1 || seen["KNEXT_TOKEN_EXTRA"] != 0 || seen["A"] != 1 {
		t.Fatalf("operator-reserved KNEXT_TOKEN_* names must appear once, from the operator: %v", seen)
	}
	if leaks := functionPodZoneKeyLeaks(ksvc.Spec.Template.Spec.PodSpec, bs.Spec.Zone); len(leaks) != 0 {
		t.Fatalf("a function pod must never reach a zone signing key or carry JWKS material in env: %v", leaks)
	}
}

// functionPodZoneKeyLeaks scans a function's pod spec for any way it could
// reach a zone's signing-key Secret: every volume source (secret, every
// projected source, a CSI driver's secret reference), every container's (and
// init container's) env secretKeyRef and envFrom secretRef, and finally the
// whole spec as JSON, so a reference through a source this list does not name
// is still caught. It also reports an env var that carries JWKS material (an
// inline JWK, or a value sourced from the zone's JWKS ConfigMap): the function
// reads the JWKS from its directory mount, never from env, where a rotation
// could not reach a running pod.
func functionPodZoneKeyLeaks(spec corev1.PodSpec, zone string) []string {
	own := ZoneSigningKeySecretName(zone)
	isKey := func(name string) bool { return name == own || strings.HasSuffix(name, zoneSigningKeySecretSuffix) }
	var leaks []string
	for _, v := range spec.Volumes {
		if v.Secret != nil && isKey(v.Secret.SecretName) {
			leaks = append(leaks, "volume "+v.Name+": secret")
		}
		if v.Projected != nil {
			for _, s := range v.Projected.Sources {
				if s.Secret != nil && isKey(s.Secret.Name) {
					leaks = append(leaks, "volume "+v.Name+": projected secret")
				}
			}
		}
		if v.CSI != nil && v.CSI.NodePublishSecretRef != nil && isKey(v.CSI.NodePublishSecretRef.Name) {
			leaks = append(leaks, "volume "+v.Name+": csi nodePublishSecretRef")
		}
	}
	jwkMember := regexp.MustCompile(`"(kty|crv|keys)"\s*:`)
	jwksName := ZoneJWKSConfigMapName(zone)
	containers := append(append([]corev1.Container{}, spec.InitContainers...), spec.Containers...)
	for _, c := range containers {
		for _, e := range c.Env {
			if e.ValueFrom != nil && e.ValueFrom.SecretKeyRef != nil && isKey(e.ValueFrom.SecretKeyRef.Name) {
				leaks = append(leaks, "container "+c.Name+" env "+e.Name+": secretKeyRef")
			}
			if e.ValueFrom != nil && e.ValueFrom.ConfigMapKeyRef != nil && e.ValueFrom.ConfigMapKeyRef.Name == jwksName {
				leaks = append(leaks, "container "+c.Name+" env "+e.Name+": JWKS from configMapKeyRef")
			}
			if jwkMember.MatchString(e.Value) || strings.Contains(e.Value, "BEGIN PRIVATE KEY") {
				leaks = append(leaks, "container "+c.Name+" env "+e.Name+": JWKS or key material in value")
			}
		}
		for _, f := range c.EnvFrom {
			if f.SecretRef != nil && isKey(f.SecretRef.Name) {
				leaks = append(leaks, "container "+c.Name+": envFrom secretRef")
			}
			if f.ConfigMapRef != nil && f.ConfigMapRef.Name == jwksName {
				leaks = append(leaks, "container "+c.Name+": JWKS from envFrom configMapRef")
			}
		}
	}
	raw, _ := json.Marshal(spec)
	if strings.Contains(string(raw), zoneSigningKeySecretSuffix) {
		leaks = append(leaks, "pod spec JSON names a "+zoneSigningKeySecretSuffix+" object")
	}
	return leaks
}

// The scan above must see every channel; a scanner that misses one is
// decoration.
func TestFunctionPodZoneKeyScanSeesEveryChannel(t *testing.T) {
	key := ZoneSigningKeySecretName("orders")
	jwks := ZoneJWKSConfigMapName("orders")
	other := ZoneSigningKeySecretName("billing")
	for name, mutate := range map[string]func(*corev1.PodSpec){
		"secret volume": func(s *corev1.PodSpec) {
			s.Volumes = append(s.Volumes, corev1.Volume{Name: "k", VolumeSource: corev1.VolumeSource{
				Secret: &corev1.SecretVolumeSource{SecretName: key}}})
		},
		"projected secret": func(s *corev1.PodSpec) {
			s.Volumes = append(s.Volumes, corev1.Volume{Name: "k", VolumeSource: corev1.VolumeSource{
				Projected: &corev1.ProjectedVolumeSource{Sources: []corev1.VolumeProjection{
					{ConfigMap: &corev1.ConfigMapProjection{LocalObjectReference: corev1.LocalObjectReference{Name: "x"}}},
					{Secret: &corev1.SecretProjection{LocalObjectReference: corev1.LocalObjectReference{Name: key}}},
				}}}})
		},
		"another zone's key": func(s *corev1.PodSpec) {
			s.Volumes = append(s.Volumes, corev1.Volume{Name: "k", VolumeSource: corev1.VolumeSource{
				Secret: &corev1.SecretVolumeSource{SecretName: other}}})
		},
		"csi secret ref": func(s *corev1.PodSpec) {
			s.Volumes = append(s.Volumes, corev1.Volume{Name: "k", VolumeSource: corev1.VolumeSource{
				CSI: &corev1.CSIVolumeSource{Driver: "d", NodePublishSecretRef: &corev1.LocalObjectReference{Name: key}}}})
		},
		"env secretKeyRef": func(s *corev1.PodSpec) {
			s.Containers[0].Env = append(s.Containers[0].Env, corev1.EnvVar{Name: "K", ValueFrom: &corev1.EnvVarSource{
				SecretKeyRef: &corev1.SecretKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: key}, Key: signingKeyCurrentKey}}})
		},
		"init container env secretKeyRef": func(s *corev1.PodSpec) {
			s.InitContainers = append(s.InitContainers, corev1.Container{Name: "init", Env: []corev1.EnvVar{{Name: "K",
				ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: key}, Key: signingKeyCurrentKey}}}}})
		},
		"envFrom secretRef": func(s *corev1.PodSpec) {
			s.Containers[0].EnvFrom = append(s.Containers[0].EnvFrom, corev1.EnvFromSource{
				SecretRef: &corev1.SecretEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: key}}})
		},
		"inline JWKS value": func(s *corev1.PodSpec) {
			s.Containers[0].Env = append(s.Containers[0].Env, corev1.EnvVar{Name: "J",
				Value: `{"keys":[{"kty":"OKP","crv":"Ed25519","x":"AAAA","kid":"k"}]}`})
		},
		"JWKS configMapKeyRef": func(s *corev1.PodSpec) {
			s.Containers[0].Env = append(s.Containers[0].Env, corev1.EnvVar{Name: "J", ValueFrom: &corev1.EnvVarSource{
				ConfigMapKeyRef: &corev1.ConfigMapKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: jwks}, Key: ZoneJWKSFileName}}})
		},
		"JWKS envFrom configMapRef": func(s *corev1.PodSpec) {
			s.Containers[0].EnvFrom = append(s.Containers[0].EnvFrom, corev1.EnvFromSource{
				ConfigMapRef: &corev1.ConfigMapEnvSource{LocalObjectReference: corev1.LocalObjectReference{Name: jwks}}})
		},
	} {
		spec := corev1.PodSpec{Containers: []corev1.Container{{Name: "fn", Image: "img"}}}
		if leaks := functionPodZoneKeyLeaks(spec, "orders"); len(leaks) != 0 {
			t.Fatalf("a clean spec must scan clean: %v", leaks)
		}
		mutate(&spec)
		if leaks := functionPodZoneKeyLeaks(spec, "orders"); len(leaks) == 0 {
			t.Fatalf("%s: the scan missed it", name)
		}
	}
}

// --- status: computed in computeStatusVerdict -------------------------------------

// zoneKeyVerdict computes the verdict over a READY zone Knative Service, so no
// other rule schedules a requeue and the zone key's own requeue is observable.
func zoneKeyVerdict(app *appsv1alpha1.NextApp, st zoneSigningKeyState) statusVerdict {
	return computeStatusVerdict(app, readyKsvcWithRevision("orders-00001", time.Now()), databaseCheckState{}, revisionCheck{},
		imageCacheState{}, netpolEnforcementState{}, envMapCollisionReport{}, privateExposureState{},
		podCreationState{}, time.Now(), withZoneSigningKey(st))
}

func TestZoneSigningKeyConditionAbsentForAZoneWithoutFunctions(t *testing.T) {
	app := zoneWithBackends()
	v := zoneKeyVerdict(app, zoneSigningKeyState{})
	if verdictConditionOrNil(v, ConditionZoneSigningKey) != nil {
		t.Fatalf("a zone without a bound function reports no signing-key condition")
	}
	baseline := computeStatusVerdict(app, readyKsvcWithRevision("orders-00001", time.Now()), databaseCheckState{}, revisionCheck{},
		imageCacheState{}, netpolEnforcementState{}, envMapCollisionReport{}, privateExposureState{},
		podCreationState{}, time.Now())
	if v.requeueAfter != baseline.requeueAfter {
		t.Fatalf("and schedules nothing of its own: %s, want the baseline %s", v.requeueAfter, baseline.requeueAfter)
	}
	app.Status.Conditions = []metav1.Condition{{Type: ConditionZoneSigningKey, Status: metav1.ConditionTrue, Reason: ReasonSigningKeyActive}}
	v = zoneKeyVerdict(app, zoneSigningKeyState{})
	found := false
	for _, c := range v.removeConditions {
		found = found || c == ConditionZoneSigningKey
	}
	if !found {
		t.Fatalf("a previously reported condition is removed when the last binding goes")
	}
}

func TestZoneSigningKeyConditionPerPhase(t *testing.T) {
	app := zoneWithBackends(appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
	base := zoneSigningKeyState{active: true, secretName: "orders-knext-signing-key", jwksName: "orders-knext-jwks", currentKid: "KIDcur"}
	cases := []struct {
		name   string
		st     zoneSigningKeyState
		status metav1.ConditionStatus
		reason string
		rq     time.Duration
	}{
		{"steady", base, metav1.ConditionTrue, ReasonSigningKeyActive, zoneKeySteadyRecheck},
		{"propagating", func() zoneSigningKeyState {
			s := base
			s.phase, s.nextKid, s.nextStep = zoneKeyPhasePropagating, "KIDnew", 40*time.Second
			return s
		}(), metav1.ConditionTrue, ReasonSigningKeyRotationPropagating, 40*time.Second + zoneKeyRequeueSlack},
		{"overlap", func() zoneSigningKeyState {
			s := base
			s.phase, s.previousKid, s.nextStep = zoneKeyPhaseOverlap, "KIDold", 50*time.Minute
			return s
		}(), metav1.ConditionTrue, ReasonSigningKeyRotationOverlap, zoneKeySteadyRecheck},
		{"conflict", zoneSigningKeyState{active: true, problemReason: ReasonSigningKeySecretConflict, problemMessage: "m"},
			metav1.ConditionFalse, ReasonSigningKeySecretConflict, zoneKeyProblemRecheck},
		{"invalid", zoneSigningKeyState{active: true, problemReason: ReasonSigningKeyInvalid, problemMessage: "m"},
			metav1.ConditionFalse, ReasonSigningKeyInvalid, zoneKeyProblemRecheck},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v := zoneKeyVerdict(app, tc.st)
			c := verdictConditionOrNil(v, ConditionZoneSigningKey)
			if c == nil || c.Status != tc.status || c.Reason != tc.reason {
				t.Fatalf("got %+v", c)
			}
			if v.requeueAfter != tc.rq {
				t.Fatalf("requeue %s, want %s", v.requeueAfter, tc.rq)
			}
			if tc.st.currentKid != "" && !strings.Contains(c.Message, tc.st.currentKid) {
				t.Fatalf("message should name the active kid: %s", c.Message)
			}
			// The Ready roll-up is untouched: the zone still serves pages.
			if r := verdictConditionOrNil(v, ConditionReady); r != nil && r.Reason == tc.reason {
				t.Fatalf("Ready must not carry the signing-key verdict")
			}
			again := zoneKeyVerdict(app, tc.st)
			if verdictConditionOrNil(again, ConditionZoneSigningKey).Message != c.Message {
				t.Fatalf("the message must be static for a given state (#98)")
			}
		})
	}
}

func TestZoneSigningKeyEventsAreTransitionGated(t *testing.T) {
	app := zoneWithBackends(appsv1alpha1.BackendBinding{Name: "pricing", Service: "pricing"})
	st := zoneSigningKeyState{active: true, problemReason: ReasonSigningKeySecretConflict, problemMessage: "m"}
	v := zoneKeyVerdict(app, st)
	if !verdictHasEvent(v, corev1.EventTypeWarning, ReasonSigningKeySecretConflict) {
		t.Fatalf("entering a False state emits a Warning: %+v", v.events)
	}
	app.Status.Conditions = []metav1.Condition{*verdictConditionOrNil(v, ConditionZoneSigningKey)}
	if v2 := zoneKeyVerdict(app, st); verdictHasEvent(v2, corev1.EventTypeWarning, ReasonSigningKeySecretConflict) {
		t.Fatalf("a persisting state is not news every pass")
	}
	ok := zoneSigningKeyState{active: true, currentKid: "K", secretName: "s", jwksName: "j"}
	if v3 := zoneKeyVerdict(app, ok); !verdictHasEvent(v3, corev1.EventTypeNormal, ReasonSigningKeyActive) {
		t.Fatalf("recovering emits a Normal event: %+v", v3.events)
	}
}

func verdictHasEvent(v statusVerdict, typ, reason string) bool {
	for _, e := range v.events {
		if e.eventType == typ && e.reason == reason {
			return true
		}
	}
	return false
}

// --- configuration -------------------------------------------------------------

func TestZoneSigningKeyConfigDefaultsAndValidation(t *testing.T) {
	d := ZoneSigningKeyConfig{}.withDefaults()
	if d.PropagationBound != DefaultZoneKeyPropagationBound || d.RotationInterval != 0 {
		t.Fatalf("defaults: %+v", d)
	}
	if DefaultZoneKeyPropagationBound != 90*time.Second || ZoneKeyOverlap != time.Hour {
		t.Fatalf("the contract's numbers moved: bound %s overlap %s", DefaultZoneKeyPropagationBound, ZoneKeyOverlap)
	}
	for _, bad := range []ZoneSigningKeyConfig{
		{PropagationBound: 59 * time.Second},
		{PropagationBound: 90 * time.Second, RotationInterval: time.Hour},
		{PropagationBound: 90 * time.Second, RotationInterval: -time.Second},
	} {
		if err := ValidateZoneSigningKeyConfig(bad); err == nil {
			t.Fatalf("%+v must be refused", bad)
		}
	}
	for _, good := range []ZoneSigningKeyConfig{
		{PropagationBound: 60 * time.Second},
		{PropagationBound: 90 * time.Second, RotationInterval: 30 * 24 * time.Hour},
	} {
		if err := ValidateZoneSigningKeyConfig(good); err != nil {
			t.Fatalf("%+v must be accepted: %v", good, err)
		}
	}
}

// --- the shared fixture --------------------------------------------------------

type zoneIdentityFixture struct {
	Namespace string `json:"namespace"`
	Zone      struct {
		Name               string   `json:"name"`
		SigningKeySecret   string   `json:"signingKeySecret"`
		SigningKeyMountDir string   `json:"signingKeyMountDir"`
		SigningKeyFiles    []string `json:"signingKeyFiles"`
		SigningKeyFileMode int32    `json:"signingKeyFileMode"`
		IssuerEnv          string   `json:"issuerEnv"`
		Issuer             string   `json:"issuer"`
	} `json:"zone"`
	Function struct {
		Name          string `json:"name"`
		JWKSConfigMap string `json:"jwksConfigMap"`
		JWKSMountDir  string `json:"jwksMountDir"`
		JWKSFile      string `json:"jwksFile"`
		IssuerEnv     string `json:"issuerEnv"`
		Issuer        string `json:"issuer"`
		AudienceEnv   string `json:"audienceEnv"`
		Audience      string `json:"audience"`
	} `json:"function"`
	Rotation struct {
		PropagationBoundSeconds int    `json:"propagationBoundSeconds"`
		OverlapSeconds          int    `json:"overlapSeconds"`
		RequestAnnotation       string `json:"requestAnnotation"`
		MaxPublishedKeys        int    `json:"maxPublishedKeys"`
	} `json:"rotation"`
}

// The zone signer and the function verifiers build to these paths and names;
// testdata/zone-identity-contract.json is the one copy both sides assert. This
// renders the operator's zone and function Knative Services and checks every
// value against it.
func TestSharedZoneIdentityFixture(t *testing.T) {
	raw, err := os.ReadFile("testdata/zone-identity-contract.json")
	if err != nil {
		t.Fatalf("read shared fixture: %v", err)
	}
	var fx zoneIdentityFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parse shared fixture: %v", err)
	}
	if fx.Zone.Name == "" || fx.Function.Name == "" || len(fx.Zone.SigningKeyFiles) == 0 {
		t.Fatalf("fixture parsed empty; the check would be vacuous")
	}

	// Zone half.
	app := &appsv1alpha1.NextApp{ObjectMeta: metav1.ObjectMeta{Name: fx.Zone.Name, Namespace: fx.Namespace}}
	ksvc := &servingv1.Service{}
	ksvc.Spec.Template.Spec.Containers = []corev1.Container{{Image: "img"}}
	applyZoneIdentity(ksvc, app, boundZone())
	vol := ksvc.Spec.Template.Spec.Volumes[0].Secret
	if vol.SecretName != fx.Zone.SigningKeySecret || ZoneSigningKeySecretName(fx.Zone.Name) != fx.Zone.SigningKeySecret {
		t.Errorf("signing-key Secret %q, fixture %q", vol.SecretName, fx.Zone.SigningKeySecret)
	}
	var files []string
	for _, it := range vol.Items {
		files = append(files, it.Path)
	}
	if !reflect.DeepEqual(files, fx.Zone.SigningKeyFiles) {
		t.Errorf("signing-key files %v, fixture %v", files, fx.Zone.SigningKeyFiles)
	}
	if *vol.DefaultMode != fx.Zone.SigningKeyFileMode {
		t.Errorf("file mode %o, fixture %o", *vol.DefaultMode, fx.Zone.SigningKeyFileMode)
	}
	if m := ksvc.Spec.Template.Spec.Containers[0].VolumeMounts[0]; m.MountPath != fx.Zone.SigningKeyMountDir {
		t.Errorf("signing-key mount %q, fixture %q", m.MountPath, fx.Zone.SigningKeyMountDir)
	}
	if got := envValue(ksvc.Spec.Template.Spec.Containers[0].Env, fx.Zone.IssuerEnv); got != fx.Zone.Issuer {
		t.Errorf("zone %s = %q, fixture %q", fx.Zone.IssuerEnv, got, fx.Zone.Issuer)
	}

	// Function half.
	bs := &appsv1alpha1.BackendService{
		ObjectMeta: metav1.ObjectMeta{Name: fx.Function.Name, Namespace: fx.Namespace},
		Spec:       appsv1alpha1.BackendServiceSpec{Zone: fx.Zone.Name, Image: "img"},
	}
	fn := &servingv1.Service{}
	if err := buildFunctionKsvc(bs, 0, fn); err != nil {
		t.Fatal(err)
	}
	var jwksVol *corev1.ConfigMapVolumeSource
	for _, v := range fn.Spec.Template.Spec.Volumes {
		if v.ConfigMap != nil && v.Name == FunctionJWKSVolumeName {
			jwksVol = v.ConfigMap
		}
	}
	if jwksVol == nil || jwksVol.Name != fx.Function.JWKSConfigMap || jwksVol.Items[0].Path != fx.Function.JWKSFile {
		t.Errorf("JWKS volume %+v, fixture %s/%s", jwksVol, fx.Function.JWKSConfigMap, fx.Function.JWKSFile)
	}
	sawMount := false
	for _, m := range fn.Spec.Template.Spec.Containers[0].VolumeMounts {
		if m.Name == FunctionJWKSVolumeName {
			sawMount = true
			if m.MountPath != fx.Function.JWKSMountDir || m.SubPath != "" {
				t.Errorf("JWKS mount %q (subPath %q), fixture %q", m.MountPath, m.SubPath, fx.Function.JWKSMountDir)
			}
		}
	}
	if !sawMount {
		t.Errorf("the function does not mount its zone's JWKS")
	}
	env := fn.Spec.Template.Spec.Containers[0].Env
	if got := envValue(env, fx.Function.IssuerEnv); got != fx.Function.Issuer {
		t.Errorf("function %s = %q, fixture %q", fx.Function.IssuerEnv, got, fx.Function.Issuer)
	}
	if got := envValue(env, fx.Function.AudienceEnv); got != fx.Function.Audience {
		t.Errorf("function %s = %q, fixture %q", fx.Function.AudienceEnv, got, fx.Function.Audience)
	}

	// Rotation numbers.
	if time.Duration(fx.Rotation.PropagationBoundSeconds)*time.Second != DefaultZoneKeyPropagationBound ||
		time.Duration(fx.Rotation.OverlapSeconds)*time.Second != ZoneKeyOverlap ||
		fx.Rotation.RequestAnnotation != RotateSigningKeyAnnotation || fx.Rotation.MaxPublishedKeys != 2 {
		t.Errorf("rotation numbers drifted from the fixture: %+v", fx.Rotation)
	}
}

func TestSetupOptionsCarryTheZoneSigningKeyConfig(t *testing.T) {
	c := ZoneSigningKeyConfig{PropagationBound: 2 * time.Minute, RotationInterval: 7 * 24 * time.Hour}
	if got := newSetupOptions(WithZoneSigningKeyConfig(c)).zoneSigningKey; got != c {
		t.Fatalf("got %+v, want %+v", got, c)
	}
	if got := newSetupOptions().zoneSigningKey; got != (ZoneSigningKeyConfig{}) {
		t.Fatalf("no option must mean the defaults: %+v", got)
	}
}

// A rotation request reconciles at once; no other annotation edit does (the
// NextApp watch otherwise passes only generation changes, #98).
func TestRotationRequestChangedPredicate(t *testing.T) {
	mk := func(ann map[string]string) *appsv1alpha1.NextApp {
		return &appsv1alpha1.NextApp{ObjectMeta: metav1.ObjectMeta{Name: "orders", Namespace: "shop", Annotations: ann}}
	}
	cases := []struct {
		name     string
		old, new map[string]string
		want     bool
	}{
		{"request set", nil, map[string]string{RotateSigningKeyAnnotation: "1"}, true},
		{"request changed", map[string]string{RotateSigningKeyAnnotation: "1"}, map[string]string{RotateSigningKeyAnnotation: "2"}, true},
		{"request removed", map[string]string{RotateSigningKeyAnnotation: "1"}, nil, true},
		{"request unchanged", map[string]string{RotateSigningKeyAnnotation: "1"}, map[string]string{RotateSigningKeyAnnotation: "1", "other": "x"}, false},
		{"other annotation", nil, map[string]string{"kubectl.kubernetes.io/last-applied-configuration": "{}"}, false},
	}
	for _, tc := range cases {
		if got := rotationRequestChanged.Update(event.UpdateEvent{ObjectOld: mk(tc.old), ObjectNew: mk(tc.new)}); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
	if rotationRequestChanged.Create(event.CreateEvent{Object: mk(nil)}) {
		t.Errorf("create is the generation predicate's business, not this one's")
	}
}
