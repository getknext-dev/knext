// RuntimeContract helpers for the opt-in `bun-exec` build target (ADR-0036).
//
// Pure and dependency-free ON PURPOSE: this module is imported by BOTH the real
// bun entry (`knext-bun-entry.mjs`, compiled into the single executable) and the
// test harness (`test/drain-harness.mjs`, run under bun without a vinext build).
// Because it imports nothing bun- or nitro-specific, the same code runs under
// node (vitest unit tests), under bun, and inside the `bun --compile --bytecode`
// binary — so the behaviour the tests assert is the behaviour the binary ships.
//
// It provides three of the seven RuntimeContract items ADR-0036 enumerates:
//   (2) in-process Prometheus `:9464` exposition,
//   (3) SIGTERM graceful drain (+ `after()`/waitUntil draining, + hardcap),
//   (5) Bearer-authenticated, fail-closed mutating-route guard.
// Items 1 (health), 4 (Redis cache-handler — WIRED: the vinext() plugin's
// `cache.data` adapter in vite.config.ts registers
// @getknext/core/internal/vinext-cache-adapter in every server entry, #953),
// 6 (operator env-injection) and 7 (module-state seam) are covered by the
// sample app routes / the vite plugin config / the env contract / the
// globalThis anchor below — see README.md.

// The only imports are node: builtins, which resolve identically under node,
// under bun, and inside the compiled binary — the "dependency-free" property
// above is about bun/nitro/vinext coupling, not about the standard library.
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── (6) Bind-host resolution — never bind to a k8s pod name ─────────────────
// Kubernetes injects HOSTNAME=<pod-name> (e.g. `recipe-validate-fn252`) into
// EVERY pod. A pod name is an identity, not a bind address: binding
// `Bun.serve({ hostname: '<pod-name>' })` makes the listener unreachable on
// 127.0.0.1 / the pod IP, so every request (app :PORT AND metrics :9464) is
// connection-refused and boot times out (confirmed on OKE).
//
// Mirror the node supervisor's intent (packages/kn-next/src/adapters/env.ts
// `isBindOrLoopback`): only an EXPLICIT bind/loopback address is a real bind
// target — anything else (a pod name, any non-address hostname) falls through
// to 0.0.0.0. This keeps an explicit `HOSTNAME=127.0.0.1` / `::1` / `localhost`
// bind honoured for local dev while never trusting a k8s-injected pod name.
// `127.` is prefix-matched (the whole 127.0.0.0/8 loopback block); no valid pod
// name contains a dot, so the prefix can't collide with one.
const BIND_OR_LOOPBACK_HOSTNAMES = new Set(['0.0.0.0', '::', '::1', 'localhost']);

function isBindOrLoopback(value) {
  const v = value.toLowerCase();
  return BIND_OR_LOOPBACK_HOSTNAMES.has(v) || v.startsWith('127.');
}

