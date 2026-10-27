/**
 * govulncheck exceptions are scoped per module. One exceptions file is shared by
 * every Go module, and the gate fails an entry the scanned module does not call
 * ("stale"), so an advisory only one module reaches needs a `modules` scope or it
 * would red every other module's scan. An entry with no `modules` applies to all.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { evaluate } from '../scripts/govulncheck-gate.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const NOW = new Date('2026-10-22T00:00:00Z');
const JUST =
  'fixed upstream in a later release, held back by the release-age rule, tracked in a ticket';
const config = { config: { protocol_version: 'v1.0.0' } };
const scanned = { progress: { message: 'Checking the code against the vulnerabilities...' } };
const DONE = [config, scanned];
const entry = (over: Record<string, unknown> = {}) => ({
  id: 'GO-2026-6809',
  expires: '2026-10-25',
  justification: JUST,
  ...over,
});
const called = (id: string) => ({ finding: { osv: id, trace: [{ function: 'Serve' }] } });
const OP = 'packages/kn-next-operator';
const GW = 'packages/scale-zero-pg/gateway';

describe('exceptions are scoped per module', () => {
  it('an operator-scoped entry does not make the gateway scan stale', () => {
    const scoped = entry({ id: 'GO-2026-7000', modules: [OP] });
    expect(evaluate([...DONE, called('GO-2026-6809')], [entry(), scoped], NOW, GW).ok).toBe(true);
    const opScan = [...DONE, called('GO-2026-6809'), called('GO-2026-7000')];
    expect(evaluate(opScan, [entry(), scoped], NOW, OP).ok).toBe(true);
  });

  it('an out-of-scope entry does not excuse a finding', () => {
    const r = evaluate([...DONE, called('GO-2026-6809')], [entry({ modules: [OP] })], NOW, GW);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('no live exception');
  });

  it('an in-scope entry that is no longer called is still stale', () => {
    const r = evaluate(DONE, [entry({ modules: [OP] })], NOW, OP);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/stale/);
  });

  it('an entry without modules applies to every module', () => {
    for (const m of [OP, GW, 'templates/go']) {
      expect(evaluate([...DONE, called('GO-2026-6809')], [entry()], NOW, m).ok).toBe(true);
      expect(evaluate(DONE, [entry()], NOW, m).ok).toBe(false);
    }
  });

  it('a malformed modules scope fails', () => {
    for (const modules of [[], 'templates/go', [''], [1]]) {
      const r = evaluate([...DONE, called('GO-2026-6809')], [entry({ modules })], NOW, OP);
      expect(r.ok, JSON.stringify(modules)).toBe(false);
    }
  });

  it('the CLI refuses to run without the module being scanned', () => {
    const run = (args: string[], env: Record<string, string> = {}) =>
      spawnSync('node', [resolve(REPO_ROOT, 'scripts/govulncheck-gate.mjs'), ...args], {
        input: `${JSON.stringify(config)}\n${JSON.stringify(scanned)}\n`,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', ...env },
      });
    const none = run([]);
    expect(none.status).not.toBe(0);
    expect(none.stderr).toMatch(/module is required/);
    // A completed scan with no findings: the committed entry is stale for it, so
    // it fails on the entry, NOT on the missing module.
    expect(run(['templates/go']).stderr).not.toMatch(/module is required/);
    expect(run([], { GOVULNCHECK_MODULE: 'templates/go' }).stderr).not.toMatch(
      /module is required/,
    );
  });
});

describe('every gated step passes the module being scanned', () => {
  const wfText = (f: string) => readFileSync(resolve(REPO_ROOT, `.github/workflows/${f}`), 'utf8');

  it('go-template.yml, govulncheck-modules.yml and the nightly pass it to the gate', () => {
    const want: Record<string, RegExp> = {
      'go-template.yml': /govulncheck-gate\.mjs" templates\/go\s*$/m,
      'govulncheck-modules.yml': /govulncheck-gate\.mjs" "\$\{\{ matrix\.module \}\}"\s*$/m,
      'govulncheck-nightly.yml': /govulncheck-gate\.mjs" "\$\{\{ matrix\.module \}\}"\s*$/m,
    };
    for (const [f, re] of Object.entries(want)) expect(wfText(f), f).toMatch(re);
  });

  it('the new workflow re-runs on gate test changes', () => {
    const on = parse(wfText('govulncheck-modules.yml')).on;
    for (const ev of ['push', 'pull_request']) {
      expect(on[ev].paths).toContain('tests/govulncheck-gate.test.ts');
      expect(on[ev].paths).toContain('tests/govulncheck-gate-scope.test.ts');
    }
  });
});
