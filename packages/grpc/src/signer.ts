/**
 * The zone's identity-token signer: what a zone sends with every call to its
 * functions, as `authorization: Bearer <token>`. Exported from
 * `@getknext/grpc/runtime`; server-only (it reads the zone's private key).
 *
 * The token is a JWS compact JWT, `alg: EdDSA` (Ed25519), with the header
 * `{"alg":"EdDSA","typ":"JWT","kid":"<kid>"}` and exactly these claims:
 *
 * - `iss` — the zone, `knext:zone:<namespace>/<NextApp name>`, read from
 *   `KNEXT_ZONE_ISSUER`, which the operator renders into the zone;
 * - `aud` — the one function called, `knext:fn:<namespace>/<BackendService>`,
 *   derived from the `<NAME>_SERVICE_URL` the operator renders
 *   (`http://<BackendService>.<namespace>.svc.cluster.local`);
 * - `method` — the RPC's path, `/<package>.<Service>/<Method>`;
 * - `sub` — the user authorize() verified. Required for an AUTH_USER RPC;
 *   empty for AUTH_PUBLIC. Nothing else the caller passes can set it, and a
 *   request body never reaches the token;
 * - `jti` — a fresh random id for this one token: 16 bytes from the system's
 *   CSPRNG, base64url (22 characters), never reused. A function keeps the ids
 *   it has accepted until the token expires and refuses a second use, so a
 *   token captured on the pod network cannot be replayed to it. A token is
 *   therefore single-use: every attempt, a retry included, needs its own;
 * - `iat`, `exp` — integer seconds, 60 s apart.
 *
 * The private key is read from the zone's signing-key Secret, mounted as a
 * volume at {@link SIGNING_KEY_DIR} (`current.key`, PKCS#8 PEM, and
 * `current.kid`). Never from env. Its files are checked on every mint and
 * re-read when they change, so a rotated key is used without a restart; the
 * `kid` is derived from the key and must match `current.kid`. Only `current.*`
 * is ever signed with: `previous.*` exists for verifiers during a rotation, and
 * a staged `next.*` is not signing yet.
 *
 * Everything fails closed, before anything is sent, with a message that names
 * the missing piece and never the key, a token or a claim value it refused.
 * Nothing here logs.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  randomBytes,
  sign,
} from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Code, ConnectError } from '@connectrpc/connect';
import { urlEnvFor } from './config';
import type { TokenMinter, TokenRequest } from './glue';

/** Where the operator mounts the zone's signing-key Secret. */
export const SIGNING_KEY_DIR = '/var/run/knext/signing-key';

/** The variable holding the zone's issuer, rendered by the operator. */
export const ZONE_ISSUER_ENV = 'KNEXT_ZONE_ISSUER';

/** A token's lifetime: `exp - iat`. The contract allows at most 60 s. */
export const TOKEN_TTL_SECONDS = 60;

/** The size of a token's `jti`, in random bytes: 128 bits, 22 base64url characters. */
const JTI_BYTES = 16;

const KEY_FILE = 'current.key';
const KID_FILE = 'current.kid';

/** A DNS label: what a namespace or a Kubernetes object name here must be. */
const LABEL = '[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?';
const ISSUER = new RegExp(`^knext:zone:(${LABEL})/(${LABEL})$`);
const AUDIENCE = new RegExp(`^knext:fn:(${LABEL})/(${LABEL})$`);
const FUNCTION_HOST = new RegExp(`^(${LABEL})\\.(${LABEL})\\.svc\\.cluster\\.local$`);
/** `/<package>.<Service>/<Method>`: a package of one or more parts, then the service. */
const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const RPC_PATH = new RegExp(`^/${IDENT}(?:\\.${IDENT})+/${IDENT}$`);
/** A `sub` is 1-512 characters with no control characters (as userSubject requires). */
const SUB = /^[^\p{Cc}]{1,512}$/u;