/**
 * Resolve the host both `Bun.serve` listeners bind to. Returns `HOSTNAME` only
 * when it is an explicit bind/loopback address; otherwise `0.0.0.0`. A k8s
 * pod-name HOSTNAME (or any non-address value, or unset) ⇒ `0.0.0.0`.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveBindHost(env = process.env) {
  const h = env.HOSTNAME;
  return h && isBindOrLoopback(h) ? h : '0.0.0.0';
}

// ── The in-process request byte cap (ADR-0044 Option C) ─────────────────────
//
// Until this landed, both listeners ran at Bun's 128 MB default: a single POST
// could make the pod buffer 128 MB, and `containerConcurrency` 20 against a 1Gi
// limit turns that into an OOM kill rather than a 413. The reverse-proxy recipe
// in the docs was the only payload cap, and it is not in the request path of a
// pod a co-resident workload can dial directly.
//
// The whole enforcement is srvx's `maxRequestBodySize`, which on Bun is handed
// to `Bun.serve` and answered BEFORE any user code runs. Measured on two
// runtimes, because the difference is the entire guarantee:
//
//   bun 1.3.5  honest 5 KB / cap 1 KB → 413 · CHUNKED 5 KB, no length → 200
//   bun 1.4.0  honest 5 KB / cap 1 KB → 413 · CHUNKED 5 KB, no length → 413
//
// ADR-0044 Decision 4 requires COUNTED bytes, never a trusted `Content-Length`
// (chunked encoding carries none), so only >= 1.4.0 satisfies it — which is why
// `vinext-build.ts`'s existing Bun 1.4.0 build floor is now load-bearing for a
// security control and pinned by `scripts/lib/request-byte-cap.mjs`.
//
// Bun's 413 is synthesized by the runtime: empty body, no `content-type`, and
// the `error` hook does not fire. srvx passes the ORIGINAL request down its
// middleware chain and ignores what a middleware returns, so nothing in-process
// can name knext in that body without either widening the cap or rebuilding the
// Request (which drops srvx's expando augmentation — the #460 bug-2 class). The
// cap is therefore made discoverable at BOOT and in the docs instead.

/**
 * 8 MiB — the default cap.
 *
 * ADR-0044's own arithmetic: 1Gi memory limit, `containerConcurrency` 20, so 20
 * worst-case buffered bodies must stay far under the limit (20 x 8 MiB =
 * 160 MiB). Deliberately ABOVE Next's 1 MB `serverActions.bodySizeLimit`: two
 * layers answering different errors at one threshold is how a support ticket
 * becomes unanswerable. The platform cap sits above the framework cap on
 * purpose.
 */
export const DEFAULT_MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/**
 * 64 KiB — the `:9464` metrics cap, FIXED.
 *
 * That listener answers exactly one GET. It is not a function of the env knob:
 * `KNEXT_MAX_REQUEST_BYTES=0` is an app-side escape hatch and must not re-open
 * the co-resident-pod path ADR-0044's threat scope names.
 */
export const METRICS_MAX_REQUEST_BYTES = 64 * 1024;

/** The operator-facing knob. Env only — deliberately not a CRD field. */
export const MAX_REQUEST_BYTES_ENV = 'KNEXT_MAX_REQUEST_BYTES';

/**
 * @typedef ResolvedRequestCap
 * @property {number | undefined} bytes app cap; `undefined` means no cap at all
 * @property {number} metricsBytes the fixed `:9464` cap
 * @property {'default' | 'env' | 'uncapped' | 'invalid'} source where it came from
 * @property {string} [warning] set for `uncapped` and `invalid`; log it loudly
 */

/**
 * Resolve the effective request byte caps from the environment.
 *
 * `bytes` is `undefined` when explicitly uncapped, because `undefined` is what
 * srvx and `Bun.serve` both read as "no option given". Returning `0` or
 * `Infinity` would be forwarded and misbehave.
 *
 * An INVALID value falls back to the default and never to uncapped — the
 * security-relevant direction. A typo in a manifest must not silently remove a
 * control; it must be loud and still capped.
 *
 * (The return type is a `@typedef` rather than an inline object type on purpose:
 * an inline `@returns` object type opens with a doubled brace, which the
 * scaffolder's renderer reads as an unsubstituted placeholder and refuses to
 * emit — so every `kn-next create` would fail on this file. Do not reintroduce
 * one, in code OR in a comment; the renderer does not care which.)
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {ResolvedRequestCap}
 */
