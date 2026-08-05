import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyTriggerShape,
  type TriageEntry,
  UNCONVERTED_GUARD_TRIAGE,
} from './helpers/blocking-gate';

/**
 * The exemption list checks itself (#672 round 2).
 *
 * `tests/helpers/blocking-gate.ts` records WHY each workflow guard is not
 * pointed at `auditBlockingGate`. That header is, by the PR's own framing, the
 * only thing standing in for the enforcement scan that was dropped — and the
 * round-2 review measured one of its reasons FALSE:
 * `image-pin-resolution-nightly.yml` was filed under "SCHEDULED, not
 * `pull_request`", but it carries a `pull_request:` trigger with a `paths:`
 * filter. `auditBlockingGate` run against its `resolve-image-pins` job reports
 * exactly one problem — "the `pull_request` trigger carries a `paths` filter" —
 * NOT a missing trigger.
 *
 * The exemption itself still stands: a deliberately paths-scoped gate is not an
 * unconditional PR gate. What did not stand was the RECORDED REASON, and a wrong
 * reason in a self-reported exemption list is precisely the silent-exemption
 * shape `workflow.md` warns about.
 *
 * Correcting only the entry the review named would be this repo's own
 * enumerate-rather-than-scan defect, one level up. So the trigger half of EVERY
 * entry is asserted here against the parsed workflow. The trigger half is the
 * mechanisable half; the `opposite-claim` half is the one the dropped scan could
 * not do (file-level text cannot tell which workflow a `continue-on-error`
 * pattern applies to — `docs-closure-nightly-workflow.test.ts` asserts such a
 * step is present at :257-263 and absent at :142-149, in one file), and this
 * file does not pretend otherwise.
 *
 * What this DOES catch, which the prose could not: a workflow that gains an
 * unconditional `pull_request:` trigger later. That entry stops being exempt at
 * the moment it becomes a real PR gate, and this goes red instead of the list
 * quietly aging into a lie.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

/** Categories that are claims about the `on:` block, so they are measurable. */
const TRIGGER_CATEGORIES = new Set(['no-pull-request-trigger', 'paths-scoped-pull-request']);

const triggerEntries: TriageEntry[] = UNCONVERTED_GUARD_TRIAGE.filter((entry) =>
  TRIGGER_CATEGORIES.has(entry.category),
);

describe('the unconverted-guard triage checks itself', () => {
  it('is non-vacuous: it has entries, and both halves are represented', () => {
    // Without this, deleting the list would make every `it.each` below pass by
    // iterating nothing.
    expect(UNCONVERTED_GUARD_TRIAGE.length).toBeGreaterThanOrEqual(6);
    expect(triggerEntries.length).toBeGreaterThanOrEqual(4);
    expect(
      UNCONVERTED_GUARD_TRIAGE.filter((e) => e.category === 'opposite-claim').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it.each(UNCONVERTED_GUARD_TRIAGE)('$test — the guard and its workflow exist', (entry) => {
    // A triage entry naming a file that was renamed or deleted is an exemption
    // for something that is no longer there.
    expect(existsSync(resolve(REPO_ROOT, entry.test)), `${entry.test} is missing`).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, entry.workflow)), `${entry.workflow} is missing`).toBe(
      true,
    );
  });

  it.each(triggerEntries)('$test — the recorded reason is the real one', (entry) => {
    // The whole point: the category is not taken on trust, it is derived from
    // the workflow and compared.
    expect(classifyTriggerShape(resolve(REPO_ROOT, entry.workflow))).toBe(entry.category);
  });

  it.each(triggerEntries)('$test — is not exempting an unconditional PR gate', (entry) => {
    // Belt-and-braces on the assertion above, stated as the invariant that
    // actually matters: no entry may be exempt because of its trigger while
    // running unconditionally on every pull request. Such a workflow IS a PR
    // gate and belongs in `auditBlockingGate`, not in this list.
    expect(classifyTriggerShape(resolve(REPO_ROOT, entry.workflow))).not.toBe(
      'unconditional-pull-request',
    );
  });
});

