/**
 * The spec digest a zone pins on `backends[].specDigest` (ADR-0004 Amendment 4).
 *
 * The image pin binds `spec.image` only, so a principal who can write the
 * BackendService could keep the pinned image and add env (NODE_OPTIONS), envFrom
 * or volumes. The spec pin binds those too: the zone pins a digest of the
 * function's security-relevant spec, `knext deploy function` computes it, and the
 * operator re-computes it from the live BackendService and compares.
 *
 * THE CANONICAL FORM (version 1). The Go operator implements the same
 * algorithm (internal/controller/backendservice_spec_pin.go) and the shared
 * vectors (testdata/backend-spec-digest-vectors.json) are recomputed on both
 * sides, so the two cannot drift apart silently.
 *
 *  1. Project: keep only the members of the BackendService spec named in
 *     {@link BACKEND_SPEC_PINNED_FIELDS}: image, env, envFrom, volumes.
 *  2. Normalise, recursively: drop every object member whose value is null,
 *     "", false, an empty list or an empty object. The operator's Go types omit
 *     some zero values and not others; this makes absent, empty and false the
 *     same thing on both sides (they are the same to Kubernetes for every hashed
 *     type). Numbers are kept, so `defaultMode: 0` differs from absent.
 *  3. Encode, deterministically:
 *       string  s<N>:<bytes>   N = the UTF-8 byte length, in decimal
 *       integer i<N>;
 *       true    t
 *       list    l<item>...e    list order is kept: it is part of the digest
 *       object  d<key><value>...e   keys are strings, sorted by UTF-8 bytes
 *     No whitespace and no escaping. Floats and null are refused.
 *  4. digest = "sha256:" + hex(SHA-256(SPEC_DIGEST_DOMAIN + encoding)).
 *
 * List order is kept on purpose: env order decides `$(VAR)` expansion and envFrom
 * order decides which source wins a key collision, so a reorder is a change of
 * what the pod sees. A tool that reorders a list makes the pin mismatch, which
 * fails closed.
 *
 * Not hashed (tuning that cannot change what runs or what it can read): zone,
 * language, port, protoVersion, wakeAhead, scaling, resources, imagePullSecrets.
 *
 * Pure: no I/O.
 */

import { createHash } from 'node:crypto';

/** Separates this digest from any other use of SHA-256 and carries the form's version. */
export const SPEC_DIGEST_DOMAIN = 'knext.dev/backendservice-spec/v1\n';

/** The BackendService spec members the digest binds, in the operator's order. */
export const BACKEND_SPEC_PINNED_FIELDS: readonly string[] = ['image', 'env', 'envFrom', 'volumes'];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Step 2. The second element says the value is "empty" and its parent object drops it. */
function normalise(v: unknown): [unknown, boolean] {
  if (v === null || v === undefined) return [null, true];
  if (typeof v === 'string') return [v, v === ''];
  if (typeof v === 'boolean') return [v, !v];
  if (Array.isArray(v)) {
    const items = v.map((x) => normalise(x)[0]);
    return [items, items.length === 0];
  }
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const [nx, empty] = normalise(x);
      if (!empty) out[k] = nx;
    }
    return [out, Object.keys(out).length === 0];
  }
  return [v, false];
}

function encodeString(s: string): string {
  const bytes = Buffer.from(s, 'utf8');
  // A lone surrogate does not survive UTF-8: refuse it rather than hash U+FFFD.
  if (bytes.toString('utf8') !== s) {
    throw new Error('a string with a lone surrogate has no canonical UTF-8 encoding');
  }
  return `s${bytes.length}:${s}`;
}

/** Step 3. */
function encode(v: unknown): string {
  if (typeof v === 'string') return encodeString(v);
  if (v === true) return 't';
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) {
      throw new Error(`number ${v} is not an integer: the canonical form takes integers only`);
    }
    return `i${v};`;
  }
  if (Array.isArray(v)) return `l${v.map(encode).join('')}e`;
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, Json>).sort((a, b) =>
      Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),
    );
    const body = keys.map((k) => encodeString(k) + encode((v as Record<string, unknown>)[k]));
    return `d${body.join('')}e`;
  }
  throw new Error(`a ${v === null ? 'null' : typeof v} has no canonical encoding`);
}

/**
 * The canonical encoding (steps 1 to 3) of the spec's pinned members, without
 * the domain prefix. `spec` is the BackendService `spec` as the CLI emits it.
 */
export function canonicalBackendSpec(spec: Readonly<Record<string, unknown>>): string {
  if (typeof spec.image !== 'string' || spec.image === '') {
    throw new Error('a BackendService spec digest needs spec.image');
  }
  const projection: Record<string, unknown> = {};
  for (const field of BACKEND_SPEC_PINNED_FIELDS) {
    if (field in spec) projection[field] = spec[field];
  }
  return encode(normalise(projection)[0]);
}

/** The digest the zone pins: `sha256:<64 lowercase hex>`. */
export function backendSpecDigest(spec: Readonly<Record<string, unknown>>): string {
  const hash = createHash('sha256')
    .update(SPEC_DIGEST_DOMAIN + canonicalBackendSpec(spec), 'utf8')
    .digest('hex');
  return `sha256:${hash}`;
}
