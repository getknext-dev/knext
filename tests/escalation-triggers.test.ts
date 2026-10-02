import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import {
  ACK_BODY_PATTERN,
  ACK_LABEL,
  classify,
  isAcknowledged,
  LEGACY_ACK_LABEL,
  parseNameStatus,
  publicSurfaceChanged,
} from '../scripts/check-escalation-triggers.mjs';

const WORKFLOW_PATH = resolve(import.meta.dirname, '../.github/workflows/escalation-triggers.yml');
function readWorkflow() {
  const raw = readFileSync(WORKFLOW_PATH, 'utf8');
  // YAML 1.1 parses the unquoted `on` key as boolean `true`; accept both, same as
  // tests/merge-queue-triggers.test.ts.
  const doc = parse(raw) as Record<string, unknown>;
  const on = (doc.on ?? (doc as Record<string, unknown>)[true as unknown as string]) as Record<
    string,
    unknown
  >;
  return { doc, on };
}

/**
 * The escalation-trigger check is a GATE, so it needs the treatment a gate gets:
 * cases that prove it fires, and cases that prove it does NOT fire on ordinary work.
 *
 * The second half is not padding. `.claude/rules/workflow.md` and this repo's own
 * history both say a guard that cries wolf gets worked around — the reader stops
 * reading the message and starts reaching for the escape hatch. Measured against 40
 * first-parent commits this fires on 15%, and every one of those is defensible, which
 * is the number these allow-cases exist to defend.
 */

const change = (path: string, status = 'M') => ({ path, status });

describe('escalation triggers — fires when it must', () => {
  it('the NextApp CRD type', () => {
    const fired = classify([change('packages/kn-next-operator/api/v1alpha1/nextapp_types.go')]);
    expect(fired.map((f: { id: string }) => f.id)).toContain('crd');
  });

  it('the knext.config.ts schema', () => {
    expect(
      classify([change('packages/kn-next/src/config.ts')]).map((f: { id: string }) => f.id),
    ).toContain('config-schema');
  });

  it('the CLI surface, anywhere under src/cli/', () => {
    expect(
      classify([change('packages/kn-next/src/cli/deploy.ts')]).map((f: { id: string }) => f.id),
    ).toContain('cli-surface');
  });

  it('a MODIFIED existing ADR', () => {
    expect(
      classify([change('docs/adr/0001-operator-single-source-of-truth.md', 'M')]).map(
        (f: { id: string }) => f.id,
      ),
    ).toContain('adr');
  });

  it('a DELETED ADR', () => {
    expect(
      classify([change('docs/adr/0010-knative-pvc-feature-flags.md', 'D')]).map(
        (f: { id: string }) => f.id,
      ),
    ).toContain('adr');
  });

  it('reports every distinct trigger, not just the first', () => {
    const fired = classify([
      change('packages/kn-next-operator/api/v1alpha1/nextapp_types.go'),
      change('packages/kn-next/src/config.ts'),
      change('packages/kn-next/src/cli/validate.ts'),
    ]);
    expect(fired.map((f: { id: string }) => f.id).sort()).toEqual([
      'cli-surface',
      'config-schema',
      'crd',
    ]);
  });
});

describe('escalation triggers — stays quiet on ordinary work', () => {
  it('ADDING a new ADR does not fire', () => {
    // Writing an ADR is the OUTPUT of an escalation. Demanding a gate for it would
    // tax the exact behaviour the rules are trying to encourage.
    expect(classify([change('docs/adr/0043-something-new.md', 'A')])).toHaveLength(0);
  });

  it('gate MEASUREMENT data does not fire', () => {
    // docs/adr/gates/*.json changes whenever someone records a benchmark.
    expect(classify([change('docs/adr/gates/adr-0042-gates.json', 'M')])).toHaveLength(0);
  });

  it('operator internals outside the CRD type do not fire', () => {
    expect(
      classify([change('packages/kn-next-operator/internal/controller/nextapp_controller.go')]),
    ).toHaveLength(0);
  });

  it('CLI TESTS do not fire — only the surface itself', () => {
    expect(classify([change('packages/kn-next/src/__tests__/deploy-cr.test.ts')])).toHaveLength(0);
  });

  it('docs, benchmarks and workflows do not fire', () => {
    expect(
      classify([
        change('docs/ARCHITECTURE.md'),
        change('benchmarks/scale-to-zero-oke/run.sh'),
        change('.github/workflows/ci.yml'),
        change('README.md'),
      ]),
    ).toHaveLength(0);
  });
});

