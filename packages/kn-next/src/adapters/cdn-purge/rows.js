/**
 * Provider rows — the PURGE half of ADR-0068 D2 — INTERNAL.
 *
 * A provider is one data row, not a code branch. A row says whether it can
 * purge at all, how big a batch is, how fast it may be called, what a valid
 * purge target looks like, and where the purge request goes.
 *
 * What ships now (ADR-0068 D2):
 *   - `cloudflare`  tag purge, <=100 tags per request, default 5 requests/min,
 *                   bucket 25. The Free-plan numbers: the conservative plan.
 *   - `emulator`    Cloudflare-shaped, test only, at a `*.svc.cluster.local`
 *                   endpoint, sending a FIXED dummy token (never the user's).
 *
 * `google-cloud-cdn`, `cloudfront` and `azure-front-door` are rows with
 * `purge: null`: their header modes ship, their purge needs a signer
 * (OAuth / SigV4 / Azure AD) and is deferred (#2270). A deferred row set on a
 * CR is accepted; the runtime skips it and says so. There is no OCI row — OCI
 * has no CDN product.
 *
 * SSRF (ADR-0068 D10): each real row's API base is a constant HERE. Neither the
 * CR, the environment, nor a caller option can override it. Only the emulator
 * takes an endpoint, and it must be a `*.svc.cluster.local` host; this module
 * validates it again at runtime (the CRD's CEL rule is the first line, this is
 * the second) and the purger fails closed on a miss.
 *
 * The edge-header columns of D2 (directive header, tag-header limits, query
 * keying) belong to the response-header preload (CDN-1), not to this file.
 */

/** Cloudflare's v4 API base. The ONLY place a real provider URL is written. */
const API_BASE_CLOUDFLARE = 'https://api.cloudflare.com/client/v4';

/** The fixed token the emulator row sends — a placeholder, not a credential. */
export const EMULATOR_DUMMY_TOKEN = 'knext-cdn-emulator-dummy-token';

const CLUSTER_LOCAL_SUFFIX = '.svc.cluster.local';
const DNS_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Validate an emulator endpoint. Returns the normalised origin
 * (`http(s)://<host>[:port]`, no trailing slash) or `null` when the value is
 * not exactly `http(s)://<name>.svc.cluster.local[:port]`.
 *
 * Judged on the PARSED URL, never on the raw text: `http://x.svc.cluster.local@evil`
 * and `http://evil/.svc.cluster.local` both contain the suffix and both point
 * somewhere else.
 *
 * @param {unknown} raw
 * @returns {string | null}
 */
export function validateEmulatorEndpoint(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  // Whitespace, backslashes (WHATWG treats `\` as `/` in special schemes) and a
  // bare `?`/`#` are refused outright rather than reasoned about.
  if (/[\s\\?#]/.test(raw)) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/') return null;
  const host = url.hostname;
  if (!DNS_NAME.test(host)) return null;
  if (!host.endsWith(CLUSTER_LOCAL_SUFFIX)) return null;
  return `${url.protocol}//${url.host}`;
}

/**
 * @typedef {object} PurgeSpec
 * @property {number} batchSize     tags per request
 * @property {number} rpm           default requests per minute
 * @property {number} bucket        token-bucket capacity
 * @property {RegExp} targetPattern what a valid `purge.target` looks like
 * @property {'env' | 'dummy'} credential  where the bearer token comes from
 * @property {(env: Record<string, string | undefined>) => string | null} base
 *           the API base for a request, or null when the row cannot be reached
 */

/** @type {Readonly<Record<string, { name: string, purge: PurgeSpec | null }>>} */
export const PURGE_ROWS = Object.freeze({
  cloudflare: Object.freeze({
    name: 'cloudflare',
    purge: Object.freeze({
      batchSize: 100,
      rpm: 5,
      bucket: 25,
      targetPattern: /^[0-9a-fA-F]{32}$/,
      credential: 'env',
      base: () => API_BASE_CLOUDFLARE,
    }),
  }),
  emulator: Object.freeze({
    name: 'emulator',
    purge: Object.freeze({
      batchSize: 100,
      rpm: 5,
      bucket: 25,
      targetPattern: /^[A-Za-z0-9_-]{1,64}$/,
      credential: 'dummy',
      base: (env) => {
        const origin = validateEmulatorEndpoint(env.KNEXT_CDN_EMULATOR_ENDPOINT);
        return origin === null ? null : `${origin}/client/v4`;
      },
    }),
  }),
  'google-cloud-cdn': Object.freeze({ name: 'google-cloud-cdn', purge: null }),
  cloudfront: Object.freeze({ name: 'cloudfront', purge: null }),
  'azure-front-door': Object.freeze({ name: 'azure-front-door', purge: null }),
});
