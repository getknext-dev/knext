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
 *
 * ## Integrity (C2)
 *
 * This is the last gate before native-code privilege, so it is where the
 * verification has to be. `kn-next build` writes `native/.integrity.json` — a
 * sha256 per staged file, plus the `@img` versions its lockfile pinned — and
 * this shim re-checks every native payload the manifest lists before handing
 * anything to the OS loader. A mismatch or an unlisted payload is FATAL. An
 * ABSENT manifest is a warning, not a failure: images built before this landed
 * have none, and failing closed on absence would turn a supply-chain fix into a
 * fleet outage. That permissiveness is a DATED exception with an off switch (S2)
 * — `KNEXT_REQUIRE_NATIVE_INTEGRITY=1` makes absence fatal today, and the expiry
 * on the exception itself lives in `scripts/lib/native-integrity-policy.mjs`.
 *
 * ## Why everything here is inline
 *
 * `vinext-compile.mjs` injects this file's SOURCE TEXT into sharp's module slot
 * via an `onLoad` hook, so a relative import would resolve against
 * `sharp/dist/`, not against this directory. The file must stay self-contained
 * over node builtins — that constraint is pinned by a test, not just stated.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

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

/**
 * The nearest `.integrity.json` at or above the addon, or `null`.
 *
 * Bounded rather than unbounded: the manifest sits at the root of the staged
 * tree, three levels above the addon (`native/<pkg>/lib/<addon>.node`). Walking
 * to `/` would let an unrelated manifest higher up the filesystem answer for a
 * tree that has none, which is a worse failure than not finding one.
 */