export function resolveMaxRequestBytes(env = process.env) {
  const metricsBytes = METRICS_MAX_REQUEST_BYTES;
  const raw = env[MAX_REQUEST_BYTES_ENV];
  if (raw === undefined) {
    return { bytes: DEFAULT_MAX_REQUEST_BYTES, metricsBytes, source: 'default' };
  }
  const trimmed = String(raw).trim();
  // `Number('')` is 0 and `Number(' ')` is 0 — an empty value must NOT read as
  // "uncapped". Digits only, so `1.5`, `-1`, `1e9`, `NaN` and `Infinity` are all
  // invalid rather than silently coerced.
  const valid = /^\d+$/.test(trimmed);
  const parsed = valid ? Number(trimmed) : Number.NaN;
  if (!valid || !Number.isSafeInteger(parsed)) {
    return {
      bytes: DEFAULT_MAX_REQUEST_BYTES,
      metricsBytes,
      source: 'invalid',
      warning:
        `${MAX_REQUEST_BYTES_ENV}=${JSON.stringify(raw)} is not a non-negative integer — ` +
        `falling back to the ${DEFAULT_MAX_REQUEST_BYTES}-byte default. Set 0 to uncap deliberately.`,
    };
  }
  if (parsed === 0) {
    return {
      bytes: undefined,
      metricsBytes,
      source: 'uncapped',
      warning:
        `${MAX_REQUEST_BYTES_ENV}=0 — request bodies are UNCAPPED. This pod will buffer a body ` +
        'of any size the runtime accepts; with containerConcurrency > 1 that is an OOM kill ' +
        'rather than a 413 (ADR-0044). The :9464 metrics listener stays capped regardless.',
    };
  }
  return { bytes: parsed, metricsBytes, source: 'env' };
}

// ── (#460 bug 3) Where the runtime reads `.output/public` from ──────────────
//
// Nitro prepends `globalThis.__nitro_main__ = import.meta.url` to the server
// entry and its public-asset reader does
// `readFile(resolve(dirname(fileURLToPath(__nitro_main__)), '../public/…'))`.
// `bun build --compile` BAKES that URL as the absolute path on the machine that
// built the binary, so a shipped container asks for
// `/Users/<builder>/…/.output/public/_next/static/…` and 500s (ENOENT) on every
// asset — while `/` still returns correct SSR HTML. That is why it survived five
// verifications: the page renders and never hydrates.
//
// The decision is factored out here, away from the entry, for two reasons: the
// entry cannot be imported by a test (it pulls in nitro + vinext), and the only
// failure mode of getting this wrong is SILENCE. Both are addressed by making it
// a pure function with an injected `exists`.
//
// Candidate order, and why:
//   1. the BAKED root, if its `../public` is actually there AND this is not a
//      compiled binary. A non-compiled `bun run /abs/path/.output/server/
//      index.mjs` has a CORRECT baked value, and it must win over anything
//      discovered from the environment.
//   2. `dirname(process.execPath)` — the compiled case. The ship shape is the
//      executable next to `.output/public` (README + Dockerfile), so anchoring
//      on the EXECUTABLE makes the binary portable. cwd deliberately is NOT a
//      candidate: it would both miss (`docker run -w /elsewhere`) and misfire
//      (an unrelated `.output/public` under cwd hijacking a correct baked root).
//   3. nothing → keep the baked value and WARN LOUDLY. Serving is already broken
//      at this point; the only thing left to get right is not being silent.
//
// `isCompiled` is load-bearing and NOT an optimisation. Without it, "a baked
// root that exists" wins unconditionally, and on the BUILD MACHINE — the one
// place a human verifies the ship shape — a compiled binary then serves the
// build tree's assets instead of its own co-located ones, with no warning. That
// makes "I copied binary + .output/public to /tmp/ship and it served" prove
// nothing (delete the shipped public/ and it still serves), lets a moved binary
// serve a rebuilt tree's content-hashed chunks against old HTML, and — because
// `exists` is DIRECTORY-level — lets a stale or emptied baked public/ shadow a
// complete co-located one. The premise "a baked root that exists ⇒ non-compiled"
// is false by construction on the builder; the honest discriminator is that a
// non-compiled run's execPath is the bun/node RUNTIME, not the app.
const PUBLIC_REL = '.output/public';
const SERVER_ENTRY_REL = '.output/server/index.mjs';

