#!/usr/bin/env node
/**
 * Standing mutation proof for the anonymous-install gate (#586).
 *
 * WHAT IT DISARMS. `tests/anonymous-install-path.test.ts` claims that a stranger
 * following our published install instructions is checked end to end. Most of
 * what it asserts is behaviour that CANNOT be seen on the clean tree — the docs
 * URL resolves, the allowlists are never violated, the credential shapes never
 * appear — which is exactly the kind of guard that can be written, merged, and
 * be decoration. Each mutation below deletes one of those behaviours and
 * requires the spec to go RED.
 *
 * THE ONE THAT MATTERS MOST is #1: making a refused ANONYMOUS pull token read as
 * a pass. That is #586 itself — a private GHCR package, 401 from the token
 * endpoint, `ImagePullBackOff` for every outside user — and it is the precise
 * shape every existing gate was already blind to. If the spec survives that
 * mutation, this whole PR is decoration.
 *
 * WHY THE DISARMS ARE OFFLINE. The spec runs against an injected transport, so
 * these are deterministic and the nightly prover lane never flakes on a
 * third-party registry. The LIVE half is not simulated anywhere — it is the
 * check itself: `node scripts/verify-anonymous-install.mjs` run against the real
 * published bundle returns `anonymous-token-denied` / HTTP 401 today, and a
 * public image resolves clean through the same code path. Using the real defect
 * beats fabricating one.
 *
 * Mutations land in tracked files through the byte-snapshot harness, so
 * restoration is content-addressed and every mutation carries the residue
 * marker that `scripts/scan-mutation-residue.mjs` finds if a run stalls.
 *
 * TWO RULES FOR ANCHORS, both learned the expensive way:
 *
 * 1. AN ANCHOR MADE ONLY OF INDENTATION IS NOT UNIQUE. The harness asserts an
 *    anchor occurs exactly once, and that assertion is a SUBSTRING count. So
 *    `'    if (x) {'` (four spaces) matches inside `'      if (x) {'` (six) —
 *    count 1, no complaint, and the row silently mutates a line it was never
 *    written for. That is how two rows here became the same mutation after a
 *    refactor re-indented one site and deleted the other: `declared` was
 *    inflated by one and nobody could see it from the output, since both rows
 *    dutifully went red. When a refactor changes indentation, re-anchor on
 *    something with real text either side of it rather than trusting the count.
 *
 * 2. A STALE ANCHOR IS ONLY LOUD WHEN IT MATCHES NOTHING. The refusal at zero
 *    occurrences is what catches a row whose subject was deleted — it is not a
 *    general defence against a row that has quietly stopped meaning what it
 *    says. Rule 1 is the case it does not cover.
 *
 * KNOWN TRAP when running the whole suite under mutation: `tests/mutation-
 * residue-scan.test.ts` scans tracked files for this harness's own marker, so it
 * fires on every live mutation. Score the spec under test, not the whole suite.
 *
 * Usage:  node scripts/mutation-prove-anonymous-install.mjs
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { countOccurrences, mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/anonymous-install-path.test.ts';
const SCRIPT = resolve(REPO_ROOT, 'scripts/verify-anonymous-install.mjs');
const WORKFLOW = resolve(REPO_ROOT, '.github/workflows/anonymous-install-nightly.yml');

/**
 * A published copy of the install URL OUTSIDE the docs site, used to prove the
 * drift check is live.
 *
 * Deliberately the operator README rather than `apps/docs/content/` or `docs/`:
 * those are owned by other workstreams, and a mutation harness should not touch
 * a file someone else may be holding even though it restores byte-identically.
 */
const OTHER_DOC = resolve(REPO_ROOT, 'packages/kn-next-operator/README.md');

/** SGR colour codes in vitest's output — matched without a raw escape byte. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * `pnpm exec vitest` resolves NOTHING in a tree without its own `node_modules`
 * — a git worktree, or a fresh clone before install — and every run then reports
 * `ran === 0` and blames the wrong thing (#680/#681/#685).
 */
const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

