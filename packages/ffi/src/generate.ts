/**
 * `knext ffi generate` and `knext ffi check` (ADR-0069 D12, D13).
 *
 * 1. Read `knext.ffi.json`.
 * 2. `cargo build --release` the crate for this host (cargo.ts).
 * 3. Scan the built library's bytes for its manifest (manifest.ts) — the
 *    wrapper is derived from the library, never from the Rust source.
 * 4. Render `<out>/index.ts` (render.ts) and the ownership record
 *    `.knext-generated.json`, then write them, or with `check` compare and
 *    fail on any drift. Ownership rules match `knext generate` (output.ts).
 */

import { existsSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { hostBuild } from './cargo';
import { type FfiConfig, FfiUsageError, loadConfig } from './config';
import { ManifestError, scanManifest } from './manifest';
import { ConfinedWriter, diffOutput, MANIFEST } from './output';
import { libNameOf, renderModule } from './render';

export { MANIFEST } from './output';

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface GenerateDeps {
  /** Build the crate for this host and return the library path (default: cargo). */
  readonly buildLibrary?: (crateDir: string) => string;
}

/**
 * Every output file in memory: relative path -> contents. Pure apart from
 * reading the library file.
 */
export function generateFiles(libraryPath: string, config: FfiConfig): Map<string, string> {
  const libName = libNameOf(basename(libraryPath));
  if (libName === undefined) {
    throw new FfiUsageError(
      `the built library ${basename(libraryPath)} is not a lib<name>.so or lib<name>.dylib`,
    );
  }
  const manifest = scanManifest(readFileSync(libraryPath));
  return new Map([
    [
      MANIFEST,
      `${JSON.stringify({ generatedBy: 'knext ffi generate', files: ['index.ts'] }, null, 2)}\n`,
    ],
    ['index.ts', renderModule(manifest, { libName, crate: config.crate })],
  ]);
}

export interface RunGenerateOptions {
  readonly cwd: string;
  readonly check?: boolean;
  readonly io: Io;
  readonly deps?: GenerateDeps;
}

/** The `generate` / `check` verbs. Returns the process exit code. */
export async function runGenerate(opts: RunGenerateOptions): Promise<number> {
  const { cwd, io } = opts;
  try {
    const config = loadConfig(cwd);
    const crateDir = join(cwd, config.crate);
    if (!existsSync(join(crateDir, 'Cargo.toml'))) {
      throw new FfiUsageError(
        `no Rust crate at ${config.crate}/Cargo.toml (knext.ffi.json "crate"). Run \`knext ffi init\` to create one.`,
      );
    }
    const library = (opts.deps?.buildLibrary ?? hostBuild)(crateDir);
    const expected = generateFiles(library, config);
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
          'Run `knext ffi generate` and commit the result.\n',
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
    if (err instanceof FfiUsageError || err instanceof ManifestError) {
      io.stderr(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
