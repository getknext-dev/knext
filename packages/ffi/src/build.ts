/**
 * `knext ffi build --target <triple>… --native-dir <dir>` (ADR-0069 D14).
 *
 * Run by `knext build` / `knext deploy` / `knext preview` (through core's
 * `ffi-dispatch.ts`) before the project build, when `knext.ffi.json` exists:
 *
 * 1. Check the toolchain: `cargo`, the rustup target. A missing one is a usage
 *    error naming its install command. Then the supply-chain gates (D16,
 *    supply-chain.ts): the git-source rule, the four pinned cargo tools, the
 *    pinned zig, and `cargo deny check`.
 * 2. `cargo auditable zigbuild --release --locked --target <triple>` in the
 *    crate, with `-C target-feature=-crt-static` (a cdylib against the musl
 *    the image has, not a static libc), linking with the verified zig.
 * 3. The libc check (elf.ts): only musl/libgcc `DT_NEEDED` entries; the
 *    library must carry cargo-auditable's crate list; `cargo cyclonedx`
 *    writes the target's SBOM.
 * 4. Stage `<native>/ffi/<triple>/lib<name>.so` + `provenance.json` +
 *    `sbom.cdx.json`, clearing
 *    only `<native>/ffi/` (sharp's staging beside it is never touched). The
 *    integrity manifest over the whole `native/` tree is core's, written after
 *    the compile.
 * 5. Drift check: the committed wrapper must be what `knext ffi generate`
 *    renders from the STAGED library, so the wrapper in the image is always
 *    the one generated from the library in the image.
 *
 * Every program runs through an injected {@link Runner}, so tests need no Rust.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pickCdylib } from './cargo';
import { FfiUsageError, loadConfig } from './config';
import { assertMuslLibrary, ElfError } from './elf';
import type { Io } from './generate';
import { generateFiles } from './generate';
import { ManifestError } from './manifest';
import { diffOutput } from './output';
import { libNameOf } from './render';
import { prepareSupplyChain, SBOM_FILE, type SupplyChain, type ZigDeps } from './supply-chain';

/** The image targets (D14 build matrix): musl x64 and arm64. */
export const SUPPORTED_TARGETS = [
  'x86_64-unknown-linux-musl',
  'aarch64-unknown-linux-musl',
] as const;

export const PROVENANCE_FILE = 'provenance.json';

/** One program run. `error` is set when it could not be started (ENOENT). */
export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  /** Only when the run asked for `captureStderr` (cargo-deny's JSON goes there). */
  readonly stderr?: string;
  readonly error?: NodeJS.ErrnoException | Error;
}

export type Runner = (
  cmd: string,
  args: readonly string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; captureStderr?: boolean },
) => RunResult;

export interface BuildDeps {
  readonly run?: Runner;
  /** The environment tools are found in and run with (default: `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
  /** zig's download (D16): fetch, cache directory and host, for tests. */
  readonly zig?: ZigDeps;
}

/** Cargo's diagnostics go to the user's terminal; stdout is captured. */
const spawnRunner: Runner = (cmd, args, opts) => {
  const r = spawnSync(cmd, [...args], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', opts.captureStderr ? 'pipe' : 'inherit'],
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    ...(opts.captureStderr ? { stderr: r.stderr ?? '' } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
};

const RUSTUP = 'https://rustup.rs';
const notStarted = (r: RunResult) => r.error !== undefined;
const firstLine = (s: string) => s.split('\n')[0]?.trim() ?? '';

/**
 * D14 step 2's preflight: cargo, rustup and the targets. cargo-zigbuild and
 * zig are pinned, and checked with the other supply-chain tools (D16,
 * supply-chain.ts). Returns `rustc -V` for provenance.
 */
function checkToolchain(
  run: Runner,
  crateDir: string,
  targets: readonly string[],
): { rustc: string } {
  const cargo = run('cargo', ['--version'], { cwd: crateDir });
  if (notStarted(cargo) || cargo.status !== 0) {
    throw new FfiUsageError(
      `cargo was not found on PATH. Install Rust from ${RUSTUP} (the crate's rust-toolchain.toml selects the version), then run this again.`,
    );
  }
  const installed = run('rustup', ['target', 'list', '--installed'], { cwd: crateDir });
  if (notStarted(installed) || installed.status !== 0) {
    throw new FfiUsageError(
      `rustup was not found on PATH; it installs the musl targets. Install Rust from ${RUSTUP}, then run this again.`,
    );
  }
  const have = new Set(installed.stdout.split('\n').map((l) => l.trim()));
  const missing = targets.filter((t) => !have.has(t));
  if (missing.length > 0) {
    throw new FfiUsageError(
      `the Rust target ${missing.join(', ')} is not installed for this crate's toolchain. Install it with: rustup target add ${missing.join(' ')}`,
    );
  }
  const rustc = run('rustc', ['-V'], { cwd: crateDir });
  return { rustc: rustc.status === 0 ? firstLine(rustc.stdout) : 'unknown' };
}

/** `[package]` name and version from Cargo.toml (null when inherited from a workspace). */
function crateIdentity(cargoToml: string): { name: string | null; version: string | null } {
  const found: { name: string | null; version: string | null } = { name: null, version: null };
  let inPackage = false;
  for (const raw of readFileSync(cargoToml, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inPackage = line === '[package]';
      continue;
    }
    const m = inPackage ? /^(name|version)\s*=\s*"([^"]*)"/.exec(line) : null;
    if (m) found[m[1] as 'name' | 'version'] = m[2] as string;
  }
  return found;
}

