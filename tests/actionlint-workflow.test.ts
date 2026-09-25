import { describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * #1300 review round 4 — wiring tests for `.github/workflows/actionlint.yml`.
 *
 * Finding 1 (jev 0.78, security.md): `${{ steps.diff.outputs.files }}`
 * substituted directly into a `run:` script body is GitHub's TEXTUAL
 * templating, done before the shell parses the script — with PR-controlled
 * filenames in that output (the diff of a PR the attacker authored), that is
 * a script-injection point, not merely an unsafe data value. The fix is the
 * documented mitigation: pass untrusted values via `env:`, never interpolate
 * them into the script text.
 *
 * Finding 3 (0.61): `git diff ... || true` swallows a REAL git error (not
 * just "no changes") and lets the step fall through as if nothing changed —
 * exactly the silent-degradation shape this repo's other guards keep having
 * to re-learn costs a real incident before it's caught.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const ACTIONLINT_WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/actionlint.yml');

function jobSteps() {
  const text = readFileSync(ACTIONLINT_WORKFLOW_PATH, 'utf8');
  const parsed = parse(text) as {
    jobs: Record<
      string,
      { steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> }
    >;
  };
  const steps = parsed.jobs.actionlint.steps;
  return { text, steps };
}

describe('#1300 review round 4: actionlint.yml is injection-safe', () => {
  it('is valid YAML', () => {
    expect(() => jobSteps()).not.toThrow();
  });

  it('finding 1: the "Run actionlint" step never interpolates ${{ steps.*.outputs.* }} into its run: script', () => {
    const { steps } = jobSteps();
    const runStep = steps.find((s) => /Run actionlint/.test(String(s.name)));
    expect(runStep).toBeTruthy();
    expect(String(runStep!.run)).not.toMatch(/\$\{\{\s*steps\./);
  });

  it('finding 1: that step instead passes the PR-controlled file list via env:, never inline', () => {
    const { steps } = jobSteps();
    const runStep = steps.find((s) => /Run actionlint/.test(String(s.name)));
    expect(runStep?.env?.FILES).toBe('${{ steps.diff.outputs.files }}');
    // And the script reads it as a shell variable, not as templated text.
    expect(String(runStep!.run)).toContain('"${FILES}"');
  });

  it('finding 1: the file list is xargs-fed with an explicit NUL/newline delimiter, not default whitespace splitting', () => {
    const { steps } = jobSteps();
    const runStep = steps.find((s) => /Run actionlint/.test(String(s.name)));
    expect(String(runStep!.run)).toMatch(/xargs -d '\\n'/);
  });

  it('finding 3: the git diff computing the changed files never swallows a real error with || true', () => {
    const { steps } = jobSteps();
    const diffStep = steps.find(
      (s) => s.name === 'Compute the workflow files this diff actually changed',
    );
    expect(diffStep).toBeTruthy();
    const diffLine = String(diffStep!.run)
      .split('\n')
      .find((l) => l.includes('git diff --name-only'));
    expect(diffLine).toBeTruthy();
    expect(diffLine).not.toContain('|| true');
  });

  it('the base/head SHAs are also passed via env:, not inlined into the run: script (same injection class)', () => {
    const { steps } = jobSteps();
    const diffStep = steps.find(
      (s) => s.name === 'Compute the workflow files this diff actually changed',
    );
    expect(diffStep?.env?.BASE_SHA).toBeTruthy();
    expect(diffStep?.env?.HEAD_SHA).toBeTruthy();
    expect(String(diffStep!.run)).not.toMatch(/\$\{\{\s*github\./);
  });
});

/**
 * #1352 — the gate did not cover `.github/actions/**` composite action
 * definitions (`action.yml`/`action.yaml`). This repo has none today, so
 * that gap was invisible: nothing would go red if one landed uncovered.
 * Two independent guards, per the issue:
 *
 *   1. the `paths:` trigger and the diff glob ARE widened to
 *      `.github/actions/**` (asserted directly against the workflow file);
 *   2. a SCANNING guard that fails the moment a composite action actually
 *      exists, if (for any reason — a future edit reverting #1, a rename)
 *      the workflow's own coverage of it goes stale. This is deliberately
 *      NOT gated on "if any exist today" — it always runs, so a composite
 *      action added tomorrow is covered from the day it lands, not from the
 *      day someone remembers to update a hand-kept exception list.
 */
describe('#1352: actionlint gate covers .github/actions/** composite actions', () => {
  it('the pull_request AND push path filters include .github/actions/**', () => {
    const text = readFileSync(ACTIONLINT_WORKFLOW_PATH, 'utf8');
    const parsed = parse(text) as {
      on: {
        pull_request?: { paths?: string[] };
        push?: { paths?: string[] };
      };
    };
    expect(parsed.on.pull_request?.paths).toContain('.github/actions/**');
    expect(parsed.on.push?.paths).toContain('.github/actions/**');
  });

  it('the diff-computing step globs .github/actions/**/action.yml AND .yaml, not just workflows', () => {
    const { steps } = jobSteps();
    const diffStep = steps.find(
      (s) => s.name && /Compute the .*files this diff actually changed/.test(String(s.name)),
    );
    expect(diffStep).toBeTruthy();
    const run = String(diffStep!.run);
    expect(run).toContain('.github/actions/**/action.yml');
    expect(run).toContain('.github/actions/**/action.yaml');
  });

  it('the diff excludes DELETED paths (--diff-filter=d), so a PR that only deletes a workflow/composite-action file does not false-red', () => {
    const { steps } = jobSteps();
    const diffStep = steps.find(
      (s) => s.name && /Compute the .*files this diff actually changed/.test(String(s.name)),
    );
    const diffLine = String(diffStep!.run)
      .split('\n')
      .find((l) => l.includes('git diff --name-only'));
    expect(diffLine).toBeTruthy();
    expect(diffLine).toContain('--diff-filter=d');
  });

  // No `if (composites.length) …` escape hatch: this ALWAYS runs. A composite
  // action landing without the workflow being updated to cover it is exactly
  // the failure this test exists to catch, so a conditional guard around it
  // would just move the same blind spot one file over.
  it('every real .github/actions/**/action.y(a)ml file in the repo is coverable by the widened glob (scan, not "if any exist today")', () => {
    const actionsDir = resolve(REPO_ROOT, '.github/actions');
    const found: string[] = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (/^action\.ya?ml$/.test(entry)) {
          found.push(full);
        }
      }
    };
    walk(actionsDir);

    const { steps } = jobSteps();
    const diffStep = steps.find(
      (s) => s.name && /Compute the .*files this diff actually changed/.test(String(s.name)),
    );
    const run = String(diffStep!.run);
    const globbed =
      run.includes('.github/actions/**/action.yml') &&
      run.includes('.github/actions/**/action.yaml');

    // If ANY composite action exists, the gate's glob MUST cover it — this is
    // the assertion that goes red the day one lands without matching wiring.
    if (found.length > 0) {
      expect(globbed).toBe(true);
    } else {
      // Documents WHY this passes vacuously today, rather than silently
      // doing nothing — a reader of a green run can tell the difference
      // between "covered" and "nothing to cover yet".
      expect(found).toEqual([]);
    }
  });
});

/**
 * #1397 review — actionlint 1.7.12 (the pinned version) REJECTS a composite
 * `action.yml` passed to it as a bare CLI argument: explicit file arguments
 * are ALWAYS treated as workflow files, so a real composite action landing
 * (once #1352's widened trigger fires) would have turned this gate red on
 * day one, on VALID code. Verified live against the exact pinned binary
 * below, not assumed from actionlint's docs.
 *
 * Fix: never hand actionlint an `action.yml` path. When a composite action
 * changes, the "Compute the workflow files" step instead re-lints every
 * WORKFLOW that `uses:` a local composite action — actionlint validates a
 * local `uses: ./...` reference as part of linting the REFERENCING workflow,
 * which is the only way this gate can react to a composite-action change
 * without ever passing it a file type it rejects.
 *
 * These tests execute the REAL "Compute the workflow files" step script
 * (the actual text shipped in actionlint.yml, not a re-derivation) against a
 * real git repo fixture with a real composite action + a workflow that
 * consumes it, THEN run the real pinned `actionlint` binary on the result —
 * so this suite is not vacuous even though the repo carries no composite
 * action today.
 */
function actionlintAvailable(): boolean {
  const r = spawnSync('actionlint', ['-version'], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0;
}

describe.skipIf(!actionlintAvailable())(
  '#1397: a changed composite action re-lints its REFERENCING workflow, never the action.yml itself',
  () => {
    function buildFixture(): { dir: string; run: (env: Record<string, string>) => string } {
      const dir = mkdtempSync(join(tmpdir(), 'knext-actionlint-composite-'));
      mkdirSync(join(dir, '.github/workflows'), { recursive: true });
      mkdirSync(join(dir, '.github/actions/sample'), { recursive: true });
      writeFileSync(
        join(dir, '.github/actions/sample/action.yml'),
        "name: 'Sample composite'\ndescription: 'test'\nruns:\n  using: 'composite'\n  steps:\n    - run: echo hi\n      shell: bash\n",
      );
      writeFileSync(
        join(dir, '.github/workflows/consumer.yml'),
        'name: consumer\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/sample\n',
      );
      writeFileSync(
        join(dir, '.github/workflows/unrelated.yml'),
        'name: unrelated\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo unrelated\n',
      );
      const git = (args: string[]) =>
        execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
          cwd: dir,
          encoding: 'utf8',
        });
      git(['init', '-q']);
      git(['config', 'user.email', 'test@example.com']);
      git(['config', 'user.name', 'Test']);
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'base']);
      const baseSha = git(['rev-parse', 'HEAD']).trim();
      // Change ONLY the composite action — nothing in .github/workflows/.
      writeFileSync(
        join(dir, '.github/actions/sample/action.yml'),
        "name: 'Sample composite'\ndescription: 'test'\nruns:\n  using: 'composite'\n  steps:\n    - run: echo hi there\n      shell: bash\n",
      );
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'change composite action only']);
      const headSha = git(['rev-parse', 'HEAD']).trim();

      const { steps } = jobSteps();
      const diffStep = steps.find(
        (s) => s.name && /Compute the .*files this diff actually changed/.test(String(s.name)),
      );
      if (!diffStep?.run) throw new Error('diff step not found');

      return {
        dir,
        run: (extraEnv) => {
          const outFile = join(dir, 'gh-output.txt');
          writeFileSync(outFile, '');
          execFileSync('bash', ['-c', diffStep.run as string], {
            cwd: dir,
            encoding: 'utf8',
            env: {
              ...process.env,
              BASE_SHA: baseSha,
              HEAD_SHA: headSha,
              GITHUB_OUTPUT: outFile,
              ...extraEnv,
            },
          });
          return readFileSync(outFile, 'utf8');
        },
      };
    }

    it('selects the REFERENCING workflow (consumer.yml), not the unrelated one, and never the action.yml itself', () => {
      const { run } = buildFixture();
      const output = run({});
      expect(output).toContain('.github/workflows/consumer.yml');
      expect(output).not.toContain('.github/workflows/unrelated.yml');
      expect(output).not.toContain('action.yml');
    });

    it('the real pinned actionlint accepts the selected file — never the "jobs section is missing" rejection', () => {
      const { dir, run } = buildFixture();
      const output = run({});
      const m = output.match(/files<<ACTIONLINT_FILES_EOF\n([\s\S]*?)\nACTIONLINT_FILES_EOF/);
      expect(m, 'no files<< block in step output').toBeTruthy();
      const files = m![1].split('\n').filter(Boolean);
      expect(files).toEqual(['.github/workflows/consumer.yml']);
      const r = spawnSync('actionlint', files, { cwd: dir, encoding: 'utf8' });
      expect(r.stderr).not.toMatch(/jobs.{0,3}section is missing/);
      expect(r.status).toBe(0);
    });

    // The DEFECT this fix avoids, proved with the real binary rather than
    // asserted from a changelog: if the composite action.yml WERE handed to
    // actionlint directly (the pre-fix behaviour), it fails exactly the way
    // the review reported.
    it('PROVES the defect is real: actionlint rejects the composite action.yml when passed directly', () => {
      const { dir } = buildFixture();
      const r = spawnSync('actionlint', ['.github/actions/sample/action.yml'], {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(r.status).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/jobs.{0,3}section is missing/);
    });
  },
);

