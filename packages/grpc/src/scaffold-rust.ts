/**
 * The Rust function's server project, scaffolded from `templates/rust`.
 *
 * `knext add function <name> --lang rust` writes the contract (see
 * add-function.ts) and this: a copy of the Rust template at
 * `functions/<name>/`, with the template's `example` service renamed to the
 * function's name and its crate (package) renamed to the function.
 *
 * What is copied is DERIVED from the template directory, minus
 * {@link RUST_TEMPLATE_EXCLUDES}, so a file added to the template reaches every
 * new function unless someone adds it to the list on purpose. The list is
 * short, each entry says why, and a test pins its exact contents.
 *
 * `gen/` is not copied: it holds generated Rust for the `example` contract,
 * which cannot be renamed by editing text. It is generated from the function's
 * own proto with the template's pinned plugins (`codegen.sh` is the one place
 * their versions are written), in a staging directory, and moved in only when
 * generation succeeded, so a failed run writes nothing.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuf } from './buf';
import { GrpcUsageError } from './config';
import {
  isExcludedBy,
  resolveLangTemplateDir,
  type StagedFunction,
  stageProject,
  type TemplateExclude,
  walkFiles,
} from './scaffold-template';

/** Template paths that are deliberately not copied. Counted by a test. */
export const RUST_TEMPLATE_EXCLUDES: readonly TemplateExclude[] = [
  {
    path: '.gitignore',
    why: 'npm never packs a .gitignore, so the scaffold writes the same content itself (RUST_GITIGNORE)',
  },
  { path: '.codegen', why: 'plugin binaries installed by a local codegen.sh run (git-ignored)' },
  { path: 'README.md', why: 'maintainer documentation for the template, not for a function' },
  {
    path: 'conformance.sh',
    why: "runs the upstream Connect conformance suite against the template's own locked connect-rust",
  },
  {
    path: 'e2e/kind-e2e.sh',
    why: "the template's own kind harness, bound to its image and cluster",
  },
  { path: 'e2e/ksvc.yaml', why: "the template's own kind manifest, bound to its image" },
  { path: 'gen', why: 'generated from the function proto at scaffold time' },
  { path: 'proto', why: 'written from the function contract, not copied' },
  {
    path: 'src/auth/vector_tests.rs',
    why: 'signed against the example service and read from the knext repository',
  },
  {
    path: 'src/testvectors.rs',
    why: 'loads the shared vectors; only the test above and one wiring test use it',
  },
  { path: 'target', why: 'build output of a local cargo run (git-ignored)' },
];

/** The template's `.gitignore`, written by the scaffold; a test pins it to the template's own file. */
export const RUST_GITIGNORE = '.codegen/\ntarget/\n';

export function isExcluded(rel: string): boolean {
  return isExcludedBy(RUST_TEMPLATE_EXCLUDES, rel);
}

/** Which `templates/rust` a run scaffolds from (see {@link resolveLangTemplateDir}). */
export function resolveRustTemplateDir(
  moduleFile: string,
  exists: (path: string) => boolean = existsSync,
): string {
  return resolveLangTemplateDir('rust', 'Cargo.toml', moduleFile, exists);
}

export function rustTemplateDir(): string {
  return resolveRustTemplateDir(fileURLToPath(import.meta.url));
}

/** Every template file that is copied: all of them minus the exclude list. */
export function rustTemplateFiles(dir: string = rustTemplateDir()): string[] {
  return walkFiles(dir, RUST_TEMPLATE_EXCLUDES);
}

/** The relative paths the scaffold writes from the template (before gen/ and proto/). */
export function scaffoldedRustFromTemplate(): string[] {
  return rustTemplateFiles();
}

