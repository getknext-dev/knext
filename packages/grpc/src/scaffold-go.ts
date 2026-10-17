/**
 * The Go function's server project, scaffolded from `templates/go`.
 *
 * `knext add function <name> --lang go` writes the contract (see
 * add-function.ts) and this: a copy of the Go template at
 * `functions/<name>/`, with the template's `example` service renamed to the
 * function's name and its module path replaced.
 *
 * What is copied is DERIVED from the template directory, minus
 * {@link GO_TEMPLATE_EXCLUDES}, so a file added to the template reaches every
 * new function unless someone adds it to the list on purpose. The list is
 * short, each entry says why, and a test pins its exact contents.
 *
 * `gen/` is not copied: it holds protobuf descriptors for the `example`
 * contract, which cannot be renamed by editing text. It is generated from the
 * function's own proto with the pinned buf, in a staging directory, and moved
 * in only when generation succeeded, so a failed run writes nothing.
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBuf } from './buf';
import { GrpcUsageError } from './config';

export interface TemplateExclude {
  /** A file, or a directory (everything under it), relative to the template root. */
  readonly path: string;
  readonly why: string;
}

/** Template paths that are deliberately not copied. Counted by a test. */
export const GO_TEMPLATE_EXCLUDES: readonly TemplateExclude[] = [
  { path: 'README.md', why: 'maintainer documentation for the template, not for a function' },
  { path: 'e2e', why: "the template's own kind harness, bound to its image and example service" },
  { path: 'gen', why: 'generated from the function proto at scaffold time' },
  {
    path: 'internal/auth/verifier_test.go',
    why: 'signed against the example service and read from the knext repository',
  },
  {
    path: 'internal/rpc/rpc_vectors_test.go',
    why: 'signed against the example service and read from the knext repository',
  },
  {
    path: 'internal/testvectors',
    why: 'loads the shared vectors; only the two tests above use it',
  },
  { path: 'proto', why: 'written from the function contract, not copied' },
];

export function isExcluded(rel: string): boolean {
  return GO_TEMPLATE_EXCLUDES.some((e) => rel === e.path || rel.startsWith(`${e.path}/`));
}

/** The template: packaged beside `dist/` in the tarball, else the repository's. */
export function goTemplateDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const root of [resolve(here, '..'), resolve(here, '..', '..', '..')]) {
    const dir = join(root, 'templates', 'go');
    if (existsSync(join(dir, 'go.mod'))) return dir;
  }
  throw new Error('the Go function template (templates/go) is not available in this install');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  const rec = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) rec(p);
      else out.push(relative(dir, p).split('\\').join('/'));
    }
  };
  rec(dir);
  return out;
}

/** Every template file that is copied: all of them minus the exclude list. */
export function goTemplateFiles(): string[] {
  return walk(goTemplateDir()).filter((f) => !isExcluded(f));
}

/** The relative paths the scaffold writes from the template (before gen/ and proto/). */
export function scaffoldedFromTemplate(): string[] {
  return goTemplateFiles();
}

const MODULE_PATH = /^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/;

export function checkModulePath(module: string): string | null {
  return MODULE_PATH.test(module)
    ? null
    : `--module "${module}" is not a Go module path (letters, digits, . _ ~ - and / only)`;
}

export interface GoScaffold {
  readonly name: string;
  readonly pkg: string;
  readonly service: string;
  readonly module: string;
  readonly contract: string;
  readonly options: string;
}

/** Rename the template's `example` service and module in one pass (no cascading rewrites). */
export function substitute(text: string, s: GoScaffold): string {
  const map: Record<string, string> = {
    'example.com/function': s.module,
    examplev1connect: `${s.pkg}v1connect`,
    examplev1: `${s.pkg}v1`,
    ExampleService: s.service,
    'example.v1': `${s.pkg}.v1`,
    'example/v1': `${s.pkg}/v1`,
    'example.proto': `${s.pkg}.proto`,
  };
  const re = new RegExp(
    Object.keys(map)
      .sort((a, b) => b.length - a.length)
      .map((k) => k.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
      .join('|'),
    'g',
  );
  return text.replace(re, (m) => map[m] as string);
}

/**
 * Build the function project in a staging directory, generate its Go code, and
 * move it to `target`. Returns the relative paths written under `target`.
 */
export function scaffoldGoFunction(target: string, s: GoScaffold): string[] {
  const template = goTemplateDir();
  const stage = mkdtempSync(join(tmpdir(), 'knext-go-function-'));
  try {
    for (const rel of goTemplateFiles()) {
      const dest = join(stage, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, substitute(readFileSync(join(template, rel), 'utf8'), s));
    }
    const protoDir = join(stage, 'proto');
    mkdirSync(join(protoDir, s.pkg, 'v1'), { recursive: true });
    mkdirSync(join(protoDir, 'knext', 'v1'), { recursive: true });
    writeFileSync(join(protoDir, s.pkg, 'v1', `${s.pkg}.proto`), s.contract);
    writeFileSync(join(protoDir, 'knext', 'v1', 'options.proto'), s.options);

    const go = spawnSync('go', ['version']);
    if (go.status !== 0) {
      throw new GrpcUsageError(
        "the Go toolchain (`go`) is needed to generate the function's code and was not found on PATH; nothing was changed",
      );
    }
    const gen = runBuf(['generate'], { cwd: stage });
    if (gen.status !== 0) {
      throw new GrpcUsageError(
        `generating the function's Go code failed; nothing was changed:\n${gen.stderr}`,
      );
    }
    mkdirSync(dirname(target), { recursive: true });
    cpSync(stage, target, { recursive: true });
    return walk(target);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
