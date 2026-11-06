#!/usr/bin/env node

/**
 * Scope the ref-pinned per-case deselections to the ref under test (ADR-0007 amendment 2026-11-04,
 * bar 1, enforced at RUN time).
 *
 *   node scripts/compat-manifest-for-ref.mjs --manifest <path> --ref <vX.Y.Z> --out <path>
 *     [--runtime <node|bun>] [--builder <turbopack|webpack|vinext>] [--bun-version <X.Y.Z>]
 *
 * Next's `get-test-filter.js` turns `suites[file].failed` into a jest deselection and knows nothing
 * about refs. So a per-case entry measured at one ref would deselect cases at every other ref, where
 * nobody measured them. This writes a COPY of the manifest in which each `$knextRefPinnedCases` entry
 * whose `nextjsRef` differs from `--ref` has its recorded names removed from `suites[file].failed`:
 * at any other ref those cases RUN. Nothing else changes (include, exclude, flakey, the upstream
 * mirror, the ledger itself). `$knextRefPinnedScope` records what was kept and dropped.
 *
 * It then applies the upstream-runtime-defect ledger (ADR-0007 amendment 2026-11-05,
 * scripts/lib/upstream-runtime-defects.mjs) only when the lane under test (`--runtime`/`--builder`,
 * else the workflow-level `KNEXT_RUNTIME`/`KNEXT_BUILDER` every step inherits) is the entry's lane,
 * the ref is its ref, and on Bun the Bun under test (`--bun-version`, else `bun --version`) is its
 * Bun. A whole-file entry ADDS its file to `rules.exclude` (a one-case file deselected by name would
 * run nothing and be credited as passed); a partial one adds its names to `suites[file].failed`.
 * `$knextUpstreamRuntimeDefectScope` records what was applied, how, and what was skipped.
 *
 * FAIL CLOSED. A missing or unparseable ref, an unreadable manifest, a ledger that is not an array,
 * an entry with no parseable ref, a non-empty upstream-runtime-defect ledger on an unknown lane, or a
 * matching Bun entry whose Bun cannot be read all exit non-zero, and the output file is removed first, so a
 * failed run can never leave a copy that still deselects. A step that "succeeded" with a stale copy
 * on disk is exactly the silent bypass this exists to prevent.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { caseName, REF_SHAPE } from './lib/ref-pinned-cases.mjs';
import {
  applyUpstreamRuntimeDefects,
  UPSTREAM_RUNTIME_DEFECT_SCOPE_KEY,
} from './lib/upstream-runtime-defects.mjs';

/** A release tag, optionally a prerelease. Anything else (a branch, a sha, empty) is refused. */
export const SCOPE_REF_SHAPE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export class ScopeError extends Error {}

/**
 * @param {object} manifest parsed deploy-tests manifest
 * @param {string} ref      the NEXTJS_REF under test
 * @returns {object} a scoped deep copy
 */
export function scopeManifestToRef(manifest, ref) {
  if (typeof ref !== 'string' || !SCOPE_REF_SHAPE.test(ref)) {
    throw new ScopeError(`--ref must be a release tag like v16.4.3, got ${JSON.stringify(ref)}`);
  }
  const out = JSON.parse(JSON.stringify(manifest));
  const ledger = out.$knextRefPinnedCases;
  if (ledger === undefined) return out;
  if (!Array.isArray(ledger)) throw new ScopeError('$knextRefPinnedCases must be an array');

  const applied = [];
  const dropped = [];
  for (const e of ledger) {
    if (typeof e?.test !== 'string') throw new ScopeError('a ledger entry has no "test"');
    if (typeof e.nextjsRef !== 'string' || !REF_SHAPE.test(e.nextjsRef)) {
      throw new ScopeError(`${e.test}: ledger entry has no parseable nextjsRef`);
    }
    if (!Array.isArray(e.cases)) throw new ScopeError(`${e.test}: ledger entry has no cases`);
    if (e.nextjsRef === ref) {
      applied.push(e.test);
      continue;
    }
    dropped.push(e.test);
    const suite = out.suites?.[e.test];
    if (!suite?.failed) continue;
    const gone = new Set(e.cases.map(caseName));
    const kept = suite.failed.filter((n) => !gone.has(n));
    if (kept.length > 0) suite.failed = kept;
    else delete suite.failed;
    if (Object.keys(suite).length === 0) delete out.suites[e.test];
  }
  out.$knextRefPinnedScope = { ref, applied, dropped };
  return out;
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

/** The Bun under test, as `bun --version` prints it, or '' when it cannot be read. */
function observedBunVersion() {
  const r = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout).trim() : '';
}

function main(argv) {
  const manifestPath = arg(argv, 'manifest');
  const outPath = arg(argv, 'out');
  if (!manifestPath || !outPath) {
    console.error('compat-manifest-for-ref: --manifest and --out are required');
    return 2;
  }
  // Remove any stale copy FIRST: a failure below must leave nothing the harness could read.
  rmSync(outPath, { force: true });
  try {
    const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'));
    const ref = arg(argv, 'ref');
    const scoped = scopeManifestToRef(manifest, ref);
    const flagBun = arg(argv, 'bun-version');
    applyUpstreamRuntimeDefects(scoped, {
      ref,
      runtime: arg(argv, 'runtime') ?? process.env.KNEXT_RUNTIME,
      builder: arg(argv, 'builder') ?? process.env.KNEXT_BUILDER,
      bunVersion: () => flagBun ?? observedBunVersion(),
    });
    writeFileSync(outPath, `${JSON.stringify(scoped, null, 2)}\n`);
    const s = scoped.$knextRefPinnedScope;
    console.log(
      s
        ? `ref-pinned deselections scoped to ${s.ref}: ${s.applied.length} file(s) applied, ${s.dropped.length} dropped (those cases run)`
        : `no ref-pinned ledger in ${manifestPath}; manifest copied unchanged`,
    );
    const d = scoped[UPSTREAM_RUNTIME_DEFECT_SCOPE_KEY];
    if (d) {
      const files = d.applied.filter((a) => a.as === 'exclude').length;
      console.log(
        `upstream-runtime defects on ${d.lane} at ${d.ref}: ${d.applied.length} applied (${files} files excluded, ${d.applied.length - files} by case), ${d.skipped.length} skipped (those cases run)${d.bunVersion ? `; bun ${d.bunVersion}` : ''}`,
      );
    }
    return 0;
  } catch (err) {
    console.error(`compat-manifest-for-ref: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv));
}
