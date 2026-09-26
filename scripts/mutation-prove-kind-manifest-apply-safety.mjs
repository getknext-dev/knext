#!/usr/bin/env node
/**
 * Mutation proof for the kind-manifest apply-safety guard (#1289, #1410).
 *
 * `tests/kind-manifest-checksum-pin.test.ts` drives
 * `scripts/lib/apply-safety-scan.mjs` over every tracked script and workflow
 * and over one fixture set per reviewer bypass class, and drives
 * `scripts/kind-manifests/pin-known-images.sh` against evasive manifests.
 * Each mutation below removes ONE rule the spec claims to enforce and
 * requires the spec to go RED; the file is then restored byte-identically
 * and the spec must be GREEN again. Verdicts come from the spec's exit code
 * only — never from grepping its output.
 *
 * One mutation per bypass class the #1410 reviewer named (and per rule the
 * round-4 lexer added to close them):
 *   class 1 — fetch spellings / helpers:   M1 M2 M3
 *   class 2 — bare URLs / invokers / streams: M4 M5 M6
 *   class 3 — defeated or non-dominating checksum: M7 M8 M9 M10
 *   fail closed on the unclassifiable:      M11
 *   loopback exemption stays strict:       M12
 *   class 4 — pin-known-images evasions:    M13 M14
 *   round 5 — step shell / errexit:         M15 M16 M17 M18 M19 M20
 *   round 5 — unclassified remote fetch:    M21 … M31
 *   round 5 — pinned versions fail fast:    M32 M33 M34
 *   round 6 — loopback stays a taint source: M35 M36 M41 M42
 *   round 7 — a fetched value is never data:  M37 M38 (no scalar exemption),
 *             M39 M40 M43 M44 (each allowlist entry), M45 (prefix match),
 *             M46 (file key ignored)
 *
 * Usage:  node scripts/mutation-prove-kind-manifest-apply-safety.mjs
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCANNER = resolve(REPO_ROOT, 'scripts/lib/apply-safety-scan.mjs');
const PIN_SCRIPT = resolve(REPO_ROOT, 'scripts/kind-manifests/pin-known-images.sh');
const DRILL_SCRIPT = resolve(
  REPO_ROOT,
  'packages/kn-next-operator/test/e2e/szpg/setup-profile-b.sh',
);
const KNATIVE_SCRIPT = resolve(REPO_ROOT, 'scripts/kind-manifests/apply-knative-kourier.sh');
const SPEC = 'tests/kind-manifest-checksum-pin.test.ts';

declareMutations(46);

// Every subject must exist before anything is mutated: a missing one is a
// FATAL throw here, never a run of vacuous reds.
// (Spelled out, one call per subject: the prover-lane audit binds each
// subject by its `readFileSync(NAME, …)` call.)
readFileSync(SCANNER, 'utf8');
readFileSync(PIN_SCRIPT, 'utf8');
readFileSync(DRILL_SCRIPT, 'utf8');
readFileSync(KNATIVE_SCRIPT, 'utf8');

const RUNNER = resolveSpecRunner(REPO_ROOT, SPEC);

/** True when the spec PASSED. Exit code only — never grepped output. */
function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

let caught = 0;
let decorative = 0;

