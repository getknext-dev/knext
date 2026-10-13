#!/usr/bin/env node
/**
 * TEETH for the CDN cache-tier kind e2e: gut the edge allowlist in a BUILT
 * `cache-control-normalize.cjs` (the header preload that bundles cdn-edge.cjs),
 * so the e2e can prove its checks go red when knext's own defences are gone.
 * Test-only: it edits a staged copy of a packed tarball inside a throwaway app
 * directory, never the repo's sources.
 *
 *   node scripts/cdn-e2e-mutate-preload.mjs [--set allowlist|foreign-build] <path/to/cache-control-normalize.cjs>
 *
 * Every anchor must occur EXACTLY ONCE, or the script exits non-zero and writes
 * nothing: a substitution that silently matched nothing would yield a "mutated"
 * build that is not mutated, and an expected-red run against it would prove
 * nothing. The result is syntax-checked before it is written.
 *
 * Each removed line is one D4.1 condition, so each expected-red FAIL in the
 * workflow is attributable to the defence it names. The prefix mutation gives
 * every app the same tag prefix, which the prefix checks must catch.
 *
 * `--set foreign-build` (the purge lane) disables ONLY the seam's foreign-build
 * record (ADR-0068 Amendment 2): the cache handler still reports that the body
 * it served was written by another build, and the preload ignores it. A rollout
 * to a build carrying it must red `rollout-no-old-html`.
 *
 * `--set foreign-stale` (the purge lane's ORIGIN red leg) targets the cache
 * handler instead: the built chunk that holds it reverts to handing another
 * build's page entry back with its stored window withheld rather than as stale,
 * so Next applies the new build's manifest window and keeps answering HIT with
 * the previous build's HTML. A rollout to a build carrying it must red
 * `rollout-origin-new-html`. The handler is bundled into a hashed chunk, so
 * `--locate <dist dir>` prints the one file in the tree that holds the anchor
 * (and exits non-zero unless exactly one does):
 *
 *   node scripts/cdn-e2e-mutate-preload.mjs --set foreign-stale --locate <dist>
 *   node scripts/cdn-e2e-mutate-preload.mjs --set foreign-stale <that file>
 *
 * `--set use-cache-tags` (the purge lane's 'use cache' red leg, #2302) targets
 * NEXT itself, in the staged 'use cache' fixture's own install: its 'use cache'
 * wrapper (`dist/server/use-cache/use-cache-wrapper.js` and the ESM copy under
 * `dist/esm/`) stops copying a 'use cache' function's tags into the enclosing
 * page entry, while still copying its cache life. The page stays an ISR page
 * with its `_N_T_` tags, so the edge still caches it, just without the
 * 'use cache' tag: exactly the case ADR-0068 D5.1 assumes away. A build carrying
 * it must red `purge-use-cache`.
 *
 * Every write replaces the file (a new inode, renamed into place) rather than
 * rewriting it, so a file hardlinked from a shared install cache (bun's default
 * on Linux) is never mutated through the link.
 */

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';

export const MUTATIONS = [
  ['method', 'if (i.method !== "GET" && i.method !== "HEAD") return skip("method");', ''],
  ['status', 'if (i.status !== 200) return skip("status");', ''],
  [
    'private_or_no_store',
    'if (name === "private" || name === "no-store" || name === "no-cache") return skip("private_or_no_store");',
    '',
  ],
  ['set_cookie', 'if (i.hasSetCookie) return skip("set_cookie");', ''],
  [
    'auth_or_draft',
    'if (i.hasAuthorization || i.hasDraftCookie) return skip("auth_or_draft");',
    '',
  ],
  [
    'non_canonical_path',
    'if (raw === void 0 || !isCanonicalRawPath(raw)) return skip("non_canonical_path");',
    '',
  ],
  [
    'middleware_matched',
    'if (!included && middlewareMatches(i.artifact, raw)) return skip("middleware_matched");',
    '',
  ],
  [
    'rsc_without_rsc_param',
    'if (rscRequest && !i.rsc.param) return skip("rsc_without_rsc_param");',
    '',
  ],
  [
    'rsc_param_without_rsc_header',
    'if (i.rsc.param && !i.rsc.header) return skip("rsc_param_without_rsc_header");',
    '',
  ],
  ['rsc_content_type_mismatch', 'if (!isFlight) return skip("rsc_content_type_mismatch");', ''],
  [
    'shared_prefix',
    'const tags = encodeTags(cfg.prefix, i.buildId, nextTags);',
    'const tags = encodeTags("000000000000", i.buildId, nextTags);',
  ],
];

export const MARKER = '/* KNEXT_E2E_MUTATED: cdn-edge allowlist gutted, test-only */';

/** The purge lane's red leg: the seam drops the foreign-build mark. */
export const FOREIGN_BUILD_MUTATIONS = [
  ['foreign_build_record', 'if (ownEntry && rec.foreignBuild === true) s.foreignBuild = true;', ''],
];
export const FOREIGN_BUILD_MARKER =
  '/* KNEXT_E2E_MUTATED: cdn-edge foreign-build record disabled, test-only */';

/**
 * The purge lane's origin red leg: the cache handler's read returns another
 * build's page entry through `scopeWindowToBuild` (window withheld) instead of
 * `staleForeignBuildEntry` (an expired window), which is the pre-fix behaviour.
 */
