import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { CRD_PATH, run, WAIVERS_PATH } from '../scripts/crd-schema-diff.mjs';
import { applyWaivers, diffCrd, validateWaiverEntry } from '../scripts/lib/crd-schema-diff.mjs';

/**
 * The narrowing waiver for the NextApp CRD additive-only guard (ADR-0017
 * Amendment 3). A waiver entry names ONE exact violation string (field path +
 * rule text), is dated, justified and points at the ADR amendment, and is
 * single-use: an entry that matches no current violation fails the guard, so
 * it must be deleted once the narrowing ships in a tag and cannot be reused.
 */

const repoRoot = join(import.meta.dir, '..');
const ADR = 'docs/adr/0017-crd-stays-v1alpha1-conversion-webhook-deferred.md';

function crdWith(keyPrefix: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    spec: {
      group: 'apps.kn-next.dev',
      versions: [
        {
          name: 'v1alpha1',
          served: true,
          storage: true,
          schema: {
            openAPIV3Schema: {
              type: 'object',
              properties: {
                spec: {
                  type: 'object',
                  properties: {
                    cache: {
                      type: 'object',
                      properties: { keyPrefix: { type: 'string', ...keyPrefix } },
                    },
                    image: { type: 'string', ...extra },
                  },
                },
              },
            },
          },
        },
      ],
    },
  };
}

const RULE = "self != 'kn-next' && !self.startsWith('kn-next:')";
const CEL_VIOLATION = `version "v1alpha1", $.spec.cache.keyPrefix.x-kubernetes-validations: new or changed CEL rule: ${JSON.stringify(RULE)}`;

function entry(overrides: Record<string, unknown> = {}) {
  return {
    violation: CEL_VIOLATION,
    field: 'spec.cache.keyPrefix',
    rule: RULE,
    added: '2026-10-16',
    justification:
      'Rejects the reserved shared keyspace at admission; safe on the Kubernetes >= 1.30 floor because validation ratcheting keeps stored objects updatable.',
    adr: `${ADR}#amendment-3-2026-10-16--narrowing-waivers`,
    ...overrides,
  };
}

const oldCrd = crdWith({});
const narrowed = crdWith({ 'x-kubernetes-validations': [{ rule: RULE, message: 'reserved' }] });

function runWith(base: unknown, head: unknown, waivers: unknown[]) {
  const logs: string[] = [];
  const exit = run(['--base-ref', 'v9.9.9'], {
    log: (m: string) => logs.push(m),
    execFileSyncFn: ((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'show') return stringify(base);
      throw new Error(`unexpected exec ${cmd} ${args.join(' ')}`);
    }) as never,
    readFileSyncFn: (() => stringify(head)) as never,
    readWaiversFn: () => ({ waivers }),
    fileExistsFn: (p: string) => p === ADR,
  });
  return { exit, out: logs.join('\n') };
}

describe('diffOpenApiSchema — a narrowing bound ADDED where none existed', () => {
  it('flags maxLength added to an existing field', () => {
    const r = diffCrd(crdWith({}), crdWith({ maxLength: 63 }));
    expect(r.ok).toBe(false);
    expect(r.violations.join('\n')).toContain(
      'keyPrefix.maxLength: added (63) where none existed before',
    );
  });
  it('flags minimum added to an existing field', () => {
    const r = diffCrd(crdWith({}), crdWith({}, { minimum: 1 }));
    expect(r.violations.join('\n')).toContain('image.minimum: added (1)');
  });
  it('does not flag a min* bound of 0 added — it constrains nothing', () => {
    expect(diffCrd(crdWith({}), crdWith({ minLength: 0 })).ok).toBe(true);
  });
});

describe('validateWaiverEntry', () => {
  it('accepts a complete entry', () => {
    expect(validateWaiverEntry(entry(), (p) => p === ADR)).toEqual([]);
  });
  for (const key of ['violation', 'field', 'rule', 'added', 'justification', 'adr']) {
    it(`rejects an entry missing ${key}`, () => {
      const e = entry();
      delete (e as Record<string, unknown>)[key];
      expect(validateWaiverEntry(e, (p) => p === ADR).length).toBeGreaterThan(0);
    });
  }
  it('rejects an undated or malformed date', () => {
    expect(validateWaiverEntry(entry({ added: 'soon' }), (p) => p === ADR).length).toBeGreaterThan(
      0,
    );
  });
  it('rejects a token justification', () => {
    expect(
      validateWaiverEntry(entry({ justification: 'needed' }), (p) => p === ADR).length,
    ).toBeGreaterThan(0);
  });
  it('rejects an adr pointer that is not an existing ADR-0017 file', () => {
    expect(
      validateWaiverEntry(entry({ adr: 'docs/adr/0099-x.md' }), () => true).length,
    ).toBeGreaterThan(0);
    expect(validateWaiverEntry(entry(), () => false).length).toBeGreaterThan(0);
  });
  it('rejects an entry whose violation does not name its own field and rule', () => {
    expect(
      validateWaiverEntry(entry({ field: 'spec.image' }), (p) => p === ADR).length,
    ).toBeGreaterThan(0);
    expect(
      validateWaiverEntry(entry({ rule: 'self.size() < 3' }), (p) => p === ADR).length,
    ).toBeGreaterThan(0);
  });
});

