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
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	appsv1alpha1 "github.com/AhmedElBanna80/knext/packages/kn-next-operator/api/v1alpha1"
)

// The spec pin on a zone's backends[] entry (ADR-0004 Amendment 4). The image
// pin binds spec.image only; a principal who can write the BackendService can
// keep the pinned digest and add env (NODE_OPTIONS=--import=...), envFrom or
// volumes, and so run code with the zone's database Secret mounted. The spec
// pin closes that: the zone pins a digest of everything in the BackendService
// that decides what code runs and what it can read, and the operator
// re-computes it from the live object and compares.
//
// Everything here is PURE and reads only the two specs in hand, so a mismatch
// is positive evidence and a transient read can never cause one.
//
// THE CANONICAL FORM (version 1). The CLI (packages/grpc/src/spec-digest.ts)
// implements the same algorithm; testdata/backend-spec-digest-vectors.json is
// recomputed by both and must agree.
//
//  1. Project: take the BackendServiceSpec as JSON and keep only the members
//     named in specPinHashedFields (image, env, envFrom, volumes).
//  2. Normalise, recursively: drop every object member whose value is null,
//     "", false, an empty list or an empty object. (The Go type omits some
//     zero values and not others; this makes absent, empty and false the same
//     thing on both sides, and they ARE the same to Kubernetes for every
//     hashed type.) Numbers are kept, so defaultMode: 0 differs from absent.
//  3. Encode, deterministically:
//     string  s<N>:<bytes>   N = the UTF-8 byte length, in decimal
//     integer i<N>;
//     true    t
//     list    l<item>...e    list order is kept: it is part of the digest
//     object  d<key><value>...e   keys are strings, sorted by UTF-8 bytes
//     No whitespace, no escaping. Floats and null are refused.
//  4. digest = "sha256:" + hex(SHA-256(specDigestDomain + encoding)).
//
// List order is kept on purpose: env order decides $(VAR) expansion and envFrom
// order decides which source wins a key collision, so a reorder is a change of
// what the pod sees. The cost is that a tool which reorders a list makes the
// pin mismatch, which fails closed.

// specDigestDomain separates this digest from any other use of SHA-256 and
// carries the version of the canonical form.
const specDigestDomain = "knext/backendservice-spec/v1\n"

// specPinHashedFields are the BackendServiceSpec members the digest binds: the
// ones that decide WHAT CODE RUNS (image, and env/envFrom/volumes, which can
// inject code through NODE_OPTIONS, a mounted file or a loader) and WHAT IT CAN
// READ (the Secrets and ConfigMaps env, envFrom and volumes name).
//
// A hashed member is bound whole: the digest covers its marshalled form, so a
// field added inside env, envFrom or volumes later is bound with no change here.
// Adding a top-level field to BackendServiceSpec is what must come HERE or on
// the exclusion list below: TestEveryBackendServiceSpecFieldIsBoundOrReviewed
// fails until it does.
var specPinHashedFields = []string{"image", "env", "envFrom", "volumes"}

// Why a field is excluded.
const (
	// exclusionNotRendered: the operator renders nothing into the function's
	// objects from it. The guard test proves that against the rendered output.
	exclusionNotRendered = "notRendered"
	// exclusionOperational: it reaches the pod but only as tuning that cannot
	// add code or widen what the pod can read.
	exclusionOperational = "operational"
	// exclusionBindingIdentity: it names the binding itself.
	exclusionBindingIdentity = "bindingIdentity"
)

type specPinExclusion struct {
	Class  string
	Reason string
}

// specPinExcludedFields are the BackendServiceSpec members the digest does NOT
// bind, each with the reviewed reason. A new field is not allowed to default
// into this list: the guard test fails until it is classified, and a reviewer
// reads the reason. Each is a residual the docs name (ADR-0004 Amendment 4).
var specPinExcludedFields = map[string]specPinExclusion{
	"zone": {exclusionBindingIdentity,
		"Immutable (a CEL rule) and the other half of the binding itself: the operator resolves the zone by " +
			"this name, so changing it unbinds the function from this zone instead of changing what it runs."},
	"language": {exclusionNotRendered,
		"Informational metadata; the operator renders nothing from it into the function's objects."},
	"wakeAhead": {exclusionNotRendered,
		"Only decides whether the zone's own wake list names the function; nothing is rendered into the function."},
	"port": {exclusionOperational,
		"Chooses which container port Knative sends h2c traffic to inside the same pod; it adds no code to the " +
			"pinned image and widens nothing the pod can read. Residual: it can aim traffic at another listener of the image."},
	"protoVersion": {exclusionOperational,
		"Stamped as an annotation on the revision and echoed to the zone; it does not change what runs. " +
			"Residual: a writer can misreport the served contract version to the zone's version gate."},
	"scaling": {exclusionOperational,
		"Autoscaling bounds (min, max, concurrency): availability and cost, not what runs or what it can read."},
	"resources": {exclusionOperational,
		"CPU and memory requests and limits: availability and cost, not what runs or what it can read."},
	"imagePullSecrets": {exclusionOperational,
		"Set on the operator-owned ServiceAccount and used by the kubelet only to authenticate the pull of an " +
			"image whose digest the pin fixes; the pod does not mount them (automount is off)."},
}