/** Crate names the toolchain owns, and Rust's keywords: none can name a crate or a proto package. */
const RESERVED_CRATES = new Set([
  'alloc',
  'core',
  'proc_macro',
  'std',
  'test',
  'self',
  'super',
  'crate',
  'as',
  'async',
  'await',
  'break',
  'const',
  'continue',
  'dyn',
  'else',
  'enum',
  'extern',
  'false',
  'fn',
  'for',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'match',
  'mod',
  'move',
  'mut',
  'pub',
  'ref',
  'return',
  'static',
  'struct',
  'trait',
  'true',
  'type',
  'unsafe',
  'use',
  'where',
  'while',
  'abstract',
  'become',
  'box',
  'do',
  'final',
  'macro',
  'override',
  'priv',
  'try',
  'typeof',
  'unsized',
  'virtual',
  'yield',
]);

const asCrateIdent = (name: string) => name.replaceAll('-', '_');

/** Names of every package in a Cargo.lock. */
export function lockedPackageNames(lock: string): string[] {
  return [...lock.matchAll(/^name = "([^"]+)"$/gm)].map((m) => m[1] as string);
}

/**
 * Why `name` cannot be the function's crate, or null. A crate named like one
 * of the template's dependencies would shadow it (the build fails with an
 * error about the dependency, not the name), so the dependency names come from
 * the template's own lockfile rather than a list that could go stale.
 */
export function checkCrateName(name: string, templateDir: string): string | null {
  const ident = asCrateIdent(name);
  if (RESERVED_CRATES.has(ident)) {
    return `"${name}" cannot name a Rust crate (it is a keyword or a name the toolchain owns); pick another function name`;
  }
  const lock = readFileSync(join(templateDir, 'Cargo.lock'), 'utf8');
  const taken = lockedPackageNames(lock).filter((n) => n !== 'function');
  if (taken.some((n) => asCrateIdent(n) === ident)) {
    return `"${name}" would shadow the Rust crate "${name}" that the function template depends on; pick another function name`;
  }
  return null;
}

export interface RustScaffold {
  readonly name: string;
  readonly pkg: string;
  readonly service: string;
  readonly contract: string;
  readonly options: string;
}

/** `UserProfileService` -> `USER_PROFILE_SERVICE`, as the connect-rust codegen names a service constant. */
export function upperSnake(pascal: string): string {
  return pascal
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();
}

/** The lines of Cargo.toml the scaffold rewrites, each present exactly once. */
const FEATURE_DEFAULT_ON = 'default = ["shared-vectors"]';
const FEATURE_DEFAULT_OFF = 'default = []';

function once(text: string, needle: string, file: string, expected: number): void {
  const n = text.split(needle).length - 1;
  if (n !== expected) {
    throw new Error(
      `the Rust template changed: expected ${expected} of "${needle}" in ${file}, found ${n}`,
    );
  }
}

/**
 * Cargo keeps `Cargo.lock` sorted by package name. Renaming the root package
 * in place leaves it out of order, and `--locked` refuses a lockfile it would
 * write differently, so the blocks are re-sorted after the rename.
 */
