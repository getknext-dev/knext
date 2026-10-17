#!/usr/bin/env node
/**
 * release-age-gate — fail when a change lands a lockfile entry younger than the
 * fresh-release quarantine (`install.minimumReleaseAge` in bunfig.toml).
 *
 * bun enforces the quarantine when it RESOLVES. This enforces it on the RESULT, for
 * every ecosystem we lock (bun.lock, package-lock.json, Cargo.lock, go.mod): the
 * entries `HEAD` adds or alters relative to the base are looked up in the registry
 * (npm packument `time`, crates.io API, Go module proxy `.info`) and must be at least
 * that old. First-party packages in `minimumReleaseAgeExcludes` are not checked.
 * The only override is a scoped, dated, short-lived entry in
 * `security/release-age-exceptions.json`.
 *
 * FAIL CLOSED. A registry that cannot be reached or does not know a version fails the job; no
 * resolvable base is exit 2. Never a pass. Policy lives in `scripts/lib/release-age.mjs`
 * (pinned by `tests/release-age-gate.test.ts`).
 *
 * Usage: node scripts/release-age-gate.mjs [--base <sha>]
 *   The base is chosen like the OSV gate's: the supplied one, else origin/integration/v2,
 *   else origin/main.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickBase, selectLockfiles } from './lib/osv-gate.mjs';
import {
  ageFailed,
  changedEntries,
  evaluateAges,
  loadExceptions,
  parseLockfile,
  publishTime,
  readBunfig,
  registryUrl,
  renderAgeReport,
} from './lib/release-age.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FETCH_TIMEOUT_MS = 30_000;
const ATTEMPTS = 3;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

function resolves(ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** One registry document, retried; cached per URL (many versions share one packument). */
const cache = new Map();
function fetchJson(url) {
  if (!cache.has(url)) {
    cache.set(
      url,
      (async () => {
        let last;
        for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
          try {
            const res = await fetch(url, {
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
              headers: {
                accept: 'application/json',
                // crates.io refuses requests without an identifying User-Agent.
                'user-agent': 'knext-release-age-gate (https://github.com/getknext-dev/knext)',
              },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
            return await res.json();
          } catch (err) {
            last = err;
            await new Promise((r) => setTimeout(r, attempt * 500));
          }
        }
        throw new Error(`could not read ${url}: ${last instanceof Error ? last.message : last}`);
      })(),
    );
  }
  return cache.get(url);
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const { seconds, excludes } = readBunfig(readFileSync(resolve(REPO_ROOT, 'bunfig.toml'), 'utf8'));
  const exceptions = loadExceptions(
    JSON.parse(readFileSync(resolve(REPO_ROOT, 'security/release-age-exceptions.json'), 'utf8')),
    today,
  );

  const picked = pickBase({
    supplied: arg('base'),
    resolves,
    currentRef: process.env.GITHUB_REF_NAME ?? '',
  });
  if (picked === null) {
    throw new Error('no base to compare against (not even origin/integration/v2 or origin/main)');
  }
  const mergeBase = git(['merge-base', picked, 'HEAD']).trim();
  console.log(`Comparing lockfiles against ${picked} (merge base ${mergeBase.slice(0, 12)}).`);

  const files = selectLockfiles(git(['ls-files']).split('\n').filter(Boolean));
  const withFile = (entries, lockfile) => entries.map((e) => ({ ...e, lockfile }));
  const head = [];
  const base = [];
  for (const f of files) {
    head.push(...withFile(parseLockfile(f, readFileSync(resolve(REPO_ROOT, f), 'utf8')), f));
    let baseText = null;
    try {
      baseText = execFileSync('git', ['show', `${mergeBase}:${f}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      // a lockfile the change adds has no base side: every entry in it is new
    }
    if (baseText !== null) base.push(...withFile(parseLockfile(f, baseText), f));
  }

  const entries = changedEntries(head, base);
  console.log(
    `${entries.length} lockfile entr${entries.length === 1 ? 'y' : 'ies'} added or altered.`,
  );

  const result = await evaluateAges({
    entries,
    now: Date.now(),
    minSeconds: seconds,
    excludes,
    exceptions,
    concurrency: 12,
    lookup: async (e) => publishTime(e, await fetchJson(registryUrl(e))),
  });
  const report = renderAgeReport(result, seconds);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Release age\n\n\`\`\`\n${report}\n\`\`\`\n`,
    );
  }
  process.exit(ageFailed(result) ? 1 : 0);
}

main().catch((err) => {
  console.error(`::error::release-age-gate: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
});
