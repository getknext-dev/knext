// @vitest-environment node
//
// Regression guard for the two #460 self-containment bugs. These are static
// source assertions on `knext-bun-entry.mjs` (the module the build compiles into
// the single binary). They can't reintroduce the full OKE build, but they lock in
// the two ROOT CAUSES that were proven on OKE — each was a silent, one-line
// regression that produced a binary which 404s every app route:
//
//   Bug 1 (routes not bundled): overriding nitro's `entry` with our file drops
//   vinext's route wiring unless the entry re-imports `#nitro/virtual/polyfills`
//   (which pulls in `#nitro-vite-setup` → `globalThis.__nitro_vite_envs__` → the
//   ssr/rsc render chunks). Without that import, no `_ssr` chunk is even emitted
//   and `bun --compile` embeds an app with zero routes.
//
//   Bug 2 (routes not served): the app listener MUST go through srvx's `serve`
//   (`srvx/bun`) — the exact path nitro's default bun entry uses, which augments
//   the Request (`runtime`/`waitUntil`) and normalises the result so nitro/vinext
//   route matching works. A raw `Bun.serve({ fetch: r => useNitroApp().fetch(r) })`
//   answers a framework 404 for every route (only :9091 metrics survive).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = readFileSync(resolve(__dirname, '../knext-bun-entry.mjs'), 'utf8');

// Strip line/block comments so the assertions match real code, not the prose
// above each guard that explains the same identifiers.
const CODE = ENTRY.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('#460 bug 1 — routes stay bundled (self-contained binary)', () => {
  it('imports #nitro/virtual/polyfills so vinext route chunks are emitted', () => {
    expect(CODE).toMatch(/import\s+['"]#nitro\/virtual\/polyfills['"]/);
  });

  it('imports the polyfills FIRST — before nitro/app is initialised', () => {
    const polyfillIdx = CODE.indexOf('#nitro/virtual/polyfills');
    const nitroAppIdx = CODE.indexOf("from 'nitro/app'");
    expect(polyfillIdx).toBeGreaterThanOrEqual(0);
    expect(nitroAppIdx).toBeGreaterThanOrEqual(0);
    expect(polyfillIdx).toBeLessThan(nitroAppIdx);
  });
});

describe('#460 bug 2 — the app handler is served through nitro’s real path', () => {
  it('serves the app via srvx `serve` (nitro’s default bun entry path)', () => {
    expect(CODE).toMatch(/import\s+\{[^}]*\bserve\b[^}]*\}\s+from\s+['"]srvx\/bun['"]/);
    expect(CODE).toMatch(/serve\(\s*\{/);
  });

  it('does NOT route app requests through a raw Bun.serve (the broken pattern)', () => {
    // The only Bun.serve in the entry is the :9091 metrics listener. The APP
    // handler must not be a raw Bun.serve delegating to useNitroApp().fetch —
    // that is exactly the pattern that 404s every route.
    expect(CODE).not.toMatch(/Bun\.serve\([^)]*nitro\.fetch/s);
    expect(CODE).not.toMatch(/Bun\.serve\([^)]*useNitroApp\(\)\.fetch/s);
  });
});