// A plain `bun run entry.mjs` reports the RUNTIME as `process.execPath`; a
// `bun build --compile` binary reports ITSELF. Basename is the only signal that
// does not depend on a bun internal, and it is used solely to pick which root
// wins / whether to warn — never to break a path that would otherwise serve.
// Overridable via the `isCompiled` parameter for a binary named `bun`, or if a
// future bun exposes something better.
//
// KNOWN RESIDUAL, stated rather than left to be rediscovered: this is a
// heuristic on a basename, so a compiled binary whose basename is EXACTLY one
// of these (`OUT=node ./build.sh`) classifies as non-compiled and takes the
// baked-root branch silently — the pre-fix behaviour, restored, for that one
// naming. `build.sh` defaults `OUT` to `knext-bun-exec-$ARCH`, so only an
// explicit `OUT=` override can reach it; do not name the binary after a
// language runtime. The inverse (`nodejs`, `bun-1.3.14`, `node18`) is benign:
// a non-compiled run so named yields at worst a spurious warning, and only if
// the runtime's OWN directory happens to hold a `.output/public`.
const RUNTIME_BASENAMES = new Set(['bun', 'bun-debug', 'bunx', 'node', 'deno']);

/**
 * @param {string} execPath `process.execPath`.
 * @returns {boolean} true when execPath is the app itself, not a language runtime.
 */
export function isCompiledExecutable(execPath) {
  const base = basename(execPath).replace(/\.exe$/i, '');
  return !RUNTIME_BASENAMES.has(base);
}

/**
 * @param {object} opts
 * @param {string | undefined} opts.bakedMain `globalThis.__nitro_main__` as baked at build time.
 * @param {string} opts.execPath              `process.execPath`.
 * @param {(path: string) => boolean} opts.exists
 * @param {boolean} [opts.isCompiled]         Defaults to `isCompiledExecutable(execPath)`.
 * @param {string} [opts.cwd]                 Reported in the warning only — never a candidate.
 * @returns { { mainUrl: string | null, source: 'baked' | 'execdir' | 'unresolved', warning: string | null } }
 *   `mainUrl` is null when `__nitro_main__` must be left alone (candidate 1 or 3).
 */
