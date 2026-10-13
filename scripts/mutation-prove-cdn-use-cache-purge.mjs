#!/usr/bin/env node
/**
 * Mutation proof for the CDN kind lane's 'use cache' purge check (#2302,
 * ADR-0068 D5.1): `purge-use-cache` in scripts/cdn-e2e-purge-assert.mjs, its
 * fixture (cdn-use-cache-kind-app), its red leg's mutation
 * (`cdn-e2e-mutate-preload.mjs --set use-cache-tags`) and its wiring in
 * .github/workflows/cdn-purge-kind-e2e.yml, all guarded by
 * tests/cdn-e2e-purge-use-cache.test.ts.
 *
 * The kind lane's own red leg (cdn-uc-mut through cdn-e2e-expect-red.sh) proves
 * the check sees red on a cluster. This proves, at PR time, that each thing the
 * check, the fixture, the mutation and the wiring rely on is guarded: each
 * mutation REMOVES or WEAKENS exactly one of them, and the spec must go red.
 *
 * Verdicts are by EXIT CODE only (the shared driver, `scripts/lib/guard-prover.mjs`,
 * never parses output), anchors must occur exactly once (preflight first), the
 * baseline must be green, a canary must go red before any green is trusted, and
 * every restore is sha256-verified.
 *
 * Usage:  node scripts/mutation-prove-cdn-use-cache-purge.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = 'packages/kn-next/src/__tests__/fixtures/cdn-use-cache-kind-app';

// Each single-line anchor runs to the end of its line, so the harness's
// trailing residue marker comments out nothing that matters.
const MUTATIONS = [
  // ── the check ─────────────────────────────────────────────────────────────
  {
    id: 'M01',
    subject: 'assert',
    claim: "the check stops requiring the 'use cache' tag hash on the edge HIT",
    anchor: "if (!tagged) why.push(`the edge HIT's Cache-Tag lacks ${tag} (${tags.join(',')})`);",
    replacement:
      "if (false) why.push(`the edge HIT's Cache-Tag lacks ${tag} (${tags.join(',')})`);",
  },
  {
    id: 'M02',
    subject: 'assert',
    claim: 'the check stops requiring the purge to evict the page (a HIT after it passes)',
    anchor: "if (hit(after)) why.push('the edge still served the page after revalidateTag');",
    replacement: "if (false) why.push('the edge still served the page after revalidateTag');",
  },
  {
    id: 'M03',
    subject: 'assert',
    claim: 'the check stops requiring a purge to have reached the emulator',
    anchor:
      "must(purge !== null, `no purge carrying the 'use cache' tag ${tag} reached the emulator`);",
    replacement: "must(true, `no purge carrying the 'use cache' tag ${tag} reached the emulator`);",
  },
  {
    id: 'M04',
    subject: 'assert',
    claim: 'the check stops requiring a fresh render after the purge',
    anchor:
      "stampOf(after) !== undefined && stampOf(after) !== stampOf(before),\n          `the MISS after the 'use cache' purge",
    replacement: "true,\n          `the MISS after the 'use cache' purge",
  },
  {
    id: 'M05',
    subject: 'assert',
    claim: 'the not-vacuous precondition goes: an untagged edge entry reads as the defect',
    anchor: 'tags.includes(appTagOf(pUc)),',
    replacement: 'true,',
  },
  {
    id: 'M06',
    subject: 'assert',
    claim: "the check reads another app's tag prefix",
    anchor: 'const pUc = c.prefixes.uc;',
    replacement: 'const pUc = c.prefixes.a;',
  },
  {
    id: 'M07',
    subject: 'assert',
    claim: "the check revalidates the ISR page's tag, not the 'use cache' one",
    anchor: 'await revalidate(c, host, UC_TAG);',
    replacement: 'await revalidate(c, host);',
  },
  {
    id: 'M08',
    subject: 'assert',
    claim: "the expected prefix is derived from another app's name",
    anchor: 'prefixes: { ...c.prefixes, uc: derivePrefix(c.ns, uc) },',
    replacement: "prefixes: { ...c.prefixes, uc: derivePrefix(c.ns, 'cdn-a') },",
  },
  // ── the red leg's mutation ────────────────────────────────────────────────
  {
    id: 'M09',
    subject: 'mutate',
    claim: "the use-cache-tags set leaves Next's tag propagation in place",
    anchor: "['use_cache_tag_propagation', 'outerTags.push(tag);', '/* tag not propagated */'],",
    replacement: "['use_cache_tag_propagation', 'outerTags.push(tag);', 'outerTags.push(tag);'],",
  },
  {
    id: 'M10',
    subject: 'mutate',
    claim: 'the mutation writes through a hardlink into a shared install cache',
    anchor: 'replaceFile(target, mutated);',
    replacement: 'writeFileSync(target, mutated);',
  },
  {
    id: 'M11',
    subject: 'mutate',
    claim: "Next's ESM wrapper is syntax-checked as CommonJS, so the set refuses it",
    anchor:
      "const esm = syntax === 'esm' || (syntax === 'by-path' && /[\\\\/]dist[\\\\/]esm[\\\\/]/.test(target));",
    replacement: "const esm = syntax === 'esm';",
  },
  // ── the fixture ───────────────────────────────────────────────────────────
  {
    id: 'M12',
    subject: 'page',
    claim: "the page takes no tag from 'use cache'",
    anchor: 'cacheTag("cdn-e2e-uc");',
    replacement: '',
  },
  {
    id: 'M13',
    subject: 'page',
    claim: 'the page gains a second route to a tag (unstable_cache)',
    anchor: 'import { cacheLife, cacheTag } from "next/cache";',
    replacement: 'import { cacheLife, cacheTag, unstable_cache } from "next/cache";',
  },
  {
    id: 'M14',
    subject: 'config',
    claim: 'the fixture is not a Cache Components app',
    anchor: 'cacheComponents: true,',
    replacement: 'cacheComponents: false,',
  },
  {
    id: 'M15',
    subject: 'route',
    claim: 'the revalidate route accepts a tag the page does not carry',
    anchor: 'const TAGS = new Set(["cdn-e2e-uc"]);',
    replacement: 'const TAGS = new Set(["cdn-e2e-uc", "cdn-e2e-page"]);',
  },
  // ── the wiring ────────────────────────────────────────────────────────────
  {
    id: 'M16',
    subject: 'workflow',
    claim: 'the lane no longer runs on a change to the fixture',
    anchor: "- 'packages/kn-next/src/__tests__/fixtures/cdn-use-cache-kind-app/**'",
    replacement: "- 'packages/kn-next/src/__tests__/fixtures/cdn-use-cache-kind-app/README'",
  },
  {
    id: 'M17',
    subject: 'workflow',
    claim: "the fixture install hardlinks bun's cache, so the Next edit leaks",
    anchor: 'bun install --backend=copyfile',
    replacement: 'bun install',
  },
  {
    id: 'M18',
    subject: 'workflow',
    claim: "the edited Next is never restored after cdn-uc-mut's build",
    anchor: 'cp "$RUNNER_TEMP/wrapper.orig.$i.js" "$w"',
    replacement: 'true',
  },
  {
    id: 'M19',
    subject: 'workflow',
    claim: 'the red leg runs against the honest app',
    anchor: 'CDN_APP_UC=cdn-uc-mut bash scripts/cdn-e2e-expect-red.sh use-cache-untagged',
    replacement: 'CDN_APP_UC=cdn-uc bash scripts/cdn-e2e-expect-red.sh use-cache-untagged',
  },
  {
    id: 'M20',
    subject: 'workflow',
    claim: "the 'use cache' apps stay, and the rollout's new revisions go Unschedulable",
    anchor: 'kubectl -n "$APP_NS" delete nextapp cdn-uc cdn-uc-mut --wait=true --timeout=180s',
    replacement: 'true',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'tests/cdn-e2e-purge-use-cache.test.ts',
  subjects: {
    assert: 'scripts/cdn-e2e-purge-assert.mjs',
    mutate: 'scripts/cdn-e2e-mutate-preload.mjs',
    workflow: '.github/workflows/cdn-purge-kind-e2e.yml',
    page: `${FIXTURE}/app/uc-tagged/page.tsx`,
    route: `${FIXTURE}/app/api/revalidate/route.ts`,
    config: `${FIXTURE}/next.config.mjs`,
  },
});

console.log("=== mutation proof: the CDN 'use cache' purge check (#2302) ===");
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed({
  subject: 'assert',
  anchor: "export const UC_TAG = 'cdn-e2e-uc';",
  replacement: "export const UC_TAG = 'cdn-e2e-ux';",
});

console.log('\n=== mutations ===');
for (const m of MUTATIONS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(MUTATIONS.length);
