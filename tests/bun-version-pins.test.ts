import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Absolute, not CWD-relative — the repo convention (vitest.config.ts explains
// why: a run from a sub-directory must not resolve a non-existent path).
const REPO_ROOT = resolve(import.meta.dirname, '..');

/**
 * Every setup-bun step in every workflow must PIN bun (#754).
 *
 * SCAN, don't enumerate: Bun 1.4.0 shipped mid-day 2026-08-20 and changed the
 * compile-cache probe shape; the one `bun-version: latest` lane that ran after
 * the release went red while main's morning run (1.3.14) passed. A pin fixed
 * the five sites that existed — this test is what stops the SIXTH site from
 * reintroducing the drift, including the quiet form: a setup-bun step with NO
 * bun-version key at all also means latest.
 *
 * Allowed forms: an explicit x.y.z, or the #188 dispatch-knob fallback
 * `${{ github.event.inputs.bun-version || 'x.y.z' }}` — note the INPUT's
 * default must itself be a pin (workflow_dispatch materialises defaults;
 * asserted in compat-suite-workflow.test.ts), the `||` alone is not enough.
 */
const WF_DIR = join(REPO_ROOT, '.github/workflows');
const PIN_RE = /^\d+\.\d+\.\d+$/;
const FALLBACK_RE = /\$\{\{\s*github\.event\.inputs\.bun-version\s*\|\|\s*'(\d+\.\d+\.\d+)'\s*\}\}/;

type Step = { file: string; line: number; version: string | null; inputDefault: string | null };

function setupBunSteps(): Step[] {
  const out: Step[] = [];
  for (const f of readdirSync(WF_DIR)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const lines = readFileSync(join(WF_DIR, f), 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (!/uses:\s*\S*setup-bun/.test(l)) return;
      // find bun-version within the step's `with:` block — walk to the next
      // step boundary, NOT a fixed window: a long comment block above the key
      // (test-e2e-deploy.yml keeps 16 lines of pin rationale there) must not
      // make the scanner misread a pinned step as unpinned. Cap generously.
      let version: string | null = null;
      for (let j = i + 1; j < Math.min(i + 60, lines.length); j++) {
        if (/^\s*-\s+(name|uses):/.test(lines[j])) break;
        const m = lines[j].match(/bun-version:\s*(.+?)\s*(#.*)?$/);
        if (m) {
          version = m[1].replace(/^['"]|['"]$/g, '');
          break;
        }
      }
      out.push({ file: f, line: i + 1, version, inputDefault: inputDefaultOf(lines) });
    });
  }
  return out;
}

// For the `${{ inputs.bun-version || 'pin' }}` form the || fallback is DEAD on
// workflow_dispatch (GitHub materialises input defaults), so the guard must
// resolve the input's OWN default in the SAME file — self-contained, no
// cross-file promise to another test (review round 2, item 1: the other
// fallback site's default was asserted nowhere).
function inputDefaultOf(lines: string[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*bun-version:\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      if (/^\s{0,6}\w[\w-]*:\s*$/.test(lines[j])) break; // next input
      const m = lines[j].match(/default:\s*(.+?)\s*(#.*)?$/);
      if (m) return m[1].replace(/^['"]|['"]$/g, '');
    }
  }
  return null;
}

describe('bun-version pins (#754) — scanned across every workflow', () => {
  const steps = setupBunSteps();

  it('finds exactly the known steps per file — a DISAPPEARING step is as loud as an unpinned one', () => {
    const byFile: Record<string, number> = {};
    for (const s of steps) byFile[s.file] = (byFile[s.file] ?? 0) + 1;
    // Counts grew when the workspace moved off pnpm: `setup-bun` now installs
    // the package manager for every lane that used to run `pnpm/action-setup`,
    // so most workflows gained one step and ci.yml gained several. The exact
    // map is the point — a step DISAPPEARING is as loud as an unpinned one,
    // which a `toBeGreaterThan` would miss.
    //
    // test-e2e-deploy.yml is deliberately NOT in this list beyond its original
    // step: its pnpm drives the next.js compat harness (next.js's own repo uses
    // pnpm), not knext's workspace, so it was left alone.
    expect(byFile).toEqual({
      'ci.yml': 13,
      'docs-closure-nightly.yml': 1,
      'mutation-prover-nightly.yml': 1,
      'operator-e2e-nightly.yml': 3,
      'preview.yml': 2,
      'scale-zero-pg.yml': 1,
      'test-e2e-deploy.yml': 1,
      'bun-sandbox-fetch-ab.yml': 1,
    });
  });

  it('every setup-bun step pins bun — no latest/canary, no omitted key', () => {
    const bad = steps.filter((s) => {
      if (s.version === null) return true; // omitted = latest
      if (PIN_RE.test(s.version)) return false;
      if (!FALLBACK_RE.test(s.version)) return true;
      // fallback form: the input's default in the SAME file must be a pin —
      // dispatch materialises defaults, so the || fallback alone proves nothing
      return !(s.inputDefault !== null && PIN_RE.test(s.inputDefault));
    });
    expect(
      bad.map((s) => `${s.file}:${s.line} -> ${s.version ?? '(bun-version omitted = latest)'}`),
      'unpinned setup-bun steps — pin to x.y.z (or the #188 input||pin fallback); see #754/#807',
    ).toEqual([]);
  });
});
