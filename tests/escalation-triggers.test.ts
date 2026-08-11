import { describe, expect, it } from 'vitest';
import {
  ACK_LABEL,
  classify,
  isAcknowledged,
  parseNameStatus,
  publicSurfaceChanged,
} from '../scripts/check-escalation-triggers.mjs';

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

  it('the kn-next.config.ts schema', () => {
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
});
