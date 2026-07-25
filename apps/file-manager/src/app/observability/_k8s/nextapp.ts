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
  | 'unreachable';

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
 * One read-only HTTPS GET with a **per-request** CA and a hard timeout.
 *
 * `node:https` is used instead of global `fetch` for exactly one reason: it
 * accepts the cluster CA per request (`ca`), so the app's process-wide TLS trust
 * store is never widened for this single read (PR-520 sysdesign follow-up). No
 * response caching exists on this path at all, so there is nothing to opt out of.
 */
function getJson(
  url: string,
  token: string,
  ca: string | undefined,
  opts: { readonly timeoutMs: number },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
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
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    // A hung API server must degrade the page, never hang the request.
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end();
  });
}

function unavailable(reason: NextAppUnavailableReason, detail: string): NextAppReadResult {
  return { status: 'source-unavailable', reason, detail };
}

function toView(body: unknown): NextAppStatusView {
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
 * @param name the `NextApp` name — already validated as a k8s label by
 *   `observabilityAppName()`, so it is safe to interpolate into the path.
 */
export async function readNextAppStatus(
  name: string,
  opts?: { readonly timeoutMs?: number },
): Promise<NextAppReadResult> {
  // Opt-in gate FIRST: not enabled ⇒ no file read, no network call, no RBAC.
  if (!nextAppSourceEnabled()) {
    return { status: 'disabled' };
  }

  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
  const token = readSecretFile('token');
  const namespace = readSecretFile('namespace');
  if (!host || !token || !namespace) {
    return unavailable(
      'not-in-cluster',
      'no in-cluster ServiceAccount credentials are mounted in this pod',
    );
  }

  const url = `https://${host}:${port}/apis/${API_GROUP}/${API_VERSION}/namespaces/${namespace}/nextapps/${name}`;

  let response: RawResponse;
  try {
    response = await getJson(url, token, readSecretFile('ca.crt'), {
      timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
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