export function resolveAssetAnchor({ bakedMain, execPath, exists, isCompiled, cwd }) {
  // A malformed/absent baked value must degrade, never throw — this runs at
  // module init of the entry, so throwing here kills the process before it listens.
  let bakedDir = null;
  try {
    if (bakedMain) bakedDir = dirname(fileURLToPath(bakedMain));
  } catch {
    bakedDir = null;
  }
  const bakedPublic = bakedDir ? resolve(bakedDir, '../public') : null;
  const bakedOk = Boolean(bakedPublic && exists(bakedPublic));

  const execDir = dirname(execPath);
  const execPublic = resolve(execDir, PUBLIC_REL);
  const execOk = exists(execPublic);
  const compiled = isCompiled ?? isCompiledExecutable(execPath);

  // Candidate 1 — the baked root wins ONLY when this is not a compiled binary.
  // For a compiled binary the baked root is the BUILD MACHINE's tree, which is
  // a different artifact that merely happens to be reachable on the builder.
  if (bakedOk && !compiled) {
    return { mainUrl: null, source: 'baked', warning: null };
  }

  // Compiled, and BOTH roots are present: the co-located one is what shipped,
  // so it wins — but this is the case that used to resolve silently, so say so.
  if (bakedOk && execOk && bakedPublic !== execPublic) {
    return {
      mainUrl: pathToFileURL(resolve(execDir, SERVER_ENTRY_REL)).href,
      source: 'execdir',
      warning:
        'knext bun-exec: TWO static-asset roots are present — anchoring on the one shipped beside ' +
        `the executable (${execPublic}) and IGNORING the build tree it was compiled from ` +
        `(${bakedPublic}). If assets look stale, you are running a binary next to a stale ` +
        '`.output/public`, or on the machine that built it.',
    };
  }

  // Compiled, but ONLY the build tree is there — `!execOk` is what makes that
  // "only" true, and it is load-bearing, not redundant with the branch above.
  // `build.sh` drops the binary INTO the example dir beside the very
  // `.output/public` it was built from (the README's documented first run), so
  // `bakedPublic === execPublic` is a NORMAL layout: one root, reached two
  // ways, both `bakedOk` and `execOk`. Without `!execOk` that lands here and
  // prints the same path twice — "found NO .output/public beside itself (<P>)
  // … fell back to (<P>)" — telling the user to do what they already did.
  // Serving is unaffected (the roots coincide), but this whole resolver exists
  // because the failure mode was silence, and a warning that cries wolf on the
  // first run is how the real one gets ignored. With the guard, coincident
  // roots fall through to the plain `execOk` branch: same directory, no noise.
  // The genuine case — a compiled binary whose co-located root is absent —
  // serves HERE and nowhere else, so keep the baked value whole (never
  // partially rewritten) and warn.
  if (bakedOk && !execOk) {
    return {
      mainUrl: null,
      source: 'baked',
      warning:
        'knext bun-exec: this executable found NO `.output/public` beside itself ' +
        `(${execPublic}) and fell back to the tree it was BUILT from (${bakedPublic}). ` +
        'It will serve here and 500 on every static asset anywhere else. Ship the executable ' +
        'NEXT TO its `.output/public` directory.',
    };
  }

  if (execOk) {
    return {
      mainUrl: pathToFileURL(resolve(execDir, SERVER_ENTRY_REL)).href,
      source: 'execdir',
      warning: null,
    };
  }

  return {
    mainUrl: null,
    source: 'unresolved',
    warning:
      'knext bun-exec: no static-asset root found — every /_next/static request will 500 ' +
      '(the page will render but never hydrate). Ship the executable NEXT TO its `.output/public` ' +
      `directory. Looked for: ${resolve(execDir, PUBLIC_REL)}` +
      (bakedPublic ? ` and ${bakedPublic}` : ' (no baked __nitro_main__ to fall back on)') +
      (cwd ? ` [cwd: ${cwd}]` : ''),
  };
}

// ── (2) Prometheus metrics ─────────────────────────────────────────────────
// Hand-rolled exposition (no prom-client dependency) so the module stays
// self-contained and compile-safe. Mirrors the process-metric shape the node
// supervisor exposes (packages/kn-next/src/adapters/node-server.ts) but scoped
// to what a single in-process runtime can measure without a child scrape.
//
// :9464 is the ONLY endpoint knext's shipped PodMonitor scrapes, so whatever is
// NOT here is not on any dashboard and cannot back any alert. That makes the
// shape below a contract, not an implementation detail — `sum(rate(...))` over a
// series nobody emits returns an empty vector, so a query naming one is blank
// and an alert on it never fires, silently and forever (#792). The set here is
// pinned against every shipped alert and dashboard by
// packages/kn-next/src/__tests__/observability-metric-contract.test.ts.
//
// CARDINALITY IS DELIBERATELY BOUNDED. A scale-to-zero fleet churns pods, and
// every pod is a fresh series set, so an unbounded label here multiplies across
// the whole fleet:
//   - the request counter carries `status_class` ONLY — five values, fixed at
//     compile time. NOT the raw status (≈60 values) and NOT the route/path,
//     which is unbounded by construction: a single crawler hitting
//     /a, /b, /c … mints a series per URL and never stops. Per-route RED needs
//     an explicit, bounded route allowlist; until there is one, there is no
//     route label. `KnextCacheUnreachable`'s old `route="/api/health"` filter
//     was exactly this, and it is why that alert was retired rather than
//     repointed.
//   - the duration histogram carries NO labels at all. Buckets already multiply
//     it 13×; crossing that with status_class would make one histogram the
//     dominant term in the fleet's series count for no SLO that needs it.
// Total: 23 series per pod, constant — 3 process/startup gauges, 5 counters,
// 1 in-flight gauge, 13 buckets, `_sum`, `_count`.
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

