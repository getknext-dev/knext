#!/usr/bin/env node
/**
 * scripts/crd-schema-diff.mjs — CI guard (#1670): structurally diff the
 * generated `NextApp` CRD's OpenAPI schema against the same file at the last
 * `v*` tag, enforcing the additive-only discipline ADR-0017 Amendment 2 §2.1
 * documents ("Within `v1alpha1`, `NextApp` schema changes are additive-only").
 *
 * WHAT THIS ENFORCES (via `scripts/lib/crd-schema-diff.mjs`): no removed
 * fields, no type changes, no new required fields, no narrowed enums or
 * validation constraints (minLength/maxLength/minimum/maximum/minItems/
 * maxItems/minProperties/maxProperties/pattern), no served CRD version
 * dropped entirely. Adding a new optional field, widening a bound, or adding
 * an enum value is always allowed.
 *
 * SCOPE: this diffs `packages/kn-next-operator/config/crd/bases/
 * apps.kn-next.dev_nextapps.yaml` — the generated CRD manifest — not
 * `api/v1alpha1/nextapp_types.go`. The generated CRD is what a cluster
 * actually validates against; the Go type is upstream of it (`make
 * manifests`) and is not independently versioned.
 *
 * USAGE
 * -----
 *   node scripts/crd-schema-diff.mjs [--base-ref <ref>]
 *
 * Without `--base-ref`, the base is the most recent `v*` tag reachable by
 * `git tag --list 'v*' --sort=-v:refname` (i.e. the highest by semver-ish
 * sort — matches how `docs/adr/0020-*.md`'s release tooling already orders
 * tags). Exits 0 when the new schema is a strict additive superset of the
 * base schema's; exits 1 and prints every violation otherwise. A base ref
 * that resolves to NO reachable `v*` tag FAILS CLOSED when `CI` is set (a
 * shallow or tagless checkout would otherwise silently skip the check; fix
 * with fetch-depth: 0 + fetch-tags: true). Outside CI it warns and passes.
 * Set CRD_DIFF_ALLOW_NO_BASELINE=1 to deliberately opt out for a branch that
 * truly predates the first tag. A base ref that IS named but whose CRD file
 * does not exist there (a pre-CRD tag) is likewise nothing-to-compare and
 * passes, rather than failing closed on a file that legitimately did not
 * exist yet.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { applyWaivers, diffCrd, validateWaiverEntry } from './lib/crd-schema-diff.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

export const CRD_PATH = 'packages/kn-next-operator/config/crd/bases/apps.kn-next.dev_nextapps.yaml';

/**
 * Narrowing waivers (ADR-0017 Amendment 3): exact, dated, justified,
 * single-use entries, each letting ONE violation string through. The rules for
 * an entry live in `validateWaiverEntry` / `applyWaivers`
 * (scripts/lib/crd-schema-diff.mjs).
 */
export const WAIVERS_PATH = 'scripts/crd-narrowing-waivers.json';