/**
 * Coverage for the CLASSIFIER, not just for the list it checks.
 *
 * The assertions above compare a recorded category against
 * `classifyTriggerShape`. That shape is blind in one direction by construction:
 * a classifier that simply agreed with whatever it was asked about would keep
 * them all green. `blocking-gate-helper.test.ts` exists for exactly this reason
 * on the audit engine; this is the same argument applied to the classifier the
 * triage now leans on.
 *
 * Fixtures are written whole, so no assertion depends on a substitution having
 * succeeded.
 */
describe('classifyTriggerShape', () => {
  const TMP = mkdtempSync(join(tmpdir(), 'triage-shape-'));
  let seq = 0;

  const shapeOf = (on: string) => {
    const path = join(TMP, `wf-${seq++}.yml`);
    writeFileSync(path, `name: fixture\non:\n${on}\njobs:\n  gate:\n    runs-on: ubuntu-latest\n`);
    return classifyTriggerShape(path);
  };

  it('no `pull_request:` key at all', () => {
    expect(shapeOf('  schedule:\n    - cron: "0 3 * * *"')).toBe('no-pull-request-trigger');
  });

  it('a bare `pull_request:` is unconditional', () => {
    expect(shapeOf('  pull_request:')).toBe('unconditional-pull-request');
  });

  it('`branches: ["**"]` is unconditional — it is provably no filter at all', () => {
    expect(shapeOf('  pull_request:\n    branches: ["**"]')).toBe('unconditional-pull-request');
  });

  it('a `paths:` filter is paths-scoped', () => {
    expect(shapeOf('  pull_request:\n    paths: ["src/**"]')).toBe('paths-scoped-pull-request');
  });

  it('`paths-ignore:` is paths-scoped too', () => {
    expect(shapeOf('  pull_request:\n    paths-ignore: ["docs/**"]')).toBe(
      'paths-scoped-pull-request',
    );
  });

  it('a NON-universal `branches:` filter is NOT paths-scoped', () => {
    // The distinction that matters: `branches: ['*']` misses every slashed
    // branch, so calling it "deliberately paths-scoped" would launder a real
    // gap into an accepted exemption.
    expect(shapeOf('  pull_request:\n    branches: ["*"]')).toBe('otherwise-filtered-pull-request');
  });

  it('a `types:` filter is neither paths-scoped nor unconditional', () => {
    expect(shapeOf('  pull_request:\n    types: [labeled]')).toBe(
      'otherwise-filtered-pull-request',
    );
  });

  it('`paths:` alongside a non-universal `branches:` is NOT waved through', () => {
    // Mixed filters must fall to the strictest reading, or a `branches:` disarm
    // could ride in behind a legitimate `paths:`.
    expect(shapeOf('  pull_request:\n    paths: ["src/**"]\n    branches: ["main"]')).toBe(
      'otherwise-filtered-pull-request',
    );
  });

  it('a top-level `true:` key still resolves — the boolean-`on` fallback works', () => {
    // MEASURED, because the first version of this test was decoration and the
    // mutation proof said so. The claim it made — "`on:` parses as the YAML 1.1
    // boolean `true`, and the `doc[true]` fallback is what finds it" — is FALSE
    // for this parser: `yaml` v2 defaults to the YAML 1.2 core schema, where
    // `on` is the plain string key `'on'`. Deleting the fallback left that test
    // GREEN, which is exactly the "stays green when its subject is removed"
    // shape `workflow.md` calls decoration.
    //
    // So this exercises the fallback for real, with a document whose top-level
    // key genuinely is not `on`. The fallback is defensive against a schema or
    // parser change rather than against today's workflows — stated plainly here
    // instead of being dressed up as coverage of the normal path.
    const path = join(TMP, `wf-${seq++}.yml`);
    writeFileSync(
      path,
      'name: f\ntrue:\n  pull_request:\n    paths: ["a/**"]\njobs:\n  g:\n    runs-on: x\n',
    );
    expect(classifyTriggerShape(path)).toBe('paths-scoped-pull-request');
  });
});
