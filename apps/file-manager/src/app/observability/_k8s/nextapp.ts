import 'server-only';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';

/**
 * Server-only, READ-ONLY, **opt-in** `NextApp` status reader for the in-app
 * Deployments page (obs-pages plan P1.4, ADR-0038).
 *
 * ## Why this module exists, and why it is off by default
 *
 * The plan's §7 fork asked where deploy/rollback history comes from:
 *  (a) the Kubernetes API — highest fidelity (rollback pin, image digest,
 *      operator conditions) but it adds an RBAC surface to the APP's
 *      ServiceAccount and couples the app to the operator's CRD;
 *  (b) Prometheus-derived (`_prom/query.ts#deploymentQueries`) — no new trust
 *      surface, same data path as P1.2/P1.3, but no rollback fidelity.
 *
 * Resolved as **(c) both, degrading — with (a) strictly opt-in**. The DEFAULT
 * trust surface is therefore exactly (b)'s: this module performs **no file read
 * and no network call at all** unless `OBSERVABILITY_NEXTAPP_SOURCE=kubernetes`
 * is explicitly set. Turning it on is a two-step, deliberate act: set the env var
 * AND apply the least-privilege, opt-in Role in
 * `apps/file-manager/deploy/observability-nextapp-read-rbac.yaml` (`get` on THIS
 * app's `nextapps` object only, by `resourceNames`, in this namespace — never
 * bundled into the operator's default install).
 *
 * Honest caveat (PR-520): under an operator-managed deploy the app's
 * ServiceAccount is reconciled with `automountServiceAccountToken: false`, so no
 * token is projected and this reader can only return `not-in-cluster`. The
 * opt-in manifest documents that; nothing here pretends otherwise.
 *
 * ## Contract
 * - **Read-only.** `GET` only; the page never mutates cluster state (ADR-0001:
 *   the operator is the single source of truth).
 * - **Never throws.** Every failure is a typed outcome the page renders as its
 *   own honest state — the `NextApp` CRD being absent (as on the OKE cluster) is
 *   `crd-absent`, an unbound Role is `forbidden`, and neither is ever allowed to
 *   look like "this app has no deployments".
 * - **Never leaks.** The ServiceAccount token stays server-side and never enters
 *   the returned value; failure details are short categories, never raw errors
 *   or internal hosts/IPs.
 *
 * TLS (PR-520 review): the API server is reached over HTTPS and its CA is the
 * projected `.../serviceaccount/ca.crt`. That CA is passed **per request** via
 * `node:https`' `ca` option, so trusting the cluster CA for this ONE read does
 * not widen the process-wide trust store (which a global `NODE_EXTRA_CA_CERTS`
 * would). Verification is NEVER disabled — no `rejectUnauthorized: false`, no
 * `NODE_TLS_REJECT_UNAUTHORIZED`. `node:https` (rather than an `undici`
 * dispatcher) keeps this dependency-free; global `fetch` has no per-request CA
 * hook at all.
 */

/** Opt-in switch. Anything other than {@link NEXTAPP_SOURCE_KUBERNETES} = off. */
export const NEXTAPP_SOURCE_ENV = 'OBSERVABILITY_NEXTAPP_SOURCE';

/** The single accepted opt-in value. */
export const NEXTAPP_SOURCE_KUBERNETES = 'kubernetes';

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const API_GROUP = 'apps.kn-next.dev';
const API_VERSION = 'v1alpha1';

/** Short abort budget: a slow API server must degrade the page, never hang it. */
const DEFAULT_TIMEOUT_MS = 4000;

/** One traffic target as mirrored into `status.currentTraffic`. */
export interface TrafficTargetView {
  readonly revisionName?: string;
  readonly percent?: number;
  readonly latestRevision?: boolean;
}

/** One `metav1.Condition` as rendered by the page. */
export interface ConditionView {
  readonly type: string;
  readonly status: string;
  readonly reason?: string;
  readonly message?: string;
  readonly lastTransitionTime?: string;
}

/** The deploy-relevant projection of a `NextApp` (spec + status). */
export interface NextAppStatusView {
  /** `status.observedRevision` — the latest-READY Knative Revision. */
  readonly observedRevision?: string;
  /** `status.lastSuccessfulDeployTime` — when the live build went live. */
  readonly lastSuccessfulDeployTime?: string;
  /** `status.scaledToZero` — no active compute right now. */
  readonly scaledToZero?: boolean;
  /** `spec.image` — the digest-pinned image of the desired deploy. */
  readonly image?: string;
  /** `spec.traffic.revisionName` — a rollback pin, when set. */
  readonly pinnedRevision?: string;
  /** `spec.traffic.canaryPercent` — % to latest while pinned. */
  readonly canaryPercent?: number;
  readonly currentTraffic: readonly TrafficTargetView[];
  readonly conditions: readonly ConditionView[];
}

/**
 * Why the high-fidelity source produced nothing. Each reason is rendered as a
 * DISTINCT sentence by the page: "off" (`disabled`) is not "broken", and neither
 * is ever an empty table.
 */
