import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * scripts/e2e-native-rebuild-musl.sh (#1257 round 7) — every REAL
 * package-manager invocation (npm/npx/pnpm/yarn/bun) in this script must
 * run as the unprivileged `run_as_builder` wrapper, not root — that is the
 * whole point of round 7's non-root fix (see the script's own header).
 *
 * Round-3 review finding (techdebt-4): the ORIGINAL scan only matched
 * `npm ci`/`npm install` immediately after a narrow set of preceding
 * syntax (start of line, `&&`, `;`, `(`, or `run_as_builder`), which missed
 * every one of:
 *   - an invocation after `||`, `then`, or `do`;
 *   - a leading env assignment (`FOO=1 npm ci`, `env A=1 npm install`);
 *   - `npm --prefix x install`, `npm rebuild`, `npm clean-install`, `npm in`;
 *   - an invocation behind `command`/`exec`;
 *   - pnpm, yarn, `bun install`, npx.
 *
 * Fixed structurally rather than patched shape-by-shape: this now flags
 * ANY non-comment line containing `\b(npm|npx|pnpm|yarn|bun)\b` as a real
 * token, regardless of what precedes it. Scanning this broadly needs an
 * explicit exclusion for the lines that legitimately mention one of these
 * words without invoking it — an `echo`/log line (a message string, never
 * a real invocation in this script — excluded by a GENERAL rule, not
 * enumerated per message) and the one line that installs `npm` itself as
 * an apk PACKAGE NAME (an explicit, named allowlist entry, asserted to
 * appear in the real script EXACTLY ONCE so it cannot silently drift).
 *
 * This is a SCAN, not an enumerated list of line numbers (workflow.md's
 * "prefer scanning to enumerating" rule) — a NEW invocation added later
 * without `run_as_builder`, in ANY shape, must fail this test.
 */
const REPO_ROOT = resolve(import.meta.dir, '..');
const SCRIPT_PATH = resolve(REPO_ROOT, 'scripts/e2e-native-rebuild-musl.sh');

const PACKAGE_MANAGER_WORD_RE = /\b(npm|npx|pnpm|yarn|bun)\b/;

/**
 * Lines KNOWN not to be a real package-manager invocation despite
 * containing one of the words above. Each entry is asserted, against the
 * REAL script, to occur EXACTLY ONCE — a stale, duplicated, or since-removed
 * allowlist entry fails this test loudly rather than silently widening (or
 * narrowing) what the scan excludes.
 */
const NON_INVOCATION_ALLOWLIST = [
  // The apk TOOLCHAIN install — "npm" here is an apk PACKAGE NAME (the
  // pinned Alpine base ships bun only, no npm binary at all — see the
  // script's own header), never a package-manager invocation.
  'apk add --no-cache python3 make g++ npm su-exec >/dev/null',
];

function isAllowlistedNonInvocation(text: string): boolean {
  return NON_INVOCATION_ALLOWLIST.some((entry) => text.includes(entry));
}

/** Every non-comment, non-echo, non-allowlisted line that mentions a package-manager word as a real token. */
function packageManagerMentionLines(source: string): { line: number; text: string }[] {
  return source
    .split('\n')
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => {
      const trimmed = text.trim();
      if (trimmed.startsWith('#')) return false; // comment/prose
      if (trimmed.startsWith('echo ')) return false; // a message string, never a real invocation here
      if (isAllowlistedNonInvocation(trimmed)) return false;
      return PACKAGE_MANAGER_WORD_RE.test(trimmed);
    });
}

/**
 * Whether a package-manager mention line is actually wrapped by
 * `run_as_builder` — checked against the CODE portion of the line only
 * (everything before an unquoted trailing `#`), so a comment that merely
 * NAMES the wrapper after the command cannot make an unguarded command
 * read as guarded.
 */
function isGuardedByRunAsBuilder(text: string): boolean {
  const codePortion = text.split('#')[0] ?? text;
  return /\brun_as_builder\b/.test(codePortion);
}

function offendersOf(source: string): { line: number; text: string }[] {
  return packageManagerMentionLines(source).filter(({ text }) => !isGuardedByRunAsBuilder(text));
}

