import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * GUARD: the `changesets/action` MAJOR and the `@changesets/cli` MAJOR must be a
 * compatible PAIR.
 *
 * WHY THIS EXISTS. On 2026-08-25 the release lane started running for the first
 * time since 2026-07-26 (#849 removed the concurrency deadlock), and the very
 * first live run failed on its Version-PR job with:
 *
 *   This version of the Changesets action is designed to work with Changesets
 *   CLI v3. Changesets CLI v2 is not supported; use Changesets action v1
 *   instead, which is compatible with CLI v2.
 *
 * The action had been bumped v1 -> v2 (#831) while `package.json` still declared
 * `"@changesets/cli": "^2.31.0"`. Nothing in the repo could see that. The pin
 * guard (`tests/release-action-pins.test.ts`) asserts a pin's FORM and SCOPE —
 * 40-hex SHA, auditable version comment, allowlisted action, which job holds the
 * credential — and every one of those held. The liveness guard
 * (`tests/release-lane-liveness.test.ts`) asserts the lane's SHAPE — jobs, edges,
 * concurrency groups, output keys — and every one of those held too. The
 * mismatch lives in neither file: it is a relation BETWEEN the workflow and the
 * root manifest, and it is only observable on a push to `main`, which no PR's CI
 * can exercise. So it stayed invisible for a month behind a deadlock that was
 * itself hiding it.
 *
 * This is the same class as #750 (renamed `with:` inputs silently ignored) and
 * mutations 14-18 of the release-lane prover (renamed `outputs.*` silently
 * resolving to `''`): a Dependabot-driven bump on one side of a contract whose
 * other side lives in a different file, green at PR time, fatal at release time.
 * Dependabot has #839 open RIGHT NOW proposing `changesets/action` 2.1.0 ->
 * 2.1.1, and will propose 2.x -> 3.x the day it exists.
 *
 * WHAT IS ASSERTED, AND WHAT IS DELIBERATELY NOT.
 *
 * The action major is read from the auditable `# vX.Y.Z` comment on the pin.
 * That comment is a CLAIM, not a resolution — and that is the existing division
 * of labour in this repo, stated in `.claude/rules/security.md`: form and scope
 * are asserted at PR time (here and in `release-action-pins`), while
 * SHA<->tag correspondence is resolved at RUN time by the nightly
 * `scripts/verify-action-pins.mjs`. Baking a resolved SHA into a committed
 * assertion is what made an earlier value-pinning attempt unworkable: it
 * reddened every correct Dependabot bump and trained the reader to edit the
 * guard to get green. So this file does not resolve anything over the network.
 *
 * BOTH HALVES. The failure is symmetric and so is the guard:
 *   - bumping the ACTION without bumping the CLI  -> red (what actually happened)
 *   - bumping the CLI without bumping the ACTION  -> red (the inverse, e.g. a
 *     future revert of the CLI to v2 while the action stays on v2)
 * and a THIRD half that the action itself checks and a manifest read alone would
 * miss: the action resolves `@changesets/cli/package.json` from disk as well as
 * reading the declared range, so `pnpm-lock.yaml` must resolve the root
 * devDependency to the same major the manifest declares.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

/**
 * The action's OWN compatibility statement, transcribed. Source:
 * `changesets/action@198f833` `src/utils.ts` -> `validateChangesetsCliVersion`,
 * which throws when the root manifest's `@changesets/cli` range is a subset of
 * `>=2.0.0-0 <3.0.0-0`, or when the resolved CLI's major is 2. Its error text
 * names the other direction explicitly ("use Changesets action v1 instead,
 * which is compatible with CLI v2").
 *
 * FAIL-CLOSED on an unknown action major: a `changesets/action@v3` bump lands as
 * a RED test demanding a deliberate decision, not as a silent pass. That is the
 * whole point — the last bump passed silently.
 */
const CLI_MAJOR_FOR_ACTION_MAJOR: ReadonlyMap<number, number> = new Map([
  [1, 2],
  [2, 3],
]);

const WORKFLOW = '.github/workflows/release.yml';

/** `uses: changesets/action@<40-hex> # vX.Y.Z` */
const CHANGESETS_PIN = /^\s*(?:-\s*)?uses:\s*changesets\/action@(\S+)\s*#\s*v(\d+)\.(\d+)\.(\d+)/;

interface Pin {
  line: number;
  ref: string;
  major: number;
  version: string;
}

function changesetsActionPins(): Pin[] {
  const text = readFileSync(resolve(REPO_ROOT, WORKFLOW), 'utf8');
  const pins: Pin[] = [];
  for (const [index, lineText] of text.split('\n').entries()) {
    const match = CHANGESETS_PIN.exec(lineText);
    if (match === undefined || match === null) continue;
    const [, ref, major, minor, patch] = match;
    if (ref === undefined || major === undefined) continue;
    pins.push({
      line: index + 1,
      ref,
      major: Number(major),
      version: `v${major}.${minor}.${patch}`,
    });
  }
  return pins;
}

/**
 * The root manifest's declared major.
 *
 * Deliberately STRICT rather than a general semver-range parser: the range must
 * be `^X.Y.Z`. A range this guard cannot reason about is a FAILURE, never a
 * skip — "unparseable therefore fine" is how a guard passes vacuously. If the
 * repo ever needs a wider range here, that is a deliberate edit with a
 * deliberate reason, which is exactly the conversation this should force.
 */
function declaredCliRange(): string {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
  const range =
    manifest.devDependencies?.['@changesets/cli'] ?? manifest.dependencies?.['@changesets/cli'];
  expect(
    typeof range,
    'the root manifest no longer declares @changesets/cli — the release lane runs its CLI, so this is not an optional dependency',
  ).toBe('string');
  return range as string;
}

function majorOfCaretRange(range: string, what: string): number {
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  expect(
    match,
    `${what} is "${range}", which this guard deliberately refuses to interpret. ` +
      'It asserts on a `^X.Y.Z` range only — a looser range would let the installed major drift ' +
      'away from the one the action requires without anything going red.',
  ).not.toBeNull();
  return Number((match as RegExpExecArray)[1]);
}

/**
 * What `bun install --frozen-lockfile` will actually put on disk for the ROOT
 * importer — which is what the action resolves via
 * `require.resolve('@changesets/cli/package.json')`.
 *
 * Read as text rather than via a YAML parser to match the other workflow guards
 * in this directory (no runtime YAML dependency), and anchored to the `.:`
 * root-importer block so a workspace package's own devDependency cannot be
 * mistaken for it.
 */
function lockfileResolvedCliVersion(): string {
  // `bun.lock` since the repo left pnpm. It is JSONC — trailing commas — with a
  // flat `packages` map of resolved dependencies.
  //
  // The old code walked pnpm's `importers:` block to scope the lookup to the
  // ROOT, so a workspace package's own devDependency could not be mistaken for
  // it. bun gives that scoping more directly: a TOP-LEVEL key in `packages` is
  // the hoisted resolution, and a dependency that resolved differently for some
  // package appears under a nested `parent/name` key instead. So matching a
  // top-level key IS "what the root installs".
  const lock = readFileSync(resolve(REPO_ROOT, 'bun.lock'), 'utf8');
  const entry = /\n {4}"@changesets\/cli": \["@changesets\/cli@(\d+\.\d+\.\d+)/.exec(lock);
  expect(
    entry,
    'bun.lock does not resolve @changesets/cli at the top level — either the ' +
      'lockfile format changed or the CLI is no longer a root dependency, and CI ' +
      'would install a version this guard never checked',
  ).not.toBeNull();
  return (entry as RegExpExecArray)[1] as string;
}

/**
 * The `with:` input KEYS passed to every `changesets/action` step.
 *
 * Scoped to the step, not matched by indent across the file: `env:` variables
 * and `run: |` script lines sit at the same column, and a bare column match
 * would let either produce a spurious red. Walks from each `uses:
 * changesets/action@…` line to its `with:` block and collects keys until the
 * block ends (a key at the step's own indent, e.g. `env:`).
 */
function changesetsActionWithKeys(): Set<string> {
  const lines = readFileSync(resolve(REPO_ROOT, WORKFLOW), 'utf8').split('\n');
  const keys = new Set<string>();
  for (const [index, lineText] of lines.entries()) {
    if (CHANGESETS_PIN.exec(lineText) === null) continue;
    const stepIndent = (/^(\s*)/.exec(lineText) as RegExpExecArray)[1]?.length ?? 0;
    // Walk the rest of the step. `with:` sits at the step's own indent; its
    // inputs sit deeper. Stop at the first line shallower than the step (the
    // next job) or at a new list item (the next step).
    let inWith = false;
    for (let i = index + 1; i < lines.length; i += 1) {
      const current = lines[i] as string;
      if (current.trim() === '' || /^\s*#/.test(current)) continue;
      const indent = (/^(\s*)/.exec(current) as RegExpExecArray)[1]?.length ?? 0;
      // A step's keys are all at `stepIndent`; the `- name:` that opens the NEXT
      // step, and every job-level key, sit shallower.
      if (indent < stepIndent) break;
      if (indent === stepIndent) {
        inWith = /^\s*with:\s*$/.test(current);
        continue;
      }
      if (!inWith) continue;
      const key = /^\s+([a-zA-Z][\w-]*):/.exec(current)?.[1];
      if (key !== undefined) keys.add(key);
    }
  }
  return keys;
}

describe('changesets/action major and @changesets/cli major stay compatible', () => {
  it('parses at least one changesets/action pin out of release.yml', () => {
    // Sanity: every assertion below iterates these pins, so an extraction regex
    // that stops matching would make the whole file pass over an empty list.
    expect(
      changesetsActionPins().length,
      `no \`uses: changesets/action@<sha> # vX.Y.Z\` line parsed out of ${WORKFLOW}`,
    ).toBeGreaterThan(0);
  });

  it('runs one and the same changesets/action major in every job', () => {
    const majors = Array.from(new Set(changesetsActionPins().map((pin) => pin.major)));
    expect(
      majors,
      'the version-pr and release jobs are pinned to different changesets/action majors — ' +
        'they read the same repository, so one of them is running against the wrong CLI',
    ).toHaveLength(1);
  });

  it('declares a CLI major the pinned action major supports', () => {
    const pins = changesetsActionPins();
    const actionMajor = (pins[0] as Pin).major;
    const expectedCliMajor = CLI_MAJOR_FOR_ACTION_MAJOR.get(actionMajor);
    // A Map lookup is `V | undefined`, and an unmapped action major is a real gap
    // in the pairing table. Throw rather than `expect(...).toBeDefined()`, which
    // is not an assertion function and so leaves `undefined` in the type below.
    if (expectedCliMajor === undefined) {
      throw new Error(`no @changesets/cli major is paired with changesets/action v${actionMajor}`);
    }
    expect(
      expectedCliMajor,
      `changesets/action v${actionMajor} has no recorded @changesets/cli compatibility in this guard. ` +
        'That is deliberate: a new action major must be paired with its CLI major here, on purpose, ' +
        "after reading the action's `validateChangesetsCliVersion`. Do not delete this assertion to get green.",
    ).toBeDefined();

    const range = declaredCliRange();
    const cliMajor = majorOfCaretRange(range, 'the root `@changesets/cli` devDependency range');

    // BOTH HALVES, in one assertion that names both sides. An action bump
    // without a CLI bump and a CLI bump without an action bump are the same
    // defect seen from two ends, and each must red here.
    expect(
      cliMajor,
      `changesets/action is pinned to ${pins.map((p) => p.version).join(', ')} (major v${actionMajor}), ` +
        `which requires @changesets/cli v${expectedCliMajor}, but package.json declares "${range}". ` +
        'The action refuses to run on a mismatched CLI major — it throws before it reads a single ' +
        'input, so the Version-PR job fails and NOTHING downstream (preflight, publish) even starts. ' +
        'This is only reachable on a push to `main`, which is why it must be caught here.',
    ).toBe(expectedCliMajor);
  });

  it('resolves the same CLI major in bun.lock as package.json declares', () => {
    // The action checks the DECLARED range and separately `require.resolve`s the
    // installed `@changesets/cli/package.json`. A manifest bumped without a
    // lockfile update would satisfy the assertion above and still fail live,
    // because CI installs with `--frozen-lockfile`.
    const declaredMajor = majorOfCaretRange(
      declaredCliRange(),
      'the root `@changesets/cli` devDependency range',
    );
    const resolved = lockfileResolvedCliVersion();
    const resolvedMajor = Number((/^(\d+)\./.exec(resolved) as RegExpExecArray)[1]);
    expect(
      resolvedMajor,
      `package.json declares @changesets/cli major v${declaredMajor} but bun.lock resolves ` +
        `${resolved} for the root importer. CI runs \`bun install --frozen-lockfile\`, so the ` +
        'lockfile — not the manifest — decides what the action finds on disk.',
    ).toBe(declaredMajor);
  });

  it('uses the v2+ input names iff the pinned action is v2+', () => {
    // The renamed-input class (#750) and the CLI-major class are two symptoms of
    // the same bump, and #831 took the bump with NEITHER. `validateChangesetsCliVersion`
    // runs BEFORE `throwOnRenamedInputs`, so while the CLI major is wrong the
    // input check can never fire — fixing only one of the two leaves the lane
    // broken in a way whose error message has changed. Assert them together.
    const actionMajor = (changesetsActionPins()[0] as Pin).major;
    // Only the `with:` KEYS of the changesets/action steps. Never prose (this
    // workflow's own comments name the v1 keys while documenting the migration
    // away from them), and never a bare indent match (an `env:` var and a `run:`
    // heredoc line sit at the same column).
    const withKeys = changesetsActionWithKeys();
    expect(
      withKeys.size,
      'no `with:` inputs parsed for any changesets/action step — the assertions below would pass over an empty set',
    ).toBeGreaterThan(0);
    const v1Only = ['version', 'publish', 'commit', 'title', 'createGithubReleases'];
    const v2Only = ['version-script', 'publish-script', 'commit-message', 'pr-title'];
    if (actionMajor >= 2) {
      for (const key of v1Only) {
        expect(
          withKeys.has(key),
          `${WORKFLOW} passes the v1 input \`${key}\` to changesets/action v${actionMajor}. ` +
            'GitHub Actions does not error on unknown `with:` keys, it IGNORES them.',
        ).toBe(false);
      }
      expect(
        v2Only.some((key) => withKeys.has(key)),
        `${WORKFLOW} passes none of the v2 input names (${v2Only.join(', ')}) to changesets/action v${actionMajor} — ` +
          'every input would be silently defaulted',
      ).toBe(true);
    } else {
      for (const key of v2Only) {
        expect(
          withKeys.has(key),
          `${WORKFLOW} passes the v2 input \`${key}\` to changesets/action v${actionMajor}, which ignores it`,
        ).toBe(false);
      }
    }
  });
});
