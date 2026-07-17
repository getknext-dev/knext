/**
 * #352/#344 — build-artifact assertion: the @knext/lib module-state SEAMS must
 * survive the production standalone bundle.
 *
 * Live failure (#352): in the Next.js standalone build, `instrumentation.ts`
 * compiles in a SEPARATE webpack layer from the app-server bundles, and
 * `@knext/lib` is bundled (NOT externalized) into each. So the instrumentation
 * copy of `@knext/lib/clients` and the app-server copy are TWO PHYSICAL module
 * instances with independent module-level `let`s. `setPoolInstrumentor(...)`
 * ran against the instrumentation copy; `getDbPool()` read the app-server copy
 * — still the no-op — so the pool was never wrapped and `knext_db_wake_*`
 * (plus correlation via the context seam) were DEAD in production.
 *
 * The fix (f6ab068) backs the seam state with a `globalThis`-anchored
 * `Symbol.for('knext.lib.clients.poolInstrumentor')` /
 * `Symbol.for('knext.lib.context.state')` store, so the two physical copies
 * share ONE state cell. `seam-duplication.test.ts` proves the mechanism at the
 * unit level with `vi.resetModules()`. THIS test proves it stays true in the
 * ACTUAL shipped artifact: the seam symbols must appear in BOTH the
 * instrumentation (writer) chunk AND an app-server (reader) chunk of the real
 * `next build --webpack` output. If a future change re-breaks the seam — e.g.
 * reverts to a bare module-level `let`, or moves `@knext/lib` into
 * `serverExternalPackages` (which would change dedup and re-split the state) —
 * the symbols stop co-occurring and this gate fails, instead of the deploy.
 *
 * CI wires this behind KNEXT_REQUIRE_STANDALONE=1 in the standalone-building
 * job so a missing build HARD-FAILS (never silently skips). Locally, with no
 * standalone build present, it skips cleanly.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const nextConfigSrc = readFileSync(join(here, 'next.config.ts'), 'utf8');

// The knext seam markers. Each is the argument to a `Symbol.for(...)` — a
// process-global registry key — which is the ONLY thing that makes the seam
// state survive `@knext/lib` being duplicated across webpack layers.
const SEAM_SYMBOLS = ['knext.lib.clients.poolInstrumentor', 'knext.lib.context.state'] as const;

const STANDALONE_SERVER_DIR = resolve(here, '.next/standalone/apps/file-manager/.next/server');
const INSTRUMENTATION_LOADER = join(STANDALONE_SERVER_DIR, 'instrumentation.js');
const CHUNKS_DIR = join(STANDALONE_SERVER_DIR, 'chunks');
const APP_DIR = join(STANDALONE_SERVER_DIR, 'app');

const buildPresent = existsSync(INSTRUMENTATION_LOADER) && existsSync(CHUNKS_DIR);

// CI gate: KNEXT_REQUIRE_STANDALONE=1 makes the standalone build MANDATORY, so a
// missing build is a HARD FAILURE, never a silent skip. Locally (flag unset)
// the suite skips cleanly when there is no build.
const requireStandalone = process.env.KNEXT_REQUIRE_STANDALONE === '1';
const skipReason =
  buildPresent || requireStandalone
    ? null
    : 'standalone build not found — run `next build --webpack` first';

/**
 * The nodejs `instrumentation.js` is a small loader that lazily pulls the
 * instrumentation-node body via webpack's `c.e(<chunkId>)`. That chunk is the
 * WRITER side of the seam (registerNode → setPoolInstrumentor / set*Provider).
 * Extract its numeric id so we assert against the exact writer chunk rather
 * than guessing.
 */
function writerChunkFile(): string {
  const loader = readFileSync(INSTRUMENTATION_LOADER, 'utf8');
  const m = loader.match(/c\.e\((\d+)\)/);
  if (!m) {
    throw new Error(
      'could not find the lazy chunk id (c.e(<id>)) in instrumentation.js — ' +
        'the standalone instrumentation loader shape changed; update this guard',
    );
  }
  const file = join(CHUNKS_DIR, `${m[1]}.js`);
  if (!existsSync(file)) {
    throw new Error(`writer chunk ${file} referenced by instrumentation.js does not exist`);
  }
  return file;
}