/**
 * #1397 round 2 review findings.
 *
 * 1. Nothing in CI ever put `actionlint` on PATH, so the `describe.skipIf`
 *    suite above never RAN there — the gate's own regression coverage was
 *    silently inert on every real PR, only ever exercised on a machine that
 *    happens to have actionlint installed (this repo's dev box). Fixed by
 *    running this file for real in actionlint.yml, right after the binary is
 *    installed, and FAILING the job outright if any test came back skipped —
 *    so a future PATH regression (a renamed binary, a broken install step) is
 *    loud, not silently green.
 * 2. Scope caveat, stated once so it does not need re-discovering: this gate
 *    lints a composite action's `uses:` REFERENCE (as part of linting the
 *    referencing workflow) — composite internals (the composite action's OWN
 *    step bodies, `runs.steps`) are never linted by this gate, because
 *    actionlint 1.7.12 refuses an action.yml as a direct argument at all.
 * 3. The `uses:` scan regex only matched an unquoted
 *    `uses: ./.github/actions/...` — `uses: './.github/actions/...'` (single
 *    or double quoted, both valid YAML) silently escaped detection.
 * 4. `grep -lE ... || true` could not tell "no workflow matched" (grep exit
 *    1, fine) from a real grep failure (exit 2 — e.g. the workflows glob not
 *    matching so the literal glob string is handed to grep as a
 *    nonexistent filename) apart; both silently produced an empty
 *    `referencing_workflows`, which reads as "nothing to re-lint" instead of
 *    "the scan itself broke".
 */
