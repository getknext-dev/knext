/**
 * The runtime half of the generated glue: what the generated queries, actions
 * and streams call around the function client. Exported from
 * `@getknext/grpc/runtime`. Everything here fails closed.
 *
 * - {@link userSubject} runs the app's authorize() hook and turns its verified
 *   user into the cache subject. A missing or unusable user is
 *   UNAUTHENTICATED; whatever the hook throws (a redirect, say) is rethrown
 *   unchanged.
 * - {@link servedVersion} reads the contract version the function SERVES from
 *   `<NAME>_SERVICE_PROTO_VERSION` at call time. It is part of every cached
 *   read's key, so a function rolled out ahead of its zone never has its
 *   predecessor's results served for it. Unset, unreadable or older than the
 *   zone's contract is FAILED_PRECONDITION.
 * - {@link mintCallToken} is where the per-call identity token comes from.
 *   The generated code calls it INSIDE the cached function, so the token is
 *   never part of a cache key. It uses the zone signer over the mounted
 *   signing-key Secret (`signer.ts`) unless a minter is registered; without a
 *   key, an issuer or a function address it is FAILED_PRECONDITION: a call
 *   never leaves the zone without a token.
 * - {@link encodeRequest}/{@link decodeRequest}/{@link normalizeRequest} move a
 *   request across the cache-key and Server-Action boundaries as the contract
 *   defines it, and nothing else.
 */

import {
  create,
  type DescMessage,
  fromBinary,
  type MessageInitShape,
  type MessageShape,
  toBinary,
} from '@bufbuild/protobuf';
import { base64Decode, base64Encode } from '@bufbuild/protobuf/wire';
import { Code, ConnectError } from '@connectrpc/connect';
import type { MethodKind } from './policy';
import { defaultZoneSigner } from './signer';
import { checkContractSkew } from './skew';

/** What the generated code tells authorize() about the call it is about to make. */
export interface AuthorizeContext {
  /** The zone function, e.g. `orders`. */
  readonly function: string;
  /** The fully qualified service, e.g. `orders.v1.OrdersService`. */
  readonly service: string;
  /** The RPC name, e.g. `GetOrder`. */
  readonly method: string;
  readonly kind: MethodKind;
}

/** A verified user. `sub` is the stable user id the app's session proves. */
export interface Principal {
  readonly sub: string;
}

/**
 * The app's authorize() hook. Return the verified user, or throw (a redirect
 * to sign-in, an error) to refuse the call. An anonymous write (sign-up, a
 * contact form) returns an explicit anonymous principal, and only after the
 * app's own check (CAPTCHA, rate limit, CSRF) has passed.
 */
export type Authorize = (ctx: AuthorizeContext) => Principal | Promise<Principal>;

/** The cache subject of an `AUTH_PUBLIC` read. No user subject can equal it. */
export const PUBLIC_SUBJECT = 'public';
const USER_PREFIX = 'user:';

/** A `sub` is 1-512 characters with no control characters. */
const SUB = /^[^\p{Cc}]{1,512}$/u;

/**
 * Run authorize() and return the cache subject of the verified user
 * (`user:<sub>`). The generated code calls this before anything else.
 */
export async function userSubject(authorize: Authorize, ctx: AuthorizeContext): Promise<string> {
  const principal: unknown = await authorize(ctx);
  const sub = (principal as { sub?: unknown } | null | undefined)?.sub;
  if (typeof sub !== 'string' || !SUB.test(sub)) {
    throw new ConnectError(
      `authorize() returned no verified user for ${ctx.service}.${ctx.method}: ` +
        'it must return { sub } (1-512 characters) or throw',
      Code.Unauthenticated,
    );
  }
  return `${USER_PREFIX}${sub}`;
}

/** The user id in a subject, or `undefined` for the public subject. */
export function subjectSub(subject: string): string | undefined {
  return subject.startsWith(USER_PREFIX) ? subject.slice(USER_PREFIX.length) : undefined;
}

const PROTO_VERSION_ENV = /^[A-Z][A-Z0-9_]*_SERVICE_PROTO_VERSION$/;

/**
 * The contract version the function serves, read from `envName` at call time.
 * Fails closed (FAILED_PRECONDITION) when it is not set, not MAJOR.MINOR.PATCH,
 * or older than `zoneVersion`, the contract the zone was generated against.
 */
export function servedVersion(
  fn: string,
  envName: string,
  zoneVersion: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (!PROTO_VERSION_ENV.test(envName)) {
    throw new ConnectError(
      `${fn}: "${envName}" is not a <NAME>_SERVICE_PROTO_VERSION variable`,
      Code.FailedPrecondition,
    );
  }
  const served = env[envName];
  if (served === undefined || served === '') {
    throw new ConnectError(
      `${envName} is not set: the zone does not know which contract version the ${fn} ` +
        'function serves, so it will not call it',
      Code.FailedPrecondition,
    );
  }
  const skew = checkContractSkew({ functionVersion: served, zoneVersion });
  if (skew.skew) {
    throw new ConnectError(`${fn}: ${skew.reason}`, Code.FailedPrecondition);
  }
  return served;
}

