import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AVAILABLE_BUILDERS, BUILDERS } from '../packages/kn-next/src/adapters/artifact-contract';
import { codeStringLiterals } from '../scripts/lib/prover-lane.mjs';

/**
 * The two §4.2 residuals the sprint-1 close left standing, converted from prose
 * findings into scans (sprint 2, lane G).
 *
 * Both are the same defect shape: a statement about the toolchain that was true
 * when it was written, is false now, and is load-bearing for whoever reads it.
 * Neither was caught by anything, because nothing looked.
 *
 *   1. `apps/file-manager/scripts/compat-smoke.mjs` tells a developer whose
 *      build is missing to run `pnpm --filter … build`. The workspace deleted
 *      pnpm this sprint, so that instruction cannot work: the reader follows it,
 *      gets `command not found`, and the real fix (`bun run --filter`) is
 *      nowhere on screen.
 *
 *   2. `packages/kn-next/src/cli/validate.ts` justifies `checkPairing` being
 *      exported-but-unreachable with "with only `turbopack` available today".
 *      `turbopack` is `available: false` (ADR-0048) and `vinext` is the default,
 *      so the justification is exactly inverted — and the pairing it calls
 *      inexpressible (`vinext` + `node`) is expressible and reached from
 *      `validateConfig`.
 *
 * SCANNED, NOT ENUMERATED, in both halves. A list of the two known sites is how
 * the third one gets missed: (1) globs every tracked workspace script, and (2)
 * derives the expected builder id from the contract's own `available` flags, so
 * the day a second builder ships the prose has to move or this reds.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

const tracked = (...pathspecs: string[]) =>
  execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();

const read = (relPath: string) => readFileSync(resolve(REPO_ROOT, relPath), 'utf8');

/**
 * A `pnpm` invocation that drives THIS workspace — a COMMAND, by position.
 *
 * Position rather than substring, for the reason `shell-command-position.mjs`
 * exists one axis over: a substring scan cannot tell an instruction from a
 * mention, and the tree contains both. `prover-lane.mjs:359` renders the
 * sentence "… `pnpm exec` resolves nothing in a tree without its own
 * node_modules" into a finding message — that is the anti-pattern being NAMED,
 * and flagging it would force the scan to be weakened until it found nothing.
 *
 * So `pnpm` must sit where a reader would COPY it: at the start of the literal,
 * at the start of a line inside it, or after a `&&`. `pnpm-lock.yaml` as a path
 * and prose discussing the migration are both out of scope by construction, and
 * no allowlist is needed to keep them out.
 *
 * What this deliberately does NOT cover, stated rather than implied: a pnpm
 * command embedded mid-line in a YAML fragment (`version-script: pnpm run …`).
 * Those live in `mutation-prove-release-lane.mjs` as PLANTED text — mutations
 * whose whole purpose is to be wrong — and are handled by that prover following
 * its subject (#912), not by widening this regex until it fires on them.
 */
const WORKSPACE_PNPM = /(?:^|\n|&&)[ \t]*pnpm\s+(?:--filter\b|install\b|run\b|exec\b|add\b)/;

/**
 * The scripts a developer is instructed BY. Their string literals are read as
 * instructions; their comments are not.
 *
 * `.github/workflows` is excluded on purpose and the reason is specific: the
 * next.js compatibility harness is a pnpm workspace of its own (next.js's repo
 * uses pnpm), so `compat-suite.yml` legitimately runs pnpm against a tree that
 * is not ours. Widening this scan to workflows would have to carve that out,
 * and a scan with a carve-out is one edit away from a scan with two.
 */
const SCRIPT_PATHSPECS = ['scripts/*.mjs', 'scripts/lib/*.mjs', 'apps/*/scripts/*.mjs'];