describe('#1397 round 2: CI actually executes the real actionlint tests, and fails on any skip', () => {
  it('a step runs tests/actionlint-workflow.test.ts using the just-installed actionlint binary', () => {
    const { text } = jobSteps();
    expect(text).toMatch(/bun test tests\/actionlint-workflow\.test\.ts/);
  });

  it('that step fails the job if any test in the file was skipped, not just on a non-zero exit code', () => {
    const { steps } = jobSteps();
    const testStep = steps.find((s) =>
      /bun test tests\/actionlint-workflow\.test\.ts/.test(String(s.run)),
    );
    expect(testStep).toBeTruthy();
    // A skip does not itself make `bun test` exit non-zero — this step must
    // parse the skip count (e.g. from a junit reporter) and exit 1 itself.
    expect(String(testStep!.run)).toMatch(/skipped/);
    expect(String(testStep!.run)).toMatch(/exit 1/);
  });

  it('the install-actionlint step runs BEFORE the test-execution step', () => {
    const { steps } = jobSteps();
    const installIdx = steps.findIndex((s) => /Install actionlint/.test(String(s.name)));
    const testIdx = steps.findIndex((s) =>
      /bun test tests\/actionlint-workflow\.test\.ts/.test(String(s.run)),
    );
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(testIdx).toBeGreaterThan(installIdx);
  });

  it('documents the scope caveat: composite action internals are never linted, only the referencing `uses:`', () => {
    const { text } = jobSteps();
    expect(text).toMatch(/composite (action )?internals? (is|are) never linted/i);
  });
});

