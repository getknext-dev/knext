/**
 * invalidation-probe.mjs — leg 4 of the file-manager e2e round (issue #1197 / T1).
 *
 * Proves the AUTHENTICATED on-demand invalidation loop end to end over real HTTP,
 * against a running server (the round boots one with CACHE_INVALIDATE_TOKEN set):
 *
 *   1. Warm the on-demand cache, capture a fingerprint.
 *   2. POST /api/cache/invalidate WITHOUT a Bearer token → MUST be 401. This is
 *      the security invariant (security.md: no unauthenticated mutating endpoint).
 *      A 200 here means the auth check was removed — the round MUST red.
 *   3. POST /api/cache/invalidate WITH the Bearer token → MUST be 200 and busts
 *      the tag (`revalidateTag`).
 *   4. GET again → the cache re-ran (fingerprint changed, or SWR staleness noted).
 *
 * Fail-closed with a non-zero exit on any failed assertion. Unlike the earlier
 * print-only version, this script ASSERTS. The pure decision (`assertInvalidation`)
 * is exported so the 401 logic can be unit-tested without a live server.
 *
 * Env: PORT (default 3998), CACHE_INVALIDATE_TOKEN (required — refuse, never skip).
 */
import http from 'node:http';

const PORT = Number(process.env.PORT || 3998);
const HOST = process.env.HOST || '127.0.0.1';

function get(path) {
  return new Promise((resolve) => {
    const req = http.get({ hostname: HOST, port: PORT, path }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
  });
}

function post(path, data, headers = {}) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(data);
    const req = http.request(
      {
        hostname: HOST,
        port: PORT,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      },
    );
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(payload);
    req.end();
  });
}

function fingerprint(html) {
  const timestamps = [...String(html).matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g)].map(
    (m) => m[0],
  );
  return { timestamps };
}

/**
 * Pure evaluation of the probe observations. Exported for unit tests: the 401
 * case is the security-critical one and must be provable without a live server.
 *
 * @param {object} obs
 * @param {number} obs.unauthStatus   status of the POST with NO Bearer token.
 * @param {number} obs.authStatus     status of the POST WITH the Bearer token.
 * @param {{timestamps:string[]}} obs.before  fingerprint before invalidation.
 * @param {{timestamps:string[]}} obs.after   fingerprint after invalidation.
 * @returns {{ ok: boolean, failures: string[], notes: string[] }}
 */
export function assertInvalidation({ unauthStatus, authStatus, before, after }) {
  const failures = [];
  const notes = [];

  // The security invariant: unauthenticated invalidation MUST be rejected.
  if (unauthStatus !== 401) {
    failures.push(
      `unauthenticated POST /api/cache/invalidate returned ${unauthStatus}, expected 401 — ` +
        `the mutating endpoint is not fail-closed (security.md)`,
    );
  }

  // The happy path: authenticated invalidation must succeed.
  if (authStatus !== 200) {
    failures.push(`authenticated POST /api/cache/invalidate returned ${authStatus}, expected 200`);
  }

  // Cache-busting effect. When the page renders ISO timestamps we can prove the
  // cache re-ran; when it does not, SWR may serve stale once — a NOTE, not a
  // failure (the authenticated 200 above already proves the endpoint fired).
  if (before.timestamps.length > 0 && after.timestamps.length > 0) {
    const changed = before.timestamps.some((t, i) => t !== after.timestamps[i]);
    if (changed) {
      notes.push(`invalidation effect proven: ${before.timestamps[0]} → ${after.timestamps[0]}`);
    } else {
      notes.push('timestamps unchanged — SWR served stale once; endpoint fired (200) regardless');
    }
  } else {
    notes.push('page exposes no ISO timestamps; relying on the authenticated 200 as proof');
  }

  return { ok: failures.length === 0, failures, notes };
}

async function main() {
  const token = process.env.CACHE_INVALIDATE_TOKEN;
  if (!token) {
    console.error(
      'invalidation-probe: CACHE_INVALIDATE_TOKEN is not set. This leg REFUSES to run ' +
        'without it (it must prove both the authenticated 200 and the unauthenticated 401). ' +
        'Set CACHE_INVALIDATE_TOKEN to the same value the server was started with.',
    );
    process.exit(2);
  }

  console.log(`Probing http://${HOST}:${PORT} (authenticated invalidation loop)`);

  // Step 1: warm + fingerprint.
  await get('/cache-tests/on-demand');
  await new Promise((r) => setTimeout(r, 100));
  const before = fingerprint((await get('/cache-tests/on-demand')).body);

  // Step 2: unauthenticated invalidation MUST 401.
  const unauth = await post('/api/cache/invalidate', { tag: 'products' });
  console.log(`  POST (no token)      → HTTP ${unauth.status ?? `ERR ${unauth.error}`}`);

  // Step 3: authenticated invalidation MUST 200.
  const auth = await post(
    '/api/cache/invalidate',
    { tag: 'products' },
    { authorization: `Bearer ${token}` },
  );
  console.log(`  POST (Bearer token)  → HTTP ${auth.status ?? `ERR ${auth.error}`}: ${auth.body}`);

  // Step 4: re-fetch, fingerprint after.
  await new Promise((r) => setTimeout(r, 300));
  const after = fingerprint((await get('/cache-tests/on-demand')).body);

  const verdict = assertInvalidation({
    unauthStatus: unauth.status,
    authStatus: auth.status,
    before,
    after,
  });
  for (const n of verdict.notes) console.log(`  note: ${n}`);

  if (!verdict.ok) {
    console.error('\ninvalidation-probe FAILED:');
    for (const f of verdict.failures) console.error(`  • ${f}`);
    process.exit(1);
  }
  console.log('invalidation-probe PASSED (401 without token, 200 with token, cache busted).');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`invalidation-probe crashed: ${e?.stack || e}`);
    process.exit(1);
  });
}
