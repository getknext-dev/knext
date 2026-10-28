/**
 * govulncheck exceptions are explicit, dated and fail closed: a called
 * vulnerability passes only through a live entry in
 * security/govulncheck-exceptions.json; an expired, malformed or no-longer-
 * reachable entry fails the gate, so an exception cannot outlive its reason.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluate, parseStream } from '../scripts/govulncheck-gate.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const NOW = new Date('2026-10-22T00:00:00Z');
const JUST =
  'fixed upstream in go1.26.10, held back by the release-age rule until 2026-10-24, tracked in #2567';
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
const importOnly = (id: string) => ({ finding: { osv: id, trace: [{ module: 'stdlib' }] } });

describe('govulncheck gate', () => {
  it('fails an un-excepted called vulnerability', () => {
    const r = evaluate([...DONE, called('GO-2026-6809')], [], NOW);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('GO-2026-6809');
  });

  it('ignores findings that are not called symbols', () => {
    expect(evaluate([...DONE, importOnly('GO-2026-1')], [], NOW).ok).toBe(true);
  });

  it('passes a called vulnerability covered by a live entry', () => {
    expect(evaluate([...DONE, called('GO-2026-6809')], [entry()], NOW).ok).toBe(true);
  });

  it('fails once the entry has expired', () => {
    const r = evaluate(
      [...DONE, called('GO-2026-6809')],
      [entry()],
      new Date('2026-10-26T00:00:00Z'),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/expired/);
  });

  it('fails a stale entry whose vulnerability is no longer called', () => {
    const r = evaluate(DONE, [entry()], NOW);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/no longer|stale/i);
  });

  it('fails malformed entries: bad id, bad date, short justification, unknown key', () => {
    for (const bad of [
      entry({ id: 'CVE-2026-1' }),
      entry({ expires: 'soon' }),
      entry({ expires: undefined }),
      entry({ justification: 'later' }),
      entry({ extra: 1 }),
    ]) {
      expect(evaluate([...DONE, called('GO-2026-6809')], [bad], NOW).ok).toBe(false);
    }
  });

  it("parses govulncheck's concatenated pretty-printed JSON stream, braces in strings included", () => {
    const s = '{\n "config": {"x": "a}b"}\n}\n{\n "finding": {"osv": "GO-1"}\n}\n';
    expect(parseStream(s)).toEqual([{ config: { x: 'a}b' } }, { finding: { osv: 'GO-1' } }]);
  });

  it('fails closed on an unparseable stream', () => {
    expect(() => parseStream('{ "finding": ')).toThrow();
  });
});

describe('the gate fails closed when govulncheck did not finish a scan', () => {
  it('fails on an empty stream with an empty allow list', () => {
    const r = evaluate([], [], NOW);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/config/);
  });

  it('fails on a config-only stream with an empty allow list', () => {
    const r = evaluate([config], [], NOW);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/scan/);
  });

  it('fails when the scan never reached the call-graph stage even with findings', () => {
    expect(evaluate([config, called('GO-2026-6809')], [entry()], NOW).ok).toBe(false);
  });

  it('fails when only an earlier progress stage was reached', () => {
    const early = { progress: { message: 'Fetching vulnerabilities from the database...' } };
    expect(evaluate([config, early], [], NOW).ok).toBe(false);
  });

  it('passes a completed scan with no called findings and no exceptions', () => {
    expect(evaluate([config, scanned], [], NOW).ok).toBe(true);
  });
});

describe('committed exceptions file and workflow wiring', () => {
  const file = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'security/govulncheck-exceptions.json'), 'utf8'),
  );

  it('carries no exceptions: GO-2026-6809 was removed with the go1.26.10 bump (#2567)', () => {
    expect(file.allow).toEqual([]);
  });
});
