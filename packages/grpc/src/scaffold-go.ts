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
import { existsSync } from 'node:fs';
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

export type { TemplateExclude };

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
  return isExcludedBy(GO_TEMPLATE_EXCLUDES, rel);
}

/** Which `templates/go` a run scaffolds from (see {@link resolveLangTemplateDir}). */
export function resolveTemplateDir(
  moduleFile: string,
  exists: (path: string) => boolean = existsSync,
): string {
  return resolveLangTemplateDir('go', 'go.mod', moduleFile, exists);
}

export function goTemplateDir(): string {
  return resolveTemplateDir(fileURLToPath(import.meta.url));
}

/** Every template file that is copied: all of them minus the exclude list. */
export function goTemplateFiles(dir: string = goTemplateDir()): string[] {
  return walkFiles(dir, GO_TEMPLATE_EXCLUDES);
}

/** The relative paths the scaffold writes from the template (before gen/ and proto/). */
export function scaffoldedFromTemplate(): string[] {
  return goTemplateFiles();
}

const MODULE_PATH = /^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/;

export function checkModulePath(module: string): string | null {
  if (!MODULE_PATH.test(module)) {
    return `--module "${module}" is not a Go module path (letters, digits, . _ ~ - and / only)`;
  }
  if (module.split('/').some((el) => el === '.' || el === '..')) {
    return `--module "${module}" is not a Go module path ("." and ".." are not allowed as path elements)`;
  }
  return null;
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
 * `buf generate` over the staged project. The plugins are Go tools pinned in
 * its go.mod, so the first run on a machine downloads (and compiles) them into
 * the Go module cache; later runs are offline.
 */
function generateWithBuf(stage: string): void {
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
}

export type StagedGoFunction = StagedFunction;

/**
 * Build the Go function project in a staging directory and generate its Go
 * code. Nothing outside the staging directory is touched; the caller installs
 * it last, after every other write has succeeded.
 */
export function stageGoFunction(
  s: GoScaffold,
  templateDir?: string,
  generate?: (stageDir: string) => void,
): StagedGoFunction {
  const template = templateDir ?? goTemplateDir();
  return stageProject({
    prefix: 'knext-go-function-',
    pkg: s.pkg,
    contract: s.contract,
    options: s.options,
    template,
    files: goTemplateFiles(template),
    transform: (_rel, text) => substitute(text, s),
    generate: generate ?? generateWithBuf,
  });
}