describe('validateWaiverEntry — only ratchetable value narrowings are waivable', () => {
  const ok = (p: string) => p === ADR;
  it('refuses to waive a removed field', () => {
    const v = 'version "v1alpha1", $.spec.cache.keyPrefix: field removed';
    expect(
      validateWaiverEntry(entry({ violation: v, rule: 'field removed' }), ok).join('\n'),
    ).toContain('waivable');
  });
  it('refuses to waive a type change', () => {
    const v = 'version "v1alpha1", $.spec.cache.keyPrefix: type changed from "string" to "integer"';
    expect(validateWaiverEntry(entry({ violation: v, rule: 'integer' }), ok).join('\n')).toContain(
      'waivable',
    );
  });
  it('refuses to waive a CEL transition rule (oldSelf)', () => {
    const rule = 'self == oldSelf';
    const v = `version "v1alpha1", $.spec.cache.keyPrefix.x-kubernetes-validations: new or changed CEL rule: ${JSON.stringify(rule)}`;
    expect(validateWaiverEntry(entry({ violation: v, rule }), ok).join('\n')).toContain('oldSelf');
  });
  it('accepts a pattern and a bound narrowing', () => {
    const pv =
      'version "v1alpha1", $.spec.cache.keyPrefix.pattern: added ("^a$") where none existed before';
    expect(validateWaiverEntry(entry({ violation: pv, rule: '^a$' }), ok)).toEqual([]);
    const bv =
      'version "v1alpha1", $.spec.cache.keyPrefix.maxLength: added (63) where none existed before';
    expect(validateWaiverEntry(entry({ violation: bv, rule: '63' }), ok)).toEqual([]);
  });
});

describe('applyWaivers', () => {
  it('waives only an exact match, and reports an unmatched entry as stale', () => {
    const other =
      'version "v1alpha1", $.spec.image.pattern: added ("^x$") where none existed before';
    const r = applyWaivers(
      [CEL_VIOLATION, other],
      [entry(), entry({ violation: `${CEL_VIOLATION} ` })],
    );
    expect(r.waived).toEqual([CEL_VIOLATION]);
    expect(r.remaining).toEqual([other]);
    expect(r.stale.map((e: { violation: string }) => e.violation)).toEqual([`${CEL_VIOLATION} `]);
  });
});

describe('run — the guard with waivers', () => {
  it('passes when every violation is waived by an exact entry', () => {
    const { exit, out } = runWith(oldCrd, narrowed, [entry()]);
    expect(exit).toBe(0);
    expect(out).toContain('waived');
  });

  it('fails on a second, unlisted narrowing next to a waived one', () => {
    const both = crdWith({ 'x-kubernetes-validations': [{ rule: RULE }] }, { pattern: '^r' });
    const { exit, out } = runWith(oldCrd, both, [entry()]);
    expect(exit).toBe(1);
    expect(out).toContain('$.spec.image.pattern');
  });

  it('fails when the listed rule text changes (the entry no longer matches, and goes stale)', () => {
    const edited = crdWith({ 'x-kubernetes-validations': [{ rule: `${RULE} && self != 'x'` }] });
    const { exit, out } = runWith(oldCrd, edited, [entry()]);
    expect(exit).toBe(1);
    expect(out).toContain('new or changed CEL rule');
    expect(out).toContain('stale');
  });

  it('fails on a stale entry even when the diff is clean (single-use)', () => {
    const { exit, out } = runWith(narrowed, narrowed, [entry()]);
    expect(exit).toBe(1);
    expect(out).toContain('stale');
  });

  it('fails on a malformed entry rather than honouring it', () => {
    const { exit, out } = runWith(oldCrd, narrowed, [entry({ justification: '' })]);
    expect(exit).toBe(1);
    expect(out).toContain('invalid waiver');
  });
});

describe('the committed waiver file', () => {
  const file = JSON.parse(readFileSync(join(repoRoot, WAIVERS_PATH), 'utf8'));
  const fileExists = (p: string) => existsSync(join(repoRoot, p));

  it('every entry is well-formed and points at an existing ADR-0017', () => {
    for (const e of file.waivers) expect(validateWaiverEntry(e, fileExists)).toEqual([]);
  });

  it('waives EXACTLY the keyPrefix narrowing the generated CRD carries, nothing more', () => {
    // Rebuild the pre-narrowing CRD — keyPrefix was a plain optional string
    // there, with no validation keyword at all — then diff: the violations must
    // be exactly the waived set. Any OTHER constraint added to keyPrefix (an
    // unlisted second narrowing) or an edited rule text shows up as a violation
    // the file does not list. The CI job runs the same guard against the real
    // last tag; this check needs no git history.
    const head = parse(readFileSync(join(repoRoot, CRD_PATH), 'utf8'));
    const base = structuredClone(head);
    for (const v of base.spec.versions) {
      const cache = v.schema.openAPIV3Schema.properties.spec.properties.cache.properties;
      cache.keyPrefix = { description: cache.keyPrefix.description, type: 'string' };
    }
    const { violations } = diffCrd(base, head);
    expect([...violations].sort()).toEqual(
      file.waivers.map((e: { violation: string }) => e.violation).sort(),
    );
  });
});
