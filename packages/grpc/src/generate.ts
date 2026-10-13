/**
 * `knext generate [--check] [--against <baseline>]`.
 *
 * 1. `buf lint` over the zone's contracts (the buf workspace in the app root).
 * 2. With `--against`, `buf breaking` against that baseline (see `baseline.ts`).
 * 3. `buf build` the contracts, then run two generators in-process on the
 *    result: protoc-gen-es (message and service types) and protoc-gen-knext
 *    (the server-only function clients). buf parses; nothing is fetched from
 *    the network and no plugin is resolved from PATH, so the output depends
 *    only on the contract, the settings in `knext.grpc.json`, and the pinned
 *    generator versions.
 * 4. Write the output, or with `--check` compare it and fail on any drift.
 *
 * Ownership. The output directory may hold files this tool did not write — a
 * user's own protoc-gen-es output, notes, anything. So ownership is never
 * inferred from a file's header: every run records the exact paths it wrote
 * in `.knext-generated.json` inside the output directory, and a file is stale only if the
 * PREVIOUS manifest lists it and this run no longer produces it. Manifest
 * entries are confined to the output directory; an entry that escapes it is
 * ignored, never deleted. The manifest is itself an output, so `--check`
 * compares it like any other generated file. (`out` itself is validated in
 * `config.ts`: never the app root, never outside it, never in node_modules.)
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
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { create, fromBinary } from '@bufbuild/protobuf';
import {
  CodeGeneratorRequestSchema,
  type FileDescriptorProto,
  FileDescriptorSetSchema,
} from '@bufbuild/protobuf/wkt';
import { protocGenEs } from '@bufbuild/protoc-gen-es/dist/cjs/src/protoc-gen-es-plugin.js';
import type { Plugin } from '@bufbuild/protoplugin';
import { BaselineUnavailableError, type DeployedBaselineSource, resolveBaseline } from './baseline';
import { BufIntegrityError, runBuf } from './buf';
import { type GrpcConfig, GrpcUsageError, loadConfig } from './config';
import { knextClientPlugin } from './plugin';
import { checkBudget } from './policy';

/** The record of what the last run wrote, inside the output directory. */
export const MANIFEST = '.knext-generated.json';

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
}

function buildImage(cwd: string, excludeImports: boolean): FileDescriptorProto[] {
  const args = ['build', ...(excludeImports ? ['--exclude-imports'] : []), '-o', '-#format=binpb'];
  const r = runBuf(args, { cwd });
  if (r.status !== 0) {
    throw new GrpcUsageError(`buf build failed:\n${r.stderr.trim()}`);
  }
  return fromBinary(FileDescriptorSetSchema, r.stdout).file;
}

/**
 * Generate every output file in memory: relative path -> contents, sorted by
 * path. Throws a {@link GrpcUsageError} on a bad contract or setting.
 */
export function generateFiles(
  cwd: string,
  config: GrpcConfig = loadConfig(cwd),
): Map<string, string> {
  const gatewayTimeoutMs = config.gatewayTimeoutSeconds * 1000;
  const budget = checkBudget(config.deadlineMs, gatewayTimeoutMs);
  if (budget) throw new GrpcUsageError(`knext.grpc.json: ${budget}`);

  const all = buildImage(cwd, false);
  const own = buildImage(cwd, true).map((f) => f.name ?? '');
  const runs: [Plugin, string][] = [
    [protocGenEs, 'target=ts'],
    [
      knextClientPlugin,
      `target=ts,deadline_ms=${config.deadlineMs},gateway_timeout_ms=${gatewayTimeoutMs}`,
    ],
  ];
  const files = new Map<string, string>();
  for (const [plugin, parameter] of runs) {
    const request = create(CodeGeneratorRequestSchema, {
      fileToGenerate: own,
      protoFile: all,
      parameter,
    });
    let response: ReturnType<Plugin['run']>;
    try {
      response = plugin.run(request);
    } catch (err) {
      throw new GrpcUsageError(`${plugin.name}: ${(err as Error).message}`);
    }
    if (response.error) throw new GrpcUsageError(`${plugin.name}: ${response.error}`);
    for (const file of response.file) files.set(file.name, file.content);
  }
  const paths = [...files.keys()].sort();
  files.set(
    MANIFEST,
    `${JSON.stringify({ generatedBy: 'knext generate', files: paths }, null, 2)}\n`,
  );
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

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
class ConfinedWriter {
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

  private refuse(path: string, why: string): GrpcUsageError {
    const where = path ? `${this.outName}/${path}` : this.outName;
    return new GrpcUsageError(
      `refusing to write ${where}: ${why}. Generated code is never written through a symlink; ` +
        'replace it with a real file or directory, then run `knext generate` again.',
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

export interface RunGenerateOptions {
  readonly cwd: string;
  readonly check?: boolean;
  /** A `buf breaking` baseline; see `resolveBaseline`. */
  readonly against?: string;
  readonly deployedBaseline?: DeployedBaselineSource;
  readonly io: Io;
}

/** The `knext generate` verb. Returns the process exit code. */
export async function runGenerate(opts: RunGenerateOptions): Promise<number> {
  const { cwd, io } = opts;
  try {
    const config = loadConfig(cwd);

    const lint = runBuf(['lint'], { cwd });
    if (lint.status !== 0) {
      io.stderr(`buf lint found problems:\n${lint.stdout.toString()}${lint.stderr}`);
      return 1;
    }

    if (opts.against !== undefined) {
      const input = await resolveBaseline(opts.against, opts.deployedBaseline);
      const breaking = runBuf(['breaking', '--against', input], { cwd });
      if (breaking.status !== 0) {
        io.stderr(
          `buf breaking found changes that break the contract against ${opts.against}:\n` +
            `${breaking.stdout.toString()}${breaking.stderr}`,
        );
        return 1;
      }
    }

    const expected = generateFiles(cwd, config);
    const outDir = join(cwd, config.out);
    const drift = diffOutput(expected, outDir);

    if (opts.check) {
      if (drift.length === 0) {
        io.stdout(`generated code in ${config.out} is up to date (${expected.size} files)\n`);
        return 0;
      }
      io.stderr(
        `generated code in ${config.out} is out of date:\n` +
          drift.map((d) => `  ${d.kind.padEnd(8)}${d.path}\n`).join('') +
          'Run `knext generate` and commit the result.\n',
      );
      return 1;
    }

    const writer = new ConfinedWriter(cwd, outDir, config.out);
    // Check every target first, so a refused one leaves the directory as it was.
    for (const d of drift) if (d.kind !== 'stale') writer.check(d.path);
    for (const d of drift) {
      const target = join(outDir, d.path);
      if (d.kind === 'stale') {
        // A lexically confined path can still land outside through a symlink:
        // delete only if its REAL path is inside the real output directory.
        if (realpathSync(target).startsWith(realpathSync(outDir) + sep)) unlinkSync(target);
      } else {
        writer.write(d.path, expected.get(d.path) as string);
      }
    }
    io.stdout(
      drift.length === 0
        ? `generated code in ${config.out} is already up to date\n`
        : `wrote ${config.out} (${drift.length} file${drift.length === 1 ? '' : 's'} changed)\n`,
    );
    return 0;
  } catch (err) {
    if (
      err instanceof GrpcUsageError ||
      err instanceof BaselineUnavailableError ||
      err instanceof BufIntegrityError
    ) {
      io.stderr(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
