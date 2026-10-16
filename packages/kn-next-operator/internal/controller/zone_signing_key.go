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
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/ptr"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
	servingv1 "knative.dev/serving/pkg/apis/serving/v1"
)

// The zone's identity (ADR-0004 Amendment 1 Decisions 8 to 11; the token
// contract on #2051).
//
// A zone that has at least one two-sided function binding gets ONE Ed25519
// signing keypair, generated here, in the operator:
//
//   - the private key lives in the Secret <zone>-knext-signing-key, mounted into
//     that zone's Knative Service only (never a function: the allowlist in
//     backendservice_sovereignty.go refuses any *-knext-signing-key reference);
//   - the public keys are published in the ConfigMap <zone>-knext-jwks, which
//     each of the zone's functions mounts as a directory volume.
//
// Both carry a controller ownerReference to the zone's NextApp, so they are
// garbage-collected with it. A zone that loses its last binding stops mounting
// the key; the objects stay (and are reused on a re-bind) until the NextApp
// goes, so the operator needs no delete on Secrets.
//
// ROTATION is the load-bearing part, in this order and no other:
//
//  1. stage a new key and publish its public half in the JWKS (the current key
//     keeps signing);
//  2. wait the propagation bound (default 90 s), counted from a JWKS write this
//     operator observed succeed, so every warm function has re-read the file;
//  3. switch signing: current <- new, previous <- old;
//  4. after the 1 h overlap, drop the old key from the Secret and the JWKS.
//
// The whole state machine lives in the two objects: which data slots the
// Secret holds (current / next / previous) and three timestamps on its
// annotations. The JWKS is always DERIVED from the Secret. So every step is
// re-derivable after a crash between any two writes; see planZoneKeyStep and
// TestRotationIsCrashSafeAtEveryWrite. Key material never leaves those two
// objects: not into an annotation, an event, a log line, status or an error
// (redactKeyMaterial guards the one path an apiserver could echo it through).

const (
	// RotateSigningKeyAnnotation requests a rotation of the zone's signing key.
	// Set it on the zone's NextApp to any new value (a nonce); the operator
	// starts one rotation per distinct value. A request that arrives during a
	// rotation waits for that rotation to finish. A change of this annotation
	// reconciles the zone at once (rotationRequestChanged), although annotation
	// edits do not bump the NextApp's generation.
	RotateSigningKeyAnnotation = "apps.kn-next.dev/rotate-signing-key"

	// ZoneSigningKeyMountDir is where the zone's container reads its key:
	// current.key / current.kid, and previous.* during an overlap.
	ZoneSigningKeyMountDir = "/var/run/knext/signing-key"
	// ZoneSigningKeyVolumeName is the zone's key volume.
	ZoneSigningKeyVolumeName = "knext-zone-signing-key"

	// ZoneIssuerEnv carries the zone's token issuer (knext:zone:<ns>/<zone>)
	// into the zone's container; the signer refuses to mint without it.
	ZoneIssuerEnv = "KNEXT_ZONE_ISSUER"

	// FunctionTokenEnvPrefix is the operator-reserved env namespace on a
	// function's container (a CEL rule on BackendServiceSpec.Env refuses it).
	FunctionTokenEnvPrefix = "KNEXT_TOKEN_"
	// FunctionTokenIssuerEnv is the issuer a function's verifier accepts.
	FunctionTokenIssuerEnv = FunctionTokenEnvPrefix + "ISSUER"
	// FunctionTokenAudienceEnv is the audience a function's verifier accepts.
	FunctionTokenAudienceEnv = FunctionTokenEnvPrefix + "AUDIENCE"

	// Data keys of the signing-key Secret. current.* and previous.* are the
	// contract the zone's signer reads; next.* is the operator's staging slot
	// during step 2 and is never projected into the zone's pod.
	signingKeyCurrentKey  = "current.key"
	signingKeyCurrentKid  = "current.kid"
	signingKeyNextKey     = "next.key"
	signingKeyNextKid     = "next.kid"
	signingKeyPreviousKey = "previous.key"
	signingKeyPreviousKid = "previous.kid"

	// Rotation state on the Secret's annotations. Timestamps, never deadlines,
	// so a changed propagation bound applies to a rotation already in flight.
	// RFC 3339 with nanoseconds: a truncated stamp would start the wait EARLIER
	// than the real publish.
	annSigningKeyCurrentSince    = "apps.kn-next.dev/signing-key-current-since"
	annSigningKeyNextPublishedAt = "apps.kn-next.dev/signing-key-next-published-at"
	annSigningKeySwitchedAt      = "apps.kn-next.dev/signing-key-switched-at"
	annSigningKeyRotationNonce   = "apps.kn-next.dev/signing-key-rotation-nonce"

	// DefaultZoneKeyPropagationBound is the default wait between publishing a
	// new public key and signing with it: the kubelet's ConfigMap-volume sync
	// bound (about 60 to 90 s on a default kubelet).
	DefaultZoneKeyPropagationBound = 90 * time.Second
	// MinZoneKeyPropagationBound is the smallest bound the operator accepts: a
	// default kubelet syncs volumes every 60 s, so anything shorter can switch
	// signing before a warm function has the key.
	MinZoneKeyPropagationBound = 60 * time.Second
	// ZoneKeyOverlap is how long the previous key stays published after the
	// switch: longer than a token's 60 s life plus a zone rollout.
	ZoneKeyOverlap = time.Hour

	// zoneKeySteadyRecheck re-reads the key and JWKS of a bound zone this often
	// even when nothing is scheduled. The operator cannot watch Secrets (no
	// list/watch, by design), so this is what restores a deleted key Secret or
	// an edited JWKS without waiting for an unrelated event.
	zoneKeySteadyRecheck = 10 * time.Minute
	// zoneKeyProblemRecheck re-checks a conflicting or invalid object.
	zoneKeyProblemRecheck = 2 * time.Minute
	// zoneKeyRequeueSlack lands the timer after a step's due time, not a
	// scheduling tick before it.
	zoneKeyRequeueSlack = 500 * time.Millisecond

	// maxZoneKeySteps bounds the writes one reconcile pass makes (a rotation
	// from a cold start is at most create, publish, stamp, then a wait).
	maxZoneKeySteps = 8
)