export type NextAppUnavailableReason =
  | 'not-in-cluster'
  | 'crd-absent'
  | 'forbidden'
  | 'unreachable'
  /**
   * The name handed to {@link readNextAppStatus} is not a valid Kubernetes object
   * name, so no request was made. Its own reason (rather than folding into
   * `unreachable`) because the page must not blame the API server for a local
   * input problem — see PR-520 review finding 5.
   */
  | 'invalid-name'
  /**
   * The shared page budget handed to {@link readNextAppStatus} was already spent,
   * so NO request was issued (PR-520 review finding 3). Its own reason for the
   * same reason `deadline-exceeded` is its own Prometheus result: a read that
   * never happened establishes nothing about the API server, so it must not be
   * reported as `unreachable`.
   */
  | 'deadline-exceeded';

export type NextAppReadResult =
  | { readonly status: 'ok'; readonly data: NextAppStatusView }
  | { readonly status: 'disabled' }
  | {
      readonly status: 'source-unavailable';
      readonly reason: NextAppUnavailableReason;
      readonly detail: string;
    };

/** `true` only for the explicit opt-in value. */
export function nextAppSourceEnabled(): boolean {
  return process.env[NEXTAPP_SOURCE_ENV]?.trim() === NEXTAPP_SOURCE_KUBERNETES;
}