/** What a token is minted for. */
export interface TokenRequest {
  /** The function the token is for (its audience). */
  readonly function: string;
  /** The RPC, as its path: `/orders.v1.OrdersService/GetOrder`. */
  readonly method: string;
  /**
   * The RPC's `(knext.v1.auth)`. Only `public` may go without a user; a request
   * that does not say is held to `user`.
   */
  readonly auth?: 'user' | 'public';
  /** The verified user, absent for an `AUTH_PUBLIC` read. */
  readonly sub?: string;
}

export type TokenMinter = (request: TokenRequest) => string | Promise<string>;

/**
 * Anchored on globalThis, never a module-level variable: Next.js can load more
 * than one copy of this module in one server, and every copy must see the one
 * minter the zone registered.
 */
const MINTER_KEY = Symbol.for('knext.grpc.tokenMinter');

/**
 * Register (or, with `undefined`, remove) a token minter in place of the
 * default zone signer: a signer with other options
 * (`createZoneTokenSigner({ ... })`), or a test double.
 */
export function registerTokenMinter(minter: TokenMinter | undefined): void {
  (globalThis as Record<symbol, unknown>)[MINTER_KEY] = minter;
}

/**
 * Mint the identity token for one call: with the registered minter, or else
 * the default zone signer, which fails closed without its key and issuer.
 */
export async function mintCallToken(request: TokenRequest): Promise<string> {
  const registered = (globalThis as Record<symbol, unknown>)[MINTER_KEY];
  const minter =
    typeof registered === 'function' ? (registered as TokenMinter) : defaultZoneSigner();
  const token: unknown = await minter(request);
  if (typeof token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(token)) {
    throw new ConnectError('the token minter returned no usable token', Code.Unauthenticated);
  }
  return token;
}

/**
 * The mark on an error raised before a request left the zone. A property keyed
 * by `Symbol.for`, never a module-level set: a second copy of this module must
 * read the mark the first copy wrote.
 */
const NOT_SENT = Symbol.for('knext.grpc.notSent');

/**
 * Mark `err` as raised before the request was sent, so the function cannot have
 * seen it. Only a client check that runs before the transport is called may
 * use this.
 */
export function markNotSent(err: unknown): ConnectError {
  const e = ConnectError.from(err);
  Object.defineProperty(e, NOT_SENT, { value: true });
  return e;
}

/**
 * Whether `err` provably happened before the request was sent. Anything else
 * (a reset, a deadline, a lost status, an error the function answered) may
 * follow a write that committed, so a generated action refreshes its reads.
 */
export function wasNotSent(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as Record<symbol, unknown>)[NOT_SENT] === true
  );
}

function invalid(schema: DescMessage, err: unknown): ConnectError {
  return new ConnectError(
    `the request does not match ${schema.typeName}: ${(err as Error).message}`,
    Code.InvalidArgument,
  );
}

/**
 * Decode with only the fields the contract has. Without this, protobuf-es keeps
 * every other field it reads in `$unknown` and writes it back out on encode.
 */
const CONTRACT_FIELDS_ONLY = { readUnknownFields: false } as const;

/**
 * The contract's message, rebuilt from `input`'s known fields only.
 *
 * `create()` returns an input whose `$typeName` matches unchanged, so a caller
 * who forges `$typeName` and adds `$unknown` would have those unknown fields
 * encoded and forwarded. Neither is trusted: both are dropped before `create`,
 * and the decode drops any unknown field a nested message carried.
 */
function contractMessage<Desc extends DescMessage>(
  schema: Desc,
  input: unknown,
): MessageShape<Desc> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('the request is not an object');
  }
  const { $typeName: _typeName, $unknown: _unknown, ...fields } = input as Record<string, unknown>;
  const bytes = toBinary(schema, create(schema, fields as MessageInitShape<Desc>));
  return fromBinary(schema, bytes, CONTRACT_FIELDS_ONLY);
}

/**
 * A request as the contract defines it: rebuilt from the contract's fields of
 * `input`, so a field the contract does not have is dropped and a value of the
 * wrong type is INVALID_ARGUMENT. Server Actions are public endpoints; their
 * input is untrusted.
 */
export function normalizeRequest<Desc extends DescMessage>(
  schema: Desc,
  input: MessageInitShape<Desc>,
): MessageShape<Desc> {
  try {
    return contractMessage(schema, input);
  } catch (err) {
    throw invalid(schema, err);
  }
}

/** The request as a cache-key argument: its binary encoding, base64. */
export function encodeRequest<Desc extends DescMessage>(
  schema: Desc,
  input: MessageInitShape<Desc>,
): string {
  try {
    return base64Encode(toBinary(schema, contractMessage(schema, input)));
  } catch (err) {
    throw invalid(schema, err);
  }
}

/** The inverse of {@link encodeRequest}. */
export function decodeRequest<Desc extends DescMessage>(
  schema: Desc,
  encoded: string,
): MessageShape<Desc> {
  try {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('not base64');
    return fromBinary(schema, base64Decode(encoded), CONTRACT_FIELDS_ONLY);
  } catch (err) {
    throw invalid(schema, err);
  }
}

/**
 * The cache life of a generated query. Entries hold one user's results, so they
 * expire within an hour (the shared cache's own cap is the backstop).
 */
export const QUERY_CACHE_LIFE = { stale: 60, revalidate: 300, expire: 3600 } as const;
