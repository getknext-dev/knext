/**
 * #1151 / #1152 / #1154 — the ADR-0054 governance reconcile stays true.
 *
 * ADR-0054 (runtime axis) left three things owed: the downstream Accepted ADRs
 * that still encode vinext as the default or only target (#1151), the price of
 * running N build targets behind one RuntimeContract (#1152), and a reopen bar
 * (#1154). All three are prose, and prose decays silently — the exact failure
 * `tests/adr-state-claims.test.ts` exists for. So the load-bearing FACTS the
 * amendments assert are pinned here against the tree, in both directions: the
 * guard reds when an amendment goes missing, AND when the code moves out from
 * under a number it quotes (the signal to update the ADR, not this guard).
 *
 * What this does NOT check, stated so it is not read as coverage: whether the
 * amendments' judgement is right. That is the sprint-close design review's job;
 * every amendment here is marked Proposed for exactly that reason.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

const ADR = {
  '0036': 'docs/adr/0036-optional-vinext-bun-build-target.md',
  '0042': 'docs/adr/0042-vinext-bun-bytecode-as-the-default-runtime.md',
  '0048': 'docs/adr/0048-vinext-single-exec-as-the-only-target.md',
  '0050': 'docs/adr/0050-vinext-isr-redis-wiring.md',
  '0051': 'docs/adr/0051-vinext-esm-only-app-contract.md',
} as const;
const ADR54 = 'docs/adr/0054-runtime-axis-reconsider-verified-target.md';
const ARTIFACT_CONTRACT = 'packages/kn-next/src/adapters/artifact-contract.ts';
const AUDIT = 'scripts/compat-window-audit.mjs';
const DEPLOY_WF = '.github/workflows/test-e2e-deploy.yml';

const RECONCILE_HEADING = '## Amendment — reconciled with ADR-0054 (2026-09-30)';
const HEADER_MARKER = '**Reconciled with ADR-0054 (2026-09-30, Proposed)**';
const PROPOSED = 'Proposed — for the sprint-close design review';

/** Text of one `## ` section, from its heading to the next `## ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return '';
  const next = text.indexOf('\n## ', start + heading.length);
  return text.slice(start, next < 0 ? undefined : next);
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** The literal a `export const NAME = "value"` / `: T = "value"` line carries. */
function constLiteral(src: string, name: string): string {
  const m = src.match(new RegExp(`export const ${name}(?::[^=]+)?\\s*=\\s*["']([^"']+)["']`));
  if (!m) throw new Error(`${name} not found as a string literal in ${ARTIFACT_CONTRACT}`);
  return m[1];
}

