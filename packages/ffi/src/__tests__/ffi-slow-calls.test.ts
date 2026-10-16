/**
 * The slow-call instrumentation the generated module carries: every Rust call
 * is timed, a call over the threshold is counted per function and logged once,
 * and the first load is reported once. The counts reach the app's metrics port
 * through a render function published on `globalThis`, which core's loopback
 * metrics listener appends (the same seam shape as the CDN and 'use cache'
 * counters).
 *
 * This file pins the emitted text; ffi-loader.test.ts proves the behaviour
 * against a real library (a fixture `add` that sleeps past the threshold), and
 * scripts/mutation-prove-2385-ffi-slow-calls.mjs proves each assertion here goes
 * red when the behaviour it guards is removed. Kept out of render.test.ts,
 * whose full golden reds on ANY change and would make every mutation look caught.
 *
 * What this does NOT claim: that a slow call can be interrupted. A `bun:ffi`
 * call blocks the JavaScript thread until it returns; nothing here changes that.
 */

import { describe, expect, it } from 'bun:test';
import { scanManifest } from '../manifest';
import { renderModule } from '../render';
import { blob, KITCHEN_SINK } from './helpers';

const manifest = scanManifest(blob(KITCHEN_SINK));
const src = renderModule(manifest, { libName: 'zone', crate: 'rust' });

/** The body of `export function <name>(…) { … }`, up to its closing brace at column 0. */
function body(name: string): string {
  const start = src.indexOf(`\nexport function ${name}(`);
  if (start < 0) throw new Error(`no export ${name}`);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 2);
}

/** The text of a module-scope `function <name>(` declaration. */
function helper(name: string): string {
  const start = src.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`no helper ${name}`);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end + 2);
}

describe('every Rust call is timed, and a slow one is counted', () => {
  it('finds every export (a vacuous loop would pass)', () => {
    expect(manifest.fns.length).toBeGreaterThan(20);
  });

  for (const f of manifest.fns) {
    it(`${f.name}: performance.now() brackets exactly the symbol call, and the check runs before any error is thrown`, () => {
      const lines = body(f.name)
        .split('\n')
        .map((l) => l.trim());
      const call = lines.findIndex((l) => l.startsWith(`const $st = $lib.${f.symbol}(`));
      expect(call).toBeGreaterThan(0);
      expect(lines[call - 1]).toBe('const $t0 = performance.now();');
      expect(lines[call + 1]).toBe('const $ms = performance.now() - $t0;');
      expect(lines[call + 2]).toBe(`if ($ms > $slowMs) $slow('${f.name}', $ms);`);
      expect(lines[call + 3]).toBe(`if ($st !== 0) $fail('${f.name}', $st);`);
      // Timed once per call, never around argument checks or encoding.
      expect(body(f.name).split('performance.now()')).toHaveLength(3);
    });
  }
});

describe('the threshold', () => {
  it('is read from KNEXT_FFI_SLOW_CALL_MS on the first call, default 50 ms', () => {
    const t = helper('$threshold');
    expect(t).toContain("if (raw === undefined || raw.trim() === '') return 50;");
    expect(helper('$load')).toContain(
      "$slowMs = $threshold(process.env['KNEXT_FFI_SLOW_CALL_MS']);",
    );
  });

  it('0 turns counting off; anything but a positive finite number falls back to 50 with a warning', () => {
    const t = helper('$threshold');
    expect(t).toContain('if (ms === 0) return Infinity;');
    expect(t).toContain('if (Number.isFinite(ms) && ms > 0) return ms;');
    expect(t).toContain('Using 50.');
  });

  it('nothing is counted before the library loads (the threshold starts unreachable)', () => {
    expect(src).toContain('let $slowMs = Infinity;');
  });
});

describe('counts are process-wide, anchored on globalThis', () => {
  it("the registry lives under Symbol.for('knext.ffi.metrics'), never in a module-scope binding", () => {
    expect(src.split("Symbol.for('knext.ffi.metrics')")).toHaveLength(2);
    const reg = helper('$registry');
    expect(reg).toContain("Symbol.for('knext.ffi.metrics')");
    expect(reg).toContain('globalThis');
    // No module-scope Map/Set/object holds a count: every module-level binding is listed.
    const lets = [...src.matchAll(/^let (\$\w+)/gm)].map((x) => x[1]).sort();
    expect(lets).toEqual(
      [
        '$buf',
        '$failed',
        '$ffi',
        '$last',
        '$lib',
        '$mem',
        '$outPtr',
        '$ready',
        '$slowMs',
        '$used',
        '$view',
      ].sort(),
    );
  });

  it('a slow call increments its own function and logs only the first time per function', () => {
    const s = helper('$slow');
    expect(s).toContain('r.slow.set(fn, (r.slow.get(fn) ?? 0) + 1);');
    expect(s).toContain('if (r.logged.has(fn)) return;');
    expect(s).toContain('r.logged.set(fn, ms);');
    expect(s).toContain('console.warn(');
  });

  it("publishes the render function under Symbol.for('knext.ffi.renderMetrics') once the library has loaded, never at import time", () => {
    expect(src.split("Symbol.for('knext.ffi.renderMetrics')")).toHaveLength(2);
    expect(helper('$loaded')).toContain("Symbol.for('knext.ffi.renderMetrics')] = $renderMetrics;");
    // $loaded runs only from $load, after $open succeeded.
    const load = helper('$load');
    expect(load.indexOf('$open();')).toBeLessThan(load.indexOf('$loaded('));
    expect(load).toContain('$loaded((performance.now() - $t0) / 1000);');
    expect(src.match(/\$loaded\(/g)).toHaveLength(2); // its declaration and the one call
  });

  it('every export is listed at 0 from the first scrape after the load', () => {
    expect(helper('$loaded')).toContain(
      'for (const [fn] of $SCHEMAS) if (!r.slow.has(fn)) r.slow.set(fn, 0);',
    );
  });
});

describe('the exposition', () => {
  it('declares two families, each once: the slow-call counter by fn, the load gauge by lib', () => {
    const types = [...src.matchAll(/# TYPE (knext_ffi_\w+) (\w+)/g)].map((x) => `${x[1]} ${x[2]}`);
    expect(types).toEqual(['knext_ffi_slow_calls_total counter', 'knext_ffi_load_seconds gauge']);
    const r = helper('$renderMetrics');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the emitted template literal, as text
    expect(r).toContain('knext_ffi_slow_calls_total{fn="${fn}"} ${n}');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the emitted template literal, as text
    expect(r).toContain('knext_ffi_load_seconds{lib="${lib}"} ${s}');
  });

  it("the label values are a closed set: the manifest's function names and the library name", () => {
    // fn comes only from $SCHEMAS (the manifest), never from a caller's value.
    expect(helper('$slow')).not.toContain('String(');
    for (const f of manifest.fns) expect(body(f.name)).toContain(`$slow('${f.name}', $ms)`);
    expect(helper('$loaded')).toContain('r.load.set($LIB,');
  });
});