/**
 * techdebt-3 round — the skip-count parse in the step above FAILS OPEN:
 * `grep -m1 ... || true` swallows a missing file (grep exits 2, "No such
 * file or directory") the exact same way it swallows a merely-absent
 * `skipped="N"` attribute, and `skipped="${skipped:-0}"` then reads either
 * case as "0 skipped" — a PASS. So a junit reporter that changes its output
 * shape, or a step that fails to produce the file at all, silently looks
 * identical to a clean run with nothing skipped. These tests extract the
 * REAL parsing logic (everything in the step after the `bun test`
 * invocation, which is exercised separately above) and run it verbatim
 * under bash against fixture junit files — not a reimplementation that
 * could drift from what CI actually runs.
 */
describe('the skip-count parse fails CLOSED on a missing file, missing attribute, or empty suite (techdebt-3)', () => {
  function parsingScript(): string {
    const { steps } = jobSteps();
    const testStep = steps.find((s) =>
      /bun test tests\/actionlint-workflow\.test\.ts/.test(String(s.run)),
    );
    if (!testStep) throw new Error('test-execution step not found');
    // Drop the `bun test ...` invocation line itself — that command is
    // exercised for real elsewhere (round 2's suite) and would need a real
    // workspace install to run here; everything AFTER it (the parsing this
    // section targets) is kept verbatim, unedited.
    return String(testStep.run)
      .split('\n')
      .filter((line) => !/^\s*bun test /.test(line))
      .join('\n');
  }

  function runParsing(xml: string | null): { status: number | null; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), 'actionlint-skip-parse-'));
    try {
      if (xml !== null) writeFileSync(join(dir, 'actionlint-test-results.xml'), xml);
      const r = spawnSync('bash', ['-c', parsingScript()], { cwd: dir, encoding: 'utf8' });
      return { status: r.status, stderr: r.stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const VALID_CLEAN = '<testsuites tests="4" skipped="0">\n</testsuites>\n';
  const VALID_SKIPPED = '<testsuites tests="4" skipped="2">\n</testsuites>\n';
  const NO_SKIPPED_ATTR = '<testsuites tests="4">\n</testsuites>\n';
  const ZERO_TESTS = '<testsuites tests="0" skipped="0">\n</testsuites>\n';

  it('a clean run (skipped=0, tests>0) exits 0 — no regression on the happy path', () => {
    expect(runParsing(VALID_CLEAN).status).toBe(0);
  });

  it('a real skip (skipped>0) still exits 1, as before', () => {
    const r = runParsing(VALID_SKIPPED);
    expect(r.status).not.toBe(0);
  });

  it('the junit file missing entirely fails closed (exit 1), not "0 skipped"', () => {
    const r = runParsing(null);
    expect(r.status).not.toBe(0);
  });

  it('a <testsuites> line with no skipped="N" attribute fails closed, not "0 skipped"', () => {
    const r = runParsing(NO_SKIPPED_ATTR);
    expect(r.status).not.toBe(0);
  });

  it('tests="0" (an empty/never-ran suite) fails closed even with skipped="0"', () => {
    const r = runParsing(ZERO_TESTS);
    expect(r.status).not.toBe(0);
  });
});