// Latency buckets, in seconds. Tuned for a scale-to-zero Next.js service rather
// than copied from prom-client's defaults: the measured cold-start floor is tens
// of milliseconds and a warm SSR hit is faster still, so a histogram whose
// finest bucket is 100 ms cannot resolve a p50 at all — every warm request lands
// in the first bucket and `histogram_quantile` interpolates a straight line
// through it. Five sub-100 ms buckets give real resolution where the traffic is,
// and the tail out to 10 s covers a cold wake plus a slow upstream.
export const REQUEST_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

// Fixed, exhaustive, and emitted even at zero. Pre-seeding every class means
// `rate()` is well-defined from the FIRST scrape after a pod starts — otherwise
// a series appears only once its first 5xx lands, and the error-rate query has
// no denominator until then. Five values is the entire cardinality of this
// label, forever: `statusClass` clamps anything else into it.
const STATUS_CLASSES = ['1xx', '2xx', '3xx', '4xx', '5xx'];

/**
 * Bucket an HTTP status into its class. Anything outside 100-599 — including a
 * non-numeric value, or a handler that threw before producing a response — is
 * counted as `5xx`: it is a server-side failure, and folding it into the class
 * that already means "we broke it" is what keeps the label's value set closed.
 *
 * @param {number | string} status
 * @returns {string}
 */
export function statusClass(status) {
  const n = Math.floor(Number(status) / 100);
  return n >= 1 && n <= 5 ? `${n}xx` : '5xx';
}

export function createMetricsState() {
  return {
    requestsTotal: 0,
    inflight: 0,
    startNs: process.hrtime.bigint(),
    // Seconds from process start to both listeners being bound. Set ONCE, by
    // recordStartupComplete(); null until then.
    startupSeconds: null,
    // status_class → count. Seeded with every class (see STATUS_CLASSES).
    byStatusClass: Object.fromEntries(STATUS_CLASSES.map((c) => [c, 0])),
    // Cumulative-by-construction counts, parallel to REQUEST_DURATION_BUCKETS,
    // plus the implicit +Inf bucket which is requestsTotal.
    durationBuckets: REQUEST_DURATION_BUCKETS.map(() => 0),
    durationSum: 0,
  };
}

/**
 * Record one completed request. Called from the entry's single srvx middleware,
 * which already wraps every request — so the RED signals cost one increment and
 * a short loop, on a path that exists either way.
 *
 * @param {ReturnType<typeof createMetricsState>} state
 * @param {number | string} status         HTTP status of the response.
 * @param {number} durationSeconds         Wall time the handler took.
 */
export function observeRequest(state, status, durationSeconds) {
  state.requestsTotal++;
  const cls = statusClass(status);
  state.byStatusClass[cls] = (state.byStatusClass[cls] ?? 0) + 1;
  const d = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
  state.durationSum += d;
  for (let i = 0; i < REQUEST_DURATION_BUCKETS.length; i++) {
    if (d <= REQUEST_DURATION_BUCKETS[i]) state.durationBuckets[i]++;
  }
}

/**
 * Mark the runtime as up. Cold start is THE product metric for a scale-to-zero
 * service, and the binary is the only thing that can measure it honestly:
 * `process.uptime()` at the moment both listeners are bound includes the Bun
 * bootstrap and every module evaluation before it, which is exactly the latency
 * a user waking a scaled-to-zero pod pays.
 *
 * A gauge rather than a histogram on purpose: each pod records it exactly once,
 * so the fleet-wide distribution is already one sample per pod and
 * `max by (app)` / `quantile` over the gauge is the correct aggregation. A
 * histogram here would cost 13 series to hold one observation.
 *
 * @param {ReturnType<typeof createMetricsState>} state
 * @param {number} [uptimeSeconds]
 */
export function recordStartupComplete(state, uptimeSeconds = process.uptime()) {
  if (state.startupSeconds === null) state.startupSeconds = uptimeSeconds;
}