// ZoneIssuer is a zone's token issuer: knext:zone:<namespace>/<zone>.
func ZoneIssuer(namespace, zone string) string { return "knext:zone:" + namespace + "/" + zone }

// FunctionAudience is a function's token audience: knext:fn:<namespace>/<fn>.
func FunctionAudience(namespace, function string) string {
	return "knext:fn:" + namespace + "/" + function
}

// --- key material ----------------------------------------------------------------

// zoneKey is one Ed25519 keypair with its contract encodings.
type zoneKey struct {
	priv ed25519.PrivateKey
	pub  ed25519.PublicKey
	kid  string
	pem  []byte // PKCS#8 "PRIVATE KEY"
}

// ZoneKeyID is the contract kid: base64url (no padding) of the first 16 bytes
// of SHA-256 over the raw 32-byte public key.
func ZoneKeyID(pub ed25519.PublicKey) string {
	sum := sha256.Sum256(pub)
	return base64.RawURLEncoding.EncodeToString(sum[:16])
}

// newZoneKey generates a keypair from r (crypto/rand.Reader in production).
func newZoneKey(r io.Reader) (zoneKey, error) {
	pub, priv, err := ed25519.GenerateKey(r)
	if err != nil {
		return zoneKey{}, fmt.Errorf("generating an Ed25519 key: %w", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return zoneKey{}, errors.New("encoding the zone key as PKCS#8 failed")
	}
	return zoneKey{
		priv: priv,
		pub:  pub,
		kid:  ZoneKeyID(pub),
		pem:  pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}),
	}, nil
}

// parseZoneKey reads one key slot. Its errors never quote the input.
func parseZoneKey(pemBytes []byte, kid string) (zoneKey, error) {
	block, rest := pem.Decode(pemBytes)
	if block == nil || block.Type != "PRIVATE KEY" || len(strings.TrimSpace(string(rest))) != 0 {
		return zoneKey{}, errors.New("is not a single PKCS#8 \"PRIVATE KEY\" PEM block")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return zoneKey{}, errors.New("is not a parseable PKCS#8 private key")
	}
	priv, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return zoneKey{}, errors.New("is not an Ed25519 key")
	}
	pub, ok := priv.Public().(ed25519.PublicKey)
	if !ok {
		return zoneKey{}, errors.New("has no Ed25519 public half")
	}
	if want := ZoneKeyID(pub); kid != want {
		return zoneKey{}, errors.New("has a kid that does not match the key")
	}
	return zoneKey{priv: priv, pub: pub, kid: kid, pem: pemBytes}, nil
}