// canonicalBackendSpec returns the canonical encoding (steps 1 to 3 above) of
// the spec's hashed members, without the domain prefix.
func canonicalBackendSpec(spec *appsv1alpha1.BackendServiceSpec) (string, error) {
	raw, err := json.Marshal(spec)
	if err != nil {
		return "", fmt.Errorf("marshalling the spec: %w", err)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var all map[string]any
	if err := dec.Decode(&all); err != nil {
		return "", fmt.Errorf("decoding the spec: %w", err)
	}
	projection := map[string]any{}
	for _, f := range specPinHashedFields {
		if v, ok := all[f]; ok {
			projection[f] = v
		}
	}
	normalised, _ := normaliseCanonical(projection)
	return canonicalValue(normalised)
}

// backendSpecDigest is the digest the zone pins: "sha256:<64 lowercase hex>".
func backendSpecDigest(spec *appsv1alpha1.BackendServiceSpec) (string, error) {
	canonical, err := canonicalBackendSpec(spec)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(specDigestDomain + canonical))
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}

// normaliseCanonical applies step 2. The boolean says the value is "empty" and
// should be dropped by its parent object.
func normaliseCanonical(v any) (any, bool) {
	switch t := v.(type) {
	case nil:
		return nil, true
	case string:
		return t, t == ""
	case bool:
		return t, !t
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, x := range t {
			nx, empty := normaliseCanonical(x)
			if !empty {
				out[k] = nx
			}
		}
		return out, len(out) == 0
	case []any:
		out := make([]any, len(t))
		for i, x := range t {
			out[i], _ = normaliseCanonical(x)
		}
		return out, len(out) == 0
	default:
		return v, false
	}
}

// canonicalValue is step 3: the deterministic encoding of a normalised value.
func canonicalValue(v any) (string, error) {
	var b strings.Builder
	if err := writeCanonical(&b, v); err != nil {
		return "", err
	}
	return b.String(), nil
}

func writeCanonical(b *strings.Builder, v any) error {
	switch t := v.(type) {
	case string:
		fmt.Fprintf(b, "s%d:%s", len(t), t)
	case bool:
		if !t {
			return fmt.Errorf("a false value has no canonical encoding (it is dropped by normalisation)")
		}
		b.WriteString("t")
	case json.Number:
		n, err := strconv.ParseInt(t.String(), 10, 64)
		if err != nil {
			return fmt.Errorf("number %q is not an integer: the canonical form takes integers only", t.String())
		}
		fmt.Fprintf(b, "i%d;", n)
	case []any:
		b.WriteString("l")
		for _, x := range t {
			if err := writeCanonical(b, x); err != nil {
				return err
			}
		}
		b.WriteString("e")
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys) // byte order of the UTF-8 strings
		b.WriteString("d")
		for _, k := range keys {
			fmt.Fprintf(b, "s%d:%s", len(k), k)
			if err := writeCanonical(b, t[k]); err != nil {
				return err
			}
		}
		b.WriteString("e")
	default:
		return fmt.Errorf("a %T has no canonical encoding", v)
	}
	return nil
}

// specPinMismatch compares the zone's pin ("sha256:<64 hex>", or "" for none)
// with the digest the live spec has, and returns a description of the
// disagreement, or "" when there is no pin or they are equal.
//
// Fail closed: a spec that cannot be canonicalised cannot match a pin.
func specPinMismatch(pin string, spec *appsv1alpha1.BackendServiceSpec) string {
	if pin == "" {
		return ""
	}
	have, err := backendSpecDigest(spec)
	if err != nil {
		return fmt.Sprintf("the zone pins this function's spec to %s, but the live spec cannot be hashed (%v): "+
			"nothing is rendered or mounted until it can", pin, err)
	}
	if have == pin {
		return ""
	}
	return fmt.Sprintf("the zone pins this function's spec (image, env, envFrom and volumes) to %s, but the live "+
		"BackendService spec hashes to %s: nothing is rendered or mounted until they agree. Review what changed. "+
		"If the change is intended, set the zone's backends[].specDigest to the new digest in the same step; "+
		"otherwise restore the BackendService's spec", pin, have)
}