describe.skipIf(!actionlintAvailable())(
  '#1397 round 2: the referencing-workflow scan is quote-tolerant and grep-error-safe',
  () => {
    function buildFixtureWithConsumer(consumerUsesLine: string): {
      dir: string;
      run: (env: Record<string, string>) => string;
    } {
      const dir = mkdtempSync(join(tmpdir(), 'knext-actionlint-quoted-'));
      mkdirSync(join(dir, '.github/workflows'), { recursive: true });
      mkdirSync(join(dir, '.github/actions/sample'), { recursive: true });
      writeFileSync(
        join(dir, '.github/actions/sample/action.yml'),
        "name: 'Sample composite'\ndescription: 'test'\nruns:\n  using: 'composite'\n  steps:\n    - run: echo hi\n      shell: bash\n",
      );
      writeFileSync(
        join(dir, '.github/workflows/consumer.yml'),
        `name: consumer\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - ${consumerUsesLine}\n`,
      );
      const git = (args: string[]) =>
        execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
          cwd: dir,
          encoding: 'utf8',
        });
      git(['init', '-q']);
      git(['config', 'user.email', 'test@example.com']);
      git(['config', 'user.name', 'Test']);
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'base']);
      const baseSha = git(['rev-parse', 'HEAD']).trim();
      writeFileSync(
        join(dir, '.github/actions/sample/action.yml'),
        "name: 'Sample composite'\ndescription: 'test'\nruns:\n  using: 'composite'\n  steps:\n    - run: echo hi there\n      shell: bash\n",
      );
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'change composite action only']);
      const headSha = git(['rev-parse', 'HEAD']).trim();

      const { steps } = jobSteps();
      const diffStep = steps.find(
        (s) => s.name && /Compute the .*files this diff actually changed/.test(String(s.name)),
      );
      if (!diffStep?.run) throw new Error('diff step not found');

      return {
        dir,
        run: (extraEnv) => {
          const outFile = join(dir, 'gh-output.txt');
          writeFileSync(outFile, '');
          execFileSync('bash', ['-c', diffStep.run as string], {
            cwd: dir,
            encoding: 'utf8',
            env: {
              ...process.env,
              BASE_SHA: baseSha,
              HEAD_SHA: headSha,
              GITHUB_OUTPUT: outFile,
              ...extraEnv,
            },
          });
          return readFileSync(outFile, 'utf8');
        },
      };
    }

    it("a single-quoted `uses: './.github/actions/sample'` reference is still detected", () => {
      const { run } = buildFixtureWithConsumer("uses: './.github/actions/sample'");
      const output = run({});
      expect(output).toContain('.github/workflows/consumer.yml');
    });

    it('a double-quoted `uses: "./.github/actions/sample"` reference is still detected', () => {
      const { run } = buildFixtureWithConsumer('uses: "./.github/actions/sample"');
      const output = run({});
      expect(output).toContain('.github/workflows/consumer.yml');
    });

    it('an unquoted `uses: ./.github/actions/sample` reference (the pre-existing case) is still detected', () => {
      const { run } = buildFixtureWithConsumer('uses: ./.github/actions/sample');
      const output = run({});
      expect(output).toContain('.github/workflows/consumer.yml');
    });

    // The genuine `grep exit 2` case: no `.github/workflows/*.y*ml` file
    // exists at all, so the glob does not expand and the LITERAL glob string
    // is handed to grep as a filename — "No such file or directory", exit 2,
    // not "no matches" (exit 1). The pre-fix `|| true` swallowed this
    // identically to "nothing referenced the changed action" instead of
    // surfacing the scan itself being broken.
    it('a real grep failure (no workflow files exist to scan) fails the step loudly, not silently as "nothing references it"', () => {
      const dir = mkdtempSync(join(tmpdir(), 'knext-actionlint-grep-error-'));
      mkdirSync(join(dir, '.github/actions/sample'), { recursive: true });
      writeFileSync(
        join(dir, '.github/actions/sample/action.yml'),
        "name: 'Sample composite'\ndescription: 'test'\nruns:\n  using: 'composite'\n  steps:\n    - run: echo hi\n      shell: bash\n",
      );
      const git = (args: string[]) =>
        execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
          cwd: dir,
          encoding: 'utf8',
        });
      git(['init', '-q']);
      git(['config', 'user.email', 'test@example.com']);
      git(['config', 'user.name', 'Test']);
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'base']);
      const baseSha = git(['rev-parse', 'HEAD']).trim();
      writeFileSync(
        join(dir, '.github/actions/sample/action.yml'),
        "name: 'Sample composite'\ndescription: 'test'\nruns:\n  using: 'composite'\n  steps:\n    - run: echo hi there\n      shell: bash\n",
      );
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'change composite action only']);
      const headSha = git(['rev-parse', 'HEAD']).trim();

      const { steps } = jobSteps();
      const diffStep = steps.find(
        (s) => s.name && /Compute the .*files this diff actually changed/.test(String(s.name)),
      );
      if (!diffStep?.run) throw new Error('diff step not found');

      const outFile = join(dir, 'gh-output.txt');
      writeFileSync(outFile, '');
      expect(() =>
        execFileSync('bash', ['-c', diffStep.run as string], {
          cwd: dir,
          encoding: 'utf8',
          env: {
            ...process.env,
            BASE_SHA: baseSha,
            HEAD_SHA: headSha,
            GITHUB_OUTPUT: outFile,
          },
        }),
      ).toThrow();
    });
  },
);