// jwk is one RFC 8037 OKP public key. It has no field for the private member,
// so a JWKS built from it cannot carry one.
type jwk struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Kid string `json:"kid"`
	Alg string `json:"alg"`
	Use string `json:"use"`
}

// buildZoneJWKS renders the RFC 7517 JWK Set for the given public keys, sorted
// by kid (so the signing switch, which keeps the key SET, keeps the bytes).
func buildZoneJWKS(pubs ...ed25519.PublicKey) ([]byte, error) {
	keys := make([]jwk, 0, len(pubs))
	for _, pub := range pubs {
		if len(pub) != ed25519.PublicKeySize {
			return nil, errors.New("an Ed25519 public key must be 32 bytes")
		}
		keys = append(keys, jwk{
			Kty: "OKP", Crv: "Ed25519",
			X:   base64.RawURLEncoding.EncodeToString(pub),
			Kid: ZoneKeyID(pub),
			Alg: "EdDSA", Use: "sig",
		})
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].Kid < keys[j].Kid })
	return json.Marshal(struct {
		Keys []jwk `json:"keys"`
	}{keys})
}

// jwksHasKid reports whether a JWKS document lists kid. An unparseable
// document lists nothing.
func jwksHasKid(raw, kid string) bool {
	var set struct {
		Keys []struct {
			Kid string `json:"kid"`
		} `json:"keys"`
	}
	if err := json.Unmarshal([]byte(raw), &set); err != nil {
		return false
	}
	for _, k := range set.Keys {
		if k.Kid == kid {
			return true
		}
	}
	return false
}

// --- the Secret ------------------------------------------------------------------

// signingKeySet is the zone's key state as the Secret holds it.
type signingKeySet struct {
	current, next, previous *zoneKey

	currentSince    time.Time
	nextPublishedAt time.Time
	switchedAt      time.Time
	rotationNonce   string
}

// publicKeys are the keys the JWKS must publish: current, and the staged or
// previous one.
func (s signingKeySet) publicKeys() []ed25519.PublicKey {
	var out []ed25519.PublicKey
	for _, k := range []*zoneKey{s.current, s.next, s.previous} {
		if k != nil {
			out = append(out, k.pub)
		}
	}
	return out
}

// desiredJWKS is the JWKS derived from the Secret.
func (s signingKeySet) desiredJWKS() string {
	b, err := buildZoneJWKS(s.publicKeys()...)
	if err != nil {
		return "" // unreachable for parsed keys; an empty document never matches
	}
	return string(b)
}

// keys lists every key the set holds (for redaction).
func (s signingKeySet) keys() []*zoneKey {
	var out []*zoneKey
	for _, k := range []*zoneKey{s.current, s.next, s.previous} {
		if k != nil {
			out = append(out, k)
		}
	}
	return out
}