/** The commit of the `knext-ffi` git dependency Cargo.lock resolved (D3), or null. */
export function knextFfiRev(cargoLock: string): string | null {
  for (const block of cargoLock.split(/^\[\[package\]\]\s*$/m)) {
    if (!/^name\s*=\s*"knext-ffi"\s*$/m.test(block)) continue;
    const source = /^source\s*=\s*"([^"]*)"/m.exec(block)?.[1];
    const hash = source?.split('#')[1];
    if (hash) return hash;
  }
  return null;
}

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

interface Built {
  readonly triple: string;
  readonly library: string;
  readonly fileName: string;
  readonly bytes: Buffer;
  /** CycloneDX SBOM of the crate graph for this target (D16). */
  readonly sbom: Buffer;
}

function parseBuildArgs(argv: readonly string[]): { targets: string[]; nativeDir: string } {
  let values: { target?: string[]; 'native-dir'?: string };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { target: { type: 'string', multiple: true }, 'native-dir': { type: 'string' } },
      allowPositionals: false,
      strict: true,
    }));
  } catch (err) {
    throw new FfiUsageError(`${(err as Error).message}`);
  }
  const targets = [...new Set(values.target ?? [])];
  if (targets.length === 0) {
    throw new FfiUsageError(`--target is required (one of: ${SUPPORTED_TARGETS.join(', ')})`);
  }
  for (const t of targets) {
    if (!(SUPPORTED_TARGETS as readonly string[]).includes(t)) {
      throw new FfiUsageError(
        `unsupported target "${t}": the image runs musl Linux, so the target is one of ${SUPPORTED_TARGETS.join(', ')}`,
      );
    }
  }
  const nativeDir = values['native-dir'];
  if (!nativeDir) throw new FfiUsageError('--native-dir is required (the app’s native/ directory)');
  return { targets, nativeDir };
}

export interface RunBuildOptions {
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly io: Io;
  readonly deps?: BuildDeps;
}