/** Applies one mutation to `file`, requires RED, restores, requires GREEN. */
function prove(label, file, anchor, replacement) {
  console.log(`── ${label}`);
  const snap = snapshot(file);
  try {
    mutate(snap, anchor, replacement);
    if (specPasses()) {
      console.log('   x DECORATION: the spec stayed GREEN with this rule removed');
      decorative += 1;
    } else {
      console.log('   ok went RED as required');
      caught += 1;
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses()) {
    console.error(`   FATAL: ${SPEC} did not go green again after restore`);
    process.exit(1);
  }
}

console.log('Baseline: the spec must be GREEN before anything is mutated.');
if (!specPasses()) {
  console.error(`FATAL: ${SPEC} is not green to begin with`);
  process.exit(1);
}
console.log('   ok baseline green\n');

// class 1 — fetch spellings / helpers
prove(
  'M1 class 1: fetch output flags (-o/-fsSLo/--output=/-O/wget) no longer recorded',
  SCANNER,
  '    if (!isFetch) continue;',
  '    if (!isFetch || true) continue;',
);
prove(
  'M2 class 1: helper functions no longer inlined at their call sites',
  SCANNER,
  '  walk(substituteArgs(body, argVals), st, callCtx);',
  '  void callCtx;',
);
prove(
  'M3 class 1: files a fetch writes are no longer tainted',
  SCANNER,
  '      for (const p of writtenPaths(ws, st, isFetch)) {',
  '      for (const p of []) {',
);

// class 2 — bare URLs / invokers / streams
prove(
  'M4 class 2: apply recognised only after a literal `kubectl`',
  SCANNER,
  '    if (APPLY_VERBS.has(ws[k])) {',
  "    if (APPLY_VERBS.has(ws[k]) && ws[k - 1] === 'kubectl') {",
);
prove(
  'M5 class 2: a URL (or URL variable) apply target is no longer rejected',
  SCANNER,
  '  if (URL_RE.test(c) || varRefs(raw).some((r) => st.vars.get(r)?.url)) {',
  '  if (false) {',
);
prove(
  'M6 class 2: a stdin apply fed by network content is no longer rejected',
  SCANNER,
  '    if (why) offend(st, `stdin apply fed by network content (${why})`, clause);',
  '    void why;',
);

// class 3 — defeated or non-dominating checksum
prove(
  'M7 class 3: a checksum run without errexit (set +e / no set -e) counts',
  SCANNER,
  '      !st.errexit ||',
  '      false ||',
);
prove(
  'M8 class 3: a checksum that is not the head of its && list counts',
  SCANNER,
  "      endsChain: !['&&', '||'].includes(cl.sepAfter) && ci === chainStart,",
  "      endsChain: !['&&', '||'].includes(cl.sepAfter),",
);
prove(
  'M9 class 3: a checksum of ANY file clears every fetched file',
  SCANNER,
  '  if (hits.length > 0) {',
  '  if (hits.length > 0 && st.verified.size === 0) {',
);
prove(
  'M10 class 3: a checksum inside a control block covers applies outside it',
  SCANNER,
  "  return v.block === '' || here === v.block || here.startsWith(`${v.block}/`);",
  '  return true;',
);

// fail closed
prove(
  'M11 fail closed: a stdin apply with no producer passes',
  SCANNER,
  "      offend(st, 'unclassifiable stdin apply (no producer in this source)', clause);",
  '      void clause;',
);

// loopback exemption strictness
prove(
  'M12 loopback: a URL nested inside a loopback URL is treated as loopback',
  SCANNER,
  "  return LOOPBACK_URL.test(u) && u.split('://').length === 2 && !/\\$/.test(u.split('/')[2]);",
  "  return LOOPBACK_URL.test(u) && !/\\$/.test(u.split('/')[2]);",
);

// class 4 — pin-known-images evasions
prove(
  'M13 class 4: only the FIRST image key on a line is judged',
  PIN_SCRIPT,
  '  while [[ "$rest" =~ $image_key_re ]]; do',
  '  for _once in 1; do [[ "$rest" =~ $image_key_re ]] || break',
);
prove(
  'M14 class 4: any value merely containing "@sha256:" counts as pinned',
  PIN_SCRIPT,
  'digest_pinned() { [[ "$1" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]]; }',
  'digest_pinned() { [[ "$1" == *@sha256:* ]]; }',
);

// round 5, finding 1 — the step's effective shell decides errexit
prove(
  'M15 shell: a custom step shell without -e (`bash {0}`) still counts as errexit',
  SCANNER,
  '  let errexit = false;',
  '  let errexit = true;',
);
prove(
  'M16 shell: workflow-level defaults.run.shell is ignored',
  SCANNER,
  '    doc?.defaults?.run?.shell ??',
  '    undefined ??',
);
prove(
  'M17 shell: job-level defaults.run.shell is ignored',
  SCANNER,
  '    job?.defaults?.run?.shell ??',
  '    undefined ??',
);
prove(
  'M18 shell: a non-POSIX step shell (pwsh/python) is scanned as bash instead of unclassifiable',
  SCANNER,
  "  if (!EXEC_STRING_SHELLS.has(ws[0].split('/').pop()) || /\\$\\{\\{/.test(s)) return null;",
  "  if (!EXEC_STRING_SHELLS.has(ws[0].split('/').pop()) || /\\$\\{\\{/.test(s)) return true;",
);
prove(
  'M19 shell: a checksum step with continue-on-error still covers later steps',
  SCANNER,
  "  if (truthyKey(step['continue-on-error'])) return false;",
  '  void truthyKey;',
);
prove(
  'M20 shell: a checksum step with an if: still covers later steps',
  SCANNER,
  '  if (step.if !== undefined) return false;',
  '  void step;',
);

// round 5, finding 2 — unclassified remote fetches
prove(
  'M21 remote: an interpreter fetching in-process (python -c urllib, node -e fetch) passes',
  SCANNER,
  "  if (INTERPRETERS.has(b) && INTERPRETER_FETCH.test(args.join(' '))) return interpreterFetch(b);",
  '  void interpreterFetch;',
);
prove(
  'M22 remote: an interpreter program fed by heredoc (node - <<JS … fetch) passes',
  SCANNER,
  '        else if (INTERPRETER_FETCH.test(body))',
  '        else if (false)',
);
prove(
  'M23 remote: git clone passes',
  SCANNER,
  "  if (b === 'git' && gitFetches(args)) return 'git fetches a remote repository';",
  '  void gitFetches;',
);
prove(
  'M24 remote: gh release download passes',
  SCANNER,
  "  if (b === 'gh' && ghDownloads(args)) return 'gh downloads a release/repo/run artifact';",
  '  void ghDownloads;',
);
prove(
  'M25 remote: helm from a remote chart URL or an added repo passes',
  SCANNER,
  "  if (b === 'helm' && helmFetches(args)) return 'helm pulls a remote chart or repo index';",
  '  void helmFetches;',
);
prove(
  'M26 remote: curl | sh / wget | bash passes',
  SCANNER,
  '  if (pipedFromNetwork && runsStdinAsCode(b, args)) return `${b} executes piped network content`;',
  '  void pipedFromNetwork;',
);
prove(
  'M27 remote: bash <(curl …) / sh -c "$(curl …)" passes',
  SCANNER,
  '  if (runsNetworkCode(b, rawArgs, st, depth)) return `${b} executes network content`;',
  '  void runsNetworkCode;',
);
prove(
  'M28 remote: a heredoc fed to ssh / docker exec / a shell is not scanned as a script',
  SCANNER,
  '          walkScript(body, st, { ...ctx, defeated: verifyDefeated, depth: ctx.depth + 1 });',
  '          void walkScript;',
);
prove(
  "M29 remote: a sourced file's functions are not followed",
  SCANNER,
  '  for (const [n, fn] of sourcedFns) if (!st.functions.has(n)) st.functions.set(n, fn);',
  '  void sourcedFns;',
);
prove(
  'M30 remote: a URL call into an unresolvable sourced file passes',
  SCANNER,
  '      if (unresolvedCallWithUrl(ws, st))',
  '      if (false)',
);
prove(
  'M31 remote: allowlist matches are no longer counted (the exactly-once check goes blind)',
  SCANNER,
  '    st.allowHits?.set(entry.id, (st.allowHits.get(entry.id) ?? 0) + 1);',
  '    void entry;',
);

// round 5, finding 3 — pinned versions fail fast, by name
prove(
  'M32 pins: the szpg drill no longer rejects a version override up front',
  DRILL_SCRIPT,
  '  check_pinned_versions\n  preflight',
  '  preflight',
);
prove(
  'M33 pins: apply-knative-kourier.sh no longer rejects an unpinned version by name',
  KNATIVE_SCRIPT,
  'if [ "$KNATIVE_VERSION" != "$PINNED_KNATIVE_VERSION" ]; then',
  'if false; then',
);
prove(
  'M34 pins: the drill resolves REPO_ROOT one level too shallow again (packages/)',
  DRILL_SCRIPT,
  'OPERATOR_DIR="$(cd "$HERE/../../.." && pwd)"',
  'OPERATOR_DIR="$(cd "$HERE/../.." && pwd)"',
);

// round 6 — a loopback fetch is still a taint source
prove(
  'M35 loopback: a fetch whose every URL is loopback is no longer a taint source',
  SCANNER,
  '    if (!FETCH_WORDS.has(base)) continue;',
  `    if (!FETCH_WORDS.has(base)) continue;
    if (ws.some((a) => /:\\/\\//.test(a)) && ws.filter((a) => /:\\/\\//.test(a)).every(isLoopbackUrl)) continue;`,
);
prove(
  'M36 loopback: git fetch of a loopback URL is exempt from the remote-fetch rule',
  SCANNER,
  'const hasRemoteArg = (args) => args.some((a) => REMOTE_ARG_RE.test(a));',
  'const hasRemoteArg = (args) => args.some((a) => REMOTE_ARG_RE.test(a) && !isLoopbackUrl(a));',
);
prove(
  'M37 no scalar exemption: a variable interpolated into a heredoc is data, not the document',
  SCANNER,
  'for (const m of body.matchAll(/\\$\\{?([A-Za-z_]\\w*)\\}?/g)) bits.push(`echo "$${m[1]}"`);',
  'for (const m of body.matchAll(/\\$\\{?([A-Za-z_]\\w*)\\}?/g)) bits.push(`: "$${m[1]}"`);',
);
prove(
  'M38 no scalar exemption: a fetched variable is only network content where a command emits it',
  SCANNER,
  '          if (st.vars.get(r)?.content) return `variable $${r} holds network content`;',
  '          if (st.vars.get(r)?.content && ws.some((x) => /^(echo|printf|cat)$/.test(unquote(x)))) return `variable $${r} holds network content`;',
);
prove(
  'M41 clone: a clone of a local path is flagged as remote',
  SCANNER,
  "  if (sub === 'clone') return !cloneSourceIsLocalPath(rest);",
  "  if (sub === 'clone') return true;",
);
prove(
  'M42 clone: any clone source counts as a local path',
  SCANNER,
  "  return source !== '' && !/:\\/\\//.test(source) && !/^[^/]*:/.test(source) && !/[$`]/.test(source);",
  '  return true;',
);

// round 7 — the statement allowlist: exactly four named sites, byte-exact, per file
prove(
  'M39 allowlist: the _verify-objstore.sh entry is dropped',
  SCANNER,
  "    file: 'packages/scale-zero-pg/deploy/_verify-objstore.sh',",
  "    file: 'packages/scale-zero-pg/deploy/dropped.sh',",
);
prove(
  'M40 allowlist: the _verify-restore.sh entry is dropped',
  SCANNER,
  "    file: 'packages/scale-zero-pg/deploy/_verify-restore.sh',",
  "    file: 'packages/scale-zero-pg/deploy/dropped.sh',",
);
prove(
  'M43 allowlist: the _verify-app-restore.sh entry is dropped',
  SCANNER,
  "    file: 'packages/scale-zero-pg/deploy/_verify-app-restore.sh',",
  "    file: 'packages/scale-zero-pg/deploy/dropped.sh',",
);
prove(
  'M44 allowlist: the _restore-writable.sh entry is dropped',
  SCANNER,
  "    file: 'packages/scale-zero-pg/deploy/_restore-writable.sh',",
  "    file: 'packages/scale-zero-pg/deploy/dropped.sh',",
);
prove(
  'M45 allowlist: an entry matches by PREFIX instead of the whole statement',
  SCANNER,
  'e.file === st.file && e.statement === stmt',
  'e.file === st.file && stmt.startsWith(e.statement.slice(0, 60))',
);
prove(
  'M46 allowlist: an entry is honoured in ANY file (the file key is ignored)',
  SCANNER,
  'e.file === st.file && e.statement === stmt',
  'e.statement === stmt',
);

console.log(`\n${caught} caught, ${decorative} undetected.`);
if (decorative > 0) {
  console.error(
    'At least one apply-safety rule is decoration — the spec does not notice it removed.',
  );
  process.exit(1);
}
