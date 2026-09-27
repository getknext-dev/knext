/**
 * Self-contained vinext binaries (#1460): sharp's native tree travels INSIDE
 * the executable and is unpacked to a real directory on the FIRST image
 * request, then dlopened from there.
 *
 * ## Why unpack at all
 *
 * The addon links libvips by a RELATIVE rpath (`@loader_path/../../sharp-libvips-
 * <platform>/lib`, `$ORIGIN/…` on linux). Bun can dlopen an addon embedded in a
 * compiled binary, but it extracts the `.node` ALONE to a flat temp name, so the
 * sibling library is never found and the load fails (oven-sh/bun#44063). Until a
 * Bun release extracts co-embedded siblings with their layout, knext extracts the
 * whole tree itself, keeping the layout, and hands the result to the existing
 * dlopen shim (`sharp-addon-dlopen.mjs`), which verifies it against the
 * embedded `.integrity.json` before the OS loader sees it.
 *
 * ## Why lazily
 *
 * Unpacking writes ~18 MB. Paid at boot, that is roughly +375 ms on every fresh
 * container, including every scale-from-zero wake — for a capability most
 * requests never touch. `lazySharp` defers sharp's WHOLE module evaluation
 * (its JavaScript calls into the addon at load) to the first call, so a pod that
 * only answers `/api/health` never unpacks anything.
 *
 * ## Where
 *
 * `KNEXT_NATIVE_TMPDIR`, else the OS temp directory (`TMPDIR`). The directory
 * must be WRITABLE: a read-only root filesystem needs a writable volume there
 * (an `emptyDir` at `/tmp`). A failure is a clear error on the image request
 * that needed it — never a hang, and never a boot crash.
 *
 * Dependency-free over node builtins: a compile script bundles it into the
 * binary.
 */
// @upstream-shim sharp-native-extract
import { createHash } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize, sep } from 'node:path';

/** Where the dlopen shim looks for an extracted native root (see sharp-addon-dlopen.mjs). */
export const NATIVE_ROOT_KEY = Symbol.for('knext.sharp.nativeRoot');

const DIR_PREFIX = 'knext-native-';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** A relpath that stays inside the extraction root, or a throw. */
function safeRel(rel) {
  const n = normalize(rel);
  if (
    !rel ||
    isAbsolute(rel) ||
    n === '..' ||
    n.startsWith(`..${sep}`) ||
    n.split(sep).includes('..')
  ) {
    throw new Error(`knext: refusing to extract '${rel}' — it escapes the native root`);
  }
  return n;
}

/**
 * The extraction directory must be ours alone: a directory other users can
 * write is one where a planted library would be dlopened at native-code
 * privilege. Refuse rather than repair.
 */
function assertPrivateDir(dir) {
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error(`knext: refusing to extract into ${dir} — it is not a plain directory`);
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null && st.uid !== uid) {
    throw new Error(
      `knext: refusing to extract into ${dir} — it belongs to uid ${st.uid}, not to this process (${uid})`,
    );
  }
  if ((st.mode & 0o022) !== 0) {
    throw new Error(
      `knext: refusing to extract into ${dir} — it is writable by other users (mode ${(st.mode & 0o777).toString(8)})`,
    );
  }
}

function writeAtomic(target, bytes) {
  const tmp = `${target}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
}

/**
 * Unpack `files` (`{ rel, path }`, where `path` is readable by `readFileSync` —
 * inside the binary, a `$bunfs` path) under one content-addressed directory,
 * keeping every relpath. A file already there with the same bytes is reused;
 * anything else is rewritten. Returns the directory and the counts.
 *
 * @param {{ files: { rel: string, path: string }[], tmpRoot?: string }} input
 * @returns {{ root: string, extracted: number, reused: number }}
 */
export function extractEmbeddedNative({ files, tmpRoot }) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(
      'knext: this self-contained binary embeds no native tree for sharp — rebuild it with a current `kn-next build --self-contained`',
    );
  }
  const base = tmpRoot || process.env.KNEXT_NATIVE_TMPDIR || tmpdir();
  const entries = [...files]
    .map((f) => ({ rel: safeRel(f.rel), path: f.path }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  let root = base;
  try {
    const bytes = entries.map((e) => readFileSync(e.path));
    const key = createHash('sha256');
    entries.forEach((e, i) => key.update(e.rel).update('\0').update(sha256(bytes[i])).update('\0'));
    root = join(base, `${DIR_PREFIX}${key.digest('hex').slice(0, 16)}`);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    assertPrivateDir(root);
    let extracted = 0;
    let reused = 0;
    entries.forEach((e, i) => {
      const target = join(root, e.rel);
      const want = bytes[i];
      let same = false;
      try {
        same =
          statSync(target).size === want.length && sha256(readFileSync(target)) === sha256(want);
      } catch {
        same = false;
      }
      if (same) {
        reused++;
        return;
      }
      mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
      writeAtomic(target, want);
      extracted++;
    });
    return { root, extracted, reused };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.startsWith('knext:')) throw error;
    throw new Error(
      `knext: could not unpack sharp's native libraries to ${root}\n` +
        '  a self-contained binary unpacks them on the first image request and needs a WRITABLE\n' +
        '  temp directory for it: set TMPDIR (or KNEXT_NATIVE_TMPDIR) to one — on a read-only root\n' +
        '  filesystem, mount a writable volume (an emptyDir) there.\n' +
        `  underlying error: ${msg}`,
    );
  }
}

/**
 * A stand-in for sharp's default export that loads the real module on first
 * USE — a call, a `new`, or a property read — and never before. A load failure
 * is remembered and rethrown on every later use, so a second image request
 * reports the same cause instead of a confusing `undefined is not a function`.
 *
 * @template T
 * @param {() => T} load
 * @returns {T}
 */
export function lazySharp(load) {
  let real;
  let failure;
  const get = () => {
    if (failure) throw failure;
    if (real === undefined) {
      try {
        real = load();
      } catch (error) {
        failure = error;
        throw error;
      }
      if (typeof real !== 'function') {
        failure = new Error(`knext: sharp loaded as ${typeof real}, not a function`);
        throw failure;
      }
    }
    return real;
  };
  return new Proxy(function sharp() {}, {
    apply: (_t, thisArg, args) => Reflect.apply(get(), thisArg, args),
    construct: (_t, args, newTarget) =>
      Reflect.construct(get(), args, newTarget === _t ? get() : newTarget),
    get: (_t, prop) => Reflect.get(get(), prop),
    has: (_t, prop) => Reflect.has(get(), prop),
  });
}
