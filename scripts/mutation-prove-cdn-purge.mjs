#!/usr/bin/env node
/**
 * Mutation proof for the CDN purge module (ADR-0068 D6, D7, D10; issue #2260).
 *
 * `workflow.md`: "a guard that stays green when its subject is removed is
 * decoration". The purge module's tests are behavioural — real HTTP against a
 * fake Cloudflare, time on an injected clock — and every control below is the
 * kind that ships green and unenforced: a bound, a cap, a refusal, a redaction.
 * So each mutation REMOVES or WEAKENS exactly one of them and requires the named
 * spec to go red.
 *
 * Verdicts are by EXIT CODE only (the shared driver, `scripts/lib/guard-prover.mjs`,
 * never parses output), anchors must occur exactly once (preflight first, so a
 * stale anchor aborts before anything runs), the baseline must be green, a canary
 * must go red before any green is trusted, and every restore is sha256-verified.
 *
 * The driver is bound to ONE spec, so there is one prover per spec over the same
 * subjects, and each mutation names the spec that must kill it.
 *
 * Usage:  node scripts/mutation-prove-cdn-purge.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = 'packages/kn-next/src/__tests__';
const SPECS = {
  main: `${TESTS}/cdn-purge.test.ts`,
  first: `${TESTS}/cdn-purge-first-ready.test.ts`,
  scan: `${TESTS}/cdn-purge-scan.test.ts`,
  tags: `${TESTS}/cdn-purge-tags.test.ts`,
};

// Each anchor runs to the end of its line, so the harness's trailing residue
// marker comments out nothing that matters.
const MUTATIONS = [
  // ── batching ──────────────────────────────────────────────────────────────
  {
    id: 'M01',
    spec: 'main',
    subject: 'rows',
    claim: 'the Cloudflare batch size grows to 101: a request can exceed the 100-tag API limit',
    anchor:
      'batchSize: 100,\n      rpm: 5,\n      bucket: 25,\n      targetPattern: /^[0-9a-fA-F]{32}$/,',
    replacement:
      'batchSize: 101,\n      rpm: 5,\n      bucket: 25,\n      targetPattern: /^[0-9a-fA-F]{32}$/,',
  },
  {
    id: 'M02',
    spec: 'main',
    subject: 'purger',
    claim: 'the batcher stops slicing: every batch carries the whole backlog',
    anchor: 'await sendBatch(c, tags.slice(i, i + c.batchSize));',
    replacement: 'await sendBatch(c, tags);',
  },
  // ── retry bound and backoff ───────────────────────────────────────────────
  {
    id: 'M03',
    spec: 'main',
    subject: 'purger',
    claim: 'the attempt bound rises from 3 to 4: a dead provider gets an extra hit',
    anchor: 'const MAX_ATTEMPTS = 3;',
    replacement: 'const MAX_ATTEMPTS = 4;',
  },
  {
    id: 'M04',
    spec: 'main',
    subject: 'purger',
    claim: 'the 5xx/network backoff schedule changes from 1 s, 2 s',
    anchor: 'const BACKOFF_MS = [1000, 2000];',
    replacement: 'const BACKOFF_MS = [1000, 1000];',
  },
  {
    id: 'M05',
    spec: 'main',
    subject: 'purger',
    claim: 'Retry-After is ignored: a 429 is retried on the generic backoff',
    anchor: "const asked = last.kind === 'ratelimited' ? last.retryAfterMs : null;",
    replacement: 'const asked = null;',
  },
  {
    id: 'M06',
    spec: 'main',
    subject: 'purger',
    claim: 'the 60 s Retry-After cap is lifted to an hour: one hostile header parks the queue',
    anchor: 'const RETRY_AFTER_CAP_MS = 60_000;',
    replacement: 'const RETRY_AFTER_CAP_MS = 3_600_000;',
  },
  {
    id: 'M07',
    spec: 'main',
    subject: 'purger',
    claim: 'a 429 stops being classified as retryable: a transient rate limit loses the purge',
    anchor:
      "if (status === 429) return { kind: 'ratelimited', status, retryAfterMs: parseRetryAfter(retryAfter, now()) };",
    replacement: '',
  },
  {
    id: 'M08',
    spec: 'main',
    subject: 'purger',
    claim: 'a 5xx stops being classified as retryable',
    anchor: "if (status >= 500) return { kind: 'retry', status };",
    replacement: '',
  },
  {
    id: 'M09',
    spec: 'main',
    subject: 'purger',
    claim: 'a final 4xx (bad token / zone) is retried instead of given up on',
    anchor: "if (last.kind === 'ok' || last.kind === 'fatal' || n === MAX_ATTEMPTS) break;",
    replacement: "if (last.kind === 'ok' || n === MAX_ATTEMPTS) break;",
  },
  {
    id: 'M10',
    spec: 'main',
    subject: 'purger',
    claim: "a 429 given up on is counted 'failed' instead of 'ratelimited'",
    anchor: "count(c.provider, last.kind === 'ratelimited' ? 'ratelimited' : 'failed');",
    replacement: "count(c.provider, 'failed');",
  },
  {
    id: 'M11',
    spec: 'main',
    subject: 'purger',
    claim: 'the per-request timeout never fires: one hung provider response wedges the queue',
    anchor: 'const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);',
    replacement: 'const timeout = setTimeout(() => {}, requestTimeoutMs);',
  },
  // ── overflow collapse ─────────────────────────────────────────────────────
  {
    id: 'M12',
    spec: 'main',
    subject: 'purger',
    claim: 'the queue never collapses: a flood becomes thousands of per-tag purges',
    anchor: 'if (pending.size > MAX_PENDING) {',
    replacement: 'if (pending.size > MAX_PENDING * 100) {',
  },
  {
    id: 'M13',
    spec: 'main',
    subject: 'purger',
    claim: 'the collapse threshold is off by one: exactly 1000 tags collapse',
    anchor: 'if (pending.size > MAX_PENDING) {',
    replacement: 'if (pending.size >= MAX_PENDING) {',
  },
  {
    id: 'M14',
    spec: 'main',
    subject: 'purger',
    claim: 'after a collapse, later tags are queued individually on top of the app-tag purge',
    anchor: '    if (collapsed) return;',
    replacement: '    if (false) return;',
  },
  {
    id: 'M15',
    spec: 'main',
    subject: 'purger',
    claim: 'duplicate tags are no longer coalesced',
    anchor: '    pending.add(encoded);',
    replacement: '    pending.add(encoded + pending.size);',
  },
  // ── rate limit ────────────────────────────────────────────────────────────
  {
    id: 'M16',
    spec: 'main',
    subject: 'purger',
    claim: 'the token bucket is bypassed: purges go out as fast as they are queued',
    anchor: '      await acquire(c);',
    replacement: '      void acquire;',
  },
  {
    id: 'M17',
    spec: 'main',
    subject: 'purger',
    claim: 'KNEXT_CDN_PURGE_RPM is ignored',
    anchor:
      'const rpm = Number.isInteger(rpmRaw) && rpmRaw >= 1 && rpmRaw <= 6000 ? rpmRaw : spec.rpm;',
    replacement: 'const rpm = spec.rpm;',
  },
  {
    id: 'M18',
    spec: 'main',
    subject: 'purger',
    claim: 'an absurd RPM is accepted: the limiter is disabled by a typo',
    anchor:
      'const rpm = Number.isInteger(rpmRaw) && rpmRaw >= 1 && rpmRaw <= 6000 ? rpmRaw : spec.rpm;',
    replacement: 'const rpm = rpmRaw > 0 ? rpmRaw : spec.rpm;',
  },
  // ── credential: fail closed, never leaked ─────────────────────────────────
  {
    id: 'M19',
    spec: 'main',
    subject: 'purger',
    claim: 'a missing token no longer stops the purge: an unauthenticated call goes out',
    anchor: "if (!TOKEN_PATTERN.test(raw)) return { state: 'no_credential', provider: row.name };",
    replacement: '',
  },
  {
    id: 'M20',
    spec: 'main',
    subject: 'purger',
    claim: 'any string counts as a token: control characters and blanks are sent',
    anchor: 'const TOKEN_PATTERN = /^[\\x21-\\x7e]+$/;',
    replacement: 'const TOKEN_PATTERN = /^[\\s\\S]*$/;',
  },
  {
    id: 'M21',
    spec: 'main',
    subject: 'purger',
    claim: 'the missing-credential line is logged on every call instead of once',
    anchor: '    if (saidOnce.has(key)) return;',
    replacement: '',
  },
  {
    id: 'M22',
    spec: 'main',
    subject: 'purger',
    claim: 'the failure log line carries the bearer token',
    anchor:
      "say('warn', `purge gave up: provider=${c.provider} ${what} tags=${batch.length} attempts=${attempts}; stale until the edge TTL`);",
    replacement:
      "say('warn', `purge gave up: provider=${c.provider} ${what} tags=${batch.length} attempts=${attempts}; stale until the edge TTL ${c.bearer()}`);",
  },
  {
    id: 'M23',
    spec: 'main',
    subject: 'purger',
    claim: 'a network error is reported with its message (which can embed request details)',
    anchor: "return { kind: 'retry', reason: safeErrorName(err) };",
    replacement: "return { kind: 'retry', reason: String(err?.message) };",
  },
  {
    id: 'M24',
    spec: 'main',
    subject: 'purger',
    claim: 'the emulator row sends the user token instead of the fixed dummy',
    anchor: '    token = EMULATOR_DUMMY_TOKEN;',
    replacement: "    token = (env.KNEXT_CDN_PURGE_TOKEN ?? '').trim() || EMULATOR_DUMMY_TOKEN;",
  },
  {
    id: 'M25',
    spec: 'main',
    subject: 'purger',
    claim: 'a throwing logger can reach the request path',
    anchor: '    try {\n      log[level](`[CdnPurge] ${message}`);\n    } catch {}',
    replacement: '    log[level](`[CdnPurge] ${message}`);',
  },
  {
    id: 'M26',
    spec: 'main',
    subject: 'purger',
    claim: 'a throwing metrics sink can reach the request path',
    anchor: '    try {\n      metrics.inc(PURGE_METRIC, { provider, result });\n    } catch {}',
    replacement: '    metrics.inc(PURGE_METRIC, { provider, result });',
  },
  // ── SSRF ──────────────────────────────────────────────────────────────────
  {
    id: 'M27',
    spec: 'main',
    subject: 'rows',
    claim: 'the *.svc.cluster.local suffix check is removed: the emulator endpoint can be any host',
    anchor: 'if (!host.endsWith(CLUSTER_LOCAL_SUFFIX)) return null;',
    replacement: '',
  },
  {
    id: 'M28',
    spec: 'main',
    subject: 'rows',
    claim: 'userinfo is tolerated in the emulator endpoint',
    anchor: "if (url.username !== '' || url.password !== '') return null;",
    replacement: '',
  },
  {
    id: 'M29',
    spec: 'main',
    subject: 'rows',
    claim: 'a path is tolerated in the emulator endpoint',
    anchor: "if (url.pathname !== '/') return null;",
    replacement: '',
  },
  {
    id: 'M30',
    spec: 'main',
    subject: 'rows',
    claim: 'the real Cloudflare base becomes overridable from the environment',
    anchor: 'base: () => API_BASE_CLOUDFLARE,',
    replacement: 'base: (env) => env.KNEXT_CDN_EMULATOR_ENDPOINT ?? API_BASE_CLOUDFLARE,',
  },
  {
    id: 'M31',
    spec: 'main',
    subject: 'purger',
    claim: 'redirects are followed: the Authorization header can chase a Location to another host',
    anchor: "redirect: 'manual',",
    replacement: "redirect: 'follow',",
  },
  {
    id: 'M32',
    spec: 'main',
    subject: 'purger',
    claim: 'the Cloudflare zone id is no longer validated: a crafted target reshapes the URL path',
    anchor: 'if (!spec.targetPattern.test(target)) {',
    replacement: 'if (false) {',
  },
  {
    id: 'M33',
    spec: 'main',
    subject: 'purger',
    claim: 'the tag prefix is no longer validated: an old operator yields tags that purge nothing',
    anchor: 'if (!PREFIX_PATTERN.test(prefix)) {',
    replacement: 'if (false) {',
  },
  {
    id: 'M34',
    spec: 'main',
    subject: 'rows',
    claim:
      'a deferred provider row is given a purge endpoint: signer-only providers get an unsigned call',
    anchor: "'google-cloud-cdn': Object.freeze({ name: 'google-cloud-cdn', purge: null }),",
    replacement:
      "'google-cloud-cdn': Object.freeze({ name: 'google-cloud-cdn', purge: { batchSize: 100, rpm: 5, bucket: 25, targetPattern: /^[0-9a-fA-F]{32}$/, credential: 'env', base: () => 'https://deferred.invalid/v1' } }),",
  },
  // ── request shape ─────────────────────────────────────────────────────────
  {
    id: 'M35',
    spec: 'main',
    subject: 'purger',
    claim: 'the Authorization header loses the Bearer scheme',
    anchor:
      "headers: { authorization: `Bearer ${c.bearer()}`, 'content-type': 'application/json' },",
    replacement: "headers: { authorization: c.bearer(), 'content-type': 'application/json' },",
  },
  {
    id: 'M36',
    spec: 'main',
    subject: 'purger',
    claim: 'the body is a bare array instead of {tags}',
    anchor: 'body: JSON.stringify({ tags: batch }),',
    replacement: 'body: JSON.stringify(batch),',
  },
  {
    id: 'M37',
    spec: 'main',
    subject: 'purger',
    claim:
      'Next tags are sent raw instead of hashed: the purge no longer matches the emitted Cache-Tag',
    anchor: 'for (const tag of list) add(c, nextTag(c.prefix, tag));',
    replacement: 'for (const tag of list) add(c, tag);',
  },
  // ── non-blocking + drain ──────────────────────────────────────────────────
  {
    id: 'M38',
    spec: 'main',
    subject: 'purger',
    claim: 'the pending purge is no longer enrolled in the SIGTERM drain registry',
    anchor: '    trackWrite(promise);',
    replacement: '    void promise;',
  },
  {
    id: 'M39',
    spec: 'main',
    subject: 'purger',
    claim: 'a tag waiting in the coalescing window is not tracked until it is sent',
    anchor: 'function schedule(c) {\n    track();',
    replacement: 'function schedule(c) {',
  },
  // ── first-ready purge ─────────────────────────────────────────────────────
  {
    id: 'M40',
    spec: 'first',
    subject: 'purger',
    claim: 'the native-client claim drops NX: every pod wins and purges',
    anchor:
      "reply = await client.send('SET', [key, '1', 'NX', 'EX', String(FIRST_READY_TTL_SECONDS)]);",
    replacement:
      "reply = await client.send('SET', [key, '1', 'EX', String(FIRST_READY_TTL_SECONDS)]);",
  },
  {
    id: 'M41',
    spec: 'first',
    subject: 'purger',
    claim: 'the ioredis claim drops NX: every pod wins and purges',
    anchor: "reply = await client.set(key, '1', 'EX', FIRST_READY_TTL_SECONDS, 'NX');",
    replacement: "reply = await client.set(key, '1', 'EX', FIRST_READY_TTL_SECONDS);",
  },
  {
    id: 'M42',
    spec: 'first',
    subject: 'purger',
    claim: 'the claim key loses the app prefix: two apps sharing one Redis suppress each other',
    anchor: '`knext:cdn:purged:${c.prefix}:${buildId}`',
    replacement: '`knext:cdn:purged:${buildId}`',
  },
  {
    id: 'M43',
    spec: 'first',
    subject: 'purger',
    claim: 'the winner purges its build tag instead of the whole app tag',
    anchor:
      '        add(c, appTag(c.prefix));\n        schedule(c);\n        return { purged: true };',
    replacement:
      '        add(c, nextTag(c.prefix, buildId));\n        schedule(c);\n        return { purged: true };',
  },
  {
    id: 'M44',
    spec: 'first',
    subject: 'purger',
    claim: 'the once-per-process guard is gone: every call hits Redis again',
    anchor: "if (attempted.has(buildId)) return { purged: false, reason: 'already_attempted' };",
    replacement: '',
  },
  {
    id: 'M45',
    spec: 'first',
    subject: 'purger',
    claim: 'a Redis failure is reported as a win: the pod would purge without the dedup',
    anchor: "return { purged: false, reason: 'redis_error' };",
    replacement: "return { purged: true, reason: 'redis_error' };",
  },
  {
    id: 'M46',
    spec: 'first',
    subject: 'purger',
    claim: 'a pod that cannot purge (no credential) still burns the one-per-build claim',
    anchor:
      "if (c.state !== 'ready') return { purged: false, reason: skip(c) };\n        if (typeof buildId",
    replacement:
      "if (c.state === 'disabled') return { purged: false, reason: 'disabled' };\n        if (typeof buildId",
  },
  // ── tags ──────────────────────────────────────────────────────────────────
  {
    id: 'M47',
    spec: 'tags',
    subject: 'tags',
    claim: 'the Next-tag hash is cut to the wrong length',
    anchor: 'return `kn-${prefix}-t${sha256hex(tag).slice(0, 16)}`;',
    replacement: 'return `kn-${prefix}-t${sha256hex(tag).slice(0, 12)}`;',
  },
  // ── no new dependency / route ─────────────────────────────────────────────
  {
    id: 'M48',
    spec: 'scan',
    subject: 'purger',
    claim: 'the purger imports a third-party package (a cloud SDK in disguise)',
    anchor: "import { trackWrite } from '../cache-write-registry.js';",
    replacement:
      "import { trackWrite } from '../cache-write-registry.js';\nimport aws from 'aws-sdk';\nvoid aws;",
  },
  {
    id: 'M49',
    spec: 'scan',
    subject: 'purger',
    claim: 'the purger opens an inbound listener',
    anchor: "import { trackWrite } from '../cache-write-registry.js';",
    replacement:
      "import { trackWrite } from '../cache-write-registry.js';\nimport { createServer } from 'node:http';\nvoid createServer;",
  },
];

// The driver is bound to one spec, so one prover per spec over the same subjects.
const makeProver = (spec) =>
  createGuardProver({
    repoRoot: REPO_ROOT,
    spec,
    subjects: {
      purger: 'packages/kn-next/src/adapters/cdn-purge/purger.js',
      rows: 'packages/kn-next/src/adapters/cdn-purge/rows.js',
      tags: 'packages/kn-next/src/adapters/cdn-purge/tags.js',
    },
  });
const provers = Object.fromEntries(
  Object.entries(SPECS).map(([name, spec]) => [name, makeProver(spec)]),
);

console.log('=== mutation proof: CDN purge module (ADR-0068 D6/D7/D10) ===');
provers.main.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
for (const p of Object.values(provers)) p.baseline();
provers.main.proveCanSeeRed({
  subject: 'purger',
  anchor: 'body: JSON.stringify({ tags: batch }),',
  replacement: 'body: JSON.stringify({ tags: [] }),',
});

console.log('\n=== mutations ===');
for (const m of MUTATIONS) {
  provers[m.spec].run({ ...m, expect: 'red' });
  recordMutation();
}
// Each prover counted only its own runs; the declared total is checked once, here.
for (const [name, p] of Object.entries(provers)) {
  p.finish(MUTATIONS.filter((m) => m.spec === name).length);
}
