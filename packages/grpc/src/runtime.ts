/**
 * The runtime the generated function clients call (`@getknext/grpc/runtime`).
 *
 * `defineFunctionClient` takes the definition protoc-gen-knext writes and
 * returns a client whose methods enforce the policy (see `policy.ts`):
 *
 * - a Connect deadline on every call, shorter than the gateway timeout; the
 *   attempts of a retried read share ONE deadline;
 * - retries only for side-effect-free unary reads, and only on UNAVAILABLE.
 *   A write gets exactly one attempt. Any other error — including a response
 *   that is missing its status — is final;
 * - every write carries an `idempotency-key` header, and a write without a
 *   usable key fails before anything is sent;
 * - every call carries `knext-contract-version`, the contract version the zone
 *   was generated against, so a function can tell it is older than its zone;
 * - the endpoint is read from the operator-injected `<NAME>_SERVICE_URL` at
 *   call time, never baked in. HTTP/2 cleartext (h2c) by default on a Node
 *   gateway. On a Bun gateway the default falls back to HTTP/1.1, because
 *   Bun's HTTP/2 client is not verified for Connect. `<NAME>_SERVICE_HTTP_VERSION`
 *   (`2` or `1.1`) overrides either default for one binding. The transport
 *   chosen for each binding is logged once, by name;
 * - a call made with a `token` carries it as `authorization: Bearer <token>`.
 *   The generated code mints it per call with the zone signer (`signer.ts`).
 *
 * The policy kinds in a definition are checked against the service
 * descriptor when the client is defined: a definition that would retry a
 * write is refused.
 *
 * This module runs only on the server (it uses Node's HTTP/2 client); the
 * generated files that import it carry `import "server-only"`.
 */

import type { DescMethod, DescService } from '@bufbuild/protobuf';
import { type Client, Code, ConnectError, createClient, type Transport } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { markNotSent } from './glue';
import { checkBudget, methodKind } from './policy';
import { parseVersion } from './semver';

export type MethodPolicy =
  | { readonly kind: 'read'; readonly retry: { readonly maxAttempts: number } }
  | { readonly kind: 'mutation'; readonly idempotencyKey: 'required' }
  | { readonly kind: 'stream' };

export type MethodPolicies<S extends DescService> = {
  readonly [K in keyof Client<S>]: MethodPolicy;
};

export interface FunctionClientDefinition<
  S extends DescService,
  P extends MethodPolicies<S> = MethodPolicies<S>,
> {
  readonly service: S;
  /** The zone function serving this service. */
  readonly function: string;
  /** Env var holding the function's URL, injected into the zone by the operator. */
  readonly urlEnv: string;
  /** Contract version the zone was generated against. */
  readonly contractVersion: string;
  readonly deadlineMs: number;
  readonly gatewayTimeoutMs: number;
  readonly methods: P;
}

/** Produces one identity token, called once per attempt. */
export type TokenSource = () => string | Promise<string>;

export interface CallOptions {
  readonly signal?: AbortSignal;
  readonly headers?: HeadersInit;
  /**
   * The per-call identity token, sent as `authorization: Bearer <token>`. A
   * function is asked for a new token on every attempt: a function refuses a
   * token it has already accepted, so a retried read must not re-send the
   * token of the attempt before it. A string is sent as given on each attempt
   * (a stream or a write, which are never retried, is given one). A stream
   * takes a string only.
   */
  readonly token?: string | TokenSource;
}

export interface WriteCallOptions extends CallOptions {
  /**
   * Identifies this write, so a re-submission of the same write can be
   * de-duplicated by the function. Reuse the key when re-submitting the same
   * logical write; use a new one for a new write. 1–255 visible ASCII
   * characters.
   */
  readonly idempotencyKey: string;
}

type Method<S extends DescService, K extends keyof Client<S>> = Client<S>[K] extends (
  request: infer Req,
  options?: infer _O,
) => infer Res
  ? { req: Req; res: Res }
  : never;

