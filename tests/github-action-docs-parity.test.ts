/**
 * The GitHub Action's docs page must describe the action that exists (#874).
 *
 * This guard is here because the page failed it. Before the action was built,
 * `github-action.mdx` documented a `getknext-dev/knext@v1` action with inputs
 * — `skip-upload`, `bucket`, `tag` — and an output, `url`, that no action in
 * this repository had, because no action existed at all. The nav linked to it,
 * so it read as shipped.
 *
 * A docs page is a promise about a surface. Nothing in CI checked that the
 * surface was real, and the page was wrong in the most expensive direction: a
 * reader copies a workflow, and it fails on their first push with an
 * unrecognised-input error they cannot debug from their side.
 *
 * Both halves, deliberately:
 *   - every input the page USES must exist on the action (or the docs lie), and
 *   - every input the action REQUIRES must appear in the page's examples (or
 *     the shortest documented path does not run).
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

const ACTION = 'packages/kn-next-action/action.yml';
const PAGE = 'apps/docs/content/docs/github-action.mdx';

interface ActionInput {
  required?: boolean;
  default?: unknown;
}

const action = () =>
  parse(read(ACTION)) as {
    inputs: Record<string, ActionInput>;
    outputs?: Record<string, unknown>;
    runs: { using: string; steps: { name?: string; run?: string }[] };
  };

/** Every `with:` block in the page that targets this action. */
function documentedUsages(): Record<string, unknown>[] {
  const page = read(PAGE);
  const usages: Record<string, unknown>[] = [];
  for (const block of page.matchAll(/```yaml[^\n]*\n([\s\S]*?)```/g)) {
    let doc: { jobs?: Record<string, { steps?: unknown[] }> };
    try {
      doc = parse(block[1] as string);
    } catch {
      // Reported by its own test below rather than silently skipped.
      continue;
    }
    for (const job of Object.values(doc?.jobs ?? {}))
      for (const step of (job.steps ?? []) as {
        uses?: string;
        with?: Record<string, unknown>;
      }[])
        if (String(step.uses ?? '').includes('kn-next-action')) usages.push(step.with ?? {});
  }
  return usages;
}

describe('the GitHub Action docs describe the action that exists (#874)', () => {
  it('the action manifest parses and is a composite action', () => {
    const a = action();
    expect(a.runs.using).toBe('composite');
    expect(a.runs.steps.length).toBeGreaterThan(0);
  });

  it('every yaml block on the page parses', () => {
    // A page whose examples do not parse cannot be copied, and nothing else
    // here would notice — the usage scan skips unparseable blocks.
    const page = read(PAGE);
    const blocks = [...page.matchAll(/```yaml[^\n]*\n([\s\S]*?)```/g)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) expect(() => parse(b[1] as string)).not.toThrow();
  });

  it('the page shows the action at least once', () => {
    // Without this the two directions below pass vacuously on a page that
    // stopped mentioning the action at all.
    expect(documentedUsages().length).toBeGreaterThan(0);
  });

  it('uses no input the action does not have', () => {
    const valid = new Set(Object.keys(action().inputs));
    const used = documentedUsages().flatMap((w) => Object.keys(w));
    expect(used.filter((k) => !valid.has(k))).toEqual([]);
  });

  it('every example passes the inputs the action requires', () => {
    // `namespace` has no default on purpose — it is what bounds the
    // credential's blast radius. An example omitting it fails at the first
    // push, which is the worst possible place to discover a docs gap.
    const required = Object.entries(action().inputs)
      .filter(([, v]) => v.required === true)
      .map(([k]) => k);
    expect(required.length).toBeGreaterThan(0);
    for (const usage of documentedUsages())
      for (const key of required) expect(Object.keys(usage)).toContain(key);
  });

  it('documents the credential preflight rather than only advising scope', () => {
    // The page previously said "do not reuse your personal admin
    // kubeconfig" — advice, which people in a hurry skip. The action now
    // refuses one, and a reader who does not know that will not understand
    // the failure when it happens.
    const page = read(PAGE);
    expect(page).toMatch(/refuse/i);
    expect(page).toContain('skip-credential-preflight');
    // The Role, in full, on the page — not a link to somewhere else.
    expect(page).toContain('apps.kn-next.dev');
    expect(page).toContain('nextapps');
  });

  it('claims no output, because the action sets none', () => {
    // The page used to advertise a `url` output. Nothing populated it.
    expect(action().outputs).toBeUndefined();
    expect(read(PAGE)).not.toMatch(/\*\*Output:\*\*/);
  });
});
