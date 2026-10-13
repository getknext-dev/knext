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
 */

import { readFileSync, writeFileSync } from 'node:fs';
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

const SETS = {
  allowlist: [MUTATIONS, MARKER],
  'foreign-build': [FOREIGN_BUILD_MUTATIONS, FOREIGN_BUILD_MARKER],
};

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
  const set = SETS[setName];
  const target = args[0];
  if (!set || !target) {
    console.error(
      'usage: cdn-e2e-mutate-preload.mjs [--set allowlist|foreign-build] <cache-control-normalize.cjs>',
    );
    return 2;
  }
  const [mutations, marker] = set;
  const source = readFileSync(target, 'utf8');
  if (source.startsWith(MARKER) || source.startsWith(FOREIGN_BUILD_MARKER)) {
    console.error(`::error::${target} is already mutated`);
    return 1;
  }
  let mutated;
  try {
    mutated = mutate(source, mutations, marker);
    // Syntax check only (the file is CommonJS; wrap it as a function body).
    new Script(`(function (exports, require, module, __filename, __dirname) {${mutated}\n})`, {
      filename: target,
    });
  } catch (err) {
    console.error(`::error::refusing to write a mutated preload: ${err.message}`);
    return 1;
  }
  writeFileSync(target, mutated);
  console.log(`mutated ${target}: ${mutations.map(([n]) => n).join(', ')}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