describe('every real package-manager invocation runs via run_as_builder — broad word-boundary scan (#1257 round 7, review round 3)', () => {
  it('finds package-manager mention lines at all — the scan must not pass vacuously', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    expect(packageManagerMentionLines(source).length).toBeGreaterThan(0);
  });

  it('every package-manager mention line in the real script contains run_as_builder', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    expect(offendersOf(source)).toEqual([]);
  });

  it('every allowlist entry appears in the real script EXACTLY ONCE', () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8');
    for (const entry of NON_INVOCATION_ALLOWLIST) {
      const count = source.split(entry).length - 1;
      expect(count).toBe(1);
    }
  });

  it('catches an npm invocation after `||`', () => {
    expect(offendersOf('true || npm ci --no-audit').length).toBe(1);
  });

  it('catches an npm invocation after `then`/`do`', () => {
    expect(offendersOf('if true; then npm ci --no-audit; fi').length).toBe(1);
    expect(offendersOf('for x in 1; do npm ci --no-audit; done').length).toBe(1);
  });

  it('catches a leading env-assignment npm invocation (FOO=1 npm ci / env A=1 npm install)', () => {
    expect(offendersOf('FOO=1 npm ci --no-audit').length).toBe(1);
    expect(offendersOf('env A=1 npm install --no-save').length).toBe(1);
  });

  it('catches npm subcommands other than ci/install (--prefix, rebuild, clean-install, in)', () => {
    for (const line of [
      'npm --prefix x install',
      'npm rebuild',
      'npm clean-install',
      'npm in --no-audit',
    ]) {
      expect(offendersOf(line).length).toBe(1);
    }
  });

  it('catches an invocation behind `command`/`exec`', () => {
    expect(offendersOf('command npm ci --no-audit').length).toBe(1);
    expect(offendersOf('exec npm ci --no-audit').length).toBe(1);
  });

  it('catches pnpm, yarn, bun install, and npx invocations too, not just npm', () => {
    for (const line of ['pnpm install', 'yarn install', 'bun install', 'npx something']) {
      expect(offendersOf(line).length).toBe(1);
    }
  });

  it('the scan correctly distinguishes a guarded line from an unguarded one (fixture proof)', () => {
    const guarded = 'if ! (cd x && run_as_builder npm ci --no-audit); then';
    const unguarded = 'if ! (cd x && npm ci --no-audit); then';
    expect(packageManagerMentionLines(guarded).length).toBe(1);
    expect(packageManagerMentionLines(unguarded).length).toBe(1);
    expect(offendersOf(guarded).length).toBe(0);
    expect(offendersOf(unguarded).length).toBe(1);
  });

  it('a comment mentioning "npm install" in prose is not counted as an invocation', () => {
    const prose = "  # every `npm install`/`npm ci` call is su-exec'd to that user";
    expect(packageManagerMentionLines(prose)).toEqual([]);
  });

  it('an echo/log line mentioning npm in its message is not counted as an invocation', () => {
    const echoLine =
      '      echo "[native-rebuild] WARNING: reproducible \'npm ci\' of \\${_spec} failed"';
    expect(packageManagerMentionLines(echoLine)).toEqual([]);
  });

  it('the allowlisted apk-toolchain-install line is not counted as an invocation (npm is an apk PACKAGE NAME there)', () => {
    const line = 'apk add --no-cache python3 make g++ npm su-exec >/dev/null';
    expect(packageManagerMentionLines(line)).toEqual([]);
  });

  it('a trailing "# run_as_builder" comment on an otherwise-unguarded line does NOT count as guarding it', () => {
    const trickLine = 'if ! (cd x && npm ci --no-audit); then # run_as_builder';
    expect(offendersOf(trickLine).length).toBe(1);
  });

  it('a genuinely guarded line with an UNRELATED trailing comment is still recognized as guarded', () => {
    const guardedWithComment = 'if ! (cd x && run_as_builder npm ci --no-audit); then # some note';
    expect(offendersOf(guardedWithComment).length).toBe(0);
  });
});