/**
 * Find app-server (reader) chunk(s) that touch the seam — the copies that
 * `getDbPool()` / `correlationLogFields()` read at request time. We scan the
 * built `chunks/` for files that reference the seam functions but are NOT the
 * writer chunk, and require at least one to carry the seam symbols too.
 */
function readerChunksWithSeamSymbols(writerFile: string): string[] {
  const hits: string[] = [];
  for (const name of readdirSync(CHUNKS_DIR)) {
    if (!name.endsWith('.js')) continue;
    const full = join(CHUNKS_DIR, name);
    if (full === writerFile) continue;
    const src = readFileSync(full, 'utf8');
    // A reader chunk is one that calls into the pool-instrumentor seam.
    if (!/getDbPool|setPoolInstrumentor/.test(src)) continue;
    if (SEAM_SYMBOLS.every((sym) => src.includes(sym))) {
      hits.push(full);
    }
  }
  return hits;
}

describe.skipIf(skipReason)('#352/#344 seam survives the standalone bundle', () => {
  it('build artifacts are present (or KNEXT_REQUIRE_STANDALONE forces a build)', () => {
    if (!buildPresent) {
      throw new Error(
        'KNEXT_REQUIRE_STANDALONE=1 but no standalone build present — ' +
          'run `pnpm --filter file-manager build` before this gate.',
      );
    }
    expect(buildPresent).toBe(true);
  });

  it('@knext/lib is NOT in serverExternalPackages (would re-split the seam state)', () => {
    // Externalizing @knext/lib would change how it dedups across the
    // instrumentation vs app-server layers and could reintroduce the #352 split
    // (or mask the globalThis fence). Assert it never gets added there.
    const externals = nextConfigSrc.match(/serverExternalPackages:\s*\[([^\]]*)\]/s)?.[1] ?? '';
    expect(externals).not.toMatch(/@knext\/lib/);
  });

  it('the instrumentation (writer) chunk carries BOTH globalThis seam symbols', () => {
    const src = readFileSync(writerChunkFile(), 'utf8');
    for (const sym of SEAM_SYMBOLS) {
      expect(src, `writer chunk missing Symbol.for('${sym}')`).toContain(sym);
    }
  });

  it('at least one app-server (reader) chunk carries BOTH globalThis seam symbols', () => {
    const readers = readerChunksWithSeamSymbols(writerChunkFile());
    // If the seam regressed to a bare module-level `let`, the reader copy would
    // not carry the Symbol.for(...) keys — so no reader chunk would qualify and
    // this fails, catching the #352 class in the shipped artifact.
    expect(
      readers.length,
      'no app-server chunk carries both seam symbols — the seam may have been ' +
        're-broken (bare module-level state instead of globalThis-anchored)',
    ).toBeGreaterThan(0);
  });

  it('an app route actually reaches a seam-bearing reader chunk', () => {
    // Sanity: the reader chunk must be reachable from a real app entry, else the
    // seam is bundled but dead code. Assert some app page/route references a
    // reader chunk id.
    const readers = readerChunksWithSeamSymbols(writerChunkFile());
    const readerIds = readers.map((f) => f.replace(/.*\/(\d+)\.js$/, '$1'));
    const appFiles: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.js')) appFiles.push(full);
      }
    };
    if (existsSync(APP_DIR)) walk(APP_DIR);
    const referenced = appFiles.some((f) => {
      const src = readFileSync(f, 'utf8');
      return readerIds.some((id) => new RegExp(`[\\[,\\s]${id}[\\],\\s]|/${id}\\.js`).test(src));
    });
    expect(referenced, 'no app entry references a seam-bearing reader chunk').toBe(true);
  });
});
