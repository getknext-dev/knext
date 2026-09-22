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
 *   2. Source prose that pins the build axis to ONE builder. Originally
 *      `packages/kn-next/src/cli/validate.ts` justifying `checkPairing` being
 *      exported-but-unreachable "with only `turbopack` available today" — the
 *      inverse of the contract at the time.
 *
 *      THE PREMISE HAS SINCE MOVED, and the guard moved with it rather than
 *      being retuned to the new value: `turbopack` is `available: true` again
 *      (ADR-0054 item 6), so TWO builders are selectable and `vinext` is merely
 *      the DEFAULT. With two available builders no "only one builder/target"
 *      claim can be true at all, which is what §4.2's third block now asserts —
 *      see the long note there for why widening the old one-id comparison would
 *      have left it vacuous instead of current.
 *
 * SCANNED, NOT ENUMERATED, in both halves. A list of the known sites is how the
 * next one gets missed: (1) globs every tracked workspace script, and (2) globs
 * the CLI/adapter/config sources and derives the builder ids from the contract —
 * which is how it caught a fourth stale claim (`cli/vinext-build.ts`) that the
 * review of the re-opening PR had not found.
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
 * Everything a developer is instructed BY: the workspace scripts, and the
 * MARKDOWN they read first.
 *
 * The markdown half was missing, and that is where the instructions actually
 * were. The scan covered `scripts/*.mjs` and reported clean while
 * `CONTRIBUTING.md`, the root `README.md` and three app READMEs all told a
 * newcomer to run `pnpm install` against a bun-pinned workspace — the very
 * first command anyone runs, in the file they run it from. A guard aimed at the
 * least-read copy of an instruction and not the most-read one is close to
 * backwards.
 *
 * `.github/workflows` is still excluded, and the reason is specific: the next.js
 * compatibility harness is a pnpm workspace of its own (next.js's repo uses
 * pnpm), so `compat-suite.yml` legitimately runs pnpm against a tree that is not
 * ours. Widening to workflows would need a carve-out, and a scan with a
 * carve-out is one edit away from a scan with two.
 */
const SCRIPT_PATHSPECS = [
  'scripts/*.mjs',
  'scripts/lib/*.mjs',
  'apps/*/scripts/*.mjs',
  // `:(glob)` magic so `*` does NOT cross a slash: without it git matches
  // every .md at any depth, which pulls in maintainer-owned `.claude/`.
  ':(glob)*.md',
  ':(glob)apps/*/README.md',
  ':(glob)packages/*/README.md',
  // #933 widened the scan into docs/ and per-app docs/ after fixing what it
  // finds there (mutation-testing guide, tracing runbook, loadtest runbook).
  // docs/wayfinder/ is carved out deliberately: those are dated measurement
  // records of commands run at a pinned pnpm toolchain — history, not
  // instructions — and rewriting a record falsifies it. Maintainer-owned
  // `.claude/` stays out; its pnpm instructions are flagged on #933, not
  // edited here.
  ':(glob)docs/**/*.md',
  ':(glob)apps/*/docs/*.md',
  ':(glob,exclude)docs/wayfinder/**',
];

