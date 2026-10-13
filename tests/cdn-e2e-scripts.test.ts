import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The CDN edge-headers kind e2e (.github/workflows/cdn-headers-kind-e2e.yml)
 * proves each check with a red leg. These tests keep the pieces of that proof
 * honest where a PR can see them, before a 40-minute kind run would:
 *
 * - the allowlist mutation's anchors exist EXACTLY ONCE in cdn-edge.cjs (in the
 *   form the bundler emits), so an edit to a D4.1 condition reds here instead of
 *   silently leaving the "gutted" build un-gutted;
 * - every expected-red line names a real check and a message that check can
 *   actually print, and every spec file is wired into the workflow;
 * - the expected-red helper itself goes red when it should.
 */
const ROOT = resolve(import.meta.dir, '..');
const ASSERT = join(ROOT, 'scripts/cdn-e2e-assert.mjs');
const PURGE_ASSERT = join(ROOT, 'scripts/cdn-e2e-purge-assert.mjs');
const MUTATE = join(ROOT, 'scripts/cdn-e2e-mutate-preload.mjs');
const HELPER = join(ROOT, 'scripts/cdn-e2e-expect-red.sh');
const RED_DIR = join(ROOT, 'scripts/cdn-e2e-red');
const WORKFLOWS = [
  join(ROOT, '.github/workflows/cdn-headers-kind-e2e.yml'),
  join(ROOT, '.github/workflows/cdn-purge-kind-e2e.yml'),
];
const CDN_EDGE = join(ROOT, 'packages/kn-next/src/adapters/cdn-edge.cjs');

/** cdn-edge.cjs as the bundler emits it into dist/adapters/cache-control-normalize.cjs. */
function bundledForm(src: string): string {
  return src.replaceAll("'", '"').replaceAll('=== undefined', '=== void 0');
}

function specLines(file: string): Array<{ id: string; msg: string }> {
  return readFileSync(join(RED_DIR, file), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('#'))
    .map((l) => ({ id: l.slice(0, l.indexOf('|')), msg: l.slice(l.indexOf('|') + 1) }));
}

