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

describe('no surviving prose claims compat-smoke can skip a capability check', () => {
  /**
   * The "no self-skipping guard survives" sweep (sprint 2, lane G), and the half
   * that was still open.
   *
   * The CODE half has been closed for a while: check (g)'s two `skip()` paths are
   * gone and `tests/compat-smoke-capability-checks.test.ts` SCANS the runner, so
   * reintroducing one reds CI.
   *
   * The PROSE half was not. `ci.yml` described compat-smoke check 'g' in the
   * present tense as something that "skip()s on non-200 so a no-bucket CI stays
   * green" — a mechanism that no longer exists. That is not cosmetic: a comment
   * presenting a skip as the established behaviour of a neighbouring gate reads
   * as licence to add one, and the compat rows are precisely where this repo has
   * been burned by capability checks that skip rather than fail.
   *
   * TIED TO THE CODE, not to a list. The rule is conditional — IF the runner has
   * no skip mechanism, THEN nothing may say it does — so the day someone
   * deliberately adds one back this guard stops firing and the capability-checks
   * guard takes over. The two cannot both be satisfied by the same wrong answer.
   *
   * ROUND 1 OF THIS GUARD WAS DECORATION, and it is worth recording how. It
   * excluded any line matching `/\b(no|never|not|cannot|reds|refus)/i` on the
   * theory that a sentence about the ABSENCE of a skip is the assertion rather
   * than a finding. The stale sentence contains the words "no-bucket", so `\bno`
   * matched and the guard passed against the exact line it was written for —
   * caught only by mutating it back in. The exclusions below are whole phrases.
   */
  const RUNNER = 'apps/file-manager/scripts/compat-smoke.mjs';

  /**
   * A file's text as CONTIGUOUS BLOCKS, so a sentence spanning two comment lines
   * is one string.
   *
   * Runs of consecutive comment-ish lines (`#`, `//`, ` * `) are joined with a
   * space, their markers stripped; any other line stands alone. That is enough
   * for the wrap this exists to catch without collapsing the whole file into one
   * haystack, which would let an unrelated "compat-smoke" a hundred lines from
   * an unrelated "skip()" read as a claim.
   */
  const commentBlocks = (text: string): string[] => {
    const out: string[] = [];
    let run: string[] = [];
    const flush = () => {
      if (run.length > 0) out.push(run.join(' '));
      run = [];
    };
    for (const line of text.split('\n')) {
      const comment = /^\s*(?:#|\/\/|\*)\s?(.*)$/.exec(line);
      if (comment) {
        run.push((comment[1] ?? '').trim());
      } else {
        flush();
        out.push(line);
      }
    }
    flush();
    return out;
  };

  /**
   * Every place a file CLAIMS compat-smoke can skip, as the text around the claim.
   *
   * Three rounds got this wrong in three different ways, so the reasoning is
   * recorded rather than the final regex alone:
   *
   *   1. LINE-SCOPED missed the wrap. A sentence broken across two comment lines
   *      put "compat-smoke" on one and "skip()s" on the next; both tests passed
   *      with the claim fully intact. Proved by planting it.
   *   2. JOINING WHOLE RUNS fixed that and broke the other end: one
   *      absence-phrase anywhere in a long paragraph excused every claim inside
   *      it. The wrap was planted INSIDE the corrected paragraph — which says
   *      "are gone" — and the scan went green again.
   *   3. SENTENCE-SPLITTING needed to guess where sentences end, and comments
   *      wrap mid-sentence with lowercase continuations, so the guess was wrong
   *      immediately.
   *
   * PROXIMITY, not punctuation. Comment runs are joined (fixing 1), then the
   * exclusion is judged only on the text AROUND the two tokens (fixing 2), with
   * no sentence boundaries to get wrong (fixing 3). The window is generous
   * enough to hold a real disclaimer and far too small to reach a paragraph
   * away.
   */
  /**
   * Phrases that make a mention a statement about ABSENCE. Whole phrases, never
   * bare words: `no` alone matched "no-bucket" and neutered round 1 of this guard.
   */
  const ABOUT_ABSENCE =
    /\b(no longer|does not|do not|must not|cannot|never|is gone|are gone|reds|refuses|removed|previously described|used to)\b/i;

  /**
   * How far a `skip()` may sit from a `compat-smoke` and still be about it, and
   * how much text either side counts as the claim's own wording.
   */
  const CLAIM_REACH = 200;
  const CLAIM_MARGIN = 40;
  const skipClaims = (text: string): string[] => {
    const claims: string[] = [];
    for (const block of commentBlocks(text)) {
      const verbs = [...block.matchAll(/\bskip\(\)?s?\b/g)].map((m) => m.index ?? 0);
      for (const subject of block.matchAll(/compat-smoke/g)) {
        const at = subject.index ?? 0;
        // The NEAREST skip(), so an unrelated one far down the paragraph neither
        // creates a claim nor drags in wording that would excuse one.
        const verb = verbs.map((v) => ({ v, d: Math.abs(v - at) })).sort((a, b) => a.d - b.d)[0];
        if (!verb || verb.d > CLAIM_REACH) continue;
        // THE SPAN BETWEEN THE TWO TOKENS, plus a small margin, is the claim.
        // Judging a fixed window around the subject instead reached into the
        // ADJACENT corrected paragraph, whose "previously described" excused the
        // planted claim — measured, and the third way this scan has been wrong.
        const from = Math.max(0, Math.min(at, verb.v) - CLAIM_MARGIN);
        const to = Math.min(
          block.length,
          Math.max(at + 'compat-smoke'.length, verb.v) + CLAIM_MARGIN,
        );
        const claim = block.slice(from, to);
        if (ABOUT_ABSENCE.test(claim)) continue;
        claims.push(claim);
      }
    }
    return claims;
  };

  it('the runner really has no skip mechanism (the premise of the scan below)', () => {
    // Non-vacuity, and the conditional's antecedent. If this ever fails, the
    // scan below is meaningless and must not silently keep passing.
    expect(readFileSync(resolve(REPO_ROOT, RUNNER), 'utf8')).not.toMatch(/\bskip\s*\(/);
  });

  it('no tracked file says compat-smoke skips', () => {
    const files = tracked('.github/workflows/*.yml', 'docs/**/*.md', 'scripts/*.mjs', 'tests/*.ts');
    expect(files.length, 'nothing to scan — the guard would pass vacuously').toBeGreaterThan(20);
    const findings: string[] = [];
    for (const relPath of files) {
      // This guard's own file is exempt BY PATH — it necessarily quotes the
      // sentence it forbids — and by path so the exemption cannot be bought by
      // wording, which is the #693 lesson applied here.
      if (relPath === 'tests/retired-toolchain-prose.test.ts') continue;
      // JOINED, NOT LINE-BY-LINE. Review proved the line-scoped version:
      // wrapping the forbidden sentence across two comment lines — which is what
      // a formatter or an 80-column habit does to it unprompted — put
      // "compat-smoke" on one line and "skip()s" on the next, and BOTH tests
      // passed. The claim was intact and the scan could not see it.
      //
      // A guard defeated by a line break is not a guard, and the fix is not a
      // wider regex: comment blocks are joined into one string first, so the
      // sentence is matched as a sentence however it happens to be wrapped.
      for (const claim of skipClaims(read(relPath))) {
        findings.push(`${relPath}: ${claim.trim().slice(0, 160)}`);
      }
    }
    expect(
      findings,
      `the runner cannot skip; these say it can:\n  ${findings.join('\n  ')}`,
    ).toEqual([]);
  });

  it('a two-line WRAP of the forbidden sentence is still caught (review round 1)', () => {
    const wrapped = [
      '    # probe (unlike compat-smoke check (g), which',
      '    # skip()s on non-200 so a bucketless CI stays green).',
    ].join('\n');
    expect(skipClaims(wrapped).length).toBeGreaterThan(0);
    // …and line-by-line, neither line carries both tokens — which is what makes
    // this a regression test rather than a restatement of the scan.
    expect(
      wrapped.split('\n').some((l) => /compat-smoke/.test(l) && /\bskip\(\)?s?\b/.test(l)),
    ).toBe(false);
  });

  it('an absence-phrase a paragraph away does not launder the claim (review round 2)', () => {
    // Joining whole runs made this pass: the wrap sat inside a paragraph that
    // itself says "are gone", so the exclusion swallowed the lot.
    const paragraph = [
      '    # This comment previously described check (g) that way and those paths are gone now,',
      '    # which is worth recording because the sentence read as licence to add one back, and',
      '    # the compat rows are where this repo has been burned by exactly that before, twice.',
      '    # probe (unlike compat-smoke check (g), which',
      '    # skip()s on non-200 so a bucketless CI stays green).',
    ].join('\n');
    expect(skipClaims(paragraph).length).toBeGreaterThan(0);
  });

  it('a real disclaimer beside the claim IS excused (not a tripwire)', () => {
    const disclaimed = '    # compat-smoke does not skip() any check — the paths are gone.';
    expect(skipClaims(disclaimed)).toEqual([]);
  });

  it('the two tokens far apart are not a claim (the scan stays precise)', () => {
    const separated = [
      `    # compat-smoke runs here${' and here'.repeat(60)}`,
      '    # skip() is discussed somewhere else entirely',
    ].join('\n');
    expect(skipClaims(separated)).toEqual([]);
  });

  it('the exclusion is by PHRASE — "no-bucket" does not launder a claim (round 1\'s defect)', () => {
    // The mutation that caught round 1, frozen as an assertion so the loose
    // form cannot come back.
    expect(ABOUT_ABSENCE.test('which skip()s on non-200 so a no-bucket CI stays green')).toBe(
      false,
    );
    expect(ABOUT_ABSENCE.test('the runner does not skip')).toBe(true);
  });
});