/** The client: writes require {@link WriteCallOptions}; reads and streams take optional options. */
export type FunctionClient<S extends DescService, P extends MethodPolicies<S>> = {
  readonly [K in keyof Client<S>]: P[K] extends { readonly kind: 'mutation' }
    ? (request: Method<S, K>['req'], options: WriteCallOptions) => Method<S, K>['res']
    : (request: Method<S, K>['req'], options?: CallOptions) => Method<S, K>['res'];
};

export type HttpVersion = '1.1' | '2';

/** Injection points, for tests. Production uses the defaults. */
export interface RuntimeDeps {
  readonly env?: () => Readonly<Record<string, string | undefined>>;
  readonly createTransport?: (baseUrl: string, httpVersion: HttpVersion) => Transport;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Is this gateway running on Bun? Defaults to `process.versions.bun`. */
  readonly isBun?: boolean;
  /** Where the one-line transport notice goes. Defaults to `console.info`. */
  readonly log?: (line: string) => void;
}

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const CONTRACT_VERSION_HEADER = 'knext-contract-version';
export const AUTHORIZATION_HEADER = 'authorization';

/** Is the current process Bun? */
export function runningOnBun(): boolean {
  return typeof process !== 'undefined' && typeof process.versions?.bun === 'string';
}

/**
 * Bindings whose transport notice was logged, by `<fn> <version> <url>`: once
 * per binding per process, however many services or module copies use it.
 */
const ANNOUNCED_KEY = Symbol.for('knext.grpc.announcedTransports');
const anchor = globalThis as Record<symbol, unknown>;
if (!(anchor[ANNOUNCED_KEY] instanceof Set)) anchor[ANNOUNCED_KEY] = new Set<string>();
const announced = anchor[ANNOUNCED_KEY] as Set<string>;

export interface TransportChoice {
  readonly httpVersion: HttpVersion;
  /** The one-line notice naming the transport and why it was chosen. */
  readonly notice: string;
}

/**
 * Pick the HTTP version for one binding. An explicit
 * `<NAME>_SERVICE_HTTP_VERSION` wins. Otherwise a Node gateway uses h2c, and a
 * Bun gateway falls back to HTTP/1.1: Bun's HTTP/2 client is not verified for
 * Connect, and Connect carries unary and server-streaming calls over HTTP/1.1.
 * Throws a FAILED_PRECONDITION on a value other than `2` or `1.1`.
 */
export function chooseTransport(opts: {
  readonly fn: string;
  readonly url: string;
  readonly versionEnv: string;
  readonly explicit: string | undefined;
  readonly isBun: boolean;
}): TransportChoice {
  const { fn, url, versionEnv, explicit, isBun } = opts;
  if (explicit !== undefined && explicit !== '2' && explicit !== '1.1') {
    throw new ConnectError(`${versionEnv} must be "2" or "1.1"`, Code.FailedPrecondition);
  }
  const http2Name = url.startsWith('https:') ? 'HTTP/2 over TLS' : 'h2c (HTTP/2 cleartext)';
  const gateway = isBun ? 'Bun' : 'Node';
  if (explicit === '2') {
    return {
      httpVersion: '2',
      notice: `knext: ${fn} function: transport ${http2Name}, set by ${versionEnv}=2 (${gateway} gateway)`,
    };
  }
  if (explicit === '1.1') {
    return {
      httpVersion: '1.1',
      notice: `knext: ${fn} function: transport HTTP/1.1, set by ${versionEnv}=1.1 (${gateway} gateway)`,
    };
  }
  if (isBun) {
    return {
      httpVersion: '1.1',
      notice:
        `knext: ${fn} function: transport HTTP/1.1, falling back from h2c on a Bun gateway ` +
        `(Bun's HTTP/2 client is not verified for Connect; set ${versionEnv}=2 to use h2c)`,
    };
  }
  return {
    httpVersion: '2',
    notice: `knext: ${fn} function: transport ${http2Name} (Node gateway default)`,
  };
}

const MAX_READ_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = 100;

const transports = new Map<string, Transport>();

