/**
 * The verbs `@getknext/ffi` adds to the `knext` CLI: `knext ffi init`,
 * `generate`, `check` and `build` (ADR-0069 D12).
 *
 * Core (`@getknext/core`) owns the `knext` bin and lazily loads this module only
 * when `knext ffi` is typed; it never imports it eagerly and does not depend on
 * it. Before calling {@link run}, core checks {@link DISPATCH_PROTOCOL} and that
 * its own version is inside {@link CORE_PEER_RANGE}, and names both versions if
 * not.
 */

import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { type GenerateDeps, type Io, runGenerate } from './generate';
import { runInit } from './init';

/** The shape of this module as core calls it. Bumped only on a breaking change to it. */
export const DISPATCH_PROTOCOL = 1;

const manifest = createRequire(import.meta.url)('../package.json') as {
  version: string;
  peerDependencies: Record<string, string>;
};

export const FFI_VERSION: string = manifest.version;
/** The `@getknext/core` versions this package works with (its peer range). */
export const CORE_PEER_RANGE: string = manifest.peerDependencies['@getknext/core'] as string;

export const VERBS = ['ffi'] as const;
export const SUBCOMMANDS = ['init', 'generate', 'check', 'build'] as const;
type Sub = (typeof SUBCOMMANDS)[number];

/** Printed once on every run (D2, D12): the Beta label and why. */
export const BETA_NOTICE =
  'knext ffi: in-process Rust is Beta — it calls Rust through bun:ffi, which Bun marks experimental, and runs only on Bun.';

const USAGE = 'Usage: knext ffi <init|generate|check|build> [options]';

const GROUP_HELP = `knext ffi — in-process Rust for this zone (Beta, Bun only, optional package)

${USAGE}

Call Rust functions from a Server Action or route handler in the same process,
through bun:ffi, with a typed server-only wrapper generated from the library.
Runs only on the Bun runtime; for Node, or for work that should scale or fail
on its own, use a zone function instead (knext add function).

Commands:
  knext ffi init       write knext.ffi.json and a starter rust/ crate
  knext ffi generate   build the crate for this machine and write the typed wrapper
  knext ffi check      the same, but fail if the committed wrapper is out of date
  knext ffi build      cross-build the library for the image (run by knext build)

Run \`knext ffi <command> --help\` for a command's options.`;

const HELP: Record<Sub, string> = {
  init: `knext ffi init — opt this zone into in-process Rust (Beta)

Usage: knext ffi init

Writes knext.ffi.json and a rust/ crate (Cargo.toml, src/lib.rs with a
\`greet\` function, rust-toolchain.toml). Refuses to overwrite either.

Options:
  -h, --help   show this help

Exit code: 0 on success; 1 if knext.ffi.json or rust/ already exists.`,
  generate: `knext ffi generate — write the typed wrapper for this zone's Rust functions (Beta)

Usage: knext ffi generate

Builds the crate named in knext.ffi.json for this machine (cargo build
--release), reads the functions the library exports, and writes a typed,
server-only TypeScript module to the configured output directory. Commit it.
Needs Rust (https://rustup.rs).

Options:
  -h, --help   show this help

Exit code: 0 on success; 1 on a build failure or a usage error.`,
  check: `knext ffi check — fail if the committed wrapper is out of date (Beta)

Usage: knext ffi check

The same as \`knext ffi generate\`, but compares instead of writing. Run it in
CI. Needs Rust (https://rustup.rs).

Options:
  -h, --help   show this help

Exit code: 0 when up to date; 1 when the wrapper is out of date, on a build
failure, or on a usage error.`,
  build: `knext ffi build — cross-build the library for the image (Beta)

Usage: knext ffi build --target <triple>... --native-dir <dir>

Run by \`knext build\` when knext.ffi.json exists; not usually run by hand.

Options:
  -h, --help   show this help`,
};

/** Help for `sub` (`''` or anything unknown: the group help). */
export function helpText(sub: string): string {
  return (SUBCOMMANDS as readonly string[]).includes(sub) ? HELP[sub as Sub] : GROUP_HELP;
}

/** What `knext ffi build` is, once `./build` exists. */
export interface BuildModule {
  runBuild(opts: { cwd: string; argv: readonly string[]; io: Io }): Promise<number>;
}

export interface RunIo extends Io, GenerateDeps {
  readonly cwd?: string;
  /** Override the recorded knext-ffi revision (`init`). */
  readonly crateRev?: string | null;
  /** Load the `build` module (default: `./build`, resolved at run time). */
  readonly loadBuild?: () => Promise<BuildModule>;
}

const defaultIo: Io = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

const isNotFound = (err: unknown) => {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND';
};

/**
 * `knext ffi build` lives in its own module (another change owns it), loaded
 * when the verb runs. The specifier is a variable so this file compiles and
 * bundles before that module exists.
 */
async function defaultLoadBuild(): Promise<BuildModule> {
  const specifier = './build.js';
  return (await import(/* webpackIgnore: true */ specifier)) as BuildModule;
}

/** Run a verb. Returns the process exit code; never calls `process.exit`. */
export async function run(
  verb: string,
  argv: readonly string[],
  io: Partial<RunIo> = {},
): Promise<number> {
  const out: Io = { stdout: io.stdout ?? defaultIo.stdout, stderr: io.stderr ?? defaultIo.stderr };
  const cwd = io.cwd ?? process.cwd();

  if (verb !== 'ffi') {
    out.stderr(`@getknext/ffi does not provide the "${verb}" command\n`);
    return 1;
  }
  const [sub, ...rest] = argv;
  const wantsHelp = argv.includes('--help') || argv.includes('-h');
  if (sub === undefined || sub.startsWith('-')) {
    if (wantsHelp) {
      out.stdout(`${GROUP_HELP}\n`);
      return 0;
    }
    out.stderr(`${USAGE}\nRun \`knext ffi --help\` for the commands.\n`);
    return 1;
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    out.stderr(`knext ffi: unknown subcommand "${sub}"\n${USAGE}\n`);
    return 1;
  }
  if (wantsHelp) {
    out.stdout(`${helpText(sub)}\n`);
    return 0;
  }

  out.stderr(`${BETA_NOTICE}\n`);
  try {
    if (sub === 'build') {
      let mod: BuildModule;
      try {
        mod = await (io.loadBuild ?? defaultLoadBuild)();
      } catch (err) {
        if (!isNotFound(err)) throw err;
        out.stderr('`knext ffi build` is not available in this version of @getknext/ffi.\n');
        return 1;
      }
      return await mod.runBuild({ cwd, argv: rest, io: out });
    }
    try {
      parseArgs({ args: [...rest], options: {}, allowPositionals: false, strict: true });
    } catch (err) {
      out.stderr(
        `knext ffi ${sub}: ${(err as Error).message}\nRun \`knext ffi ${sub} --help\` for usage.\n`,
      );
      return 1;
    }
    if (sub === 'init') {
      return runInit({
        cwd,
        io: out,
        ...('crateRev' in io ? { crateRev: io.crateRev ?? null } : {}),
      });
    }
    return await runGenerate({
      cwd,
      check: sub === 'check',
      io: out,
      deps: io.buildLibrary ? { buildLibrary: io.buildLibrary } : {},
    });
  } catch (err) {
    out.stderr(`knext ffi ${sub} failed: ${(err as Error)?.message ?? String(err)}\n`);
    return 1;
  }
}
