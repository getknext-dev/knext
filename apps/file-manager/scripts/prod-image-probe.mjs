#!/usr/bin/env node
/**
 * knext prod-image-probe — STRICT next/image optimization verification against the
 * SHIPPED Alpine production Docker image (issue #66, AC#2 + AC#3).
 *
 * Unlike compat-smoke check 'g' (which `skip()`s on any non-200 so a CI without a
 * storage bucket stays green), this probe is INTENTIONALLY fail-closed. It is meant
 * to run ONLY against the production container built from apps/file-manager/Dockerfile,
 * where the optimizer MUST be active (sharp's musl runtime present). If the optimizer
 * is broken, this probe FAILS the job — that is the whole point.
 *
 * It does NOT boot a server itself — it probes an already-running container at
 * BASE_URL (default http://127.0.0.1:3000). The CI job is responsible for `docker run`.
 *
 * Strict success requires ALL of:
 *   1. HTTP 200 from /_next/image?url=...&w=...&q=...
 *   2. response content-type is image/webp OR image/avif (modern format negotiated)
 *   3. the optimized body is SMALLER than the source image bytes
 *
 * Env knobs:
 *   BASE_URL    base of the running container (default http://127.0.0.1:3000)
 *   IMAGE_ASSET public asset to optimize (default /knext-optimize-fixture.png)
 *   WIDTH       requested width (default 256)
 *   QUALITY     requested quality (default 75)
 *   READY_TIMEOUT_MS  how long to wait for the container to answer (default 90000)
 */
import assert from 'node:assert';
import http from 'node:http';
import https from 'node:https';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const IMAGE_ASSET = process.env.IMAGE_ASSET || '/knext-optimize-fixture.png';
const WIDTH = Number(process.env.WIDTH || 256);
const QUALITY = Number(process.env.QUALITY || 75);
const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS || 90000);

function get(urlStr, { accept } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = {};
    if (accept) headers.Accept = accept;
    const req = lib.get(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, bytes: buf.length });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('request timeout')));
  });
}

async function waitForReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastErr = 'no response';
  while (Date.now() < deadline) {
    try {
      const res = await get(`${BASE_URL}/api/health`);
      if (res.status > 0) return true;
    } catch (err) {
      lastErr = err && err.message ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`container never became ready at ${BASE_URL} (${lastErr})`);
}

async function main() {
  console.log(`[prod-image-probe] target=${BASE_URL} asset=${IMAGE_ASSET} w=${WIDTH} q=${QUALITY}`);
  await waitForReady();

  // Source size: fetch the raw public asset (no optimization).
  const source = await get(`${BASE_URL}${IMAGE_ASSET}`);
  assert.strictEqual(
    source.status,
    200,
    `source asset ${IMAGE_ASSET} not served (status ${source.status}); cannot verify optimization`,
  );
  assert.ok(source.bytes > 0, `source asset is empty (${source.bytes} bytes)`);
  console.log(`[prod-image-probe] source bytes=${source.bytes}`);

  // Optimized request. Accept header advertises avif+webp so the optimizer negotiates a modern format.
  const optimizedUrl = `${BASE_URL}/_next/image?url=${encodeURIComponent(IMAGE_ASSET)}&w=${WIDTH}&q=${QUALITY}`;
  const opt = await get(optimizedUrl, { accept: 'image/avif,image/webp,*/*' });

  // (1) HTTP 200 — NOT skipped. A broken optimizer (missing sharp musl runtime) typically 500s here.
  assert.strictEqual(
    opt.status,
    200,
    `optimizer returned ${opt.status} (expected 200). The next/image optimizer is NOT working in the production image — likely sharp's musl/vips runtime is missing.`,
  );

  // (2) modern format negotiated.
  const ct = String(opt.headers['content-type'] || '');
  assert.ok(
    ct === 'image/webp' || ct === 'image/avif',
    `optimizer content-type was "${ct}"; expected image/webp or image/avif (modern format negotiation failed)`,
  );

  // (3) optimized body strictly smaller than the source bytes.
  assert.ok(
    opt.bytes < source.bytes,
    `optimized body (${opt.bytes}B) is NOT smaller than source (${source.bytes}B); the image was not actually re-encoded/optimized`,
  );

  console.log(
    `[prod-image-probe] PASS  status=200 content-type=${ct} optimized=${opt.bytes}B < source=${source.bytes}B`,
  );
}

main().catch((err) => {
  console.error(`[prod-image-probe] FAIL: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
