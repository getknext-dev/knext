// @vitest-environment node
//
// Regression guard for the THREE #460 self-containment bugs. These are static
// source assertions on `knext-bun-entry.mjs` (the module the build compiles into
// the single binary). They can't reintroduce the full OKE build, but they lock in
// the ROOT CAUSES that were proven on OKE — each was a silent, one-line
// regression that produced a binary which 404s every app route, or serves them
// with no JS:
//
//   Bug 1 (routes not bundled): overriding nitro's `entry` with our file drops
//   vinext's route wiring unless the entry re-imports `#nitro/virtual/polyfills`
//   (which pulls in `#nitro-vite-setup` → `globalThis.__nitro_vite_envs__` → the
//   ssr/rsc render chunks). Without that import, no `_ssr` chunk is even emitted
//   and `bun --compile` embeds an app with zero routes.
//
//   Bug 3 (routes served, assets not): `bun --compile` bakes the BUILD MACHINE's
//   path into `globalThis.__nitro_main__`, which is where nitro reads
//   `.output/public` from — so the shipped image 500'd every JS chunk while `/`
//   still returned correct SSR HTML (renders, never hydrates). The entry must
//   re-anchor via `resolveAssetAnchor`, on the EXECUTABLE's directory rather than
//   cwd, and must be LOUD when no layout is found. The decision itself is unit-
//   tested in `runtime-contract.test.ts`; what is guarded here is that the entry
//   still calls it — otherwise only the minutes-long container job catches its
//   deletion, which is precisely this file's stated rationale.
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

describe('#460 bug 3 — the asset root travels with the binary', () => {
  it('resolves the asset anchor through the tested resolver', () => {
    expect(CODE, 'the entry no longer calls resolveAssetAnchor').toMatch(
      /\bresolveAssetAnchor\s*\(/,
    );
    expect(CODE, 'resolveAssetAnchor is not imported from the shared contract module').toMatch(
      /import\s+\{[^}]*\bresolveAssetAnchor\b[^}]*\}\s+from\s+['"]\.\/runtime-contract\.mjs['"]/s,
    );
  });

  it('anchors on the EXECUTABLE, so the binary is portable rather than cwd-bound', () => {
    expect(CODE, 'the entry does not feed process.execPath to the resolver').toMatch(
      /execPath:\s*process\.execPath/,
    );
  });

  it('SCANS every __nitro_main__ assignment — none may bypass the resolver', () => {
    // Enumerating the one known assignment is how the second one gets missed.
    // Every write to the global must come from the resolver's verdict, so an
    // added `globalThis.__nitro_main__ = pathToFileURL(resolve(process.cwd(), …))`
    // fails here rather than passing alongside the good one.
    const writes = CODE.match(/globalThis\.__nitro_main__\s*=\s*[^;\n]+/g) ?? [];
    expect(writes.length, 'the entry never re-anchors __nitro_main__ at all').toBeGreaterThan(0);
    for (const write of writes) {
      expect(
        write,
        `__nitro_main__ assigned from something other than the resolver: ${write}`,
      ).toMatch(/\.mainUrl\b/);
    }
  });

  it('is LOUD when the resolver finds no asset layout', () => {
    // A guard whose only failure mode is silence is what this whole round is
    // about: the warning must actually be emitted, not merely returned.
    expect(CODE, 'the entry swallows the resolver warning').toMatch(
      /console\.warn\([^)]*\.warning/,
    );
  });
});
