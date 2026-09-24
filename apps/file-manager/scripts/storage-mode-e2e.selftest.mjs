#!/usr/bin/env node
/**
 * storage-mode-e2e.selftest.mjs — proves the storage-mode leg can go RED (#1292).
 *
 * Same doctrine as `platform-e2e.selftest.mjs`: a guard that stays green when
 * its subject is removed is decoration. This exercises the exact assertion
 * functions the live leg calls (`storage-mode-checks.mjs`) against synthetic
 * fixtures, no cluster needed — first a HEALTHY fixture (every check must
 * pass, otherwise "red" below proves nothing), then once per defect class
 * that reproduces what an image built WITHOUT ASSET_PREFIX/NEXT_DEPLOYMENT_ID
 * would serve.
 *
 * Exit-code based, not an output grep: every expectation increments `failures`
 * on a wrong result and the script exits non-zero if any did. No text mutation
 * of a fixture file is involved (nothing here shells out to `perl`/`sed`) —
 * every defect is a literal, distinct fixture object.
 *
 * Run: node scripts/storage-mode-e2e.selftest.mjs
 */
import assert from 'node:assert/strict';
import {
  assertAssetPrefixReferenced,
  assertAssetUrlsServeOk,
  assertBuildIdMatchesTag,
  extractBucketAssetRefs,
} from './storage-mode-checks.mjs';

const BUCKET_URL = 'http://minio.fm-e2e.svc.cluster.local:9000/fm-e2e-storage-assets';
const NAME = 'file-manager-storage';
const TAG = 'run123-storage';
const PREFIX = `${BUCKET_URL}/${NAME}/`;

/**
 * HTML an image built WITH the fix serves: every asset under the bucket
 * prefix, all sharing the same `<buildId>` segment (`_next/static/<buildId>/`,
 * per `asset-upload.ts`'s `STATIC_NS` + `buildId` upload shape).
 */
function healthyHtml() {
  return (
    '<html><head>' +
    `<link rel="stylesheet" href="${PREFIX}_next/static/${TAG}/css/a.css">` +
    `<script src="${PREFIX}_next/static/${TAG}/chunk.js"></script>` +
    '</head><body>ok</body></html>'
  );
}

/**
 * HTML an image built WITHOUT ASSET_PREFIX serves: `next start` semantics,
 * every asset is an image-local RELATIVE path — the exact #1283 regression.
 */
function noAssetPrefixHtml() {
  return (
    '<html><head>' +
    '<link rel="stylesheet" href="/_next/static/css/a.css">' +
    `<script src="/_next/static/${TAG}/chunk.js"></script>` +
    '</head><body>ok</body></html>'
  );
}

/** HTML built WITH ASSET_PREFIX but WITHOUT NEXT_DEPLOYMENT_ID: bucket prefix present, wrong/default build id. */
function wrongBuildIdHtml() {
  return (
    '<html><head>' +
    `<link rel="stylesheet" href="${PREFIX}_next/static/css/a.css">` +
    `<script src="${PREFIX}_next/static/development/chunk.js"></script>` +
    '</head><body>ok</body></html>'
  );
}

let failures = 0;
/** @param {string} label @param {boolean} ok @param {string} [why] */
function report(label, ok, why = '') {
  console.log(`${ok ? 'ok  ' : 'BAD '} ${label}${why ? ` — ${why}` : ''}`);
  if (!ok) failures++;
}

/** @param {string} label @param {() => unknown} fn */
function mustPass(label, fn) {
  try {
    fn();
    report(label, true);
  } catch (e) {
    report(label, false, String(e instanceof Error ? e.message : e));
  }
}

/** @param {string} label @param {() => unknown} fn */
function mustThrow(label, fn) {
  let caught = false;
  try {
    fn();
  } catch {
    caught = true;
  }
  report(`RED on: ${label}`, caught, caught ? '' : 'stayed green');
}

// ── healthy fixture: every check must pass ──────────────────────────────────
/** @type {ReturnType<typeof assertAssetPrefixReferenced>} */
let healthyRefs;
mustPass('healthy HTML: asset prefix referenced', () => {
  healthyRefs = assertAssetPrefixReferenced({
    html: healthyHtml(),
    bucketUrl: BUCKET_URL,
    name: NAME,
  });
  assert.ok(healthyRefs.refs.length >= 2, 'expected both refs to match the bucket prefix');
});
mustPass('healthy HTML: build id matches the deploy tag', () => {
  assertBuildIdMatchesTag({ refs: healthyRefs.refs, tag: TAG });
});

await (async () => {
  try {
    const evidence = await assertAssetUrlsServeOk({
      urls: healthyRefs.refs,
      fetchOne: async (url) => ({
        status: 200,
        headers: { 'content-type': url.endsWith('.css') ? 'text/css' : 'text/javascript' },
      }),
    });
    report('healthy HTML: bucket urls serve 200 with correct content-type', true, evidence);
  } catch (e) {
    report(
      'healthy HTML: bucket urls serve 200 with correct content-type',
      false,
      String(e instanceof Error ? e.message : e),
    );
  }
})();

// ── defects: each must make its check throw ─────────────────────────────────
mustThrow('image built without ASSET_PREFIX (relative asset paths served)', () => {
  assertAssetPrefixReferenced({ html: noAssetPrefixHtml(), bucketUrl: BUCKET_URL, name: NAME });
});

mustThrow('image built without NEXT_DEPLOYMENT_ID (build id != deploy tag)', () => {
  const { refs } = assertAssetPrefixReferenced({
    html: wrongBuildIdHtml(),
    bucketUrl: BUCKET_URL,
    name: NAME,
  });
  assertBuildIdMatchesTag({ refs, tag: TAG });
});

await (async () => {
  let caught = false;
  try {
    await assertAssetUrlsServeOk({
      urls: [`${PREFIX}_next/static/${TAG}/chunk.js`],
      fetchOne: async () => ({ status: 403, headers: {} }),
    });
  } catch {
    caught = true;
  }
  report('RED on: bucket object is not reachable (403/404)', caught, caught ? '' : 'stayed green');
})();

await (async () => {
  let caught = false;
  try {
    await assertAssetUrlsServeOk({
      urls: [`${PREFIX}_next/static/${TAG}/chunk.js`],
      fetchOne: async () => ({
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      }),
    });
  } catch {
    caught = true;
  }
  report(
    'RED on: bucket object served with the wrong content-type',
    caught,
    caught ? '' : 'stayed green',
  );
})();

mustPass(
  'extractBucketAssetRefs finds nothing when no prefix is present (no false positives)',
  () => {
    const refs = extractBucketAssetRefs('<html><body>no assets here</body></html>', PREFIX);
    assert.equal(refs.length, 0, `expected no matches, got ${JSON.stringify(refs)}`);
  },
);

assert.equal(failures, 0, `${failures} storage-mode selftest expectation(s) failed`);
console.log(
  'storage-mode-e2e selftest: every check passes when healthy and goes red on each defect',
);