describe('§4.2 the workspace no longer instructs anyone through pnpm', () => {
  const files = tracked(...SCRIPT_PATHSPECS);

  it('finds workspace scripts to scan at all (non-vacuity)', () => {
    // Without this, an empty pathspec would make the scan below pass by
    // examining nothing — the vacuous-green shape this whole lane exists for.
    expect(files.length).toBeGreaterThan(10);
  });

  it('no tracked workspace script carries a runnable pnpm instruction', () => {
    const findings: string[] = [];
    for (const relPath of files) {
      const source = read(relPath);
      for (const literal of codeStringLiterals(source)) {
        const hit = WORKSPACE_PNPM.exec(literal);
        if (hit) findings.push(`${relPath}: ${JSON.stringify(hit[0])}`);
      }
    }
    expect(
      findings,
      `pnpm left the workspace; these still tell a reader to run it:\n  ${findings.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the scan reads string literals, not comments (it can tell the two apart)', () => {
    // The other half of the guard: a scan that could not distinguish an
    // instruction from a note about the migration would have to be weakened
    // until it found nothing, which is how this class of guard dies.
    const commented = '// we used to run `pnpm --filter x build` here\nconst a = 1;\n';
    expect(codeStringLiterals(commented).some((s) => WORKSPACE_PNPM.test(s))).toBe(false);
    const instructed = "const hint = '  pnpm --filter x build';\n";
    expect(codeStringLiterals(instructed).some((s) => WORKSPACE_PNPM.test(s))).toBe(true);
    // …and a MENTION in a code-position literal is still not an instruction,
    // which is the half that keeps `prover-lane.mjs`'s diagnostic legal.
    const mentioned = "const msg = 'resolve the runner instead; `pnpm exec` resolves nothing';\n";
    expect(codeStringLiterals(mentioned).some((s) => WORKSPACE_PNPM.test(s))).toBe(false);
  });
});

describe("§4.2 compat-smoke's default artifact is the one CI actually runs", () => {
  /**
   * The sprint-1 finding was that `SERVER_PATH` defaulted to the standalone
   * `server.js` — a build ADR-0048 retired — and that nothing noticed because
   * `ci.yml` overrides the variable on every invocation. A default only a human
   * can reach, pointing at an artifact that is not produced, is worse than no
   * default: it sends the one reader without CI's context to a missing file.
   *
   * So the two are TIED, by basename, in both directions. Moving either without
   * the other reds. Basename rather than full path because CI's is an absolute
   * `${{ github.workspace }}/…` expression and the script's is resolved from
   * `import.meta.url`; the shared fact is which artifact is named.
   */
  const SMOKE = 'apps/file-manager/scripts/compat-smoke.mjs';
  const CI = '.github/workflows/ci.yml';

  const ciSmokeArtifact = () => {
    const workflow = read(CI);
    const match = /SERVER_PATH:\s*\$\{\{\s*github\.workspace\s*\}\}\/(\S+)/.exec(workflow);
    return match ? (match[1] as string).split('/').pop() : undefined;
  };

  const smokeDefaultArtifact = () => {
    const source = read(SMOKE);
    const match =
      /const SERVER_PATH\s*=\s*process\.env\.SERVER_PATH\s*\|\|\s*path\.resolve\(\s*APP_DIR,\s*'([^']+)'/.exec(
        source,
      );
    return match ? (match[1] as string).split('/').pop() : undefined;
  };

  it('ci.yml names an artifact for the compat-smoke job (non-vacuity)', () => {
    expect(ciSmokeArtifact()).toBeDefined();
  });

  it('compat-smoke.mjs has a parseable SERVER_PATH default (non-vacuity)', () => {
    expect(smokeDefaultArtifact()).toBeDefined();
  });

  it('the default and the CI override name the same artifact', () => {
    expect(smokeDefaultArtifact()).toBe(ciSmokeArtifact() as string);
  });

  it('the default is not the retired standalone server', () => {
    // Stated separately from the tie above: if someone ever changed BOTH back to
    // `server.js` the tie would still hold, and this is the half that would not.
    expect(smokeDefaultArtifact()).not.toBe('server.js');
  });
});

describe('§4.2 an "only X available today" claim names the builder that IS available', () => {
  /**
   * Any prose in the CLI/adapter sources that pins itself to the one available
   * builder. The id is CAPTURED, never assumed, so the assertion below compares
   * what the prose says against what the contract does.
   */
  const AVAILABILITY_CLAIM = /only\s+`?([a-z][a-z0-9-]*)`?\s+(?:is\s+)?available\b/gi;
  const files = tracked('packages/kn-next/src/cli/*.ts', 'packages/kn-next/src/adapters/*.ts');
  const builderIds = new Set(BUILDERS.map((b) => b.id as string));

  it('the contract has exactly one available builder (the claim shape is meaningful)', () => {
    expect(AVAILABLE_BUILDERS.map((b) => b.id)).toEqual(['vinext']);
  });

  /**
   * A JSDoc block wraps, and the continuation marker is ` * `. Stripping it is
   * required, not cosmetic: the live defect is spelled `with only\n * \`turbopack\`
   * available today`, and a scan that did not unwrap it found nothing — which is
   * how the first version of this guard passed against the very line it was
   * written for.
   */
  const unwrapComments = (source: string) =>
    source.replace(/\n[ \t]*\*[ \t]?/g, '\n').replace(/\s*\n\s*/g, ' ');

  it('every availability claim in the sources names it', () => {
    const available = AVAILABLE_BUILDERS.map((b) => b.id as string);
    const findings: string[] = [];
    for (const relPath of files) {
      const source = unwrapComments(read(relPath));
      for (const match of source.matchAll(AVAILABILITY_CLAIM)) {
        const claimed = (match[1] ?? '').toLowerCase();
        // Only builder ids are in scope; "only bun available" is about runtimes.
        if (!builderIds.has(claimed)) continue;
        if (!available.includes(claimed)) {
          findings.push(`${relPath}: claims "${match[0]}" but ${claimed} is available: false`);
        }
      }
    }
    expect(findings, findings.join('\n  ')).toEqual([]);
  });
});
