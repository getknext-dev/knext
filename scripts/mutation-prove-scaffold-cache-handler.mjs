#!/usr/bin/env node
/**
 * Mutation proof for #896's scaffold cache-handler wiring guard.
 *
 * WHAT #896 CLAIMED, AND WHY IT NEEDS PROVING
 * -------------------------------------------
 * The stability-planning gate found a silent-degradation defect: nothing wired
 * `cacheHandler` in the scaffolded `next.config.ts`, so every `kn-next create`
 * app served 200s with NO ISR cache and NO data cache — full recompute per
 * render, the provisioned Redis unused, and nothing red anywhere. #895/#896's
 * fix is the two template files this prover mutates:
 *   - `templates/app/next.config.ts.hbs` wires `cacheHandler` at a file path and
 *     turns the divergent per-pod in-memory cache OFF (`cacheMaxMemorySize: 0`);
 *   - `templates/app/cache-handler.js.hbs` re-exports the framework handler.
 * `create-scaffold.test.ts` is the guard: it scaffolds a real app from these
 * templates and asserts the wiring survives. #896 shipped with a dated #928
 * exemption instead of a prover, on the (now stale) grounds that concurrent
 * sprint-2 template work owned the subject. That work has landed; this file
 * removes the exemption by proving the guard.
 *
 * WHICH TEMPLATE (#2514): these rows mutate `next.config.ts.hbs`, the DEFAULT
 * (standalone) target's config. Since #1342 the guard's original #895 assertions
 * read the vinext scaffold (`next.config.ts.vinext.hbs`) only, so for a while no
 * test read this template and the canary below left the guard green (the prover
 * aborted, declared 4 / run 0). The "default standalone target" describe in
 * `create-scaffold.test.ts` now pins this template's own wiring.
 *
 * THE FOUR MUTATIONS are the ways the #895 defect could quietly return, each an
 * independent RED of the guard, plus a negative control that must stay GREEN.
 *
 * WHY NO `jsStillParses` VALIDATE: the subjects are Handlebars templates
 * (`next.config.ts.hbs` carries a `{{ name }}` expression), so they are not
 * parseable JS at baseline. Every mutation below is a whole-line or whole-value
 * edit that keeps the surrounding syntax intact, and the harness's residue
 * marker lands inline (single-line replacements) so it can never comment out a
 * statement tail — the failure mode `jsStillParses` guards against does not
 * arise here. `.hbs` has no COMMENT_PREFIX entry, so each mutation passes an
 * explicit `commentPrefix: '//'` (valid for both the TS- and JS-flavoured
 * templates); this is the file-specific case #942 F5 sanctions.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline; a
 * canary red first; anchors exactly once or abort; clean tree between mutations.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'packages/kn-next/src/__tests__/create-scaffold.test.ts';

const HBS = { commentPrefix: '//' };

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      'the `cacheHandler` wiring is deleted from next.config — this IS the #895 defect: a ' +
      'scaffolded app with no ISR/data cache, every request a full recompute, Redis unused',
    subject: 'nextConfig',
    options: HBS,
    anchor: 'cacheHandler: new URL("./cache-handler.js", import.meta.url).pathname,',
    replacement: '',
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'the per-pod in-memory cache is turned back ON (cacheMaxMemorySize 0 -> 1) — per-pod ' +
      'memory caches diverge across Knative pods, the exact inconsistency the Redis handler exists ' +
      'to end',
    subject: 'nextConfig',
    options: HBS,
    anchor: 'cacheMaxMemorySize: 0,',
    replacement: 'cacheMaxMemorySize: 1,',
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'the re-export binding in cache-handler.js is corrupted (default -> notdefault) — Next takes ' +
      'cacheHandler as a PATH and imports its default; a non-default export means no handler is ' +
      'registered and the scaffolded app silently loses its cache',
    subject: 'cacheHandler',
    options: HBS,
    anchor: 'export { default } from "@getknext/core/adapters/cache-handler";',
    replacement: 'export { notdefault } from "@getknext/core/adapters/cache-handler";',
  },
];

/**
 * NEGATIVE CONTROL. `assetPrefix`'s empty-string fallback is app-level wiring the
 * guard checks for PRESENCE, not for a specific value (create-scaffold asserts
 * `assetPrefix: process.env.ASSET_PREFIX`, deliberately not the fallback). Retuning
 * the fallback must leave the guard GREEN — a guard that reddened on it would be
 * pinning a byte, not the cache contract.
 */
const NEGATIVE = {
  id: 'M4',
  expect: 'green',
  claim:
    'the assetPrefix fallback is retuned — unrelated to the cache-handler wiring the guard pins',
  subject: 'nextConfig',
  options: HBS,
  anchor: 'assetPrefix: process.env.ASSET_PREFIX || "",',
  replacement: 'assetPrefix: process.env.ASSET_PREFIX || "/",',
};

const ALL = [...MUTATIONS, NEGATIVE];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    nextConfig: 'packages/kn-next/templates/app/next.config.ts.hbs',
    cacheHandler: 'packages/kn-next/templates/app/cache-handler.js.hbs',
  },
});

console.log(`=== mutation proof: ${SPEC} (#896 scaffold cache-handler) ===`);
prover.preflight(ALL);
declareMutations(ALL.length);
prover.baseline();

// The canary removes the `export default` from the scaffolded (default-target)
// next.config, so the default-target "still exports a NextConfig" assertion must fall. If the runner
// cannot see that, nothing below is worth reading.
prover.proveCanSeeRed({
  subject: 'nextConfig',
  options: HBS,
  anchor: 'export default nextConfig;',
  replacement: 'const _cfg = nextConfig;',
});

console.log('\n=== mutations ===');
for (const m of ALL) {
  prover.run(m);
  recordMutation();
}

prover.finish(ALL.length);
