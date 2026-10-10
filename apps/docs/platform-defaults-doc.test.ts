/**
 * The "Platform defaults" page is the user-facing half of the cluster-scoped
 * platform config. A page like this rots in two ways: its numbers drift from the
 * operator's, and it documents fields that no longer exist (or omits ones that
 * do). So its LOAD-BEARING claims are derived from the shipped sources rather
 * than restated:
 *
 *  - every built-in value in the table equals the operator's constant;
 *  - the set of fields it documents equals the CRD's `spec` leaves, both ways;
 *  - the set of `PlatformDefaultsApplied` reasons it explains equals the set the
 *    operator can actually emit;
 *  - it says "absent means unchanged", the singleton name, the upgrade order,
 *    and that `fastColdStart` sets nothing yet (no claim is made for it).
 *
 * General user-facing-language rules (no ADR / issue numbers) are enforced for
 * every page by content-hygiene.test.ts.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';

const DOCS_DIR = resolve(import.meta.dirname, 'content/docs');
const PAGE = join(DOCS_DIR, 'platform-defaults.mdx');
const OPERATOR = resolve(import.meta.dirname, '../../packages/kn-next-operator');

const page = readFileSync(PAGE, 'utf-8');

/** `Name = value` constants from the operator's one table of built-in values. */
function builtinTable(): Record<string, string> {
  const src = readFileSync(join(OPERATOR, 'internal/defaults/defaults.go'), 'utf-8');
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/^\s+([A-Z][A-Za-z]+)\s+=\s+("?)([^"\n]+)\2\s*$/gm)) {
    out[m[1]] = m[3];
  }
  return out;
}

/** Dotted leaf paths under `spec` in the KnextPlatform CRD's schema. */
function crdSpecLeaves(): string[] {
  const crd = YAML.parse(
    readFileSync(
      join(OPERATOR, 'config/crd/bases/platform.kn-next.dev_knextplatforms.yaml'),
      'utf-8',
    ),
  ) as {
    spec: { versions: { schema: { openAPIV3Schema: { properties: { spec: unknown } } } }[] };
  };
  const spec = crd.spec.versions[0].schema.openAPIV3Schema.properties.spec as {
    properties: Record<string, unknown>;
  };
  const leaves: string[] = [];
  const walk = (node: { properties?: Record<string, unknown> }, prefix: string) => {
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      const c = child as { type?: string; properties?: Record<string, unknown> };
      const path = prefix ? `${prefix}.${key}` : key;
      if (c.type === 'object' && c.properties) walk(c, path);
      else leaves.push(path);
    }
  };
  walk(spec, '');
  return leaves.sort();
}

/** The `PlatformDefaultsApplied` reasons the operator can emit. */
function operatorReasons(): string[] {
  const src = readFileSync(join(OPERATOR, 'internal/controller/platform_state.go'), 'utf-8');
  return [...src.matchAll(/^\s+Reason[A-Za-z]+\s+=\s+"([A-Za-z]+)"/gm)].map((m) => m[1]).sort();
}

