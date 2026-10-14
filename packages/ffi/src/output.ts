/**
 * Writing the generated module: the same ownership rules `knext generate`
 * (`@getknext/grpc`) applies, so the two generators behave alike. (Copied,
 * not imported: the two packages are independent and optional.)
 *
 * Ownership. The output directory may hold files this tool did not write. So
 * ownership is never inferred from a file's header: every run records the
 * exact paths it wrote in `.knext-generated.json` inside the output directory,
 * and a file is stale only if the PREVIOUS manifest lists it and this run no
 * longer produces it. Manifest entries are confined to the output directory;
 * an entry that escapes it is ignored, never deleted. The manifest is itself
 * an output, so `check` compares it like any other generated file. Writes never
 * go through a symlink or a hardlink, and never leave the app.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { FfiUsageError } from './config';

/** The record of what the last run wrote, inside the output directory. */
export const MANIFEST = '.knext-generated.json';

export interface Drift {
  readonly path: string;
  readonly kind: 'changed' | 'missing' | 'stale';
}

/**
 * The paths the previous run recorded, confined to `outDir`: an entry that is
 * absolute, climbs out with `..`, or names the manifest itself is dropped. A
 * missing or unreadable manifest owns nothing.
 */
export function previouslyWritten(outDir: string): string[] {
  let files: unknown;
  try {
    files = (JSON.parse(readFileSync(join(outDir, MANIFEST), 'utf8')) as { files?: unknown }).files;
  } catch {
    return [];
  }
  if (!Array.isArray(files)) return [];
  const root = resolve(outDir);
  return files
    .filter((f): f is string => typeof f === 'string' && f !== '' && f !== MANIFEST)
    .filter((f) => !isAbsolute(f) && !f.includes('\\'))
    .filter((f) => {
      const norm = posix.normalize(f);
      if (norm !== f || norm.startsWith('../') || norm === '..') return false;
      const target = resolve(root, norm);
      return target.startsWith(root + sep) && relative(root, target).split(sep).join('/') === norm;
    })
    .sort();
}

/** Compare the expected output with what is on disk under `outDir`. */
export function diffOutput(expected: Map<string, string>, outDir: string): Drift[] {
  const drift: Drift[] = [];
  for (const [path, content] of expected) {
    const onDisk = join(outDir, path);
    if (!existsSync(onDisk)) drift.push({ path, kind: 'missing' });
    else if (readFileSync(onDisk, 'utf8') !== content) drift.push({ path, kind: 'changed' });
  }
  for (const path of previouslyWritten(outDir)) {
    // Only a regular file can be stale: a recorded name that is now a
    // directory or a symlink is skipped, never unlinked.
    if (!expected.has(path) && isRegularFile(join(outDir, path))) {
      drift.push({ path, kind: 'stale' });
    }
  }
  return drift;
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/**
 * Write `content` to `target` by creating a fresh temp file beside it and
 * renaming it over the target. rename() replaces the directory entry, so the
 * write never goes through the target's inode: a target that is a hardlink to
 * a file outside the output directory is replaced, and the outside twin keeps
 * its bytes. A symlink at the target is replaced too, never followed. The temp
 * file is opened O_EXCL | O_NOFOLLOW and removed if anything fails. The
 * target's permission bits are carried over (minus setuid/setgid); its inode, ownership and extended
 * attributes are not (the replacement is a new file owned by the caller).
 */
export function writeFileAtomic(target: string, content: string): void {
  const temp = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  const fd = openSync(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    try {
      writeFileSync(fd, content);
      // Keep an existing file's permission bits (0600 stays 0600, a read-only
      // 0444 file is replaced and stays 0444). setuid/setgid are dropped, as the
      // kernel did on the old in-place write (4755 becomes 0755); the sticky bit
      // is kept. A new file keeps 0644 minus umask.
      const existing = lstatSync(target, { throwIfNoEntry: false });
      if (existing?.isFile()) fchmodSync(fd, existing.mode & 0o1777);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/**
 * Writes confined to the output directory. Generation never writes THROUGH a
 * symlink: not a symlinked file, not a symlinked directory on the way to it,
 * and not an output directory that is itself a symlink leading out of the app.
 * Every target is checked before any is written ({@link check}); the write
 * itself re-checks after creating parent directories, then replaces the target
 * by rename ({@link writeFileAtomic}), so neither a symlink nor a hardlink
 * planted at the target is ever written through.
 */
export class ConfinedWriter {
  private readonly realOut: string;

  constructor(
    cwd: string,
    private readonly outDir: string,
    private readonly outName: string,
  ) {
    const realApp = realpathSync(cwd);
    const outside = (real: string) =>
      this.refuse('', `the output directory resolves to ${real}, outside the app`);
    // Before creating anything: the deepest part of out that exists must
    // already be inside the app, or mkdir would create directories outside it.
    let ancestor = outDir;
    while (lstatSync(ancestor, { throwIfNoEntry: false }) === undefined)
      ancestor = dirname(ancestor);
    const realAncestor = realpathSync(ancestor);
    if (!isInside(realAncestor, realApp)) throw outside(realAncestor);
    mkdirSync(outDir, { recursive: true });
    this.realOut = realpathSync(outDir);
    if (!isInside(this.realOut, realApp) || this.realOut === realApp) throw outside(this.realOut);
  }

  private refuse(path: string, why: string): FfiUsageError {
    const where = path ? `${this.outName}/${path}` : this.outName;
    return new FfiUsageError(
      `refusing to write ${where}: ${why}. Generated code is never written through a symlink; ` +
        'replace it with a real file or directory, then run `knext ffi generate` again.',
    );
  }

  /** Throw unless `path` (relative to out) can be written without leaving out. */
  check(path: string): void {
    const target = join(this.outDir, path);
    if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw this.refuse(path, 'it is a symlink');
    }
    // The deepest ancestor that exists must really be inside out.
    let ancestor = dirname(target);
    while (lstatSync(ancestor, { throwIfNoEntry: false }) === undefined)
      ancestor = dirname(ancestor);
    if (!isInside(realpathSync(ancestor), this.realOut)) {
      throw this.refuse(path, 'a directory on its path leads outside the output directory');
    }
  }

  write(path: string, content: string): void {
    this.check(path);
    const target = join(this.outDir, path);
    mkdirSync(dirname(target), { recursive: true });
    if (!isInside(realpathSync(dirname(target)), this.realOut)) {
      throw this.refuse(path, 'a directory on its path leads outside the output directory');
    }
    if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw this.refuse(path, 'it is a symlink');
    }
    writeFileAtomic(target, content);
  }
}