describe('§4.2 the workspace no longer instructs anyone through pnpm', () => {
  const files = tracked(...SCRIPT_PATHSPECS);

  it('the scan reaches the MARKDOWN, not just the scripts', () => {
    // Named explicitly, because "the pathspec covers everything" is exactly what
    // was believed while five files instructed a newcomer through pnpm.
    expect(files).toContain('CONTRIBUTING.md');
    expect(files).toContain('README.md');
    expect(files.some((f) => f.startsWith('apps/') && f.endsWith('README.md'))).toBe(true);
  });

  it('a markdown fenced instruction IS matched (the shape the scan missed)', () => {
    // The literal-only reader saw nothing in markdown. This pins the raw-line
    // path so it cannot quietly revert to reading string literals.
    expect(WORKSPACE_PNPM.test('pnpm install')).toBe(true);
    expect(WORKSPACE_PNPM.test('bun install')).toBe(false);
  });

  it('finds workspace scripts to scan at all (non-vacuity)', () => {
    // Without this, an empty pathspec would make the scan below pass by
    // examining nothing — the vacuous-green shape this whole lane exists for.
    expect(files.length).toBeGreaterThan(10);
  });

  it('no tracked workspace script or doc carries a runnable pnpm instruction', () => {
    const findings: string[] = [];
    for (const relPath of files) {
      const source = read(relPath);
      // MARKDOWN is read as raw lines: its instructions live in fenced code
      // blocks, not in string literals, so the code-literal reader that keeps
      // `prover-lane.mjs`'s diagnostic legal would see nothing at all here.
      const haystacks = relPath.endsWith('.md') ? source.split('\n') : codeStringLiterals(source);
      for (const text of haystacks) {
        const hit = WORKSPACE_PNPM.exec(text);
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

describe('§4.2 no source prose claims one builder is the only selectable one', () => {
  /**
   * REWORKED for the two-builder contract, and the rework is the point.
   *
   * The first version of this guard compared a captured id against the one
   * available builder: "an `only X available` claim must name the builder that
   * IS available". That worked while exactly one was available, and its
   * non-vacuity premise said so — `AVAILABLE_BUILDERS` is exactly `['vinext']`.
   *
   * Both builders are selectable now (ADR-0054 item 6 re-opened `turbopack`),
   * and merely widening that premise to `['turbopack','vinext']` would have
   * made the scan VACUOUS rather than current: with two available builders,
   * prose saying "only vinext is available" still passes the old check, because
   * vinext *is* available. The claim the guard exists to catch becomes
   * unreachable by it.
   *
   * So the rule is stated over the contract instead of over one id: **while more
   * than one builder is available, NO "only one builder/target" claim can be
   * true**, whoever it names and however it is worded. Two live examples this
   * rework caught that the old regex's word order could not —
   * `artifact-contract.ts` called vinext "the ONLY available builder" and "the
   * ONLY supported target", both false the moment turbopack re-opened, both in a
   * file the activating PR edited.
   *
   * SCANNED, NOT ENUMERATED: the file set comes from `git ls-files`, and the
   * builder ids come from the contract, so a third builder is in scope for free.
   */
  const files = tracked(
    'packages/kn-next/src/cli/*.ts',
    'packages/kn-next/src/adapters/*.ts',
    // `config.ts` (the `build` key's own documentation) is in scope too: it is
    // where a reader looks up what they may select, so it is the likeliest place
    // for a stale exclusivity claim to sit. Zero findings there today, which is
    // the only useful time to widen a scan.
    ':(glob)packages/kn-next/src/*.ts',
  );
  const builderIds = new Set(BUILDERS.map((b) => b.id as string));

  /**
   * "…is the only <adjectives> builder/target" — the ONE-OF-A-KIND form.
   *
   * `the only` rather than a bare `only`, and that ordering is what makes the
   * scan usable rather than something that has to be weakened until it finds
   * nothing. The sources are full of legitimate SCOPING statements — "only the
   * vinext target runs the ESM preflight", "(vinext target only)", "only when
   * the standalone target is selected" — which say where a behaviour applies,
   * not that one target is all there is. `only the` is scoping; `the only` is
   * exclusivity. The precision test below pins both directions.
   *
   * The noun is `builder`/`target` specifically: "the only spelling", "the only
   * mode", "the only cache provider" are other axes and none of this guard's
   * business.
   */
  const ONE_OF_A_KIND = /\bthe\s+only\s+(?:[\w.'-]+\s+){0,3}(?:builders?|targets?)\b/gi;

  /**
   * "only `turbopack` is available" — the NAMED-BUILDER form the first version
   * of this guard scanned for, kept because it is a real wording and the one
   * that was actually in the tree. The id is CAPTURED and checked against the
   * contract, so "only bun available" (a runtime) stays out of scope.
   */
  const NAMED_BUILDER_CLAIM =
    /\bonly\s+`?([a-z][a-z0-9-]*)`?\s+(?:is\s+|are\s+)?(?:available|supported|selectable)\b/gi;

  /**
   * A JSDoc block wraps, and the continuation marker is ` * `. Stripping it is
   * required, not cosmetic: the live defect is spelled `with only\n * \`turbopack\`
   * available today`, and a scan that did not unwrap it found nothing — which is
   * how the first version of this guard passed against the very line it was
   * written for.
   */
  const unwrapComments = (source: string) =>
    source.replace(/\n[ \t]*\*[ \t]?/g, '\n').replace(/\s*\n\s*/g, ' ');

  const exclusivityClaims = (source: string): string[] => {
    const text = unwrapComments(source);
    const claims = [...text.matchAll(ONE_OF_A_KIND)].map((m) => m[0]);
    for (const match of text.matchAll(NAMED_BUILDER_CLAIM)) {
      // Builder ids only — a runtime or an unrelated word is not this axis.
      if (builderIds.has((match[1] ?? '').toLowerCase())) claims.push(match[0]);
    }
    return claims;
  };

  it('more than one builder is available (the premise that makes the claim FALSE)', () => {
    // The antecedent of the rule below, asserted rather than assumed. If a
    // release ever narrows back to one available builder, an "only X" claim
    // becomes true again and this scan must be REWRITTEN, not silently kept
    // green — so this fails loudly instead of the scan quietly degrading, which
    // is precisely what the widen-the-array fix would have done.
    expect(AVAILABLE_BUILDERS.length).toBeGreaterThan(1);
  });

  it('there are sources to scan at all (non-vacuity)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('no source prose claims a single builder or target is all there is', () => {
    const findings: string[] = [];
    for (const relPath of files) {
      for (const claim of exclusivityClaims(read(relPath))) {
        findings.push(
          `${relPath}: "${claim}" — but ${AVAILABLE_BUILDERS.length} builders are available ` +
            `(${AVAILABLE_BUILDERS.map((b) => b.id).join(', ')})`,
        );
      }
    }
    expect(
      findings,
      `two builders are selectable; these still say one is all there is:\n  ${findings.join('\n  ')}`,
    ).toEqual([]);
  });

  it('BOTH word orders are caught (the pair the old regex missed)', () => {
    // The two live comments this rework found. `/only X available/` matched
    // neither: the builder id is not adjacent to the availability word in
    // either, which is how they shipped through a guard written for exactly
    // this class.
    expect(exclusivityClaims('// `available: true` — the ONLY available builder')).toHaveLength(1);
    expect(exclusivityClaims('// ADR-0048: the ONLY supported target.')).toHaveLength(1);
    // …a wrapped JSDoc spelling of the same claim, since that is what a
    // formatter does to it unprompted.
    expect(
      exclusivityClaims(' * vinext is the only\n * target this release can build.'),
    ).toHaveLength(1);
    // …and the named form the first version scanned for still reds.
    expect(exclusivityClaims('// with only `turbopack` available today')).toHaveLength(1);
    // A NEGATED form is flagged too, and that is DELIBERATE rather than a gap:
    // this repo's sibling prose guard (the compat-smoke skip scan below) was
    // decoration for a whole round precisely because it tried to excuse
    // absence-phrasing — "no" matched "no-bucket" and laundered the claim. The
    // rule here is the cheaper one: do not write the phrase at all, write "one
    // of two selectable builders". It caught this very rework's own first
    // wording of the vinext docstring ("not the only selectable builder").
    expect(exclusivityClaims('// vinext is not the only selectable builder')).toHaveLength(1);
  });

  it('SCOPING prose is not an exclusivity claim (the guard stays usable)', () => {
    // The other half. A scan that flagged these would be turned off within a
    // day, because every one of them is a true and useful statement about WHERE
    // a behaviour applies. `only the` vs `the only` is the whole distinction.
    expect(exclusivityClaims('// requireEsm gates the preflight: only the vinext target')).toEqual(
      [],
    );
    expect(exclusivityClaims('// staged only when the standalone target is selected')).toEqual([]);
    expect(exclusivityClaims('// the vinext ESM preflight (vinext target only).')).toEqual([]);
    // Other axes keep their own "the only": this guard is about builders.
    expect(exclusivityClaims('// Redis is the ONLY cache provider')).toEqual([]);
    expect(exclusivityClaims('// the only spelling an older operator understands')).toEqual([]);
    // A runtime id is not a builder id, so the named form ignores it.
    expect(exclusivityClaims('// only `bun` is available for this shape')).toEqual([]);
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
    // `apps/**` was missing, and the runner LIVES there — the one directory
    // whose files are most likely to describe its behaviour was the one the scan
    // could not see. Re-running the identical logic over the wider set is zero
    // findings today, so this changes nothing now and catches the apps/ case
    // later, which is the only useful time to widen a scan.
    const files = tracked(
      '.github/workflows/*.yml',
      'docs/**/*.md',
      'scripts/*.mjs',
      'scripts/lib/*.mjs',
      'tests/*.ts',
      'apps/**/*.mjs',
      'apps/**/*.md',
      'apps/**/*.ts',
    );
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