function defaultTransport(baseUrl: string, httpVersion: HttpVersion): Transport {
  const key = `${httpVersion} ${baseUrl}`;
  let t = transports.get(key);
  if (!t) {
    t = createConnectTransport({ baseUrl, httpVersion });
    transports.set(key, t);
  }
  return t;
}

function checkIdempotencyKey(key: unknown): string {
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(key)) {
    throw new ConnectError(
      'a write needs an idempotency key: 1-255 visible ASCII characters, passed as ' +
        '{ idempotencyKey } in the call options',
      Code.InvalidArgument,
    );
  }
  return key;
}

function checkDefinition<S extends DescService>(def: FunctionClientDefinition<S>): void {
  const budget = checkBudget(def.deadlineMs, def.gatewayTimeoutMs);
  if (budget) throw new Error(`${def.function}: ${budget}`);
  if (!/^[A-Z][A-Z0-9_]*_SERVICE_URL$/.test(def.urlEnv)) {
    throw new Error(`${def.function}: "${def.urlEnv}" is not a <NAME>_SERVICE_URL variable`);
  }
  if (!parseVersion(def.contractVersion)) {
    throw new Error(
      `${def.function}: contract version "${def.contractVersion}" is not MAJOR.MINOR.PATCH`,
    );
  }
  const policies = def.methods as Readonly<Record<string, MethodPolicy | undefined>>;
  const names = new Set(def.service.methods.map((m) => m.localName));
  for (const name of Object.keys(policies)) {
    if (!names.has(name)) throw new Error(`${def.function}: policy for unknown method "${name}"`);
  }
  for (const method of def.service.methods) {
    const policy = policies[method.localName];
    const expected = methodKind(method);
    if (!policy) throw new Error(`${def.function}: no policy for method "${method.localName}"`);
    if (policy.kind !== expected) {
      throw new Error(
        `${def.function}: method "${method.localName}" is a ${expected} by its descriptor, ` +
          `but its policy says ${policy.kind}; regenerate with \`knext generate\``,
      );
    }
    if (
      policy.kind === 'read' &&
      (!Number.isInteger(policy.retry.maxAttempts) ||
        policy.retry.maxAttempts < 1 ||
        policy.retry.maxAttempts > MAX_READ_ATTEMPTS)
    ) {
      throw new Error(
        `${def.function}: "${method.localName}" maxAttempts must be 1-${MAX_READ_ATTEMPTS}`,
      );
    }
  }
}