/** Count `{ runtime, builder, lane, wired }` entries in CREDENTIAL_CELLS (scanned, not imported). */
function credentialCells(): { total: number; wired: number } {
  const src = read(AUDIT);
  const start = src.indexOf('export const CREDENTIAL_CELLS = Object.freeze([');
  if (start < 0) throw new Error('CREDENTIAL_CELLS table not found');
  const end = src.indexOf(']);', start);
  const table = src.slice(start, end);
  return {
    total: (table.match(/^\s+lane: '/gm) ?? []).length,
    wired: (table.match(/^\s+wired: true,/gm) ?? []).length,
  };
}

describe('#1151 — every downstream ADR carries a dated ADR-0054 reconcile amendment', () => {
  for (const [num, path] of Object.entries(ADR)) {
    it(`ADR-${num}: header pointer AND body amendment, each exactly once, Proposed`, () => {
      const text = read(path);
      const header = text.slice(0, text.indexOf('\n## '));
      expect(countOccurrences(header, HEADER_MARKER)).toBe(1);
      expect(countOccurrences(text, RECONCILE_HEADING)).toBe(1);
      const body = section(text, RECONCILE_HEADING);
      expect(body).toContain(PROPOSED);
      // Not self-accepted: the gates decide at sprint close.
      expect(body).not.toMatch(/\*\*Status:\*\*\s*\*?\*?Accepted/);
      // Both halves: what still stands, and what is superseded.
      expect(body).toContain('**Still stands:**');
      expect(body).toContain('**Superseded:**');
      // Appended, never inserted into history: it is the LAST section.
      expect(text.lastIndexOf('\n## ')).toBe(text.indexOf(RECONCILE_HEADING) - 1);
    });
  }

  it('the default the amendments quote is the default in code (turbopack × bun)', () => {
    const src = read(ARTIFACT_CONTRACT);
    expect(constLiteral(src, 'DEFAULT_BUILDER_ID')).toBe('turbopack');
    expect(constLiteral(src, 'DEFAULT_RUNTIME_ID')).toBe('bun');
    for (const path of [ADR['0042'], ADR['0048']]) {
      expect(section(read(path), RECONCILE_HEADING)).toContain(
        '`DEFAULT_BUILDER_ID = "turbopack"` × `DEFAULT_RUNTIME_ID = "bun"`',
      );
    }
  });
});

describe('#1152 — ADR-0054 prices the N-target cost against the live tree', () => {
  const HEADING = '## Amendment 9 — the cost of N build targets, and the shared RuntimeContract';

  it('the amendment exists once, is Proposed, and is listed in the Status header', () => {
    const text = read(ADR54);
    expect(countOccurrences(text, HEADING)).toBe(1);
    expect(section(text, HEADING)).toContain(PROPOSED);
    expect(text.slice(0, text.indexOf('\n## '))).toContain('Amendment 9');
  });

  it('its cell counts equal CREDENTIAL_CELLS (defined / wired)', () => {
    const { total, wired } = credentialCells();
    const body = section(read(ADR54), HEADING);
    expect(body).toContain(`**${total} cells defined, ${wired} wired**`);
  });

  it('its cron and shard counts equal test-e2e-deploy.yml', () => {
    const wf = read(DEPLOY_WF);
    const crons = (wf.match(/^\s+- cron: '/gm) ?? []).length;
    const shards = (wf.match(/'(\d+)\/16'/g) ?? []).length;
    const body = section(read(ADR54), HEADING);
    expect(body).toContain(`**${crons} scheduled crons**`);
    // The deploy-tests matrix lists each of 16 shards once.
    expect(shards).toBe(16);
    expect(body).toContain('**16 shards**');
  });

  it('it reaffirms exactly two RuntimeContract implementations, and both exist', () => {
    const body = section(read(ADR54), HEADING);
    expect(body).toContain('**exactly two `RuntimeContract` implementations**');
    // The two it names: the standalone supervisor and the vinext in-process entry.
    expect(read('packages/kn-next/src/adapters/node-server.ts').length).toBeGreaterThan(0);
    expect(read('packages/kn-next/templates/app/runtime-contract.mjs.hbs').length).toBeGreaterThan(
      0,
    );
    // Every standalone runtime stage boots the ONE supervisor entry, not its own.
    const standalone = read(
      'packages/kn-next/templates/runtime-standalone/Dockerfile.standalone.hbs',
    );
    const entries = new Set(
      [...standalone.matchAll(/^COPY (\S+) \/app\/knext-entry\.mjs$/gm)].map((m) => m[1]),
    );
    expect([...entries]).toEqual(['knext-standalone-entry.mjs']);
    // Both halves of the open exception: the ADR names the candidate third
    // implementation, and that file still exists — so if it is deleted or
    // renamed, the ADR text goes stale and this reds.
    const candidate = 'packages/kn-next/src/adapters/standalone-self-contained-supervisor.cjs';
    expect(body).toContain(candidate);
    expect(read(candidate).length).toBeGreaterThan(0);
  });
});

describe('#1154 — ADR-0054 carries an explicit, measurable reopen bar', () => {
  const HEADING = '## Amendment 10 — the reopen bar';

  it('the amendment exists once, is Proposed, and is listed in the Status header', () => {
    const text = read(ADR54);
    expect(countOccurrences(text, HEADING)).toBe(1);
    expect(section(text, HEADING)).toContain(PROPOSED);
    expect(text.slice(0, text.indexOf('\n## '))).toContain('Amendment 10');
  });

  it('names each reopen condition R1..R5 once, and what does NOT reopen it', () => {
    const body = section(read(ADR54), HEADING);
    for (const id of ['R1', 'R2', 'R3', 'R4', 'R5']) {
      expect(countOccurrences(body, `**${id} —`)).toBe(1);
    }
    expect(body).toContain('**Does not reopen it:**');
    // The cold-start condition must carry the recorded tie's sample floor.
    const r1 = body.slice(body.indexOf('**R1 —'), body.indexOf('**R2 —'));
    expect(r1).toContain('n ≥ 7');
  });
});
