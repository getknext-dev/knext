/**
 * An exception scoped to a module that is never scanned is skipped in every leg,
 * so it is never stale and lingers forever. The gate therefore rejects any
 * `modules` value that is not a known, scanned module, in its canonical spelling.
 */
import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { evaluate, knownModules } from '../scripts/govulncheck-gate.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const NOW = new Date('2026-10-22T00:00:00Z');
const config = { config: { protocol_version: 'v1.0.0' } };
const scanned = { progress: { message: 'Checking the code against the vulnerabilities...' } };
const called = { finding: { osv: 'GO-2026-6809', trace: [{ function: 'Serve' }] } };
const OP = 'packages/kn-next-operator';
const entry = (modules: unknown) => ({
  id: 'GO-2026-6809',
  expires: '2026-10-25',
  justification: 'held back by the release-age rule until the fixed toolchain is allowed in',
  modules,
});
const known = knownModules(REPO_ROOT);
const run = (modules: unknown) =>
  evaluate([config, scanned, called], [entry(modules)], NOW, OP, known);

describe('scope values must be known scanned modules', () => {
  it('accepts the canonical spelling of a scanned module', () => {
    expect(run([OP]).ok).toBe(true);
  });

  it('rejects a trailing slash, a ./ prefix and other non-canonical spellings', () => {
    for (const bad of [`${OP}/`, `./${OP}`, `${OP}/.`, `../${OP}`, `/${OP}`]) {
      const r = run([OP, bad]);
      expect(r.ok, bad).toBe(false);
      expect(r.errors.join('\n'), bad).toMatch(/not a scanned module/);
    }
  });

  it('rejects a module that does not exist or has no go.mod', () => {
    for (const bad of ['packages/nope', 'packages', 'docs']) {
      expect(run([OP, bad]).ok, bad).toBe(false);
    }
  });

  it('rejects a module the repo lists as excluded from the scan', () => {
    expect(knownModules(REPO_ROOT).has('spikes/zone-functions-coldstart/fn-go')).toBe(false);
  });
});
