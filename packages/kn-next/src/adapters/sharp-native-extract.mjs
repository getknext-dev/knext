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
  realpathSync,
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
      `knext: refusing to extract into ${dir} — it belongs to uid ${st.uid}, not to this process (${uid}). ` +
        'Set KNEXT_NATIVE_TMPDIR to a private directory this process owns.',
    );
  }
  if ((st.mode & 0o022) !== 0) {
    throw new Error(
      `knext: refusing to extract into ${dir} — it is writable by other users (mode ${(st.mode & 0o777).toString(8)}). ` +
        'Set KNEXT_NATIVE_TMPDIR to a private directory this process owns.',
    );
  }
}

/**
 * The TMPDIR base itself (before this process creates anything under it) must
 * be safe to share: a shared temp directory that is world-writable but lacks
 * the sticky bit lets another local user rename or replace entries out from
 * under this process between checks. `/tmp` is normally 1777 (world-writable,
 * sticky) and passes; a private directory this process owns outright also
 * passes without needing the sticky bit.
 *
 * A world-writable, NON-sticky base also passes when it is ROOT-owned: that
 * is the Kubernetes `emptyDir` default the operator mounts at `/tmp`
 * (`nextapp_controller.go:894-897`) — kubelet's `setupDir` creates it 0777
 * with no sticky bit (k8s 1.34 has no sticky-bit support there), and it is
 * owned by root. Refusing that base would break image optimization under the
 * operator's own default, for no real gain: the actual guard against a
 * planted sibling is the per-uid `0700` subdir this function's caller creates
 * NEXT and `assertPrivateDir()` enforces on it — not this base directory's
 * mode. This does NOT extend to a base merely owned by THIS process: without
 * the sticky bit, directory-write permission governs deletion/rename of
 * every entry regardless of who owns the directory, so a self-owned 0777
 * base is exactly as exposed to another local uid as a foreign-owned one —
 * it stays refused, same as a base owned by any other non-root uid.
 *
 * `dir` is resolved through symlinks first (`realpathSync`) — `/tmp` is a
 * symlink to `/private/tmp` on macOS, and `lstatSync` on the symlink itself
 * would report `isSymbolicLink()` and get refused as "not a plain directory"
 * even though the target is a perfectly normal, safe directory.
 */
function assertSafeBase(dir) {
  let real;
  try {
    real = realpathSync(dir);
  } catch (error) {
    throw new Error(
      `knext: refusing to extract under ${dir} — it does not exist or is not accessible\n` +
        `  underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let st;
  try {
    st = lstatSync(real);
  } catch (error) {
    throw new Error(
      `knext: refusing to extract under ${dir} — it does not exist or is not accessible\n` +
        `  underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error(`knext: refusing to extract under ${dir} — it is not a plain directory`);
  }
  const worldWritable = (st.mode & 0o002) !== 0;
  const sticky = (st.mode & 0o1000) !== 0;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const rootOwned = st.uid === 0;
  if (worldWritable && !sticky) {
    if (rootOwned) return;
    throw new Error(
      `knext: refusing to extract under ${dir} — it is world-writable (mode ${(st.mode & 0o777).toString(8)}) ` +
        `without the sticky bit set and owned by uid ${st.uid} (not root), so another local user could ` +
        'rename or replace entries here between checks. Set KNEXT_NATIVE_TMPDIR to a directory with the ' +
        'sticky bit set (like a normal /tmp), one root owns (like a kubelet emptyDir), or one this process ' +
        'owns privately.',
    );
  }
  if (uid !== null && !worldWritable && st.uid !== uid && st.uid !== 0) {
    throw new Error(
      `knext: refusing to extract under ${dir} — it is owned by uid ${st.uid}, not this process ` +
        `(${uid}) or root. Set KNEXT_NATIVE_TMPDIR to a directory this process owns.`,
    );
  }
}

function writeAtomic(target, bytes) {
  const tmp = `${target}.${process.pid}.tmp`;
  // 0500 (r-x, no write bit): a dlopened native library needs no write access
  // after extraction, and denying it narrows the window a compromised
  // same-uid process (or the app itself) could tamper with a verified file
  // between the integrity check and the OS loader reading it.
  const fd = openSync(tmp, 'w', 0o500);
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
  const envTmp = process.env.KNEXT_NATIVE_TMPDIR;
  const base = tmpRoot || envTmp || tmpdir();
  // A relative base would resolve against the process's current working
  // directory at call time — unpredictable in a server process, and a config
  // mistake this process can catch instead of silently extracting somewhere
  // nobody expected.
  if (!isAbsolute(base)) {
    throw new Error(
      `knext: the native extraction directory must be an absolute path, got ${JSON.stringify(base)}` +
        (base === envTmp ? ' (from KNEXT_NATIVE_TMPDIR)' : '') +
        ' — a relative path would resolve against the current working directory, which is unpredictable.',
    );
  }
  assertSafeBase(base);
  const entries = [...files]
    .map((f) => ({ rel: safeRel(f.rel), path: f.path }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  let root = base;
  try {
    const bytes = entries.map((e) => readFileSync(e.path));
    const key = createHash('sha256');
    entries.forEach((e, i) => key.update(e.rel).update('\0').update(sha256(bytes[i])).update('\0'));
    // The uid is part of the directory name (not just enforced by
    // assertPrivateDir afterwards): the name is otherwise a pure function of
    // the embedded tree's content, so it is the SAME on every host running
    // the same binary. Without the uid, any local user could pre-create it
    // and permanently deny extraction to every other uid (assertPrivateDir
    // would then always refuse it as foreign-owned) — a denial-of-service
    // this process cannot recover from without an operator's intervention.
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'nouid';
    root = join(base, `${DIR_PREFIX}${uid}-${key.digest('hex').slice(0, 16)}`);
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