describe('public manifest surface', () => {
  const base = {
    name: '@getknext/core',
    version: '1.0.0',
    exports: { '.': './dist/index.js' },
    bin: { 'kn-next': './dist/cli/kn-next.js' },
  };

  it('a version bump alone is NOT a public-surface change', () => {
    // package.json is edited constantly; firing on every edit would train everyone
    // to reach for the ack label reflexively, which is how a gate stops meaning anything.
    expect(publicSurfaceChanged(base, { ...base, version: '1.0.1' })).toBe(false);
  });

  it('a dependency change is NOT a public-surface change', () => {
    expect(publicSurfaceChanged(base, { ...base, dependencies: { zod: '^3' } })).toBe(false);
  });

  it('adding an exports subpath IS', () => {
    expect(
      publicSurfaceChanged(base, {
        ...base,
        exports: { '.': './dist/index.js', './adapter': './dist/adapter.js' },
      }),
    ).toBe(true);
  });

  it('removing a bin IS', () => {
    expect(publicSurfaceChanged(base, { ...base, bin: undefined })).toBe(true);
  });

  it('a manifest missing on one side is handled, not thrown on', () => {
    expect(publicSurfaceChanged(null, base)).toBe(true);
    expect(publicSurfaceChanged(null, null)).toBe(false);
  });
});

describe('diff parsing and acknowledgement', () => {
  it('parses name-status output', () => {
    expect(parseNameStatus('M\tdocs/adr/0001.md\nA\tsrc/new.ts\n')).toEqual([
      { status: 'M', path: 'docs/adr/0001.md' },
      { status: 'A', path: 'src/new.ts' },
    ]);
  });

  it('takes the DESTINATION path of a rename', () => {
    expect(parseNameStatus('R100\told/path.ts\tnew/path.ts')).toEqual([
      { status: 'R', path: 'new/path.ts' },
    ]);
  });

  it('the ack label is recognised, case-insensitively', () => {
    expect(isAcknowledged([ACK_LABEL])).toBe(true);
    expect(isAcknowledged([ACK_LABEL.toUpperCase()])).toBe(true);
    expect(isAcknowledged(['tier-A', 'bug'])).toBe(false);
    expect(isAcknowledged([])).toBe(false);
  });

  it('the legacy design-gate:cleared label still counts (backward compatible)', () => {
    expect(isAcknowledged([LEGACY_ACK_LABEL])).toBe(true);
    expect(isAcknowledged([LEGACY_ACK_LABEL.toUpperCase()])).toBe(true);
  });

  it('a PR-body acknowledgement line counts, with no label present', () => {
    const body = [
      'Some PR description.',
      '',
      'Escalation trigger acknowledged: CLI surface — adds a new flag, no behaviour change.',
      '',
      'More text.',
    ].join('\n');
    expect(isAcknowledged([], body)).toBe(true);
  });

  it('the body line is matched case-insensitively and tolerates surrounding whitespace', () => {
    expect(
      isAcknowledged([], '  escalation TRIGGER acknowledged: adr — amends rationale only'),
    ).toBe(true);
  });

  it('an unrelated body does NOT acknowledge', () => {
    expect(isAcknowledged([], 'This PR touches the CLI surface but says nothing else.')).toBe(
      false,
    );
    expect(isAcknowledged([])).toBe(false);
    expect(isAcknowledged([], undefined)).toBe(false);
  });

  it('ACK_BODY_PATTERN matches the documented line shape directly', () => {
    expect(ACK_BODY_PATTERN.test('Escalation trigger acknowledged: CRD — reason')).toBe(true);
    expect(ACK_BODY_PATTERN.test('not an acknowledgement')).toBe(false);
  });
});

describe('escalation-triggers.yml — the workflow actually re-runs on a body edit', () => {
  /**
   * The PR-body acknowledgement line is one of the two acknowledgement mechanisms.
   * If `pull_request.types` does not include `edited`, adding that line to an
   * ALREADY-OPEN PR never retriggers this check — it stays red until an unrelated
   * push happens to retrigger it. Caught in review on #1804 round 2.
   */
  it('pull_request.types includes `edited`', () => {
    const { on } = readWorkflow();
    const pr = on.pull_request as { types?: string[] };
    expect(pr.types ?? []).toContain('edited');
  });

  it('still triggers on the mechanically-necessary PR events (no regression from the fix)', () => {
    const { on } = readWorkflow();
    const pr = on.pull_request as { types?: string[] };
    for (const t of ['opened', 'synchronize', 'reopened', 'labeled', 'unlabeled']) {
      expect(pr.types ?? []).toContain(t);
    }
  });

  it('still triggers on merge_group (queue hang guard, unchanged by this fix)', () => {
    const { on } = readWorkflow();
    expect('merge_group' in on).toBe(true);
  });

  it('concurrency cancels a stale PR run but never a merge_group run', () => {
    const { doc } = readWorkflow();
    const concurrency = doc.concurrency as { group?: string; 'cancel-in-progress'?: unknown };
    expect(concurrency).toBeTruthy();
    // The group key must NOT include the event name, or an `edited` run and a
    // `synchronize` run on the same PR land in sibling groups and race instead of
    // cancelling each other.
    expect(String(concurrency.group)).not.toContain('event_name');
    expect(String(concurrency.group)).toContain('pull_request.number');
    // cancel-in-progress must be scoped to pull_request — a cancelled merge_group
    // run never reports its required context and hangs the queue.
    expect(String(concurrency['cancel-in-progress'])).toContain("event_name == 'pull_request'");
  });
});
