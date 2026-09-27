/**
 * #1460 — the self-contained sharp extractor and its lazy loader.
 *
 * `extractEmbeddedNative` unpacks the native tree a self-contained binary
 * embeds; inside the binary its `path`s are `$bunfs` paths, here they are real
 * files, which is the same `readFileSync` contract.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { extractEmbeddedNative, lazySharp } from '../adapters/sharp-native-extract.mjs';

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) {
    try {
      chmodSync(d, 0o755);
    } catch {}
    rmSync(d, { recursive: true, force: true });
  }
});
function temp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
}

/** An embedded-tree stand-in: sources on disk, listed as `{ rel, path }`. */
function tree(files: Record<string, string>): { rel: string; path: string }[] {
  const src = temp('knext-1460-src-');
  return Object.entries(files).map(([rel, body]) => {
    const path = join(src, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    return { rel, path };
  });
}

const LAYOUT = {
  'sharp-linux-x64/lib/sharp-linux-x64.node': 'ADDON',
  'sharp-libvips-linux-x64/lib/libvips-cpp.so.42': 'LIBVIPS',
  '.integrity.json': '{"version":1}',
};

describe('extractEmbeddedNative', () => {
  it('unpacks every file with its relative layout, into a private directory', () => {
    const tmpRoot = temp('knext-1460-tmp-');
    const out = extractEmbeddedNative({ files: tree(LAYOUT), tmpRoot });
    expect(out.extracted).toBe(3);
    expect(out.reused).toBe(0);
    expect(dirname(out.root)).toBe(tmpRoot);
    for (const [rel, body] of Object.entries(LAYOUT)) {
      expect(readFileSync(join(out.root, rel), 'utf8')).toBe(body);
    }
    expect(statSync(out.root).mode & 0o077).toBe(0);
  });

  it('the second call reuses the unpacked tree instead of rewriting it', () => {
    const tmpRoot = temp('knext-1460-tmp-');
    const files = tree(LAYOUT);
    const first = extractEmbeddedNative({ files, tmpRoot });
    const second = extractEmbeddedNative({ files, tmpRoot });
    expect(second.root).toBe(first.root);
    expect(second).toMatchObject({ extracted: 0, reused: 3 });
  });

  it('a tampered file is rewritten from the embedded bytes, never trusted', () => {
    const tmpRoot = temp('knext-1460-tmp-');
    const files = tree(LAYOUT);
    const { root } = extractEmbeddedNative({ files, tmpRoot });
    const lib = join(root, 'sharp-libvips-linux-x64/lib/libvips-cpp.so.42');
    // Extracted files ship 0500 (no write bit, #1460 round 2 hardening) —
    // a REALISTIC same-uid tamper has to reclaim write access first, same
    // as this simulates.
    chmodSync(lib, 0o600);
    writeFileSync(lib, 'LIBVIPZ'); // same length, different bytes
    const again = extractEmbeddedNative({ files, tmpRoot });
    expect(again).toMatchObject({ extracted: 1, reused: 2 });
    expect(readFileSync(lib, 'utf8')).toBe('LIBVIPS');
  });

  it('a different embedded tree gets a different directory (content-addressed)', () => {
    const tmpRoot = temp('knext-1460-tmp-');
    const a = extractEmbeddedNative({ files: tree(LAYOUT), tmpRoot });
    const b = extractEmbeddedNative({
      files: tree({
        ...LAYOUT,
        '.integrity.json': '{"version":1,"x":1}',
      }),
      tmpRoot,
    });
    expect(b.root).not.toBe(a.root);
  });

  it('an unwritable temp root is a clear error naming the fix — thrown, not a hang', () => {
    const tmpRoot = temp('knext-1460-ro-');
    chmodSync(tmpRoot, 0o555);
    const started = performance.now();
    expect(() => extractEmbeddedNative({ files: tree(LAYOUT), tmpRoot })).toThrow(
      /could not unpack sharp's native libraries[\s\S]*WRITABLE[\s\S]*emptyDir[\s\S]*underlying error: E(ACCES|ROFS|PERM)/,
    );
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('refuses a pre-existing extraction directory other users can write', () => {
    const tmpRoot = temp('knext-1460-tmp-');
    const files = tree(LAYOUT);
    const { root } = extractEmbeddedNative({ files, tmpRoot });
    chmodSync(root, 0o777);
    expect(() => extractEmbeddedNative({ files, tmpRoot })).toThrow(
      /refusing to extract .* writable by other users/,
    );
  });

  it('refuses a relpath that escapes the root', () => {
    const tmpRoot = temp('knext-1460-tmp-');
    const [file] = tree({ 'a.node': 'A' });
    expect(() =>
      extractEmbeddedNative({
        files: [{ rel: '../escape.node', path: file.path }],
        tmpRoot,
      }),
    ).toThrow(/escapes the native root/);
    expect(existsSync(join(tmpRoot, '..', 'escape.node'))).toBe(false);
  });

  it('an empty embedded tree is an error, not a silent no-op', () => {
    expect(() =>
      extractEmbeddedNative({
        files: [],
        tmpRoot: temp('knext-1460-tmp-'),
      }),
    ).toThrow(/embeds no native tree/);
  });

  // #1460 round 2 hardening (i)-(iv): the extraction directory name is not a
  // pure function of content alone, the TMPDIR base itself is checked before
  // anything is created under it, a relative KNEXT_NATIVE_TMPDIR is refused,
  // and extracted files carry no write bit.

  it('the extraction directory name includes the uid, not just the content hash', () => {
    // A name that were ONLY a content hash would be identical on every
    // host running the same binary, regardless of who runs it — so any
    // local user could pre-create it and permanently deny extraction to
    // every OTHER uid (assertPrivateDir would then always refuse it as
    // foreign-owned, with no way for the legitimate uid to recover
    // without an operator clearing it).
    const tmpRoot = temp('knext-1460-uid-');
    const { root } = extractEmbeddedNative({
      files: tree(LAYOUT),
      tmpRoot,
    });
    const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'nouid';
    expect(basename(root).startsWith(`knext-native-${uid}-`)).toBe(true);
  });

  it('extracted files carry no write bit (0500) — read+execute only', () => {
    const tmpRoot = temp('knext-1460-mode-');
    const { root } = extractEmbeddedNative({
      files: tree(LAYOUT),
      tmpRoot,
    });
    const file = join(root, 'sharp-linux-x64/lib/sharp-linux-x64.node');
    expect(statSync(file).mode & 0o777).toBe(0o500);
  });

  it('refuses a world-writable TMPDIR base that lacks the sticky bit', () => {
    // Distinct from assertPrivateDir, which checks the directory THIS
    // process creates — this checks the BASE it creates that directory
    // under. A shared, non-sticky, world-writable base lets another local
    // user rename or replace entries here between checks.
    const tmpRoot = temp('knext-1460-unsticky-');
    chmodSync(tmpRoot, 0o777);
    expect(() => extractEmbeddedNative({ files: tree(LAYOUT), tmpRoot })).toThrow(
      /world-writable.*without the sticky bit/s,
    );
  });

  it('accepts a world-writable TMPDIR base that HAS the sticky bit, like a real /tmp', () => {
    const tmpRoot = temp('knext-1460-sticky-');
    chmodSync(tmpRoot, 0o1777);
    const out = extractEmbeddedNative({ files: tree(LAYOUT), tmpRoot });
    expect(out.extracted).toBe(3);
  });

  it('still refuses a world-writable, non-sticky base merely because THIS process owns it — ownership by self does not gate rename/delete, mode does', () => {
    // Distinct from the operator's root-owned emptyDir case (a separate
    // mocked test covers root): a base this process owns, but which is
    // 0777 with no sticky bit, is exactly as exposed to another local
    // uid renaming/deleting entries as a foreign-owned one would be —
    // directory-write permission, not ownership, governs that.
    const tmpRoot = temp('knext-1460-selfowned-unsticky-');
    chmodSync(tmpRoot, 0o777);
    expect(() => extractEmbeddedNative({ files: tree(LAYOUT), tmpRoot })).toThrow(
      /world-writable.*without the sticky bit/s,
    );
  });

  it("resolves a symlinked KNEXT_NATIVE_TMPDIR base (like macOS /tmp -> /private/tmp) instead of refusing it as 'not a plain directory'", () => {
    const realDir = temp('knext-1460-symtarget-');
    const parent = dirname(realDir);
    const link = join(parent, `knext-1460-symlink-${process.pid}`);
    symlinkSync(realDir, link);
    temps.push(link);
    const out = extractEmbeddedNative({
      files: tree(LAYOUT),
      tmpRoot: link,
    });
    // The extraction root is created UNDER the path as given (the symlink)
    // — writes go through it transparently at the OS level — but
    // `assertSafeBase` had to resolve it through `realpathSync` first to
    // stat the real target instead of refusing the symlink itself.
    expect(dirname(out.root)).toBe(link);
    expect(readFileSync(join(realDir, basename(out.root), Object.keys(LAYOUT)[0]), 'utf8')).toBe(
      LAYOUT[Object.keys(LAYOUT)[0] as keyof typeof LAYOUT],
    );
    expect(out.extracted).toBe(3);
  });

  it('refuses a pre-created hostile per-uid subdir sitting inside an otherwise-allowed base — the base being writable does not excuse the subdir', () => {
    const tmpRoot = temp('knext-1460-hostile-subdir-');
    const files = tree(LAYOUT);
    // Learn the content-addressed path, then plant a hostile (world-
    // writable) directory there BEFORE the real extraction ever runs —
    // simulating another local user racing to pre-create it. `mkdirSync`'s
    // `mode` is masked by the process umask (typically 022), so the mode is
    // forced explicitly afterwards, same as the sibling test above that
    // chmods an EXISTING root to 0777.
    const { root } = extractEmbeddedNative({ files, tmpRoot });
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o777);
    expect(() => extractEmbeddedNative({ files, tmpRoot })).toThrow(
      /refusing to extract .* writable by other users/,
    );
  });

  it('refuses a relative KNEXT_NATIVE_TMPDIR (would resolve against the cwd, unpredictably)', () => {
    const prev = process.env.KNEXT_NATIVE_TMPDIR;
    process.env.KNEXT_NATIVE_TMPDIR = 'relative/native-tmp-should-never-exist';
    try {
      expect(() => extractEmbeddedNative({ files: tree(LAYOUT) })).toThrow(
        /must be an absolute path/,
      );
      expect(existsSync('relative/native-tmp-should-never-exist')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.KNEXT_NATIVE_TMPDIR;
      else process.env.KNEXT_NATIVE_TMPDIR = prev;
    }
  });
});

describe('lazySharp', () => {
  it('does not load at construction — only on first use', () => {
    let loads = 0;
    const real = Object.assign((n: number) => n * 2, { cache: 'c' });
    const s = lazySharp(() => {
      loads++;
      return real;
    }) as unknown as typeof real;
    expect(loads).toBe(0);
    expect(s(21)).toBe(42);
    expect(s.cache).toBe('c');
    expect(s(1)).toBe(2);
    expect(loads).toBe(1);
  });

  it("a property read is a use (sharp's statics load it too)", () => {
    let loads = 0;
    const s = lazySharp(() => {
      loads++;
      return Object.assign(() => 0, { versions: { vips: '8' } });
    }) as unknown as { versions: { vips: string } };
    expect(s.versions.vips).toBe('8');
    expect(loads).toBe(1);
  });

  it('`new` reaches the real constructor', () => {
    class Real {
      v = 7;
    }
    const S = lazySharp(() => Real) as unknown as typeof Real;
    expect(new S().v).toBe(7);
    expect(new S()).toBeInstanceOf(Real);
  });

  it('a load failure is remembered: every later use rethrows the SAME cause', () => {
    let loads = 0;
    const s = lazySharp(() => {
      loads++;
      throw new Error("knext: could not unpack sharp's native libraries to /x");
    }) as unknown as () => void;
    expect(() => s()).toThrow(/could not unpack/);
    expect(() => s()).toThrow(/could not unpack/);
    expect(loads).toBe(1);
  });

  it('a load that yields a non-function is refused, not called', () => {
    const s = lazySharp(() => ({}) as unknown as () => void) as unknown as () => void;
    expect(() => s()).toThrow(/sharp loaded as object, not a function/);
  });
});
