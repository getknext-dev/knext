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
 * ACTUAL shipped artifact: each seam symbol must appear in BOTH the
 * instrumentation (writer) chunk AND an app-server (reader) chunk of the real
 * `next build --webpack` output. (Next's webpack chunker may split the two seam
 * families — clients/poolInstrumentor and context/state — into DIFFERENT reader
 * chunks; the reader assertion is therefore per-family, not one combined chunk.)
 * If a future change re-breaks the seam — e.g. reverts to a bare module-level
 * `let`, or moves `@knext/lib` into `serverExternalPackages` (which would change
 * dedup and re-split the state) — a seam symbol stops co-occurring with its seam
 * API in any reader chunk and this gate fails, instead of the deploy.
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

// Each seam family pairs its globalThis Symbol.for(...) key with the seam API
// that reads/writes it. The clients seam (poolInstrumentor) travels with
// getDbPool/setPoolInstrumentor; the context seam (context.state) travels with
// correlationLogFields/getContextState. Next's webpack chunker is free to place
// these two families in DIFFERENT app-server chunks (it does as of the current
// Next.js/webpack), so we must NOT require a single chunk to carry BOTH — only
// that EACH symbol co-occurs with its own seam API in a NON-writer reader chunk.
const SEAM_FAMILIES: ReadonlyArray<{ symbol: (typeof SEAM_SYMBOLS)[number]; api: RegExp }> = [
  { symbol: 'knext.lib.clients.poolInstrumentor', api: /getDbPool|setPoolInstrumentor/ },
  { symbol: 'knext.lib.context.state', api: /correlationLogFields|getContextState/ },
];

/**
 * For each seam family, find app-server (reader) chunk(s) — the copies read at
 * request time — that carry that family's globalThis symbol alongside its seam
 * API, excluding the writer chunk. Returns a map of symbol -> reader chunk
 * files. A family with zero reader chunks means the seam regressed for that
 * family (bare module-level state instead of a globalThis-anchored cell).
 */
function readerChunksBySeamSymbol(writerFile: string): Map<string, string[]> {
  const bySymbol = new Map<string, string[]>(SEAM_FAMILIES.map((f) => [f.symbol, []]));
  for (const name of readdirSync(CHUNKS_DIR)) {
    if (!name.endsWith('.js')) continue;
    const full = join(CHUNKS_DIR, name);
    if (full === writerFile) continue;
    const src = readFileSync(full, 'utf8');
    for (const { symbol, api } of SEAM_FAMILIES) {
      // A reader chunk for this family calls into that family's seam API AND
      // carries its globalThis Symbol.for(...) key.
      if (api.test(src) && src.includes(symbol)) {
        bySymbol.get(symbol)?.push(full);
      }
    }
  }
  return bySymbol;
}

/** All reader chunk files across every seam family (deduplicated). */
function allReaderChunks(writerFile: string): string[] {
  const set = new Set<string>();
  for (const files of readerChunksBySeamSymbol(writerFile).values()) {
    for (const f of files) set.add(f);
  }
  return [...set];
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

  it('each globalThis seam symbol reaches an app-server (reader) chunk', () => {
    // If a seam regressed to a bare module-level `let`, the reader copy would
    // not carry that family's Symbol.for(...) key — so no reader chunk would
    // qualify for it, catching the #352 class in the shipped artifact. Next's
    // webpack chunker may split the two seam families into DIFFERENT reader
    // chunks, so we assert per-family rather than requiring one combined chunk.
    const bySymbol = readerChunksBySeamSymbol(writerChunkFile());
    for (const sym of SEAM_SYMBOLS) {
      const readers = bySymbol.get(sym) ?? [];
      expect(
        readers.length,
        `no app-server (reader) chunk carries Symbol.for('${sym}') alongside its ` +
          'seam API — that seam may have been re-broken (bare module-level state ' +
          'instead of globalThis-anchored)',
      ).toBeGreaterThan(0);
    }
  });

  it('an app route actually reaches a seam-bearing reader chunk', () => {
    // Sanity: the reader chunk must be reachable from a real app entry, else the
    // seam is bundled but dead code. Assert some app page/route references a
    // reader chunk id.
    const readers = allReaderChunks(writerChunkFile());
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