function readSecretFile(name: string): string | undefined {
  try {
    const value = readFileSync(`${SA_DIR}/${name}`, 'utf8');
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/** The minimal HTTP response shape this module needs. */
interface RawResponse {
  readonly statusCode: number;
  readonly body: string;
}

/**
 * One read-only HTTPS GET with a **per-request** CA and a hard TOTAL-duration
 * bound.
 *
 * `node:https` is used instead of global `fetch` for exactly one reason: it
 * accepts the cluster CA per request (`ca`), so the app's process-wide TLS trust
 * store is never widened for this single read (PR-520 sysdesign follow-up). No
 * response caching exists on this path at all, so there is nothing to opt out of.
 *
 * TWO bounds, deliberately (PR-520 review finding 2):
 *  - `timeout` — `node:https`' option, which is a **socket-INACTIVITY** timer:
 *    every received chunk resets it. On its own it does NOT bound the call, so an
 *    API server that trickles one byte per second holds this request open forever
 *    while the page's shared budget silently passes;
 *  - `deadlineTimer` — a real **total-duration** bound: `timeoutMs` after the
 *    request is issued the promise rejects and the socket is destroyed, whatever
 *    the server is doing. This is what makes the page's "bounded end to end"
 *    claim true for this read too, not just for the Prometheus queries.
 * The promise is rejected directly (rather than relying on `destroy()` surfacing
 * an `error` event) so the bound holds even if the socket is already gone.
 */
function getJson(
  url: string,
  token: string,
  ca: string | undefined,
  opts: { readonly timeoutMs: number },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const settle = <T>(fn: (value: T) => void) => {
      return (value: T) => {
        if (settled) {
          return;
        }
        settled = true;
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
        }
        fn(value);
      };
    };
    const succeed = settle(resolve);
    const fail = settle<unknown>(reject);

    const request = httpsRequest(
      url,
      {
        method: 'GET',
        // Scope the cluster CA to THIS request. Verification stays on.
        ca: ca ? [ca] : undefined,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        timeout: opts.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          succeed({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', fail);
      },
    );
    // The TOTAL bound: a trickling API server must not outlive the page's budget.
    deadlineTimer = setTimeout(() => {
      request.destroy(new Error('deadline'));
      fail(new Error('deadline'));
    }, opts.timeoutMs);
    // A hung (silent) API server must degrade the page, never hang the request.
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', fail);
    request.end();
  });
}

function unavailable(reason: NextAppUnavailableReason, detail: string): NextAppReadResult {
  return { status: 'source-unavailable', reason, detail };
}

/**
 * RFC 1123 subdomain — the shape every Kubernetes object name (including a
 * `NextApp`) must have, and the ONLY shape allowed into the request path.
 */
const DNS1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/** Defence-in-depth: the caller validates too, but this module does not rely on it. */
function isValidObjectName(name: string): boolean {
  return name.length > 0 && name.length <= 253 && DNS1123_SUBDOMAIN.test(name);
}

/**
 * The API-server origin, or `undefined` when the injected env cannot form a URL.
 *
 * An IPv6 `KUBERNETES_SERVICE_HOST` (e.g. `fd00::1`, normal on an IPv6 cluster)
 * MUST be bracketed inside a URL authority; plain interpolation yields an
 * unparseable URL that fails closed as "unreachable" and looks like a broken
 * cluster (PR-520 review finding 5). The port is validated rather than trusted so
 * a garbage value is refused here instead of becoming part of a request URL.
 */
function apiServerOrigin(host: string, port: string): string | undefined {
  const bare = host.replace(/^\[/, '').replace(/\]$/, '');
  // A colon in the host can only be an IPv6 literal — hostnames cannot contain one.
  const authority = bare.includes(':') ? `[${bare}]` : bare;

  const portNumber = Number(port);
  if (!/^[0-9]{1,5}$/.test(port) || portNumber < 1 || portNumber > 65535) {
    return undefined;
  }

  const origin = `https://${authority}:${portNumber}`;
  try {
    const parsed = new URL(origin);
    // Refuse anything that is not a bare authority: a host carrying a path,
    // query or credentials would otherwise reshape the request URL below.
    const bare =
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      parsed.username === '' &&
      parsed.password === '';
    return bare ? origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Project the raw `NextApp` document onto {@link NextAppStatusView}.
 *
 * Exported ONLY so the CRD contract gate (`nextapp-crd-contract.test.ts`) can
 * assert the BUILT view rather than substring-matching this source — a source
 * scan also matches the doc comments above, which name every field, so it would
 * stay green even if this projection were deleted (PR-520 review finding).
 */
export function toView(body: unknown): NextAppStatusView {
  const doc = (body ?? {}) as {
    spec?: { image?: string; traffic?: { revisionName?: string; canaryPercent?: number } };
    status?: {
      observedRevision?: string;
      lastSuccessfulDeployTime?: string;
      scaledToZero?: boolean;
      currentTraffic?: TrafficTargetView[];
      conditions?: ConditionView[];
    };
  };

  return {
    observedRevision: doc.status?.observedRevision,
    lastSuccessfulDeployTime: doc.status?.lastSuccessfulDeployTime,
    scaledToZero: doc.status?.scaledToZero,
    image: doc.spec?.image,
    pinnedRevision: doc.spec?.traffic?.revisionName,
    canaryPercent: doc.spec?.traffic?.canaryPercent,
    currentTraffic: Array.isArray(doc.status?.currentTraffic) ? doc.status.currentTraffic : [],
    conditions: Array.isArray(doc.status?.conditions) ? doc.status.conditions : [],
  };
}

/**
 * Read this app's `NextApp` CR, read-only, from the in-cluster API server.
 *
 * @param name the `NextApp` name. Callers validate it (`observabilityAppName()`),
 *   but this function does NOT rely on that: it re-checks the DNS-1123 shape
 *   itself before the name reaches the request path, so the safety of the URL is a
 *   property of this module rather than of every call site (PR-520 finding 5).
 */
export async function readNextAppStatus(
  name: string,
  opts?: { readonly timeoutMs?: number },
): Promise<NextAppReadResult> {
  // Opt-in gate FIRST: not enabled ⇒ no file read, no network call, no RBAC.
  if (!nextAppSourceEnabled()) {
    return { status: 'disabled' };
  }

  /**
   * REFUSE TO START on an exhausted budget (PR-520 review finding 3), mirroring
   * `runQuery`'s guard in `_prom/query.ts`.
   *
   * `PageDeadline.remainingMs()` is floored at 0, and the caller forwards it as
   * `timeoutMs`. Without this guard `0 ?? DEFAULT_TIMEOUT_MS` is `0` — and
   * `timeout: 0` on `https.request` means NO timeout at all, so the exhausted-
   * budget path would fail OPEN into an unbounded read: the exact inverse of what
   * the caller asked for.
   */
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (timeoutMs <= 0) {
    return unavailable(
      'deadline-exceeded',
      'the page ran out of its shared time budget before this read could start',
    );
  }

  // Defensive re-check before ANY credential read or request: an unvalidated name
  // is the only thing this module interpolates into a URL path. The detail
  // deliberately echoes neither the name nor the host.
  if (!isValidObjectName(name)) {
    return unavailable('invalid-name', 'the requested NextApp name is not a valid Kubernetes name');
  }

  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
  const token = readSecretFile('token');
  const namespace = readSecretFile('namespace');
  // The namespace comes from the projected SA volume and is interpolated into the
  // same path, so it gets the same shape check rather than implicit trust.
  if (!host || !token || !namespace || !isValidObjectName(namespace)) {
    return unavailable(
      'not-in-cluster',
      'no usable in-cluster ServiceAccount credentials are mounted in this pod',
    );
  }

  const origin = apiServerOrigin(host, port);
  if (!origin) {
    return unavailable(
      'unreachable',
      'the injected Kubernetes API server address is not a usable URL',
    );
  }

  const url = `${origin}/apis/${API_GROUP}/${API_VERSION}/namespaces/${namespace}/nextapps/${name}`;

  let response: RawResponse;
  try {
    response = await getJson(url, token, readSecretFile('ca.crt'), { timeoutMs });
  } catch {
    // Deliberately no error message: it can carry the API server host/IP.
    return unavailable('unreachable', 'the Kubernetes API server could not be reached');
  }

  if (response.statusCode === 404) {
    return unavailable('crd-absent', 'HTTP 404 — no such NextApp resource or CRD');
  }
  if (response.statusCode === 401 || response.statusCode === 403) {
    return unavailable('forbidden', `HTTP ${response.statusCode} — read access denied`);
  }
  if (response.statusCode < 200 || response.statusCode > 299) {
    return unavailable('unreachable', `HTTP ${response.statusCode} from the Kubernetes API`);
  }

  try {
    return { status: 'ok', data: toView(JSON.parse(response.body)) };
  } catch {
    return unavailable('unreachable', 'the Kubernetes API returned an unreadable response');
  }
}