describe('allowlist mutation (scripts/cdn-e2e-mutate-preload.mjs)', () => {
  it('every anchor occurs exactly once in cdn-edge.cjs, in the bundled form', async () => {
    const { MUTATIONS } = await import(MUTATE);
    const bundled = bundledForm(readFileSync(CDN_EDGE, 'utf8'));
    for (const [name, anchor] of MUTATIONS as Array<[string, string, string]>) {
      expect({ name, count: bundled.split(anchor).length - 1 }).toEqual({ name, count: 1 });
    }
  });

  it('mutate() removes every condition and marks the file', async () => {
    const { MUTATIONS, MARKER, mutate } = await import(MUTATE);
    const out: string = mutate(bundledForm(readFileSync(CDN_EDGE, 'utf8')));
    expect(out.startsWith(MARKER)).toBe(true);
    for (const [, anchor, replacement] of MUTATIONS as Array<[string, string, string]>) {
      expect(out.includes(anchor)).toBe(false);
      if (replacement) expect(out.includes(replacement)).toBe(true);
    }
  });

  it('refuses a source where an anchor is missing or duplicated', async () => {
    const { MUTATIONS, mutate } = await import(MUTATE);
    const all = (MUTATIONS as Array<[string, string, string]>).map(([, a]) => a).join('\n');
    expect(() => mutate(all.replace(MUTATIONS[3][1], ''))).toThrow(/set_cookie occurs 0 times/);
    expect(() => mutate(`${all}\n${MUTATIONS[0][1]}`)).toThrow(/method occurs 2 times/);
  });

  it('the CLI writes nothing and exits non-zero on a source it cannot mutate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdn-mutate-'));
    const file = join(dir, 'cache-control-normalize.cjs');
    writeFileSync(file, 'module.exports = {};\n');
    try {
      const r = spawnSync(process.execPath, [MUTATE, file], { encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(readFileSync(file, 'utf8')).toBe('module.exports = {};\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('expected-red specs (scripts/cdn-e2e-red)', () => {
  const files = readdirSync(RED_DIR).filter((f) => f.endsWith('.txt'));

  it('every line names a real check and a message that check prints', async () => {
    const { checks, config } = await import(ASSERT);
    const { purgeChecks, purgeConfig } = await import(PURGE_ASSERT);
    const ids = new Set(
      [...checks(config({})), ...purgeChecks(purgeConfig({}))].map((c: { id: string }) => c.id),
    );
    const source = readFileSync(ASSERT, 'utf8') + readFileSync(PURGE_ASSERT, 'utf8');
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const lines = specLines(file);
      expect({ file, n: lines.length > 0 }).toEqual({ file, n: true });
      for (const { id, msg } of lines) {
        expect({ file, id, known: ids.has(id) }).toEqual({ file, id, known: true });
        // The message must be literal text in the script, not a precondition.
        // neverCached() composes `${what} was edge-cached`, so for those the
        // `what` must be a literal argument and the template must exist.
        const tail = ' was edge-cached';
        const composed =
          msg.endsWith(tail) &&
          source.includes(`'${msg.slice(0, -tail.length)}'`) &&
          source.includes(`\${what}${tail}`);
        expect({ file, id, found: source.includes(msg) || composed }).toEqual({
          file,
          id,
          found: true,
        });
        expect(msg.startsWith('precondition')).toBe(false);
      }
    }
  });

  it('every spec file is used by the workflow, through the helper', () => {
    const wf = WORKFLOWS.map((w) => readFileSync(w, 'utf8')).join('\n');
    for (const file of files) {
      expect({
        file,
        wired:
          wf.includes(`scripts/cdn-e2e-expect-red.sh`) &&
          wf.includes(`scripts/cdn-e2e-red/${file}`),
      }).toEqual({
        file,
        wired: true,
      });
    }
  });
});

describe('zero-diff comparator', () => {
  it('ignores only the clock and hop-by-hop framing, and sees order, value and body changes', async () => {
    const { diffResponses } = await import(ASSERT);
    const r = (raw: string[], body = 'x') => ({
      status: 200,
      rawHeaders: raw,
      body: Buffer.from(body),
    });
    const base = ['Date', 'Mon', 'Cache-Control', 'a', 'ETag', '"1"', 'Connection', 'keep-alive'];
    expect(diffResponses(r(base), r(['Date', 'Tue', 'Cache-Control', 'a', 'ETag', '"1"']))).toEqual(
      [],
    );
    expect(diffResponses(r(base), r(['ETag', '"1"', 'Cache-Control', 'a'])).length).toBeGreaterThan(
      0,
    );
    expect(diffResponses(r(base), r(['Cache-Control', 'b', 'ETag', '"1"']))).toEqual([
      'header #0: "cache-control: a" != "cache-control: b"',
    ]);
    expect(diffResponses(r(base), r(base, 'y'))[0]).toMatch(/^body sha256/);
    expect(diffResponses(r(base), r([...base, 'Cache-Tag', 'kn-x']))).toEqual([
      'header #2: null != "cache-tag: kn-x"',
    ]);
  });

  it('the purge checks encode tags exactly as the runtime does (independent implementation, same bytes)', async () => {
    const { appTagOf, nextTagOf, PAGE_TAG } = await import(PURGE_ASSERT);
    const tags = await import(join(ROOT, 'packages/kn-next/src/adapters/cdn-purge/tags.js'));
    for (const t of [PAGE_TAG, '_N_T_/tagged', 'with,comma', 'ünïcode']) {
      expect(nextTagOf('77489686e9ad', t)).toBe(tags.nextTag('77489686e9ad', t));
    }
    expect(appTagOf('77489686e9ad')).toBe(tags.appTag('77489686e9ad'));
  });

  it('derives the per-app prefix exactly as the operator does: sha256("<ns>/<name>")[:12]', async () => {
    const { derivePrefix } = await import(ASSERT);
    // Independently computed: printf 'cdn-e2e/cdn-a' | sha256sum | cut -c1-12
    expect(derivePrefix('cdn-e2e', 'cdn-a')).toBe('77489686e9ad');
    expect(derivePrefix('cdn-e2e', 'cdn-b')).toBe('3903a6817858');
  });
});

describe('expected-red helper (scripts/cdn-e2e-expect-red.sh)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdn-red-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const spec = join(dir, 'spec.txt');
  writeFileSync(spec, '# c\nalpha|went wrong here\nbeta|also wrong\n');
  const run = (script: string) =>
    spawnSync('bash', [HELPER, 'unit', spec, '--', process.execPath, '-e', script], {
      encoding: 'utf8',
    });

  it('passes when the command fails at every expected check', () => {
    const r = run(
      "console.log('FAIL [alpha] went wrong here (x)'); console.log('FAIL [beta] also wrong'); process.exit(1)",
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('proved: exit 1');
  });

  it('fails when the command passes', () => {
    const r = run(
      "console.log('FAIL [alpha] went wrong here'); console.log('FAIL [beta] also wrong')",
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('PASSED');
  });

  it('fails when an expected check did not go red, or went red on its precondition', () => {
    const missing = run("console.log('FAIL [alpha] went wrong here'); process.exit(1)");
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain('[beta] did not fail with: also wrong');
    const pre = run(
      "console.log('FAIL [alpha] precondition: went wrong here'); console.log('FAIL [beta] also wrong'); process.exit(1)",
    );
    expect(pre.status).toBe(1);
    expect(pre.stdout).toContain('[alpha] went red on its PRECONDITION');
  });

  it('a FAIL line for another check does not satisfy an expectation', () => {
    const r = run(
      "console.log('FAIL [gamma] went wrong here'); console.log('FAIL [beta] also wrong'); process.exit(1)",
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('[alpha] did not fail with');
  });
});

/**
 * The KNOWN DEFECT (#2299) leg passes only when `rollout-no-old-html` fails at
 * its own message. A broken /tagged (5xx, 404, the emulator's 502) carries no
 * build mark, and must NOT read as "old-build HTML": that would keep the pinned
 * step green while the page under test is simply down. It must be a
 * precondition failure, which the expected-red helper rejects.
 */
describe('rollout-no-old-html: only a real page counts as old-build HTML', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdn-rollout-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function runAgainst(tagged: { status: number; type: string; body: string }) {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      if (String(req.url).startsWith('/build-mark')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><p id="build">v2</p>');
        return;
      }
      res.writeHead(tagged.status, { 'content-type': tagged.type });
      res.end(tagged.body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (server.address() as { port: number }).port;
      const stateFile = join(dir, `state-${port}.json`);
      writeFileSync(
        stateFile,
        JSON.stringify({ rollout: { paths: ['/tagged?k=1'], mark: 'v1', buildTag: 'kn-x-b0' } }),
      );
      const { purgeChecks, purgeConfig } = await import(PURGE_ASSERT);
      const c = purgeConfig({ CDN_EMU_URL: `http://127.0.0.1:${port}`, CDN_STATE_FILE: stateFile });
      const check = purgeChecks(c).find((x: { id: string }) => x.id === 'rollout-no-old-html');
      try {
        return { ok: true, note: await check.run() };
      } catch (err) {
        return { ok: false, note: String((err as Error).message) };
      }
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  }

  it('a 5xx /tagged is a precondition failure, not the pinned old-build FAIL', async () => {
    const r = await runAgainst({
      status: 502,
      type: 'application/json',
      body: '{"error":"upstream failed"}',
    });
    expect(r.ok).toBe(false);
    expect(r.note.startsWith('precondition:')).toBe(true);
    expect(r.note).not.toContain('old-build HTML was served');
  });

  it('a 200 HTML page with no build mark is a precondition failure too', async () => {
    const r = await runAgainst({
      status: 200,
      type: 'text/html',
      body: '<!DOCTYPE html><p>error page</p>',
    });
    expect(r.ok).toBe(false);
    expect(r.note.startsWith('precondition:')).toBe(true);
  });

  it('a 200 HTML page with the OLD build mark is the pinned failure', async () => {
    const r = await runAgainst({
      status: 200,
      type: 'text/html',
      body: '<!DOCTYPE html><p id="build">v1</p>',
    });
    expect(r.ok).toBe(false);
    expect(r.note.startsWith('old-build HTML was served after the first-ready purge')).toBe(true);
  });

  it('a 200 HTML page with the NEW build mark passes', async () => {
    const r = await runAgainst({
      status: 200,
      type: 'text/html',
      body: '<!DOCTYPE html><p id="build">v2</p>',
    });
    expect(r).toEqual({ ok: true, note: 'every page served build v2' });
  });
});