export function renameLockedPackage(lock: string, from: string, to: string): string {
  once(lock, `\nname = "${from}"\n`, 'Cargo.lock', 1);
  const [head, ...blocks] = lock.split('\n[[package]]\n') as [string, ...string[]];
  const renamed = blocks.map((b) =>
    b.startsWith(`name = "${from}"\n`)
      ? `name = "${to}"\n${b.slice(`name = "${from}"\n`.length)}`
      : b,
  );
  const key = (b: string) => [
    b.match(/^name = "([^"]+)"$/m)?.[1] ?? '',
    b.match(/^version = "([^"]+)"$/m)?.[1] ?? '',
  ];
  renamed.sort((a, b) => {
    const [an, av] = key(a) as [string, string];
    const [bn, bv] = key(b) as [string, string];
    if (an !== bn) return an < bn ? -1 : 1;
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
  return head + renamed.map((b) => `\n[[package]]\n${b}`).join('');
}

/** Rename the template's `example` service, crate and proto package in one pass (no cascading rewrites). */
export function substituteRust(rel: string, text: string, s: RustScaffold): string {
  let out = text;
  if (rel === 'Cargo.toml') {
    // The package and its bin target both carry the template's crate name.
    once(out, 'name = "function"', rel, 2);
    out = out.replaceAll('name = "function"', `name = "${s.name}"`);
    once(out, FEATURE_DEFAULT_ON, rel, 1);
    return out.replace(FEATURE_DEFAULT_ON, FEATURE_DEFAULT_OFF);
  }
  if (rel === 'Cargo.lock') return renameLockedPackage(out, 'function', s.name);
  if (rel === 'Dockerfile') {
    once(out, '--bin function', rel, 1);
    once(out, 'target/release/function ', rel, 1);
    return out
      .replace('--bin function', `--bin ${s.name}`)
      .replace('target/release/function ', `target/release/${s.name} `);
  }
  const map: Record<string, string> = {
    EXAMPLE_SERVICE_SERVICE_NAME: `${upperSnake(s.service)}_SERVICE_NAME`,
    ExampleService: s.service,
    'example.v1': `${s.pkg}.v1`,
    'example::v1': `${s.pkg}::v1`,
    'example/v1': `${s.pkg}/v1`,
    'example.proto': `${s.pkg}.proto`,
    'function::': `${s.pkg}::`,
  };
  const re = new RegExp(
    Object.keys(map)
      .sort((a, b) => b.length - a.length)
      .map((k) => k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
      .join('|'),
    'g',
  );
  return out.replace(re, (m) => map[m] as string);
}

/** Where the generation plugins are installed, shared by every function on this machine. */
export function codegenCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.KNEXT_RUST_CODEGEN_DIR ??
    join(env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'knext', 'rust-codegen')
  );
}

/**
 * Generate the staged project's Rust code: install the template's pinned
 * plugins (`codegen.sh`, the one place their versions live) into a cache shared
 * by every function, then run knext's own verified buf over the project. The
 * first run on a machine compiles the plugins with cargo; later runs are
 * offline.
 */
function generateWithBuf(stage: string): void {
  const cargo = spawnSync('cargo', ['--version'], { cwd: stage });
  if (cargo.status !== 0) {
    throw new GrpcUsageError(
      "the Rust toolchain (`cargo`, at the version in the function's rust-toolchain.toml) is needed to generate the function's code and was not usable; install it with rustup; nothing was changed",
    );
  }
  const cache = codegenCacheDir();
  const install = spawnSync('bash', ['codegen.sh'], {
    cwd: stage,
    env: { ...process.env, CODEGEN_ROOT: cache, CODEGEN_INSTALL_ONLY: '1' },
    encoding: 'utf8',
  });
  if (install.status !== 0) {
    throw new GrpcUsageError(
      `installing the Rust code generators failed; nothing was changed:\n${install.stderr ?? install.error?.message ?? ''}`,
    );
  }
  // buf.gen.yaml names the plugins as `.codegen/bin/...`; point that at the cache for this run only.
  const link = join(stage, '.codegen');
  symlinkSync(cache, link, 'dir');
  try {
    const gen = runBuf(['generate'], { cwd: stage });
    if (gen.status !== 0) {
      throw new GrpcUsageError(
        `generating the function's Rust code failed; nothing was changed:\n${gen.stderr}`,
      );
    }
  } finally {
    rmSync(link, { force: true });
  }
}

export type StagedRustFunction = StagedFunction;

/**
 * Build the Rust function project in a staging directory and generate its
 * Rust code. Nothing outside the staging directory is touched; the caller
 * installs it last, after every other write has succeeded.
 */
export function stageRustFunction(
  s: RustScaffold,
  templateDir?: string,
  generate?: (stageDir: string) => void,
): StagedRustFunction {
  const template = templateDir ?? rustTemplateDir();
  return stageProject({
    prefix: 'knext-rust-function-',
    pkg: s.pkg,
    contract: s.contract,
    options: s.options,
    template,
    files: rustTemplateFiles(template),
    transform: (rel, text) => substituteRust(rel, text, s),
    extraFiles: { '.gitignore': RUST_GITIGNORE },
    generate: generate ?? generateWithBuf,
  });
}
