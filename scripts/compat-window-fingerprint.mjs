#!/usr/bin/env node
/**
 * compat-window-fingerprint.mjs — the COMPAT-WINDOW FINGERPRINT (S1, #545).
 *
 * v1.0 is gated on "14 consecutive scheduled node-lane runs with the harness
 * unchanged". Nothing recorded what "unchanged" meant, so the guarantee was
 * unfalsifiable: the window would be policed by a human reading a log they also
 * wrote. This script makes it checkable — it emits a deterministic digest over
 * the FROZEN SET, recorded per scheduled run, so a mid-window change is
 * detectable from the log rather than from memory.
 *
 * THE FROZEN SET (docs/adr/0039, decision D-1 of docs/SPRINT_2.md) has two
 * halves, and both must be in the digest:
 *
 *   harness — .github/workflows/test-e2e-deploy.yml, the scripts/e2e-* lifecycle
 *             scripts the reference harness shells out to, and the deploy-tests
 *             manifest that selects what runs.
 *   packed  — the `@getknext/*` tarballs the workflow packs and installs into
 *             every fixture. This is THE ADAPTER UNDER TEST. A fingerprint that
 *             covers only the harness would go unchanged across a night that
 *             tested different code — the exact silent failure this exists to
 *             prevent — so an empty or non-@getknext packed set is a hard error,
 *             never a quietly-omitted component.
 *
 * SCANNED, NOT ENUMERATED. The roots below are directories + patterns, not a
 * file list: a newly-added `scripts/e2e-*.sh`, a second manifest lane, or a
 * fourth packed package moves the digest with no edit here. An enumerated list
 * is how the second file gets missed.
 *
 * NOT in the frozen set: `dist/cli/**` (excluded by D-1 so CLI work can land
 * mid-window — kept honest by scripts/adapter-import-closure.mjs) and
 * `scripts/compat-smoke.mjs`, which is a DIFFERENT gate, in ci.yml, app-side.
 *
 * Usage:
 *   node scripts/compat-window-fingerprint.mjs \
 *     --repo-root . --tarballs-dir "$GITHUB_WORKSPACE/knext-tarballs" \
 *     [--out compat-window-fingerprint.json] [--json] [--files]
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

export const SCHEMA = 'knext.compat-window-fingerprint/v1';

/**
 * The frozen HARNESS roots. Each `dir` root is SCANNED (recursively) and
 * filtered by `match`, so the set grows with the tree rather than with edits
 * to this file.
 *
 * @type {{ kind: 'file' | 'dir', path: string, match?: RegExp }[]}
 */
export const HARNESS_ROOTS = [
  { kind: 'file', path: '.github/workflows/test-e2e-deploy.yml' },
  // The lifecycle scripts the reference harness invokes
  // (NEXT_TEST_DEPLOY_SCRIPT_PATH and friends) plus the preflight/summary/ledger
  // helpers the workflow runs around them.
  { kind: 'dir', path: 'scripts', match: /^e2e-[^/]*\.(sh|mjs|cjs|js)$/ },
  // The deploy-tests manifest(s): the exclude ledger that decides what the
  // night actually selected. A second lane manifest is picked up automatically.
  { kind: 'dir', path: 'test', match: /^deploy-tests-manifest\.[^/]*\.json$/ },
];

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Recursively list files under `dir`, as paths relative to `dir`, sorted. */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  const visit = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) visit(abs, rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  visit(dir, '');
  return out.sort();
}

/**
 * One digest line per frozen file. The executable bit is part of the identity:
 * a lifecycle script that loses `+x` changes what the night ran.
 */
function line(component, path, absolute) {
  const mode = statSync(absolute).mode & 0o111 ? 'x' : '-';
  return `${component}\t${path}\t${mode}\t${sha256(readFileSync(absolute))}`;
}

function collectHarness(repoRoot) {
  /** @type {{ component: string, path: string, line: string }[]} */
  const entries = [];
  for (const root of HARNESS_ROOTS) {
    const abs = resolve(repoRoot, root.path);
    if (root.kind === 'file') {
      if (!existsSync(abs)) {
        throw new Error(
          `compat-window fingerprint: frozen harness file ${root.path} is missing. A root that resolves to nothing silently shrinks the frozen set — fix the path or amend the freeze scope (docs/adr/0039).`,
        );
      }
      entries.push({
        component: 'harness',
        path: root.path,
        line: line('harness', root.path, abs),
      });
      continue;
    }
    if (!existsSync(abs)) {
      throw new Error(`compat-window fingerprint: frozen harness root ${root.path}/ is missing`);
    }
    const matched = walk(abs).filter((rel) => (root.match ? root.match.test(rel) : true));
    if (matched.length === 0) {
      throw new Error(
        `compat-window fingerprint: frozen harness root ${root.path}/ matched ZERO files for ${root.match}. An empty root is a fingerprint over nothing.`,
      );
    }
    for (const rel of matched) {
      const path = `${root.path}/${rel}`;
      entries.push({ component: 'harness', path, line: line('harness', path, join(abs, rel)) });
    }
  }
  return entries;
}