export const FOREIGN_STALE_MUTATIONS = [
  [
    'foreign_build_stale',
    'return staleForeignBuildEntry(parsed, ctx, writerIsLive);',
    'return scopeWindowToBuild(parsed, ctx, writerIsLive);',
  ],
];
export const FOREIGN_STALE_MARKER =
  '/* KNEXT_E2E_MUTATED: cache-handler foreign-build stale window removed, test-only */';

/**
 * The purge lane's 'use cache' red leg: Next's
 * `propagateCacheLifeAndTagsToRevalidateStore` keeps the cache life it copies
 * into the enclosing page and drops the tags.
 */
export const USE_CACHE_TAGS_MUTATIONS = [
  ['use_cache_tag_propagation', 'outerTags.push(tag);', '/* tag not propagated */'],
];
export const USE_CACHE_TAGS_MARKER =
  "/* KNEXT_E2E_MUTATED: next 'use cache' tag propagation removed, test-only */";

/**
 * name -> [mutations, marker, module syntax of the target]. `by-path`: ESM when
 * the file sits under a `dist/esm/` tree, CommonJS otherwise.
 */
const SETS = {
  allowlist: [MUTATIONS, MARKER, 'cjs'],
  'foreign-build': [FOREIGN_BUILD_MUTATIONS, FOREIGN_BUILD_MARKER, 'cjs'],
  'foreign-stale': [FOREIGN_STALE_MUTATIONS, FOREIGN_STALE_MARKER, 'esm'],
  'use-cache-tags': [USE_CACHE_TAGS_MUTATIONS, USE_CACHE_TAGS_MARKER, 'by-path'],
};
const MARKERS = [MARKER, FOREIGN_BUILD_MARKER, FOREIGN_STALE_MARKER, USE_CACHE_TAGS_MARKER];

/**
 * Replace `target` with `content`: write a sibling, then rename it into place,
 * so the target gets a new inode and any hardlink to the old one keeps its bytes.
 */
function replaceFile(target, content) {
  const tmp = `${target}.knext-e2e-${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: statSync(target).mode });
  renameSync(tmp, target);
}

/** Every JavaScript file under `dir` (source maps excluded), recursively. */
function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(p));
    else if (/\.[cm]?js$/.test(entry.name)) out.push(p);
  }
  return out;
}

/**
 * The ONE file under `dir` that holds the set's anchors. Throws unless exactly
 * one file holds any of them, and holds each exactly once.
 */
export function locate(dir, mutations) {
  const holders = jsFiles(dir).filter((f) => {
    const src = readFileSync(f, 'utf8');
    return mutations.some(([, anchor]) => src.includes(anchor));
  });
  if (holders.length !== 1)
    throw new Error(
      `${holders.length} files under ${dir} hold the anchors, want exactly 1: ${holders.join(', ')}`,
    );
  const src = readFileSync(holders[0], 'utf8');
  for (const [name, anchor] of mutations) {
    const count = src.split(anchor).length - 1;
    if (count !== 1)
      throw new Error(`anchor ${name} occurs ${count} times in ${holders[0]}, want exactly 1`);
  }
  return holders[0];
}

/** Syntax-check an ES module with `node --check` (vm.Script cannot parse `import`). */
function checkEsm(source, label) {
  const dir = mkdtempSync(join(tmpdir(), 'cdn-mutate-check-'));
  try {
    const file = join(dir, 'mutated.mjs');
    writeFileSync(file, source);
    const r = spawnSync('node', ['--check', file], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${label} does not parse: ${r.stderr || r.error}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Apply every mutation to `source`; throws naming the anchor that did not occur exactly once. */
export function mutate(source, mutations = MUTATIONS, marker = MARKER) {
  let out = source;
  for (const [name, anchor, replacement] of mutations) {
    const count = out.split(anchor).length - 1;
    if (count !== 1)
      throw new Error(`anchor ${name} occurs ${count} times, want exactly 1: ${anchor}`);
    out = out.replace(anchor, () => replacement);
  }
  return `${marker}\n${out}`;
}

function main(argv) {
  let setName = 'allowlist';
  const args = [...argv];
  if (args[0] === '--set') {
    setName = args[1];
    args.splice(0, 2);
  }
  let locating = false;
  if (args[0] === '--locate') {
    locating = true;
    args.shift();
  }
  const set = Object.hasOwn(SETS, setName) ? SETS[setName] : undefined;
  const target = args[0];
  if (!set || !target) {
    console.error(
      'usage: cdn-e2e-mutate-preload.mjs [--set allowlist|foreign-build|foreign-stale|use-cache-tags] [--locate <dir>] <file>',
    );
    return 2;
  }
  const [mutations, marker, syntax] = set;
  if (locating) {
    try {
      console.log(locate(target, mutations));
      return 0;
    } catch (err) {
      console.error(`::error::${err.message}`);
      return 1;
    }
  }
  const source = readFileSync(target, 'utf8');
  if (MARKERS.some((m) => source.startsWith(m))) {
    console.error(`::error::${target} is already mutated`);
    return 1;
  }
  let mutated;
  try {
    mutated = mutate(source, mutations, marker);
    // Syntax check only.
    const esm = syntax === 'esm' || (syntax === 'by-path' && /[\\/]dist[\\/]esm[\\/]/.test(target));
    if (esm) checkEsm(mutated, target);
    else
      new Script(`(function (exports, require, module, __filename, __dirname) {${mutated}\n})`, {
        filename: target,
      });
  } catch (err) {
    console.error(`::error::refusing to write a mutated preload: ${err.message}`);
    return 1;
  }
  replaceFile(target, mutated);
  console.log(`mutated ${target}: ${mutations.map(([n]) => n).join(', ')}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
