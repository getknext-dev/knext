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

  it('the foreign-build set (the purge lane red leg) has one anchor, exactly once, and removes it', async () => {
    const { FOREIGN_BUILD_MUTATIONS, FOREIGN_BUILD_MARKER, mutate } = await import(MUTATE);
    const bundled = bundledForm(readFileSync(CDN_EDGE, 'utf8'));
    const set = FOREIGN_BUILD_MUTATIONS as Array<[string, string, string]>;
    expect(set.map(([n]) => n)).toEqual(['foreign_build_record']);
    for (const [name, anchor] of set) {
      expect({ name, count: bundled.split(anchor).length - 1 }).toEqual({ name, count: 1 });
    }
    const out: string = mutate(bundled, set, FOREIGN_BUILD_MARKER);
    expect(out.startsWith(FOREIGN_BUILD_MARKER)).toBe(true);
    expect(out.includes(set[0][1])).toBe(false);
    // Only that line: the allowlist is untouched.
    expect(out.includes('return skip("foreign_build_body")')).toBe(true);
  });

  it('the CLI applies --set foreign-build to a real copy of the preload, once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdn-mutate-fb-'));
    const file = join(dir, 'cache-control-normalize.cjs');
    writeFileSync(file, bundledForm(readFileSync(CDN_EDGE, 'utf8')));
    try {
      const r = spawnSync(process.execPath, [MUTATE, '--set', 'foreign-build', file], {
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('foreign_build_record');
      expect(readFileSync(file, 'utf8')).not.toContain('s.foreignBuild = true;');
      const again = spawnSync(process.execPath, [MUTATE, '--set', 'foreign-build', file], {
        encoding: 'utf8',
      });
      expect(again.status).toBe(1);
      const unknown = spawnSync(process.execPath, [MUTATE, '--set', 'nope', file], {
        encoding: 'utf8',
      });
      expect(unknown.status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
 * `rollout-no-old-html` (the #2261 criterion as amended by ADR-0068 Amendment 2)
 * gates what the edge owns: after the first-ready purge, no old-build HTML may
 * be STORED at the edge or served FROM it, nor carry an edge directive or tag
 * header, whatever the origin answers (the origin may still serve it for a
 * while; tracked separately, #2305). The fake upstream stands in for the
 * emulator, so each response carries the emulator's `x-emu-cache` /
 * `x-emu-stored` verdict. A broken page (5xx, 404, the emulator's 502, a page
 * with no build mark) is a precondition failure: it must never pass, nor read
 * as the defect.
 */
describe('rollout-no-old-html: old-build HTML never reaches the edge', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdn-rollout-edge-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  type Mode =
    | 'refused'
    | 'stored'
    | 'stored-bare'
    | 'hit-only'
    | 'hit-bare'
    | 'directive'
    | 'new'
    | 'broken'
    | 'no-mark';

  async function runAgainst(tagged: Mode, control: 'cached' | 'never' = 'cached') {
    const { createServer } = await import('node:http');
    const seen = new Map<string, number>();
    const html = (mark: string) => `<!DOCTYPE html><p id="build">${mark}</p>`;
    const server = createServer((req, res) => {
      const url = String(req.url);
      const n = (seen.get(url) ?? 0) + 1;
      seen.set(url, n);
      const page = (mark: string, headers: Record<string, string>) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
        res.end(html(mark));
      };
      if (url.startsWith('/build-mark')) return page('v2', { 'x-emu-cache': 'BYPASS' });
      if (url.startsWith('/variant-b')) {
        if (control === 'never') return page('v2', { 'x-emu-cache': 'MISS' });
        return n === 1
          ? page('v2', { 'x-emu-cache': 'MISS', 'x-emu-stored': '3600' })
          : page('v2', { 'x-emu-cache': 'HIT' });
      }
      const tag = 'kn-77489686e9ad,kn-77489686e9ad-b222222222222';
      switch (tagged) {
        case 'refused': // the origin's old body, refused by the edge
          return page('v1', { 'x-emu-cache': 'MISS' });
        case 'stored': // the #2299 defect: stored under the new build's tag
          return n === 1
            ? page('v1', { 'x-emu-cache': 'MISS', 'x-emu-stored': '3600', 'cache-tag': tag })
            : page('v1', { 'x-emu-cache': 'HIT', 'cache-tag': tag });
        case 'stored-bare': // an edge that stores without a directive (store-all)
          return page('v1', { 'x-emu-cache': 'MISS', 'x-emu-stored': '300' });
        case 'hit-bare': // served from the edge, no edge headers passed through
          return page('v1', { 'x-emu-cache': 'HIT' });
        case 'hit-only': // stored by an earlier request this check did not see
          return page('v1', { 'x-emu-cache': 'HIT', 'cache-tag': tag });
        case 'directive': // edge-cacheable on the wire, whatever this emulator did
          return page('v1', {
            'x-emu-cache': 'MISS',
            'cloudflare-cdn-cache-control': 'max-age=3600',
            'cache-tag': tag,
          });
        case 'no-mark': // an error page: HTML, 200, no build mark
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<!DOCTYPE html><p>error page</p>');
          return;
        case 'new':
          return n === 1
            ? page('v2', { 'x-emu-cache': 'MISS', 'x-emu-stored': '3600' })
            : page('v2', { 'x-emu-cache': 'HIT' });
        default:
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end('{"error":"upstream failed"}');
      }
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
      expect(check).toBeDefined();
      try {
        return { ok: true, note: String(await check.run()) };
      } catch (err) {
        return { ok: false, note: String((err as Error).message) };
      }
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  }

  it('the origin serving the old body is fine while the edge refuses to store it (the #2299 fix)', async () => {
    const r = await runAgainst('refused');
    expect(r.ok).toBe(true);
    expect(r.note).toContain(
      '4 old-build response(s) from the origin, none edge-cacheable or stored',
    );
  });

  it('old-build HTML stored at the edge under the new build tag is the failure', async () => {
    const r = await runAgainst('stored');
    expect(r.ok).toBe(false);
    expect(r.note.startsWith('old-build HTML was stored at or served from the edge')).toBe(true);
    expect(r.note).toContain('kn-77489686e9ad-b222222222222');
  });

  it('an old-build body carrying an edge directive or a tag header is the failure', async () => {
    const r = await runAgainst('directive');
    expect(r.ok).toBe(false);
    expect(r.note.startsWith('old-build HTML was stored at or served from the edge')).toBe(true);
    expect(r.note).toContain('cloudflare-cdn-cache-control: max-age=3600');
    expect(r.note).toContain('cache-tag: ');
  });

  it('old-build HTML stored, or served as an edge HIT, with no edge headers on it is the failure', async () => {
    const stored = await runAgainst('stored-bare');
    expect(stored.ok).toBe(false);
    expect(stored.note).toContain('stored for 300 s');
    const hitBare = await runAgainst('hit-bare');
    expect(hitBare.ok).toBe(false);
    expect(hitBare.note).toContain('an edge HIT');
  });

  it('an edge HIT on old-build HTML is the failure too', async () => {
    const r = await runAgainst('hit-only');
    expect(r.ok).toBe(false);
    expect(r.note.startsWith('old-build HTML was stored at or served from the edge')).toBe(true);
  });

  it('new-build HTML at the edge passes (the day the origin half is fixed too)', async () => {
    const r = await runAgainst('new');
    expect(r.ok).toBe(true);
    expect(r.note).toContain('0 old-build response(s) from the origin');
  });

  it('a broken page is a precondition failure, never a pass or the defect', async () => {
    for (const mode of ['broken', 'no-mark'] as const) {
      const r = await runAgainst(mode);
      expect({ mode, ok: r.ok }).toEqual({ mode, ok: false });
      expect(r.note.startsWith('precondition:')).toBe(true);
      expect(r.note).not.toContain('old-build HTML was');
    }
  });

  it('not vacuous: an edge that caches nothing at all is a precondition failure', async () => {
    const r = await runAgainst('refused', 'never');
    expect(r.ok).toBe(false);
    expect(r.note.startsWith('precondition:')).toBe(true);
    expect(r.note).toContain('/variant-b');
  });
});