/** Build the client for one service of a zone function. */
export function defineFunctionClient<S extends DescService, P extends MethodPolicies<S>>(
  def: FunctionClientDefinition<S, P>,
  deps: RuntimeDeps = {},
): FunctionClient<S, P> {
  checkDefinition(def);
  const env = deps.env ?? (() => process.env);
  const makeTransport = deps.createTransport ?? defaultTransport;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const isBun = deps.isBun ?? runningOnBun();
  const log =
    deps.log ??
    // biome-ignore lint/suspicious/noConsole: the one-line transport notice is meant for the zone's log
    ((line: string) => console.info(line));
  const versionEnv = def.urlEnv.replace(/_URL$/, '_HTTP_VERSION');

  function connectClient(): Client<S> {
    const vars = env();
    const url = vars[def.urlEnv];
    if (!url) {
      throw new ConnectError(
        `${def.urlEnv} is not set: this zone has no binding to the ${def.function} function`,
        Code.FailedPrecondition,
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ConnectError(`${def.urlEnv} is not a URL`, Code.FailedPrecondition);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ConnectError(`${def.urlEnv} must be an http or https URL`, Code.FailedPrecondition);
    }
    const choice = chooseTransport({
      fn: def.function,
      url,
      versionEnv,
      explicit: vars[versionEnv],
      isBun,
    });
    const key = `${def.function} ${choice.httpVersion} ${url}`;
    if (!announced.has(key)) {
      announced.add(key);
      log(choice.notice);
    }
    return createClient(def.service, makeTransport(url, choice.httpVersion));
  }

  function headersFor(options: CallOptions | undefined): Headers {
    const headers = new Headers(options?.headers);
    headers.set(CONTRACT_VERSION_HEADER, def.contractVersion);
    return headers;
  }

  /** One attempt's token: the string given, or a new one from the source. */
  async function tokenFor(token: CallOptions['token']): Promise<string | undefined> {
    const value = typeof token === 'function' ? await token() : token;
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(value)) {
      throw new ConnectError('the call token is not a usable bearer token', Code.Unauthenticated);
    }
    return value;
  }

  function withToken(base: Headers, token: string | undefined): Headers {
    if (token === undefined) return base;
    const headers = new Headers(base);
    headers.set(AUTHORIZATION_HEADER, `Bearer ${token}`);
    return headers;
  }

  const policies = def.methods as Readonly<Record<string, MethodPolicy>>;
  const client: Record<string, unknown> = {};
  for (const method of def.service.methods as readonly DescMethod[]) {
    const name = method.localName;
    const policy = policies[name] as MethodPolicy;
    const call = (c: Client<S>, request: unknown, opts: object) =>
      (c[name as keyof Client<S>] as (req: unknown, o: object) => unknown)(request, opts);

    if (policy.kind === 'stream') {
      client[name] = (request: unknown, options?: CallOptions) => {
        const token = options?.token;
        if (typeof token === 'function') {
          throw new ConnectError(
            'a stream takes its identity token as a string',
            Code.InvalidArgument,
          );
        }
        let headers = headersFor(options);
        if (token !== undefined) {
          if (typeof token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(token)) {
            throw new ConnectError(
              'the call token is not a usable bearer token',
              Code.Unauthenticated,
            );
          }
          headers = withToken(headers, token);
        }
        return call(connectClient(), request, {
          timeoutMs: def.deadlineMs,
          headers,
          signal: options?.signal,
        });
      };
      continue;
    }

    const attempts = policy.kind === 'read' ? policy.retry.maxAttempts : 1;
    client[name] = async (request: unknown, options?: CallOptions | WriteCallOptions) => {
      let headers: Headers;
      let c: Client<S>;
      let firstToken: string | undefined;
      try {
        headers = headersFor(options);
        if (policy.kind === 'mutation') {
          headers.set(
            IDEMPOTENCY_KEY_HEADER,
            checkIdempotencyKey((options as WriteCallOptions | undefined)?.idempotencyKey),
          );
        }
        c = connectClient();
        firstToken = await tokenFor(options?.token);
      } catch (err) {
        // Nothing has been sent: the function cannot have seen this call.
        throw markNotSent(err);
      }
      const deadlineAt = now() + def.deadlineMs;
      for (let attempt = 1; ; attempt++) {
        const remaining = deadlineAt - now();
        if (remaining <= 0) {
          throw new ConnectError(
            `${def.function}.${name}: deadline exceeded`,
            Code.DeadlineExceeded,
          );
        }
        try {
          // A new token for each attempt after the first, from a token source:
          // the function refuses a token it has already accepted.
          const token = attempt === 1 ? firstToken : await tokenFor(options?.token);
          return await call(c, request, {
            timeoutMs: remaining,
            headers: withToken(headers, token),
            signal: options?.signal,
          });
        } catch (err) {
          const e = ConnectError.from(err);
          if (attempt >= attempts || e.code !== Code.Unavailable || options?.signal?.aborted)
            throw e;
          await sleep(RETRY_BACKOFF_MS * attempt);
        }
      }
    };
  }
  return client as FunctionClient<S, P>;
}

export {
  type Authorize,
  type AuthorizeContext,
  decodeRequest,
  encodeRequest,
  mintCallToken,
  normalizeRequest,
  type Principal,
  PUBLIC_SUBJECT,
  QUERY_CACHE_LIFE,
  registerTokenMinter,
  servedVersion,
  subjectSub,
  type TokenMinter,
  type TokenRequest,
  userSubject,
  wasNotSent,
} from './glue';
export {
  audienceFromServiceUrl,
  contractKid,
  createZoneTokenSigner,
  SIGNING_KEY_DIR,
  TOKEN_TTL_SECONDS,
  ZONE_ISSUER_ENV,
  type ZoneSignerOptions,
} from './signer';