/**
 * Every disarm, as `[file, label, anchor, replacement]`.
 *
 * A TABLE rather than inline calls, so the declaration below is DERIVED from it
 * and cannot drift: adding a row runs it and counts it in the same edit. The
 * lane compares declared against run in both directions (#685).
 */
const MUTATIONS = [
  [
    SCRIPT,
    '#586 ITSELF: a refused ANONYMOUS pull token reads as a pass',
    "  if (resolved.stage === 'token') {",
    '  if (false) {',
  ],
  [
    SCRIPT,
    'the install URL is HARDCODED instead of read from the docs',
    "  const text = options.text ?? readFileSync(resolve(repoRoot, file), 'utf8');",
    "  const text =\n    options.text ?? 'kubectl apply -f https://github.com/o/r/releases/download/x/install.yaml';",
  ],
  [
    SCRIPT,
    'only the FIRST image is checked, so a second one is never pulled',
    // Anchored on the CONSUMER, not on `return found;` inside the extractor:
    // `findUnscannedKindImages` ends with the same line, and the harness refuses
    // an anchor that occurs twice rather than silently mutating the wrong one.
    '  const images = extractContainerImages(body);',
    '  const images = extractContainerImages(body).slice(0, 1);',
  ],
  [
    SCRIPT,
    'the request-header ALLOWLIST becomes a denylist of one literal',
    '      if (!ALLOWED_REQUEST_HEADERS.has(header)) {',
    "      if (header === 'cookie') {",
  ],
  [
    SCRIPT,
    'the credential-name SHAPE becomes three literal spellings',
    'export const CREDENTIAL_NAME_RE =\n',
    'export const CREDENTIAL_NAME_RE = /^(GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN)$/;\nconst UNUSED_CREDENTIAL_NAME_RE =\n',
  ],
  [
    SCRIPT,
    'an UNREACHABLE registry becomes a silent pass',
    '      message: error instanceof Error ? error.message : String(error),\n    };',
    '      message: undefined,\n    } && undefined;',
  ],
  [
    SCRIPT,
    'a bundle with NO workload image passes vacuously',
    '  if (images.length === 0) {',
    '  if (false) {',
  ],
  [
    SCRIPT,
    'a body that is not a bundle at all (a 404 page) passes',
    '  if (kinds.length === 0) {',
    '  if (false) {',
  ],
  // ── the download half (F1). Every one of these defends behaviour that used to
  //    live inside the `c8 ignore`d CLI, where no mutation could reach it — which
  //    is exactly why the empty-200 bug was there and nothing else was.
  [
    SCRIPT,
    'F1 THE BUG: a zero-length 200 skips bundle verification entirely',
    '  let images = [];\n  if (download.body !== null) {',
    "  let images = [];\n  if (download.body !== null && download.body !== '') {",
  ],
  [
    SCRIPT,
    'a zero-length 200 stops being a finding of its own',
    '  } else if (body.length === 0) {',
    '  } else if (false) {',
  ],
  // ── the workflow audit's scope (F2/F3) ───────────────────────────────────
  [
    SCRIPT,
    'F2: the workflow-level key scan is disarmed (a top-level `env:` goes unseen)',
    '    if (!key || !FORBIDDEN_TOP_LEVEL_KEYS.includes(key)) continue;',
    '    if (true) continue;',
  ],
  [
    SCRIPT,
    'a job-level `container:`/`services:` registry login goes unseen',
    // Re-anchored in round 4: this row pointed at the 4-space-pinned regex that
    // round 4 replaced. The harness refused it at zero occurrences rather than
    // scoring nothing — the loud half of the anchor lesson in the header.
    "    if (new RegExp(`^\\\\s+${yamlKey(key)}`, 'm').test(block)) {",
    '    if (false) {',
  ],
  // NOTE: two round-2 rows are gone, and the two removals failed differently —
  // which is the whole lesson.
  //
  //   - the per-JOB `persist-credentials` disarm anchored on code round 3
  //     deleted. The harness REFUSED it (0 occurrences), so it could not
  //     silently score nothing.
  //   - the job-wide `with:` disarm anchored on `'    if (!ALLOWED_JOB_WITH_KEYS…'`
  //     — four spaces. Round 3 deleted that site too, but the surviving per-step
  //     site is the SAME text at six spaces, and the 4-space string is a
  //     SUBSTRING of it. `indexOf` found it, `countOccurrences` said 1, and the
  //     row went on reding — against a line it was never written for, producing a
  //     mutated file byte-identical to the row below. Two rows, one mutation,
  //     `declared` inflated by one.
  //
  // See the header: an anchor made only of indentation is not unique.
  [
    SCRIPT,
    'the audit reads raw text, so a COMMENT can satisfy the required-input guard',
    "  const lines = blankYamlComments(workflowText).split('\\n');",
    "  const lines = workflowText.split('\\n');",
  ],
  // ── the extractor's undercounts (F4) ─────────────────────────────────────
  [
    SCRIPT,
    'F4: an image with a trailing YAML comment is silently dropped',
    // Re-anchored in round 4: comment stripping moved into the shared
    // `withoutTrailingComment` helper. Anchored on `imageOnLine`'s CALL SITE
    // rather than the helper body, so this row still proves the image rule
    // specifically and does not overlap the `documentKind` row below.
    '  const match = withoutTrailingComment(line).match(',
    '  const match = line.match(',
  ],
  [
    SCRIPT,
    'an image in an unscanned kind is silently skipped instead of reported',
    '  for (const unscanned of findUnscannedKindImages(body)) {',
    '  for (const unscanned of []) {',
  ],
  [
    WORKFLOW,
    'the workflow drops `persist-credentials: false` and keeps the runner token',
    '          persist-credentials: false',
    '          persist-credentials: true',
  ],
  // ── R3: every guard must hold at EVERY site, not the one that exists today ─
  [
    WORKFLOW,
    'R3 THE BUG: a SECOND checkout is added with no `with:` at all',
    // Deliberately ADDING a step rather than re-editing the existing one. Row 18
    // already re-edits the first checkout and reds; that is precisely the
    // mutation a job-wide "does the string appear anywhere" check survives, so
    // only a second site proves the rule is per-step.
    '        run: node scripts/verify-anonymous-install.mjs',
    '        run: node scripts/verify-anonymous-install.mjs\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  ],
  [
    SCRIPT,
    'the per-step checkout rule is disarmed',
    "    if (uses?.split('@')[0] === 'actions/checkout') {",
    '    if (false) {',
  ],
  [
    SCRIPT,
    'the per-step `with:` allowlist becomes a denylist of one literal',
    '      if (!ALLOWED_JOB_WITH_KEYS.has(key)) {',
    "      if (key === 'token') {",
  ],
  [
    SCRIPT,
    'the step parse returns nothing, making every per-step rule vacuous',
    'export function parseJobSteps(block) {',
    'export function parseJobSteps(block) {\n  return [];',
  ],
  [
    SCRIPT,
    'the top-level key scan stops recognising quoted / space-before-colon keys',
    '    const key = line.match(/^["\']?([\\w.-]+)["\']?\\s*:/)?.[1];',
    '    const key = line.match(/^([\\w.-]+):/)?.[1];',
  ],
  [
    SCRIPT,
    'the `env:` rule is re-anchored to end-of-line, so the inline form escapes',
    '  if (/^\\s*["\']?env["\']?\\s*:/m.test(block)) {',
    '  if (/^\\s*env:\\s*$/m.test(block)) {',
  ],
  // ── R4: every rule at every SPELLING, not just every site ─────────────────
  //
  // Each row below removes the tolerance for ONE spelling. They are written as
  // narrowings of the shared `yamlKey` primitive or of its callers, because a
  // rule that only handles the spelling this repo uses today is the shape that
  // has now defeated two rounds of review.
  [
    SCRIPT,
    'R4 THE BUG: `stepUses` stops recognising a QUOTED `uses:` key',
    "  const match = stepText.match(new RegExp(`^\\\\s*(?:-\\\\s+)?${yamlKey('uses')}(.*)$`, 'm'));",
    '  const match = stepText.match(/^\\s*(?:-\\s+)?uses\\s*:(.*)$/m);',
  ],
  [
    SCRIPT,
    'the shared key primitive stops tolerating quotes at ALL sites at once',
    'export function yamlKey(name) {\n  return `["\']?${name}["\']?[ \\\\t]*:`;',
    'export function yamlKey(name) {\n  return `${name}:`;',
  ],
  [
    SCRIPT,
    'the per-STEP fail-closed for an unreadable `uses` is removed',
    '    if (uses === null) {',
    '    if (false) {',
  ],
  [
    SCRIPT,
    '`container:`/`services:` goes back to being pinned at a 4-space indent',
    "    if (new RegExp(`^\\\\s+${yamlKey(key)}`, 'm').test(block)) {",
    "    if (new RegExp(`^ {4}${key}:`, 'm').test(block)) {",
  ],
  [
    SCRIPT,
    '`documentKind` stops stripping a trailing comment, dropping the document from BOTH scans',
    '  const value = unquote(withoutTrailingComment(line).trim());',
    '  const value = unquote(line.trim());',
  ],
  // Re-anchored in round 5, and SPLIT: `normaliseNewlines` now does two jobs, and
  // one row disarming both would let either behaviour rot behind the other.
  [
    SCRIPT,
    'CRLF normalisation is removed, blanking every `with:` entry on a correct workflow',
    "  return text.replace(/\\uFEFF/g, '').replace(/\\r\\n?/g, '\\n');",
    "  return text.replace(/\\uFEFF/g, '');",
  ],
  [
    SCRIPT,
    "BOM stripping is removed, hiding a BOM-prefixed document's `kind:`",
    "  return text.replace(/\\uFEFF/g, '').replace(/\\r\\n?/g, '\\n');\n}",
    "  return text.replace(/\\r\\n?/g, '\\n');\n}",
  ],
  // ── R5: the "neither bucket" — the blocking finding ───────────────────────
  [
    SCRIPT,
    'R5 THE BUG: an UNREADABLE kind is dropped by BOTH scans (neither scanned nor reported)',
    // Reinstates the exact pre-fix shape: `continue` on an unreadable kind, so
    // the document reaches neither bucket. Five spellings hit this, and each hid
    // an unpullable image behind zero findings and exit 0.
    '    (readable && WORKLOAD_KINDS.has(kind) ? workload : other).push({',
    '    if (!readable) continue;\n    (WORKLOAD_KINDS.has(kind) ? workload : other).push({',
  ],
  [
    SCRIPT,
    'the unscanned bucket stops being the COMPLEMENT and is re-derived independently',
    '  for (const doc of partitionDocuments(bundleText).other) found.push(...imagesInDocument(doc));',
    "  for (const doc of partitionDocuments(bundleText).other) {\n    if (doc.kind === '<unreadable>') continue;\n    found.push(...imagesInDocument(doc));\n  }",
  ],
  [
    OTHER_DOC,
    'a docs copy OUTSIDE the docs site drifts back to the #585 404 URL',
    'kubectl apply --server-side -f https://github.com/getknext-dev/knext/releases/download/operator-latest/install.yaml',
    'kubectl apply --server-side -f https://github.com/getknext-dev/knext/releases/latest/download/install.yaml',
  ],
  [
    WORKFLOW,
    'the anonymous job is granted a registry permission',
    '    permissions: {}',
    '    permissions:\n      packages: read',
  ],
  [
    WORKFLOW,
    'the job runs the check with --scrub, removing the credentials it must report',
    '        run: node scripts/verify-anonymous-install.mjs',
    '        run: node scripts/verify-anonymous-install.mjs --scrub',
  ],
  [
    WORKFLOW,
    'a registry login step nobody put on a denylist is added',
    '      - name: Checkout code',
    '      - name: Log in to GHCR\n        uses: docker/login-action@v3\n      - name: Checkout code',
  ],
];

/**
 * PREFLIGHT: no two rows may produce the same mutation.
 *
 * The header explains why an indentation-only anchor is not unique; this is that
 * lesson as a GATE rather than a comment, because the comment would not have
 * caught it either. Two rows here silently collapsed into one mutation after a
 * refactor re-indented their shared target — both went red, `declared` was
 * inflated by one, and nothing in the output could show it. `declared === run`
 * cannot detect this: the duplicate row runs, it just proves nothing new.
 *
 * Computed in memory, before anything touches disk, so a duplicate is reported
 * without a single file being mutated.
 */
function assertDistinctMutations() {
  const problems = [];
  const seen = new Map();
  for (const [file, label, anchor, replacement] of MUTATIONS) {
    const source = readFileSync(file, 'utf8');
    const occurrences = countOccurrences(source, anchor);
    if (occurrences !== 1) {
      problems.push(`"${label}": anchor occurs ${occurrences} times (expected exactly 1)`);
      continue;
    }
    const mutated = source.replace(anchor, () => replacement);
    if (mutated === source) {
      problems.push(`"${label}": substitution changes nothing`);
      continue;
    }
    const fingerprint = `${file} :: ${createHash('sha256').update(mutated).digest('hex')}`;
    if (seen.has(fingerprint)) {
      problems.push(
        `"${label}" produces a mutated file byte-identical to "${seen.get(fingerprint)}" — ` +
          'two rows, one mutation. Re-anchor on text, not indentation.',
      );
      continue;
    }
    seen.set(fingerprint, label);
  }
  if (problems.length > 0) {
    console.error('FATAL: mutation table preflight failed\n');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`Preflight: ${MUTATIONS.length} rows, all anchored once and all distinct.\n`);
}

assertDistinctMutations();

declareMutations(MUTATIONS.length);

let pass = 0;
let fail = 0;

function runSpec() {
  const result = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC, '')], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(ANSI, '');
  // Parse the summary LINE, then pull each count out of it. Matching
  // `/Tests\s+(\d+) passed/` against the whole output looks equivalent and is
  // not: vitest writes `Tests  1 failed | 60 passed` when anything fails, so the
  // `passed` group never matches on a red run and every disarm would report
  // "1 test ran" — an undercount that makes the `ran === 0` non-vacuity guard
  // read as almost-tripped on every single mutation.
  const summary = output.match(/Tests\s+(.+)/)?.[1] ?? '';
  // Both runners' formats (#902): vitest's `Tests N failed | M passed` line,
  // and bun test's ` N pass` / ` N fail` lines (forwarded by bun-test.mjs
  // under a -t filter, printed directly otherwise on failure output).
  const passed = Number(
    summary.match(/(\d+) passed/)?.[1] ?? output.match(/^\s*(\d+) pass\b/m)?.[1] ?? 0,
  );
  const failed = Number(
    summary.match(/(\d+) failed/)?.[1] ?? output.match(/^\s*(\d+) fail\b/m)?.[1] ?? 0,
  );
  return { ok: result.status === 0, ran: passed + failed };
}