export function renderMetrics(state) {
  const mem = process.memoryUsage();
  const uptimeSec = Number(process.hrtime.bigint() - state.startNs) / 1e9;
  const lines = [
    '# HELP knext_bunexec_process_resident_memory_bytes Resident set size of the runtime in bytes.',
    '# TYPE knext_bunexec_process_resident_memory_bytes gauge',
    `knext_bunexec_process_resident_memory_bytes ${mem.rss}`,
    '# HELP knext_bunexec_process_uptime_seconds Seconds since the runtime process started.',
    '# TYPE knext_bunexec_process_uptime_seconds gauge',
    `knext_bunexec_process_uptime_seconds ${uptimeSec.toFixed(3)}`,
  ];

  // Omitted, not zeroed, until the listeners are actually bound: a `0` here
  // would read as "this pod started instantly", which is the one wrong answer.
  if (state.startupSeconds !== null) {
    lines.push(
      '# HELP knext_bunexec_startup_duration_seconds Seconds from process start until both listeners were bound (cold start).',
      '# TYPE knext_bunexec_startup_duration_seconds gauge',
      `knext_bunexec_startup_duration_seconds ${state.startupSeconds.toFixed(3)}`,
    );
  }

  lines.push(
    '# HELP knext_bunexec_http_requests_total Total app HTTP requests handled, by response status class.',
    '# TYPE knext_bunexec_http_requests_total counter',
  );
  for (const cls of STATUS_CLASSES) {
    lines.push(
      `knext_bunexec_http_requests_total{status_class="${cls}"} ${state.byStatusClass[cls] ?? 0}`,
    );
  }

  lines.push(
    '# HELP knext_bunexec_http_inflight_requests App HTTP requests currently in flight.',
    '# TYPE knext_bunexec_http_inflight_requests gauge',
    `knext_bunexec_http_inflight_requests ${state.inflight}`,
    '# HELP knext_bunexec_http_request_duration_seconds App HTTP request duration in seconds.',
    '# TYPE knext_bunexec_http_request_duration_seconds histogram',
  );
  for (let i = 0; i < REQUEST_DURATION_BUCKETS.length; i++) {
    lines.push(
      `knext_bunexec_http_request_duration_seconds_bucket{le="${REQUEST_DURATION_BUCKETS[i]}"} ${state.durationBuckets[i]}`,
    );
  }
  lines.push(
    `knext_bunexec_http_request_duration_seconds_bucket{le="+Inf"} ${state.requestsTotal}`,
    `knext_bunexec_http_request_duration_seconds_sum ${state.durationSum.toFixed(6)}`,
    `knext_bunexec_http_request_duration_seconds_count ${state.requestsTotal}`,
  );

  return lines.join('\n') + '\n';
}

