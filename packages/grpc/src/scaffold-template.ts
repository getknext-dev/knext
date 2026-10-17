/**
 * What `knext add function` does the same way for every language: which
 * template directory a run scaffolds from, which of its files are copied, and
 * how the project is built in a staging directory before anything in the app
 * is touched. The per-language modules (scaffold-go.ts, scaffold-rust.ts) say
 * what is excluded, how text is renamed, and how the code is generated.
 */

import {
  chmodSync,
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

export interface TemplateExclude {
  /** A file, or a directory (everything under it), relative to the template root. */
  readonly path: string;
  readonly why: string;
}

export function isExcludedBy(excludes: readonly TemplateExclude[], rel: string): boolean {
  return excludes.some((e) => rel === e.path || rel.startsWith(`${e.path}/`));
}

/**
 * Which `templates/<lang>` a run scaffolds from, by an explicit rule rather
 * than "whichever exists". Run from source (a `.ts` module: tests, the in-repo
 * CLI), the repository's template is the truth, and the gitignored package copy
 * `build` leaves behind is stale by construction. Run from the built package
 * (`dist/*.js`), the copy packed beside `dist/` is the only one there is.
 */
export function resolveLangTemplateDir(
  lang: 'go' | 'rust',
  marker: string,
  moduleFile: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const here = dirname(moduleFile);
  const fromSource = moduleFile.endsWith('.ts');
  const dir = fromSource
    ? join(resolve(here, '..', '..', '..'), 'templates', lang)
    : join(resolve(here, '..'), 'templates', lang);
  if (!exists(join(dir, marker))) {
    throw new Error(
      `the ${lang === 'go' ? 'Go' : 'Rust'} function template is not available in this install (looked in ${dir})`,
    );
  }
  return dir;
}

/**
 * Every file under `dir`, relative and `/`-separated, sorted. A directory on
 * the exclude list is not entered, so build output next to a template (a
 * `target/` from a local build) is never read.
 */
export function walkFiles(dir: string, excludes: readonly TemplateExclude[] = []): string[] {
  const out: string[] = [];
  const rec = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const rel = relative(dir, p).split('\\').join('/');
      if (isExcludedBy(excludes, rel)) continue;
      if (statSync(p).isDirectory()) rec(p);
      else out.push(rel);
    }
  };
  rec(dir);
  return out;
}

export interface StagedFunction {
  /** The finished project, in a temporary directory. */
  readonly dir: string;
  /** Its files, relative to `dir`. */
  readonly files: readonly string[];
  /** Move the project to `target`, then drop the staging directory. */
  install(target: string): void;
  /** Drop the staging directory (idempotent). */
  dispose(): void;
}

export interface StageInput {
  /** Prefix of the staging directory's name. */
  readonly prefix: string;
  readonly pkg: string;
  readonly contract: string;
  readonly options: string;
  readonly template: string;
  /** The template files to copy (already minus the excludes). */
  readonly files: readonly string[];
  /** Rewrites one copied file's text. */
  readonly transform: (rel: string, text: string) => string;
  /** Files written beside the copied ones (relative path -> content). */
  readonly extraFiles?: Readonly<Record<string, string>>;
  /** Generates the code into the staged project, or throws. */
  readonly generate: (stageDir: string) => void;
}

/**
 * Build the function project in a staging directory and generate its code.
 * Nothing outside the staging directory is touched; the caller installs it
 * last, after every other write has succeeded.
 */
export function stageProject(input: StageInput): StagedFunction {
  const stage = mkdtempSync(join(tmpdir(), input.prefix));
  const dispose = () => rmSync(stage, { recursive: true, force: true });
  try {
    for (const rel of input.files) {
      const dest = join(stage, rel);
      mkdirSync(dirname(dest), { recursive: true });
      const from = join(input.template, rel);
      writeFileSync(dest, input.transform(rel, readFileSync(from, 'utf8')));
      // A script keeps its executable bit (codegen.sh).
      chmodSync(dest, statSync(from).mode & 0o777);
    }
    for (const [rel, content] of Object.entries(input.extraFiles ?? {})) {
      writeFileSync(join(stage, rel), content);
    }
    const protoDir = join(stage, 'proto');
    mkdirSync(join(protoDir, input.pkg, 'v1'), { recursive: true });
    mkdirSync(join(protoDir, 'knext', 'v1'), { recursive: true });
    writeFileSync(join(protoDir, input.pkg, 'v1', `${input.pkg}.proto`), input.contract);
    writeFileSync(join(protoDir, 'knext', 'v1', 'options.proto'), input.options);

    input.generate(stage);
    return {
      dir: stage,
      files: walkFiles(stage),
      install(target) {
        mkdirSync(dirname(target), { recursive: true });
        cpSync(stage, target, { recursive: true });
        dispose();
      },
      dispose,
    };
  } catch (err) {
    dispose();
    throw err;
  }
}