func formatStamp(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

// applyTo writes the set into a Secret's data and annotations, removing any
// slot or stamp the set does not hold. Other annotations are left alone.
func (s signingKeySet) applyTo(sec *corev1.Secret) {
	if sec.Data == nil {
		sec.Data = map[string][]byte{}
	}
	if sec.Annotations == nil {
		sec.Annotations = map[string]string{}
	}
	slot := func(k *zoneKey, keyName, kidName string) {
		if k == nil {
			delete(sec.Data, keyName)
			delete(sec.Data, kidName)
			return
		}
		sec.Data[keyName] = append([]byte(nil), k.pem...)
		sec.Data[kidName] = []byte(k.kid)
	}
	slot(s.current, signingKeyCurrentKey, signingKeyCurrentKid)
	slot(s.next, signingKeyNextKey, signingKeyNextKid)
	slot(s.previous, signingKeyPreviousKey, signingKeyPreviousKid)
	stamp := func(t time.Time, name string) {
		if t.IsZero() {
			delete(sec.Annotations, name)
			return
		}
		sec.Annotations[name] = formatStamp(t)
	}
	stamp(s.currentSince, annSigningKeyCurrentSince)
	stamp(s.nextPublishedAt, annSigningKeyNextPublishedAt)
	stamp(s.switchedAt, annSigningKeySwitchedAt)
	if s.rotationNonce == "" {
		delete(sec.Annotations, annSigningKeyRotationNonce)
	} else {
		sec.Annotations[annSigningKeyRotationNonce] = s.rotationNonce
	}
}

// readSigningKeySecret parses the Secret's slots and stamps. Any inconsistency
// is an error that names the slot and never quotes its content.
func readSigningKeySecret(sec *corev1.Secret) (signingKeySet, error) {
	var s signingKeySet
	read := func(keyName, kidName string, required bool) (*zoneKey, error) {
		pemBytes, hasKey := sec.Data[keyName]
		kid, hasKid := sec.Data[kidName]
		if !hasKey && !hasKid {
			if required {
				return nil, fmt.Errorf("%s is missing", keyName)
			}
			return nil, nil
		}
		if !hasKey || !hasKid {
			return nil, fmt.Errorf("%s and %s must be set together", keyName, kidName)
		}
		k, err := parseZoneKey(pemBytes, string(kid))
		if err != nil {
			return nil, fmt.Errorf("%s %s", keyName, err.Error())
		}
		return &k, nil
	}
	var err error
	if s.current, err = read(signingKeyCurrentKey, signingKeyCurrentKid, true); err != nil {
		return s, err
	}
	if s.next, err = read(signingKeyNextKey, signingKeyNextKid, false); err != nil {
		return s, err
	}
	if s.previous, err = read(signingKeyPreviousKey, signingKeyPreviousKid, false); err != nil {
		return s, err
	}
	if s.next != nil && s.previous != nil {
		return s, errors.New("holds both a staged next key and a previous key; a rotation starts only from a single key")
	}
	stamp := func(name string) (time.Time, error) {
		v, ok := sec.Annotations[name]
		if !ok {
			return time.Time{}, nil
		}
		t, err := time.Parse(time.RFC3339Nano, v)
		if err != nil {
			return time.Time{}, fmt.Errorf("annotation %s is not an RFC 3339 time", name)
		}
		return t, nil
	}
	if s.currentSince, err = stamp(annSigningKeyCurrentSince); err != nil {
		return s, err
	}
	if s.nextPublishedAt, err = stamp(annSigningKeyNextPublishedAt); err != nil {
		return s, err
	}
	if s.switchedAt, err = stamp(annSigningKeySwitchedAt); err != nil {
		return s, err
	}
	s.rotationNonce = sec.Annotations[annSigningKeyRotationNonce]
	return s, nil
}

// --- configuration -------------------------------------------------------------

// ZoneSigningKeyConfig tunes the rotation. The zero value means the defaults.
type ZoneSigningKeyConfig struct {
	// PropagationBound is the wait between publishing a new public key and
	// signing with it. 0 means DefaultZoneKeyPropagationBound.
	PropagationBound time.Duration
	// RotationInterval rotates every zone key this long after it became
	// current. 0 (the default) turns scheduled rotation off: keys rotate only
	// on the RotateSigningKeyAnnotation request.
	RotationInterval time.Duration
}

func (c ZoneSigningKeyConfig) withDefaults() ZoneSigningKeyConfig {
	if c.PropagationBound == 0 {
		c.PropagationBound = DefaultZoneKeyPropagationBound
	}
	return c
}

// ValidateZoneSigningKeyConfig refuses a configuration that would break the
// rotation order: a bound shorter than a default kubelet's volume sync, or an
// interval that would start a new rotation before the last one could finish.
func ValidateZoneSigningKeyConfig(c ZoneSigningKeyConfig) error {
	c = c.withDefaults()
	if c.PropagationBound < MinZoneKeyPropagationBound {
		return fmt.Errorf("the zone signing-key propagation bound %s is below the %s minimum "+
			"(a default kubelet syncs ConfigMap volumes every 60 s)", c.PropagationBound, MinZoneKeyPropagationBound)
	}
	if c.RotationInterval < 0 {
		return fmt.Errorf("the zone signing-key rotation interval %s is negative", c.RotationInterval)
	}
	if c.RotationInterval > 0 && c.RotationInterval <= c.PropagationBound+ZoneKeyOverlap {
		return fmt.Errorf("the zone signing-key rotation interval %s must exceed the propagation bound plus the %s overlap",
			c.RotationInterval, ZoneKeyOverlap)
	}
	return nil
}

// --- the planner (pure) -----------------------------------------------------------

// zoneKeyAction is the next step of the key's lifecycle.
type zoneKeyAction string

const (
	zkCreateSecret      zoneKeyAction = "CreateSecret"
	zkPublishJWKS       zoneKeyAction = "PublishJWKS"
	zkMarkPublished     zoneKeyAction = "MarkPublished"
	zkSwitchSigning     zoneKeyAction = "SwitchSigning"
	zkStampSwitched     zoneKeyAction = "StampSwitched"
	zkRetirePrevious    zoneKeyAction = "RetirePrevious"
	zkStampCurrentSince zoneKeyAction = "StampCurrentSince"
	zkStartRotation     zoneKeyAction = "StartRotation"
	// zkWait: nothing to do now; wait is the time until the next step is due
	// (0: nothing is scheduled).
	zkWait zoneKeyAction = "Wait"
)

// zoneKeyWorld is what the two objects say, as read at the start of a pass and
// updated in memory as the pass writes.
type zoneKeyWorld struct {
	secretFound bool
	keys        signingKeySet
	jwksFound   bool
	jwks        string
	// nextFreshlyPublished: THIS pass wrote a JWKS that added the staged key,
	// so its publish time must be (re)stamped now; an older stamp never counts.
	nextFreshlyPublished bool
}

// zoneKeyInputs are the pass's inputs besides the objects.
type zoneKeyInputs struct {
	now            time.Time
	cfg            ZoneSigningKeyConfig
	requestedNonce string
}

// zoneKeyStep is one planned step.
type zoneKeyStep struct {
	action zoneKeyAction
	wait   time.Duration
}

// planZoneKeyStep returns the next step for the observed objects. PURE. The
// rules, in order:
//
//   - no Secret: create it with a fresh current key;
//   - the JWKS differs from the one the Secret implies: write it (this is
//     publish, retire-from-JWKS and drift repair at once);
//   - a staged key: stamp its publish time if this pass published it or it was
//     never stamped; switch only once the bound has passed since that stamp;
//   - a previous key: stamp the switch if unstamped; retire only once the
//     overlap has passed since that stamp;
//   - a single key: start a rotation on a new request nonce or when the
//     scheduled interval is due.
//
// A missing stamp is always set to NOW, never guessed backwards: it can only
// make a wait longer, never shorter.
func planZoneKeyStep(w zoneKeyWorld, in zoneKeyInputs) zoneKeyStep {
	cfg := in.cfg.withDefaults()
	if !w.secretFound {
		return zoneKeyStep{action: zkCreateSecret}
	}
	if !w.jwksFound || w.jwks != w.keys.desiredJWKS() {
		return zoneKeyStep{action: zkPublishJWKS}
	}
	k := w.keys
	switch {
	case k.next != nil:
		if w.nextFreshlyPublished || k.nextPublishedAt.IsZero() {
			return zoneKeyStep{action: zkMarkPublished}
		}
		if due := k.nextPublishedAt.Add(cfg.PropagationBound); in.now.Before(due) {
			return zoneKeyStep{action: zkWait, wait: due.Sub(in.now)}
		}
		return zoneKeyStep{action: zkSwitchSigning}
	case k.previous != nil:
		if k.switchedAt.IsZero() {
			return zoneKeyStep{action: zkStampSwitched}
		}
		if due := k.switchedAt.Add(ZoneKeyOverlap); in.now.Before(due) {
			return zoneKeyStep{action: zkWait, wait: due.Sub(in.now)}
		}
		return zoneKeyStep{action: zkRetirePrevious}
	}
	if k.currentSince.IsZero() {
		return zoneKeyStep{action: zkStampCurrentSince}
	}
	if in.requestedNonce != "" && in.requestedNonce != k.rotationNonce {
		return zoneKeyStep{action: zkStartRotation}
	}
	if cfg.RotationInterval > 0 {
		due := k.currentSince.Add(cfg.RotationInterval)
		if !in.now.Before(due) {
			return zoneKeyStep{action: zkStartRotation}
		}
		return zoneKeyStep{action: zkWait, wait: due.Sub(in.now)}
	}
	return zoneKeyStep{action: zkWait}
}

// zoneKeyWrite names the object a step changed.
type zoneKeyWrite int

const (
	zkWriteNone zoneKeyWrite = iota
	zkWriteSecret
	zkWriteJWKS
)

// advanceZoneKey applies one planned step to the in-memory world and returns
// which object must now be persisted. PURE but for gen. Every step changes
// exactly one object, so a crash leaves the store at a step boundary.
func advanceZoneKey(w *zoneKeyWorld, s zoneKeyStep, in zoneKeyInputs, gen func() (zoneKey, error)) (zoneKeyWrite, error) {
	now := in.now
	switch s.action {
	case zkCreateSecret:
		k, err := gen()
		if err != nil {
			return zkWriteNone, err
		}
		w.keys = signingKeySet{current: &k, currentSince: now, rotationNonce: in.requestedNonce}
		w.secretFound = true
		return zkWriteSecret, nil
	case zkPublishJWKS:
		if w.keys.next != nil && !jwksHasKid(w.jwks, w.keys.next.kid) {
			w.nextFreshlyPublished = true
		}
		w.jwks, w.jwksFound = w.keys.desiredJWKS(), true
		return zkWriteJWKS, nil
	case zkMarkPublished:
		w.keys.nextPublishedAt = now
		w.nextFreshlyPublished = false
		return zkWriteSecret, nil
	case zkSwitchSigning:
		w.keys.previous, w.keys.current, w.keys.next = w.keys.current, w.keys.next, nil
		w.keys.nextPublishedAt = time.Time{}
		w.keys.switchedAt = now
		w.keys.currentSince = now
		return zkWriteSecret, nil
	case zkStampSwitched:
		w.keys.switchedAt = now
		return zkWriteSecret, nil
	case zkRetirePrevious:
		w.keys.previous = nil
		w.keys.switchedAt = time.Time{}
		return zkWriteSecret, nil
	case zkStampCurrentSince:
		w.keys.currentSince = now
		return zkWriteSecret, nil
	case zkStartRotation:
		k, err := gen()
		if err != nil {
			return zkWriteNone, err
		}
		w.keys.next = &k
		w.keys.nextPublishedAt = time.Time{}
		if in.requestedNonce != "" {
			w.keys.rotationNonce = in.requestedNonce
		}
		return zkWriteSecret, nil
	}
	return zkWriteNone, nil
}

// --- status (computed in computeStatusVerdict, never in Reconcile) ---------------

const (
	// ConditionZoneSigningKey reports the zone's signing key and JWKS. Present
	// only while the zone has a two-sided function binding. Informational:
	// Ready keeps reflecting whether the zone serves; a call that cannot be
	// signed or verified fails closed at call time.
	ConditionZoneSigningKey = "ZoneSigningKey"

	ReasonSigningKeyActive              = "KeyActive"
	ReasonSigningKeyRotationPropagating = "RotationPropagating"
	ReasonSigningKeyRotationOverlap     = "RotationOverlap"
	ReasonSigningKeySecretConflict      = "SigningKeySecretConflict"
	ReasonJWKSConfigMapConflict         = "JWKSConfigMapConflict"
	ReasonSigningKeyInvalid             = "SigningKeyInvalid"
)

// zoneKeyPhase is where the key is in its lifecycle.
type zoneKeyPhase string

const (
	zoneKeyPhaseSteady      zoneKeyPhase = ""
	zoneKeyPhasePropagating zoneKeyPhase = "propagating"
	zoneKeyPhaseOverlap     zoneKeyPhase = "overlap"
)

// zoneSigningKeyState is what the verdict needs. The zero value (active
// false) means the zone has no bound function: no condition, no requeue.
type zoneSigningKeyState struct {
	active bool
	// problemReason/problemMessage: a False state (conflict or invalid).
	problemReason  string
	problemMessage string

	phase       zoneKeyPhase
	currentKid  string
	nextKid     string
	previousKid string
	// pending: a rotation request arrived during a rotation and waits for it.
	pending bool
	// nextStep is the time until the next scheduled step (0: none).
	nextStep time.Duration

	secretName string
	jwksName   string
}

// zoneKeyStatusFrom summarises the world after a pass.
func zoneKeyStatusFrom(w zoneKeyWorld, in zoneKeyInputs, last zoneKeyStep, zone string) zoneSigningKeyState {
	st := zoneSigningKeyState{
		active:     true,
		secretName: ZoneSigningKeySecretName(zone),
		jwksName:   ZoneJWKSConfigMapName(zone),
	}
	if last.action == zkWait {
		st.nextStep = last.wait
	} else {
		// The pass ran out of steps before it reached a wait: come back soon.
		st.nextStep = time.Second
	}
	k := w.keys
	if k.current != nil {
		st.currentKid = k.current.kid
	}
	switch {
	case k.next != nil:
		st.phase, st.nextKid = zoneKeyPhasePropagating, k.next.kid
	case k.previous != nil:
		st.phase, st.previousKid = zoneKeyPhaseOverlap, k.previous.kid
	}
	st.pending = st.phase != zoneKeyPhaseSteady && in.requestedNonce != "" && in.requestedNonce != k.rotationNonce
	return st
}

// zoneSigningKeyCondition builds the condition. Messages are static for a
// given state (kids, no elapsed time) so a converged status write is a no-op.
func zoneSigningKeyCondition(app *appsv1alpha1.NextApp, st zoneSigningKeyState) metav1.Condition {
	c := metav1.Condition{Type: ConditionZoneSigningKey, ObservedGeneration: app.Generation}
	if st.problemReason != "" {
		c.Status, c.Reason, c.Message = metav1.ConditionFalse, st.problemReason, st.problemMessage
		return c
	}
	c.Status = metav1.ConditionTrue
	switch st.phase {
	case zoneKeyPhasePropagating:
		c.Reason = ReasonSigningKeyRotationPropagating
		c.Message = fmt.Sprintf("rotating: new key %s is published in ConfigMap %s and becomes the signing key once "+
			"the propagation bound has passed; key %s signs until then", st.nextKid, st.jwksName, st.currentKid)
	case zoneKeyPhaseOverlap:
		c.Reason = ReasonSigningKeyRotationOverlap
		c.Message = fmt.Sprintf("rotated: key %s signs; previous key %s stays published in ConfigMap %s for the "+
			"overlap and is then retired", st.currentKid, st.previousKid, st.jwksName)
	default:
		c.Reason = ReasonSigningKeyActive
		c.Message = fmt.Sprintf("key %s signs this zone's calls to its functions; Secret %s holds it and "+
			"ConfigMap %s publishes its public key", st.currentKid, st.secretName, st.jwksName)
	}
	if st.pending {
		c.Message += ". A further rotation request is pending and starts when this rotation completes"
	}
	return c
}

// zoneSigningKeyRequeue is how soon a bound zone's key must be looked at again.
func zoneSigningKeyRequeue(st zoneSigningKeyState) time.Duration {
	if !st.active {
		return 0
	}
	if st.problemReason != "" {
		return zoneKeyProblemRecheck
	}
	rq := zoneKeySteadyRecheck
	if st.nextStep > 0 && st.nextStep+zoneKeyRequeueSlack < rq {
		rq = st.nextStep + zoneKeyRequeueSlack
	}
	return rq
}

// --- redaction ---------------------------------------------------------------------

var pemBlockPattern = regexp.MustCompile(`-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----\n?`)

// redactKeyMaterial removes every encoding of the given keys from a message,
// and any PEM block at all. It is applied to every error the key reconcile
// returns, which is the only path an apiserver (or an admission webhook) could
// echo a Secret's content back through into an event, a log line or status.
func redactKeyMaterial(msg string, keys []*zoneKey) string {
	for _, k := range keys {
		if k == nil {
			continue
		}
		var needles []string
		needles = append(needles, string(k.pem))
		for _, line := range strings.Split(string(k.pem), "\n") {
			if l := strings.TrimSpace(line); l != "" && !strings.HasPrefix(l, "-----") {
				needles = append(needles, l)
			}
		}
		needles = append(needles,
			base64.StdEncoding.EncodeToString(k.pem),
			base64.StdEncoding.EncodeToString(k.priv.Seed()),
			base64.RawStdEncoding.EncodeToString(k.priv.Seed()),
			base64.RawURLEncoding.EncodeToString(k.priv.Seed()),
			base64.StdEncoding.EncodeToString(k.priv),
		)
		for _, n := range needles {
			if n != "" {
				msg = strings.ReplaceAll(msg, n, "[REDACTED]")
			}
		}
	}
	return pemBlockPattern.ReplaceAllString(msg, "[REDACTED PEM]")
}

// redactZoneKeyError returns err with every key encoding removed. The result
// keeps no wrapped error, so nothing downstream can format the original.
func redactZoneKeyError(err error, keys []*zoneKey) error {
	if err == nil {
		return nil
	}
	return errors.New(redactKeyMaterial(err.Error(), keys))
}

// --- render: the zone's Knative Service -----------------------------------------

// hasBoundFunction reports whether the zone has at least one two-sided binding.
func hasBoundFunction(b zoneBindings) bool {
	for _, e := range b.entries {
		if e.state == bindingBound {
			return true
		}
	}
	return false
}

// applyZoneIdentity mounts the zone's signing key into its container and sets
// its issuer, only while the zone has a bound function; otherwise it changes
// nothing, so a zone without functions renders byte-identically. The volume is
// a directory (never a subPath) so a rotated key reaches a warm pod; it
// projects the contract slots only (current.*, previous.*), so the staged key
// never reaches the zone; it is optional, so an absent Secret leaves the zone
// serving and its signer failing closed. A spec.env/envMap entry already named
// KNEXT_ZONE_ISSUER is kept and reported, never overwritten.
func applyZoneIdentity(ksvc *servingv1.Service, app *appsv1alpha1.NextApp, b zoneBindings) []string {
	containers := ksvc.Spec.Template.Spec.Containers
	if !hasBoundFunction(b) || len(containers) == 0 {
		return nil
	}
	items := make([]corev1.KeyToPath, 0, 4)
	for _, k := range []string{signingKeyCurrentKey, signingKeyCurrentKid, signingKeyPreviousKey, signingKeyPreviousKid} {
		items = append(items, corev1.KeyToPath{Key: k, Path: k})
	}
	ksvc.Spec.Template.Spec.Volumes = append(ksvc.Spec.Template.Spec.Volumes, corev1.Volume{
		Name: ZoneSigningKeyVolumeName,
		VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{
			SecretName: ZoneSigningKeySecretName(app.Name),
			Items:      items,
			// 0444: the app runs non-root and Knative disables pod fsGroup by
			// default, so a group-only mode would be unreadable. Only the
			// zone's own container mounts it.
			DefaultMode: ptr.To[int32](0o444),
			Optional:    ptr.To(true),
		}},
	})
	containers[0].VolumeMounts = append(containers[0].VolumeMounts, corev1.VolumeMount{
		Name: ZoneSigningKeyVolumeName, MountPath: ZoneSigningKeyMountDir, ReadOnly: true,
	})
	for _, e := range containers[0].Env {
		if e.Name == ZoneIssuerEnv {
			return []string{ZoneIssuerEnv}
		}
	}
	containers[0].Env = append(containers[0].Env, corev1.EnvVar{Name: ZoneIssuerEnv, Value: ZoneIssuer(app.Namespace, app.Name)})
	return nil
}

// functionIdentityEnv is the env a function's verifier reads. It replaces any
// user entry in the reserved KNEXT_TOKEN_ namespace (admission refuses one; a
// CR that predates the rule still never sets the verifier's identity).
func functionIdentityEnv(bs *appsv1alpha1.BackendService) []corev1.EnvVar {
	env := make([]corev1.EnvVar, 0, len(bs.Spec.Env)+2)
	for _, e := range bs.Spec.Env {
		if strings.HasPrefix(e.Name, FunctionTokenEnvPrefix) {
			continue
		}
		env = append(env, e)
	}
	return append(env,
		corev1.EnvVar{Name: FunctionTokenIssuerEnv, Value: ZoneIssuer(bs.Namespace, bs.Spec.Zone)},
		corev1.EnvVar{Name: FunctionTokenAudienceEnv, Value: FunctionAudience(bs.Namespace, bs.Name)},
	)
}
