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
 * That exemption is now GONE (#677): the guard is converted, using the audit's
 * `allowPathsFilter` opt-in, so the list is one entry shorter and the floors
 * below moved with it. What the episode established is why the list is data at
 * all — a wrong reason in a self-reported exemption list is precisely the
 * silent-exemption shape `workflow.md` warns about, and it survived two rounds
 * of being read rather than checked.
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
    // The floors moved with #677: the `paths-scoped-pull-request` entry left
    // the list when its guard was converted (5 entries, 3 of them trigger-half),
    // and a floor left at the old number would have been the "edit the guard to
    // get green" move this repo keeps having to unwind. They are still floors
    // and not equalities — an entry LEAVING is progress; the list silently
    // emptying is not.
    expect(UNCONVERTED_GUARD_TRIAGE.length).toBeGreaterThanOrEqual(5);
    expect(triggerEntries.length).toBeGreaterThanOrEqual(3);
    expect(
      UNCONVERTED_GUARD_TRIAGE.filter((e) => e.category === 'opposite-claim').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('the `paths-scoped-pull-request` category is EMPTY — the option replaced it (#690)', () => {
    // Was a comment three lines up ("the floors moved with #677 …") and a
    // sentence in `blocking-gate.ts`'s header: "a paths-scoped trigger is no
    // longer sufficient grounds for an exemption: convert with the option
    // instead". By this repo's own standard a documented expectation decays, and
    // an empty category with prose saying "do not use this" is exactly the shape
    // someone re-populates without noticing — `TriageCategory` still offers it,
    // `TRIGGER_CATEGORIES` still admits it, and the per-entry assertion below
    // would happily CONFIRM a new one as correctly classified. That is the
    // failure this converts into a gate: a paths-scoped guard now has an audit
    // path (`allowPathsFilter`), so filing it as exempt is a regression, not a
    // triage.
    //
    // Deliberately an equality, not a floor: every OTHER count in this file is a
    // floor because an entry LEAVING is progress. Here the direction is
    // inverted — an entry ARRIVING is the regression — so the only honest bound
    // is zero.
    expect(
      UNCONVERTED_GUARD_TRIAGE.filter((e) => e.category === 'paths-scoped-pull-request'),
      'a paths-scoped guard has an audit path (`allowPathsFilter`) — convert it instead of exempting it',
    ).toEqual([]);
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

  // There was a fourth `it.each` here asserting
  // `.not.toBe('unconditional-pull-request')` on the same workflows. It is gone
  // rather than reworded: `triggerEntries` is filtered to the two trigger
  // categories, so `toBe(entry.category)` above ALREADY excludes
  // `'unconditional-pull-request'` — the extra assertion was true by
  // construction and could not fail while its sibling passed. It read as
  // coverage of the headline invariant ("an exempt workflow that later gains an
  // unconditional PR trigger reds") while being the one assertion that could
  // never fire. That invariant is real and is carried by the sibling; what it
  // needed was a classifier that can SEE all three `on:` syntaxes, which is the
  // `classifyTriggerShape` block below.
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

  /** `on:` in its MAPPING form — the block is indented under a bare `on:`. */
  const shapeOf = (on: string) => shapeOfRaw(`on:\n${on}`);

  /** `on:` written out in full, so the LIST and SCALAR forms are reachable too. */
  const shapeOfRaw = (onBlock: string) => {
    const path = join(TMP, `wf-${seq++}.yml`);
    writeFileSync(path, `name: fixture\n${onBlock}\njobs:\n  gate:\n    runs-on: ubuntu-latest\n`);
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

  /**
   * `on:` has THREE syntaxes, and only one of them is a mapping (#676 round 4).
   *
   * GitHub accepts `on: [pull_request, push]` (sequence) and `on: pull_request`
   * (scalar) as well as the block mapping every workflow in this repo happens to
   * use today. The first version of this classifier tested `'pull_request' in on`
   * against the parse without normalising, so both non-mapping forms fell out as
   * `no-pull-request-trigger` — MEASURED by rewriting `docs-closure-nightly.yml`
   * three ways in a sandbox: list form GREEN, scalar form GREEN, mapping form
   * (control) RED. An exempt guard could therefore keep asserting "this workflow
   * has no `pull_request` trigger" about a workflow that had become an
   * unconditional PR gate — the stays-green-when-its-subject-is-removed shape.
   *
   * Note the POLARITY, because the identical `'pull_request' in on` test inside
   * `auditBlockingGate` is not a bug: there a missing trigger is REPORTED as a
   * problem, so mis-reading a list form fails safe (over-strict). Here "absent"
   * means "wave this exemption through", so the same code fails UNSAFE. Same
   * pattern, opposite polarity.
   */
  it('the LIST form of `on:` is seen — `on: [pull_request, push]`', () => {
    expect(shapeOfRaw('on: [pull_request, push]')).toBe('unconditional-pull-request');
  });

  it('the LIST form without a PR trigger is still no-trigger', () => {
    expect(shapeOfRaw('on: [push, workflow_dispatch]')).toBe('no-pull-request-trigger');
  });

  it('the SCALAR form of `on:` is seen — `on: pull_request`', () => {
    expect(shapeOfRaw('on: pull_request')).toBe('unconditional-pull-request');
  });

  it('the SCALAR form without a PR trigger is still no-trigger', () => {
    expect(shapeOfRaw('on: schedule')).toBe('no-pull-request-trigger');
  });

  /**
   * `pull_request_target` is IN SCOPE, deliberately.
   *
   * It is the more dangerous of the two — it runs with the base repository's
   * secrets and write-scoped token against the head ref's changes — so a guard
   * exempt on the grounds of "no `pull_request` trigger" while the workflow runs
   * unconditionally on `pull_request_target` is the same silent exemption, on the
   * trigger it matters more for. Treating it as out of scope would leave exactly
   * the hole this round is closing, for the worse case.
   */
  it('`pull_request_target:` counts as a PR trigger', () => {
    expect(shapeOf('  pull_request_target:')).toBe('unconditional-pull-request');
  });

  it('`pull_request_target:` counts in the list form too', () => {
    expect(shapeOfRaw('on: [pull_request_target]')).toBe('unconditional-pull-request');
  });

  it('a paths-scoped `pull_request_target:` is paths-scoped', () => {
    expect(shapeOf('  pull_request_target:\n    paths: ["src/**"]')).toBe(
      'paths-scoped-pull-request',
    );
  });

  it('with both triggers, the LEAST exempt classification wins', () => {
    // A `paths:`-scoped `pull_request` does not launder an unconditional
    // `pull_request_target` sitting beside it.
    expect(shapeOf('  pull_request:\n    paths: ["src/**"]\n  pull_request_target:')).toBe(
      'unconditional-pull-request',
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