function findManifest(startDir) {
  let dir = startDir;
  for (let up = 0; up < 4; up++) {
    const candidate = join(dir, '.integrity.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** `.node`, `.dylib`, `.so`, `.so.42` — the files an OS loader will execute. */
function isNativePayload(file) {
  return /\.(node|dylib|so)$|\.so\.[0-9]+$/.test(file);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Every spelling of on/off this accepts, trimmed and lower-cased. */
const REQUIRE_ON = ['1', 'true', 'yes', 'on'];
const REQUIRE_OFF = ['0', 'false', 'no', 'off'];

/**
 * Is the fail-closed switch on?
 *
 * NOT `process.env.X === '1'`, and the difference is the whole point. A strict
 * equality test sends every OTHER non-empty value — `true`, `yes`, `1 ` with a
 * trailing space from a YAML block scalar — down the PERMISSIVE branch, with no
 * signal anywhere. An operator who set `KNEXT_REQUIRE_NATIVE_INTEGRITY=true`
 * would believe their fleet refuses an unverifiable native tree while nothing at
 * all had changed. A security opt-in that silently means "off" is worse than no
 * opt-in, precisely because it is believed.
 *
 * So: the usual spellings of ON turn it on, the usual spellings of OFF (and
 * unset, and whitespace) leave the dated exception in force, and anything else
 * THROWS. Refusing is the only sound answer for an unparseable value in a
 * security control — guessing "off" is the bug above, and guessing "on" bricks a
 * fleet on a typo. Same fail-closed shape as `cache-handler.js`'s seam gate.
 */
function requireIntegrity() {
  const raw = process.env.KNEXT_REQUIRE_NATIVE_INTEGRITY;
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (value === '') return false;
  if (REQUIRE_ON.includes(value)) return true;
  if (REQUIRE_OFF.includes(value)) return false;
  throw new Error(
    `knext: KNEXT_REQUIRE_NATIVE_INTEGRITY=${JSON.stringify(raw)} is not a value this ` +
      'understands, and it will not guess.\n' +
      `  accepted (on):  ${REQUIRE_ON.join(' | ')}\n` +
      `  accepted (off): ${REQUIRE_OFF.join(' | ')}, or leave it unset\n` +
      '  reading an unrecognised value as "off" would leave an operator believing the fleet\n' +
      '  fails closed on an unverifiable native tree when it does not.',
  );
}

/**
 * Fail-closed check of the staged native tree against its manifest.
 *
 * Every listed payload is checked, not only the addon being dlopened: libvips is
 * pulled in transitively by the OS loader off a relative rpath and never passes
 * through this function, so verifying just the addon would leave the larger — and
 * more easily swapped — binary unpinned. The cost is one hash of the tree, paid
 * on first sharp import (the first `/_next/image` request), not at boot.
 */
function verifyAgainstManifest(addon) {
  // Parsed UNCONDITIONALLY, before anything branches on it. A value nobody can
  // read is an operator mistake in a security control whether or not this
  // particular image happens to carry a manifest — and validating it only on
  // the absent-manifest path would mean the same typo refuses on one image and
  // is silently ignored on the next, which is a worse contract to explain than
  // either answer on its own.
  const required = requireIntegrity();

  const manifestPath = findManifest(dirname(addon));
  if (manifestPath === null) {
    // S2. Absence is the ONE permissive branch here, and it is a dated
    // exception (`scripts/lib/native-integrity-policy.mjs`), not a permanent
    // default: an image built before native-tree pinning has no manifest, so
    // refusing on absence would turn a supply-chain fix into a fleet outage.
    // `KNEXT_REQUIRE_NATIVE_INTEGRITY` turns the exception off for an operator
    // who knows every image in their fleet is current. See `requireIntegrity()`
    // for why it accepts every usual spelling of on/off and REFUSES anything
    // else, rather than testing `=== '1'`.
    //
    // The exception's EXPIRY is deliberately not read here: a wall-clock branch
    // in the runtime would brick running pods at midnight on the expiry date.
    // The clock reds CI instead (`tests/native-integrity-absence-exception.test.ts`).
    if (required) {
      throw new Error(
        `knext: refusing to dlopen — no native integrity manifest beside ${addon}, and\n` +
          '  KNEXT_REQUIRE_NATIVE_INTEGRITY requires one. This image predates native-tree\n' +
          '  integrity pinning; rebuild it with a current `kn-next build`, or unset the variable\n' +
          '  to accept an UNVERIFIED native tree.',
      );
    }
    console.warn(
      `knext: no native integrity manifest beside ${addon} — loading it UNVERIFIED.\n` +
        '  images built before native-tree integrity pinning have none; rebuild with a current\n' +
        '  `kn-next build` to get one, after which a mismatch becomes a hard failure.\n' +
        '  set KNEXT_REQUIRE_NATIVE_INTEGRITY=1 to make this absence a hard failure instead.',
    );
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `knext: refusing to dlopen — the native integrity manifest at ${manifestPath} is unreadable\n` +
        `  underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const root = dirname(manifestPath);
  const files = manifest && manifest.files ? manifest.files : {};

  // The addon itself must be LISTED. A payload sitting in a tree that has a
  // manifest but is absent from it is the injected-file case, and treating it as
  // "nothing recorded, nothing to check" is exactly the hole being closed.
  const addonKey = relative(root, addon).split(sep).join('/');
  if (!Object.hasOwn(files, addonKey)) {
    throw new Error(
      `knext: refusing to dlopen a native module the integrity manifest does not list\n` +
        `  file: ${addonKey} (${addon})\n` +
        `  manifest: ${manifestPath}\n` +
        '  the manifest records every file `kn-next build` staged; one that is not in it was\n' +
        '  added to the image afterwards.',
    );
  }

  for (const [rel, expected] of Object.entries(files)) {
    if (!isNativePayload(rel)) continue;
    const abs = join(root, ...rel.split('/'));
    let actual;
    try {
      actual = sha256(abs);
    } catch (error) {
      throw new Error(
        `knext: refusing to dlopen — a native payload the integrity manifest lists is unreadable\n` +
          `  file: ${rel} (${abs})\n` +
          `  underlying error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (actual !== expected) {
      throw new Error(
        `knext: refusing to dlopen a native module that does not match the integrity manifest\n` +
          `  file: ${rel} (${abs})\n` +
          `  expected sha256 ${expected}\n` +
          `  actual   sha256 ${actual}\n` +
          `  manifest: ${manifestPath}\n` +
          '  the native tree changed after `kn-next build` staged it. Rebuild the image; do not\n' +
          '  work around this by editing the manifest.',
      );
    }
  }
}

const path = addonPath();
const container = { exports: {} };

verifyAgainstManifest(path);

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