export interface ZoneSignerOptions {
  /** The mounted signing-key Secret. Defaults to {@link SIGNING_KEY_DIR}. */
  readonly keyDir?: string;
  /** The environment, read at every mint. Defaults to `process.env`. */
  readonly env?: () => Readonly<Record<string, string | undefined>>;
  /** The clock, in milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * The audience of a call. Defaults to the one derived from the function's
   * `<NAME>_SERVICE_URL` ({@link audienceFromServiceUrl}). Whatever it returns
   * must be `knext:fn:<namespace>/<name>` in the zone's own namespace.
   */
  readonly audience?: (request: TokenRequest) => string;
}

function refuse(message: string, code: Code = Code.FailedPrecondition): ConnectError {
  return new ConnectError(message, code);
}

/**
 * The audience of a call to `fn`: `knext:fn:<namespace>/<BackendService>`,
 * from the function address the operator renders into `urlEnv`. Anything but
 * `http(s)://<service>.<namespace>.svc.cluster.local[:port][/]` is refused, so
 * a token is never minted for an address that is not a function's.
 */
export function audienceFromServiceUrl(
  fn: string,
  urlEnv: string,
  url: string | undefined,
): string {
  if (url === undefined || url === '') {
    throw refuse(`${urlEnv} is not set: this zone has no binding to the ${fn} function`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw refuse(`${urlEnv} is not a URL`);
  }
  const host = FUNCTION_HOST.exec(parsed.hostname);
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !host ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw refuse(
      `${urlEnv} is not a function address (http://<service>.<namespace>.svc.cluster.local), ` +
        `so no token can be minted for the ${fn} function`,
    );
  }
  return `knext:fn:${host[2]}/${host[1]}`;
}

/**
 * The contract's `kid`: base64url (no padding) of the first 16 bytes of
 * SHA-256 over the raw 32-byte Ed25519 public key.
 */
export function contractKid(publicKey: KeyObject): string {
  const x = publicKey.export({ format: 'jwk' }).x;
  const raw = typeof x === 'string' ? Buffer.from(x, 'base64url') : Buffer.alloc(0);
  if (raw.length !== 32) throw new Error('not an Ed25519 public key');
  return createHash('sha256').update(raw).digest().subarray(0, 16).toString('base64url');
}

interface LoadedKey {
  /** Identifies the files the key was read from; a change means re-read. */
  readonly fingerprint: string;
  readonly key: KeyObject;
  readonly kid: string;
}

/**
 * Where the current key's files really are, and a fingerprint of them. A
 * kubelet Secret volume is `current.key -> ..data/current.key`, `..data` a
 * symlink swapped on update: both files are read from the directory
 * `current.key` resolves to, so the pair always comes from one update.
 */
function locate(keyDir: string): { dir: string; fingerprint: string } {
  const keyPath = join(keyDir, KEY_FILE);
  let real: string;
  try {
    real = realpathSync(keyPath);
  } catch {
    throw refuse(
      `no signing key at ${keyPath}: the zone's signing-key Secret is not mounted, so no call can be made`,
    );
  }
  const dir = dirname(real);
  const parts = [real];
  for (const file of [real, join(dir, KID_FILE)]) {
    try {
      const s = statSync(file, { bigint: true });
      parts.push(`${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`);
    } catch {
      throw refuse(`no ${KID_FILE} beside ${keyPath}: the zone's signing-key Secret is incomplete`);
    }
  }
  return { dir, fingerprint: parts.join('|') };
}

function load(keyDir: string, dir: string, fingerprint: string): LoadedKey {
  const keyPath = join(keyDir, KEY_FILE);
  let pem: string;
  let kidFile: string;
  try {
    pem = readFileSync(join(dir, KEY_FILE), 'utf8');
    kidFile = readFileSync(join(dir, KID_FILE), 'utf8').trim();
  } catch {
    throw refuse(`cannot read the signing key at ${keyPath}`);
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    // The parser's own message is dropped: nothing about the file's content is echoed.
    throw refuse(`${keyPath} is not a PKCS#8 PEM Ed25519 private key`);
  }
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw refuse(`${keyPath} is not an Ed25519 private key`);
  }
  const kid = contractKid(createPublicKey(key));
  if (kidFile !== kid) {
    throw refuse(`${join(keyDir, KID_FILE)} does not match ${KEY_FILE}: refusing to sign`);
  }
  return { fingerprint, key, kid };
}