/** The `build` verb. Returns the process exit code. */
export async function runBuild(opts: RunBuildOptions): Promise<number> {
  const { cwd, io } = opts;
  const run = opts.deps?.run ?? spawnRunner;
  // Holds this build's private zig (when downloaded) until the build is over.
  let supply: SupplyChain | undefined;
  try {
    const { targets, nativeDir: nativeArg } = parseBuildArgs(opts.argv);
    const config = loadConfig(cwd);
    const crateDir = join(cwd, config.crate);
    const cargoToml = join(crateDir, 'Cargo.toml');
    if (!existsSync(cargoToml)) {
      throw new FfiUsageError(
        `no Rust crate at ${config.crate}/Cargo.toml (knext.ffi.json "crate"). Run \`knext ffi init\` to create one.`,
      );
    }
    const lockPath = join(crateDir, 'Cargo.lock');
    if (!existsSync(lockPath)) {
      throw new FfiUsageError(
        `no ${config.crate}/Cargo.lock: the image build is --locked, so the lockfile must be committed. Run \`cargo generate-lockfile\` in ${config.crate}/ and commit it.`,
      );
    }
    const tools = checkToolchain(run, crateDir, targets);
    const baseEnv = opts.deps?.env ?? process.env;
    const lock = readFileSync(lockPath);
    const identity = crateIdentity(cargoToml);
    // D16: pinned tools, git sources and `cargo deny check`, before any build.
    supply = await prepareSupplyChain({
      run,
      crateDir,
      crateLabel: config.crate,
      cargoLock: lock.toString('utf8'),
      crateName: identity.name,
      env: baseEnv,
      note: io.stderr,
      ...(opts.deps?.zig ? { zig: opts.deps.zig } : {}),
    });

    // Steps 2–3 for every target before anything is staged: a failure leaves
    // native/ exactly as it was.
    const env = {
      ...baseEnv,
      ...supply.env,
      RUSTFLAGS: [baseEnv.RUSTFLAGS, '-C target-feature=-crt-static'].filter(Boolean).join(' '),
    };
    const built: Built[] = [];
    for (const triple of targets) {
      const r = run(
        'cargo',
        [
          ...supply.cargoPrefix,
          '--release',
          '--locked',
          '--target',
          triple,
          '--message-format=json-render-diagnostics',
        ],
        { cwd: crateDir, env },
      );
      if (notStarted(r) || r.status !== 0) {
        throw new FfiUsageError(
          `cargo zigbuild failed for ${triple} (exit ${r.status ?? 'not started'}); see its errors above.`,
        );
      }
      const library = pickCdylib(r.stdout, cargoToml);
      const fileName = basename(library);
      if (!fileName.endsWith('.so') || libNameOf(fileName) === undefined) {
        throw new FfiUsageError(`the cross-built library ${fileName} is not a lib<name>.so`);
      }
      const bytes = readFileSync(library);
      assertMuslLibrary(bytes, triple, `${fileName} (${triple})`);
      supply.verifyLibrary(bytes, `${fileName} (${triple})`);
      built.push({ triple, library, fileName, bytes, sbom: supply.sbom(triple, env) });
    }

    // Step 4: stage, clearing only <native>/ffi/.
    const native = resolve(cwd, nativeArg);
    const ffiDir = join(native, 'ffi');
    rmSync(ffiDir, { recursive: true, force: true });
    const rev = knextFfiRev(lock.toString('utf8'));
    const staged: string[] = [];
    for (const b of built) {
      const dir = join(ffiDir, b.triple);
      mkdirSync(dir, { recursive: true });
      const target = join(dir, b.fileName);
      copyFileSync(b.library, target);
      writeFileSync(join(dir, SBOM_FILE), b.sbom);
      const provenance = {
        version: 1,
        crate: identity,
        cargoLockSha256: sha256(lock),
        rustc: tools.rustc,
        zigbuild: supply.zigbuildVersion,
        target: b.triple,
        profile: 'release',
        knextFfiRev: rev,
        library: { file: b.fileName, sha256: sha256(b.bytes) },
        ...supply.provenance,
        sbom: { file: SBOM_FILE, sha256: sha256(b.sbom) },
      };
      writeFileSync(join(dir, PROVENANCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`);
      staged.push(target);
    }

    // Step 5: the committed wrapper must be the one rendered from the staged
    // library. On drift, unstage: a stale tree must not be shipped by a later
    // build that skips this step.
    const outDir = join(cwd, config.out);
    for (const lib of staged) {
      const drift = diffOutput(generateFiles(lib, config), outDir);
      if (drift.length > 0) {
        rmSync(ffiDir, { recursive: true, force: true });
        io.stderr(
          `the generated wrapper in ${config.out} does not match the library built for the image:\n` +
            drift.map((d) => `  ${d.kind.padEnd(8)}${d.path}\n`).join('') +
            'run `knext ffi generate` and commit the result, then build again.\n',
        );
        return 1;
      }
    }
    for (const b of built) {
      io.stdout(
        `staged native/ffi/${b.triple}/${b.fileName} (sha256 ${sha256(b.bytes).slice(0, 12)}…)\n`,
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof FfiUsageError || err instanceof ManifestError || err instanceof ElfError) {
      io.stderr(`knext ffi build: ${err.message}\n`);
      return 1;
    }
    throw err;
  } finally {
    supply?.dispose();
  }
}
