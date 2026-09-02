/*
 * Replacement for `sharp/dist/sharp.mjs`, whose entire contract is
 * `export default <the native addon>`.
 *
 * ## Why this exists
 *
 * Inside a `bun build --compile` binary, module RESOLUTION is closed: the
 * resolver sees only the embedded graph. Measured on bun 1.4.0, every route that
 * goes through resolution fails, and none of them is a configuration mistake:
 *
 *   - `require('@img/sharp-<platform>/sharp.node')` — sharp's own loader — throws
 *     `Could not load the "sharp" module`.
 *   - `--external sharp` resolves from `/$bunfs/root/`, which has no
 *     `node_modules` above it.
 *   - `--asset=` embeds the `.node` successfully, and it is STILL unusable: the
 *     OS cannot `dlopen` a path inside the binary's virtual filesystem.
 *
 * What does work is `process.dlopen` with an absolute path on the real
 * filesystem. It bypasses resolution and hands the path straight to the OS
 * loader. So the addon ships beside the executable and is opened by path, while
 * sharp's JavaScript is bundled normally.
 *
 * ## What must ship alongside
 *
 * The `.node` is not self-contained — it links libvips by a RELATIVE rpath. The
 * addon must keep its original directory layout (`@img/sharp-<platform>/lib/…`
 * next to `@img/sharp-libvips-<platform>/lib/…`), or `dlopen` finds the addon
 * and then fails resolving `libvips-cpp`. Copying the bare `.node` alone is the
 * mistake this paragraph exists to prevent; it was made once.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Absolute path to the addon. `KNEXT_SHARP_ADDON` wins so an image can put the
 * native tree wherever it likes; the default is beside the executable, which is
 * where a single-binary deployment naturally keeps it.
 *
 * `process.execPath` is the REAL path on disk even inside a compiled binary —
 * verified, and worth stating because almost everything else in that process
 * reports a `/$bunfs/` virtual path.
 */
function addonPath() {
    // Truthiness, not `??`: an env var that is SET BUT EMPTY is the common
    // shape of a mis-staged image (`KNEXT_SHARP_ADDON=$(find … )` that matched
    // nothing), and `??` would accept `""` and then dlopen the empty string.
    // That failure reads as "could not dlopen the sharp addon at " — a message
    // with a hole in it, which is worse than falling back.
  const configured = process.env.KNEXT_SHARP_ADDON;
  if (configured && configured.trim() !== '') return configured;

  const beside = dirname(process.execPath);

  // The simple shape: the addon dropped straight next to the executable.
  const flat = join(beside, 'sharp.node');
  if (existsSync(flat)) return flat;

  // The shape an image actually ships, because the addon links libvips by a
  // RELATIVE rpath and therefore cannot be flattened: `native/@img`-style trees
  // kept intact beside the binary. Discovered rather than configured — one less
  // value to set correctly, and a wrong env var is the failure mode this
  // function already had to defend against.
  const nativeRoot = join(beside, 'native');
  for (const pkg of safeReadDir(nativeRoot)) {
    if (!pkg.startsWith('sharp-') || pkg.startsWith('sharp-libvips-')) continue;
    const lib = join(nativeRoot, pkg, 'lib');
    for (const file of safeReadDir(lib)) {
      if (file.startsWith('sharp-') && file.endsWith('.node')) return join(lib, file);
    }
  }
  return flat;
}

/** `readdirSync` that treats "not there" as "nothing", not as a crash. */
function safeReadDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const path = addonPath();
const container = { exports: {} };

try {
    process.dlopen(container, path);
} catch (error) {
    // Deliberately NOT sharp's stock message, which blames a bad npm install.
    // Here the addon ships with the image, so the real causes are a missing
    // file, a wrong architecture, or a libc mismatch — and saying "run npm
    // install" would send the reader somewhere with nothing to find.
    throw new Error(
        `knext: could not dlopen the sharp addon at ${path}\n` +
            `  set KNEXT_SHARP_ADDON to point at the .node inside its @img tree\n` +
            `  the addon links libvips by relative rpath, so it must keep that layout\n` +
            `  underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
}

export default container.exports;