console.log(`Baseline: ${SPEC} must be GREEN before anything is disarmed.`);
const baseline = runSpec();
if (baseline.ran === 0 || !baseline.ok) {
  console.error(`FATAL: ${SPEC} is not green to begin with (ran ${baseline.ran})`);
  process.exit(1);
}
console.log(`   ok baseline green (${baseline.ran} tests)\n`);

for (const [file, label, anchor, replacement] of MUTATIONS) {
  console.log(`── disarming: ${label}`);
  const snap = snapshot(file);
  try {
    mutate(snap, anchor, replacement);
    const { ok, ran } = runSpec();
    if (ran === 0) {
      // A spec that did not RUN is not a spec that went red. Reporting the
      // disarm as caught here would be the confidently-wrong diagnosis this
      // repo has already shipped several times.
      console.error(`   FATAL: no test ran in ${SPEC} under this mutation`);
      restore(snap);
      process.exit(1);
    }
    if (ok) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      fail += 1;
    } else {
      console.log(`   ok went RED as required (${ran} tests ran)`);
      pass += 1;
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!runSpec().ok) {
    console.error(`   FATAL: ${SPEC} did not go green again after restore`);
    process.exit(1);
  }
}

console.log(`\n${pass} disarm(s) went RED as required, ${fail} stayed green.`);
process.exit(fail === 0 ? 0 : 1);