// ── (5) Bearer-authenticated, fail-closed mutating-route guard ──────────────
// security.md hard rule: no unauthenticated mutating endpoints. Returns `null`
// when the request is authorised, or a 401 `Response` when it is NOT. Fails
// CLOSED on every ambiguity: unset server token, missing header, and mismatch
// all deny. Constant-time comparison avoids leaking the token via timing.
export function checkBearer(req, token) {
  if (!token) {
    // Misconfigured server (token env unset) → deny, never allow-through.
    return jsonResponse(401, {
      error: 'unauthorized',
      reason: 'server misconfigured: CACHE_INVALIDATE_TOKEN is not set',
    });
  }
  const header = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${token}`;
  if (!constantTimeEqual(header, expected)) {
    return jsonResponse(401, { error: 'unauthorized' });
  }
  return null;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Length-independent constant-time-ish compare: iterate to the longer length so
// the loop count does not branch on a match, and fold the length difference in.
function constantTimeEqual(a, b) {
  let mismatch = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

// ── (7 / after()) Background-task registry, anchored on globalThis ──────────
// ADR-0027: a runtime seam's mutable state MUST live on globalThis via a
// namespaced Symbol.for key, never a bare module-level `let` — a bundler may
// duplicate this module across layers, giving each copy independent state. The
// binary bundles this file once, but we honour the invariant so route handlers
// in a different bundle layer share ONE pending set. Next.js `after()` /
// WinterCG `waitUntil` callbacks register here and are awaited during drain.
const PENDING_KEY = Symbol.for('knext.bunexec.pendingTasks');

export function waitUntil(promise) {
  globalThis[PENDING_KEY] ??= new Set();
  const set = globalThis[PENDING_KEY];
  const tracked = Promise.resolve(promise)
    .catch(() => {})
    .finally(() => set.delete(tracked));
  set.add(tracked);
  return promise;
}

export async function drainPending() {
  const set = globalThis[PENDING_KEY];
  if (!set || set.size === 0) return;
  await Promise.all([...set]);
}

// ── (3) SIGTERM graceful drain ──────────────────────────────────────────────
// A single executable has no supervisor, so the drain lives IN the process:
//   1. Arm a hardcap timer (GRACE_MS) that force-stops + exits 1 if drain hangs.
//   2. `server.stop()` (no arg) — stop accepting new conns, let in-flight
//      requests FINISH; the returned Promise resolves when they do (the drain).
//   3. Await after()/waitUntil background tasks.
//   4. Stop the metrics listener LAST — load-bearing: it is what holds the
//      event loop open so the `unref()`ed hardcap can fire (and, secondarily,
//      it keeps a scrape answerable throughout the drain). See the DO-NOT-
//      REORDER note at the drain site.
//   5. Exit 0. `server.stop(true)` (force) is the hardcap path only.
// Idempotent: a second signal while draining is ignored.
/**
 * @param { {
 *   appServers: Array<{ stop: (force?: boolean) => Promise<void> | void }>,
 *   metricsServer?: { stop: (force?: boolean) => Promise<void> | void },
 *   drainTasks?: () => Promise<void>,
 *   graceMs?: number,
 *   log?: (msg: string) => void,
 *   exit?: (code: number) => void,
 * } } opts
 */
export function createGracefulShutdown({
  appServers,
  metricsServer,
  drainTasks = drainPending,
  graceMs = 25_000,
  log = () => {},
  exit = (code) => process.exit(code),
}) {
  let started = false;
  return async function shutdown(signal) {
    if (started) return;
    started = true;
    log(`SIGNAL:${signal} draining (graceMs=${graceMs})`);

    const hardcap = setTimeout(() => {
      log('HARDCAP: drain exceeded grace, forcing stop');
      for (const s of appServers) {
        try {
          s.stop(true);
        } catch {
          /* already stopped */
        }
      }
      exit(1);
    }, graceMs);
    // Never let the hardcap timer itself keep the loop alive.
    if (typeof hardcap.unref === 'function') hardcap.unref();

    try {
      await Promise.all(appServers.map((s) => s.stop()));
      await drainTasks();
      // ── DO NOT REORDER: the metrics listener is stopped LAST, and that is
      // LOAD-BEARING, not cosmetic (#448). The hardcap timer above is
      // `unref()`ed, so it can only fire while something ELSE keeps the event
      // loop alive; during the drain that something is this metrics listener.
      // Stop it before the app drain / `drainTasks()` and the loop can empty,
      // bun exits before the hardcap fires, and a hung request is silently NOT
      // force-terminated within grace — the SIGTERM guarantee regresses with
      // every unit test still green. (Serving a scrape throughout the drain is
      // the second, lesser reason.) Guarded by test/sigterm-hardcap-e2e.test.ts.
      if (metricsServer) await metricsServer.stop();
      clearTimeout(hardcap);
      log('DRAINED cleanly');
      exit(0);
    } catch (err) {
      clearTimeout(hardcap);
      log(`DRAIN-ERROR ${err}`);
      exit(1);
    }
  };
}