/** Read the waiver file; a missing file is "no waivers". */
export function readWaivers(readFileSyncFn = readFileSync) {
  let content;
  try {
    content = readFileSyncFn(resolve(repoRoot, WAIVERS_PATH), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { waivers: [] };
    throw err;
  }
  return JSON.parse(content);
}

/**
 * Highest `v*` tag REACHABLE FROM HEAD (`--merged HEAD`), or null. Release-line filter (ADR-0063): `v1.3.0-rc.*` tags live on integration/v1.3, whose CRD has fields main lacks; a tag on a line HEAD does not descend from must never be the baseline.
 * @param {typeof execFileSync} [execFileSyncFn]
 * @param {string} [cwd] directory whose HEAD defines reachability (default: this repo)
 * @returns {string | null}
 */
export function resolveLatestVTag(execFileSyncFn = execFileSync, cwd = repoRoot) {
  let output;
  try {
    output = execFileSyncFn(
      'git',
      ['tag', '--list', 'v*', '--merged', 'HEAD', '--sort=-v:refname'],
      {
        cwd,
        encoding: 'utf8',
      },
    );
  } catch (err) {
    throw new Error(`failed to list git tags: ${err.message}`);
  }
  const tags = output
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return tags[0] ?? null;
}

/**
 * Read+parse the CRD YAML at `path` as it existed at `ref`. Returns `null`
 * (not a throw) when the file did not exist at that ref — a legitimate
 * "nothing to compare" state, distinguished from a git failure that IS an
 * error (a bad ref, a shallow checkout missing the tag's history).
 */
export function readCrdAtRef(ref, path, execFileSyncFn = execFileSync) {
  let content;
  try {
    content = execFileSyncFn('git', ['show', `${ref}:${path}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } catch (err) {
    const message = String(err.stderr ?? err.message ?? '');
    if (/does not exist|exists on disk, but not in/i.test(message)) {
      return null;
    }
    throw new Error(`failed to read ${path} at ${ref}: ${message.trim() || err.message}`);
  }
  return parse(content);
}

/** Read+parse the CRD YAML from the current working tree. */
export function readCrdFromDisk(path, readFileSyncFn = readFileSync) {
  const content = readFileSyncFn(resolve(repoRoot, path), 'utf8');
  return parse(content);
}

function parseArgs(argv) {
  const opts = { crdPath: CRD_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-ref') opts.baseRef = argv[++i];
    else if (arg === '--crd-path') opts.crdPath = argv[++i];
    else throw new Error(`unrecognized argument: ${arg}`);
  }
  return opts;
}

export function run(
  argv,
  {
    log = console.log,
    execFileSyncFn = execFileSync,
    readFileSyncFn = readFileSync,
    resolveLatestVTagFn = resolveLatestVTag,
    env = process.env,
    // A caller that fakes the CRD read and passes no waiver reader gets no
    // waivers: the repo's real waiver file names real violations, which a
    // fabricated CRD pair would report as stale.
    readWaiversFn = readFileSyncFn === readFileSync ? () => readWaivers() : () => ({ waivers: [] }),
    fileExistsFn = (p) => existsSync(resolve(repoRoot, p)),
  } = {},
) {
  const opts = parseArgs(argv);
  const baseRef = opts.baseRef ?? resolveLatestVTagFn(execFileSyncFn);

  if (!baseRef) {
    if (env.CRD_DIFF_ALLOW_NO_BASELINE === '1') {
      log(
        '[crd-schema-diff] no v* tag reachable from HEAD — CRD_DIFF_ALLOW_NO_BASELINE=1, passing.',
      );
      return 0;
    }
    if (env.CI) {
      log(
        '[crd-schema-diff] FAIL: no v* tag is reachable from HEAD, so there is no baseline to ' +
          'diff against. Likely cause: a shallow clone or missing tags — check out with ' +
          '`fetch-depth: 0` and `fetch-tags: true`. If this branch truly predates the first ' +
          'tag, set CRD_DIFF_ALLOW_NO_BASELINE=1 deliberately.',
      );
      return 1;
    }
    log(
      '[crd-schema-diff] WARNING: no v* tag found — nothing to compare against, passing locally. ' +
        'CI fails closed here.',
    );
    return 0;
  }

  const oldCrd = readCrdAtRef(baseRef, opts.crdPath, execFileSyncFn);
  if (oldCrd === null) {
    log(
      `[crd-schema-diff] ${opts.crdPath} did not exist at ${baseRef} — nothing to compare against, passing.`,
    );
    return 0;
  }

  const newCrd = readCrdFromDisk(opts.crdPath, readFileSyncFn);

  const result = diffCrd(oldCrd, newCrd);

  // Waivers apply to the NextApp CRD only — they name its violation strings.
  const waivers = opts.crdPath === CRD_PATH ? (readWaiversFn()?.waivers ?? []) : [];
  const invalid = [];
  for (const [i, entry] of waivers.entries()) {
    for (const problem of validateWaiverEntry(entry, fileExistsFn)) {
      invalid.push(`invalid waiver #${i + 1} in ${WAIVERS_PATH}: ${problem}`);
    }
  }
  if (invalid.length > 0) {
    log(`[crd-schema-diff] FAIL: ${invalid.length} problem(s) in ${WAIVERS_PATH}:`);
    for (const p of invalid) log(`  - ${p}`);
    return 1;
  }
  const { waived, remaining, stale } = applyWaivers(result.violations, waivers);

  let failed = false;
  if (remaining.length > 0) {
    failed = true;
    log(
      `[crd-schema-diff] FAIL: ${remaining.length} additive-only violation(s) against ${baseRef}:`,
    );
    for (const v of remaining) log(`  - ${v}`);
    log(
      '[crd-schema-diff] See ADR-0017 Amendment 2 §2.1 — within v1alpha1, NextApp schema ' +
        'changes must be additive-only. A non-additive change needs a new CRD API version, ' +
        `or an exact waiver in ${WAIVERS_PATH} under the rules of ADR-0017 Amendment 3.`,
    );
  }
  if (stale.length > 0) {
    failed = true;
    log(
      `[crd-schema-diff] FAIL: ${stale.length} stale waiver(s) in ${WAIVERS_PATH} match no current ` +
        `violation against ${baseRef}. Waivers are single-use: delete them (the narrowing has ` +
        'shipped in a tag, or the waived rule text changed and needs a new review):',
    );
    for (const w of stale) log(`  - ${w.violation}`);
  }
  if (failed) return 1;

  if (waived.length > 0) {
    log(
      `[crd-schema-diff] PASS: ${opts.crdPath} vs ${baseRef} — ${waived.length} narrowing(s) waived ` +
        `by ${WAIVERS_PATH} (ADR-0017 Amendment 3):`,
    );
    for (const v of waived) log(`  - ${v}`);
    return 0;
  }
  log(`[crd-schema-diff] PASS: ${opts.crdPath} is an additive-only superset of ${baseRef}.`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(run(process.argv.slice(2)));
  } catch (err) {
    console.error(`[crd-schema-diff] ERROR: ${err.message}`);
    process.exit(1);
  }
}