/** Backticked identifiers in the given table column (1 = first) of the page. */
function tableCode(column: number, re: RegExp): string[] {
  return page
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .map((l) => l.split('|')[column]?.trim() ?? '')
    .map((cell) => cell.match(/^`([^`]+)`$/)?.[1] ?? '')
    .filter((c) => re.test(c));
}

describe('docs — platform defaults', () => {
  it('has front matter with a title and description', () => {
    expect(page).toMatch(/^---\n(?:.*\n)*?title: .+\n(?:.*\n)*?description: .+\n---/);
  });

  it('is listed in the sidebar, under the Platform group', () => {
    const meta = JSON.parse(readFileSync(join(DOCS_DIR, 'meta.json'), 'utf-8')) as {
      pages: string[];
    };
    const at = meta.pages.indexOf('platform-defaults');
    expect(at).toBeGreaterThan(-1);
    const heading = meta.pages.lastIndexOf('---Platform---', at);
    const next = meta.pages.findIndex((p, i) => i > heading && p.startsWith('---'));
    expect(heading).toBeGreaterThan(-1);
    expect(at).toBeLessThan(next === -1 ? meta.pages.length : next);
  });

  it('quotes every built-in value exactly as the operator defines it', () => {
    const t = builtinTable();
    // A parser that found nothing would make every check below vacuous.
    expect(Object.keys(t).length).toBeGreaterThanOrEqual(8);
    const row = (field: string) => page.split('\n').find((l) => l.includes(`\`${field}\``)) ?? '';
    const expectBuiltin = (field: string, value: string) => {
      const r = row(field);
      expect(r).not.toBe('');
      expect(r).toContain(`\`${value}\``);
    };
    expectBuiltin('resources.defaults.cpuRequest', t.CPURequest);
    expectBuiltin('resources.defaults.cpuLimit', t.CPULimit);
    expectBuiltin('resources.defaults.memoryRequest', t.MemoryRequest);
    expectBuiltin('resources.defaults.memoryLimit', t.MemoryLimit);
    expectBuiltin('limits.timeoutSeconds', t.TimeoutSeconds);
    expectBuiltin('scaling.defaults.containerConcurrency', t.ContainerConcurrency);
    expectBuiltin('database.connectionBudget', t.ConnectionBudget);
    expectBuiltin('rollout.maxAppsPerMinute', t.MaxAppsPerMinute);
  });

  it('documents exactly the fields the CRD defines, in both directions', () => {
    const leaves = crdSpecLeaves();
    expect(leaves.length).toBeGreaterThanOrEqual(12);
    // The fields table: column 1 is the area, column 2 the field.
    const documented = tableCode(2, /^[a-z]+(\.[a-zA-Z]+)+$/);
    // Every schema field is documented (profile is explained in its own section)…
    for (const leaf of leaves.filter((l) => l !== 'profile')) {
      expect(documented).toContain(leaf);
    }
    // …and nothing is documented that the schema does not have.
    for (const d of documented) {
      expect(leaves).toContain(d);
    }
  });

  it('explains exactly the PlatformDefaultsApplied reasons the operator can emit', () => {
    const emitted = operatorReasons();
    expect(emitted.length).toBeGreaterThanOrEqual(7);
    const explained = tableCode(1, /^[A-Z][A-Za-z]+$/).sort();
    expect(explained).toEqual(emitted);
  });

  it('says absent means unchanged, including for an empty or default-profile object', () => {
    expect(page).toMatch(/Absent means unchanged/);
    expect(page).toMatch(
      /ships the custom resource\s+definition but \*\*no\*\* `KnextPlatform` object/,
    );
    expect(page).toMatch(/`spec: \{\}`/);
    expect(page).toMatch(/`profile: default`/);
  });

  it('names the singleton and the state it is cluster-scoped', () => {
    expect(page).toMatch(/cluster-scoped and \*\*must be named `default`\*\*/);
    expect(page).toContain('name: default');
  });

  it('is honest that fastColdStart sets nothing yet and makes no claim for it', () => {
    expect(page).toMatch(
      /`fastColdStart`\*\* is accepted but \*\*sets no value in this release\*\*/,
    );
    // No performance claim anywhere on the page.
    expect(page).not.toMatch(/\bfaster\b|\bspeeds? up\b|\bsaves?\b|\breduces cold/i);
  });

  it('states the upgrade order and the resource back-fill caveat', () => {
    expect(page).toMatch(/Operator and definition first, then the `KnextPlatform`, then the CLI/);
    expect(page).toContain('scaling.cpuRequest');
    expect(page).toMatch(/fills in the other\s+three/);
  });

  it('says changes are paced, held on invalid, and that an own deploy is not queued', () => {
    expect(page).toMatch(/Changes are paced/);
    expect(page).toMatch(/held, not applied/);
    expect(page).toMatch(/Your own deploy is never queued/);
  });
});