function b64url(json: string): string {
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * The zone's token minter, over the mounted signing-key Secret. Register it
 * with `registerTokenMinter` only to change a default; with nothing
 * registered, the generated code already uses the default signer.
 */
export function createZoneTokenSigner(options: ZoneSignerOptions = {}): TokenMinter {
  const keyDir = options.keyDir ?? SIGNING_KEY_DIR;
  const env = options.env ?? (() => process.env);
  const now = options.now ?? Date.now;
  let loaded: LoadedKey | undefined;

  function currentKey(): LoadedKey {
    // A swap between resolving and reading (kubelet removes the old directory
    // right after it) is retried once from the top; a second failure stands.
    for (let attempt = 1; ; attempt++) {
      try {
        const { dir, fingerprint } = locate(keyDir);
        if (loaded?.fingerprint !== fingerprint) loaded = load(keyDir, dir, fingerprint);
        return loaded;
      } catch (err) {
        if (attempt >= 2) throw err;
      }
    }
  }

  return async (request: TokenRequest): Promise<string> => {
    const method = request.method;
    if (typeof method !== 'string' || !RPC_PATH.test(method)) {
      throw refuse(
        'the token request does not name an RPC as /<package>.<Service>/<Method>',
        Code.Internal,
      );
    }
    // Only an RPC that says it is AUTH_PUBLIC may go without a user: a request
    // that does not say (an older generated file) is held to AUTH_USER.
    const isPublic = request.auth === 'public';
    const sub = request.sub ?? '';
    if (typeof sub !== 'string' || (sub === '' ? !isPublic : !SUB.test(sub))) {
      throw refuse(
        `${method} needs a signed-in user (AUTH_USER), and the token request has no usable sub`,
        Code.Unauthenticated,
      );
    }

    const vars = env();
    const iss = vars[ZONE_ISSUER_ENV];
    if (iss === undefined || iss === '') {
      throw refuse(
        `${ZONE_ISSUER_ENV} is not set: the zone has no identity, so ${method} on the ` +
          `${request.function} function was not called`,
      );
    }
    const zone = ISSUER.exec(iss);
    if (!zone) throw refuse(`${ZONE_ISSUER_ENV} is not knext:zone:<namespace>/<zone>`);

    const urlEnv = urlEnvFor(String(request.function));
    const aud = options.audience
      ? options.audience(request)
      : audienceFromServiceUrl(String(request.function), urlEnv, vars[urlEnv]);
    const fn = typeof aud === 'string' ? AUDIENCE.exec(aud) : null;
    if (!fn) {
      throw refuse(
        `the audience for the ${request.function} function is not knext:fn:<namespace>/<name>`,
      );
    }
    if (fn[1] !== zone[1]) {
      throw refuse(
        `the ${request.function} function is not in the zone's namespace, so no token is minted for it`,
      );
    }

    const { key, kid } = currentKey();
    const iat = Math.floor(now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }));
    // Single-use: a function refuses a jti it has already accepted.
    const jti = randomBytes(JTI_BYTES).toString('base64url');
    const claims = b64url(
      JSON.stringify({ iss, aud, method, sub, jti, iat, exp: iat + TOKEN_TTL_SECONDS }),
    );
    const input = `${header}.${claims}`;
    const signature = sign(null, Buffer.from(input, 'utf8'), key).toString('base64url');
    return `${input}.${signature}`;
  };
}

/**
 * The default signer, one per process. Anchored on globalThis, never a
 * module-level variable: Next.js can load more than one copy of this module in
 * one server, and they share one key cache.
 */
const DEFAULT_SIGNER_KEY = Symbol.for('knext.grpc.defaultZoneSigner');

export function defaultZoneSigner(): TokenMinter {
  const anchor = globalThis as Record<symbol, unknown>;
  if (typeof anchor[DEFAULT_SIGNER_KEY] !== 'function') {
    anchor[DEFAULT_SIGNER_KEY] = createZoneTokenSigner();
  }
  return anchor[DEFAULT_SIGNER_KEY] as TokenMinter;
}
