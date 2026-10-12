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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
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
    if (!expected.has(path) && existsSync(join(outDir, path))) drift.push({ path, kind: 'stale' });
  }
  return drift;
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

    for (const d of drift) {
      const target = join(outDir, d.path);
      if (d.kind === 'stale') {
        // A lexically confined path can still land outside through a symlink:
        // delete only if its REAL path is inside the real output directory.
        if (realpathSync(target).startsWith(realpathSync(outDir) + sep)) unlinkSync(target);
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, expected.get(d.path) as string);
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