function collectPacked(tarballsDir) {
  const dir = resolve(tarballsDir);
  if (!existsSync(dir)) {
    throw new Error(`compat-window fingerprint: --tarballs-dir ${tarballsDir} does not exist`);
  }
  const tarballs = readdirSync(dir)
    .filter((f) => f.endsWith('.tgz'))
    .sort();
  if (tarballs.length === 0) {
    throw new Error(
      `compat-window fingerprint: no *.tgz in ${tarballsDir}. The packed @getknext/* closure IS the adapter under test; a fingerprint that omits it would stay identical across a night that ran different code. Refusing to emit one.`,
    );
  }

  /** @type {{ component: string, path: string, line: string }[]} */
  const entries = [];
  /** @type {{ tarball: string, name: string, version: string, files: number, sha256: string }[]} */
  const packages = [];

  for (const tarball of tarballs) {
    const stage = mkdtempSync(join(tmpdir(), 'knext-cwfp-'));
    try {
      // Hash the tarball's CONTENTS, never its bytes: gzip embeds an mtime and
      // pnpm pack is not bit-reproducible, so a byte digest would churn nightly
      // and the window would never hold for reasons that are not code changes.
      execFileSync('tar', ['xzf', join(dir, tarball), '-C', stage]);
      const pkgRoot = existsSync(join(stage, 'package')) ? join(stage, 'package') : stage;
      const manifestPath = join(pkgRoot, 'package.json');
      if (!existsSync(manifestPath)) {
        throw new Error(
          `compat-window fingerprint: ${tarball} has no package.json — not an npm tarball`,
        );
      }
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@getknext/')) {
        throw new Error(
          `compat-window fingerprint: ${tarball} packs "${manifest.name}", not an @getknext/* package. The packed set is the adapter under test; a foreign tarball means the pack step drifted.`,
        );
      }

      const files = walk(pkgRoot);
      const pkgLines = files.map((rel) => {
        const path = `${manifest.name}@${manifest.version}/${rel}`;
        return { component: 'packed', path, line: line('packed', path, join(pkgRoot, rel)) };
      });
      entries.push(...pkgLines);
      packages.push({
        tarball,
        name: manifest.name,
        version: manifest.version,
        files: files.length,
        sha256: sha256(pkgLines.map((e) => e.line).join('\n')),
      });
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  return { entries, packages };
}

/**
 * @param {{ repoRoot: string, tarballsDir: string }} options
 */
export function computeFingerprint({ repoRoot, tarballsDir }) {
  const harness = collectHarness(repoRoot);
  const { entries: packed, packages } = collectPacked(tarballsDir);

  const harnessLines = harness.map((e) => e.line).sort();
  const packedLines = packed.map((e) => e.line).sort();
  const components = {
    harness: `sha256:${sha256(harnessLines.join('\n'))}`,
    packed: `sha256:${sha256(packedLines.join('\n'))}`,
  };
  const fingerprint = `sha256:${sha256(`${SCHEMA}\n${components.harness}\n${components.packed}\n`)}`;

  return {
    schema: SCHEMA,
    fingerprint,
    components,
    counts: { harness: harness.length, packed: packed.length },
    packages,
    files: [...harness, ...packed].map((e) => ({ component: e.component, path: e.path })),
  };
}

/* c8 ignore start — CLI wrapper */
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(`--${name}`);
  const arg = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
  };

  const repoRoot = resolve(arg('repo-root', process.cwd()));
  const tarballsDir = arg('tarballs-dir', null);
  if (!tarballsDir) {
    console.error(
      'compat-window fingerprint: --tarballs-dir is REQUIRED (the packed adapter is half the frozen set)',
    );
    process.exit(2);
  }

  let result;
  try {
    result = computeFingerprint({ repoRoot, tarballsDir });
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const payload = flag('files') ? result : { ...result, files: undefined };
  const out = arg('out', null);
  if (out) {
    writeFileSync(resolve(out), `${JSON.stringify(result, null, 2)}\n`);
  }
  if (flag('json')) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`compat-window fingerprint: ${result.fingerprint}`);
    console.log(`  harness ${result.components.harness} (${result.counts.harness} files)`);
    console.log(`  packed  ${result.components.packed} (${result.counts.packed} files)`);
    for (const p of result.packages) {
      console.log(`    ${p.name}@${p.version} ${p.sha256} (${p.files} files)`);
    }
    if (out) console.log(`  written to ${relative(process.cwd(), resolve(out))}`);
  }
}
/* c8 ignore stop */
