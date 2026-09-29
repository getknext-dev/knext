#!/usr/bin/env node
/**
 * check-config-filename-mentions.mjs — #1559 scan guard.
 *
 * knext renamed its config file `kn-next.config.ts` -> `knext.config.ts`, with
 * NO dual-read (founder decision, superseding the issue's original
 * deprecation-warning wording): a directory that still has the pre-rename
 * file gets ONE actionable error naming the rename — never a silent fallback
 * read. This guard keeps every user-facing surface honest about the new
 * name: the old literal string `kn-next.config` must not appear in docs,
 * scaffold templates, CLI messages, package READMEs, or the GitHub Action —
 * except in the ONE place that is SUPPOSED to still say it, the migration
 * error itself.
 *
 * SCANNED, not enumerated (workflow.md: "prefer scanning to enumerating").
 * Every git-tracked file is scanned; what is left OUT is an explicit,
 * justified allowlist, not a silent skip:
 *
 *   - `packages/kn-next/src/cli/shared.ts` — carries the ONE guarded mention:
 *     `LEGACY_CONFIG_FILE` / `LegacyConfigFileError` / `formatLegacyConfigFile`
 *     / `LEGACY_CONFIG_FILE_CODE`. This IS the migration-error surface the
 *     issue asks to keep; excluding it is the point, not an oversight.
 *   - This file itself (`scripts/check-config-filename-mentions.mjs`) —
 *     `OLD_NAME` below MUST hold the literal old-name string as data for the
 *     scan to work at all; that is not a stray mention, it is the sentinel.
 *   - Any `*.test.ts` / `*.spec.ts` file, or anything under a `__tests__/`
 *     directory — test code deliberately exercises BOTH names (the
 *     legacy-file-detection tests plant the old name in temp fixtures and
 *     assert the migration error fires); it is not the user-facing surface
 *     this guard protects.
 *   - `.changeset/pre/*.md`, `docs/adr/**`, `docs/verification/**`, and any
 *     file literally named `CHANGELOG.md` — dated history. A changelog entry
 *     that said "existing apps keep kn-next.config.ts" was true the day it
 *     was written; rewriting it after the fact revises history rather than
 *     fixing a stale doc.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The pre-rename literal every user-facing surface must no longer say. */
export const OLD_NAME = 'kn-next.config';

/**
 * The ONE file allowed to carry the old name — the migration error itself.
 * An exact path, not a prefix: any OTHER file under `cli/` is fair game.
 */
const ALLOWED_FILES = new Set([
  'packages/kn-next/src/cli/shared.ts',
  'CLAUDE.md',
  // This scan script's own docblock/sentinel — see the module docblock.
  'scripts/check-config-filename-mentions.mjs',
]);

/**
 * Directory prefixes excluded from the scan, each justified:
 *   - `docs/adr/`, `docs/verification/`, `.changeset/` — dated history (see
 *     the module docblock).
 *   - `.claude/` — agent operating notes and skills, not shipped to knext
 *     app consumers. Per this issue's own instructions, `.claude/` and
 *     `CLAUDE.md` are not an agent's to edit as part of this change (the
 *     stale `CLAUDE.md` §9 mention is tracked separately).
 */
const ALLOWED_DIR_PREFIXES = ['docs/adr/', 'docs/verification/', '.changeset/', '.claude/'];

function isChangelog(path) {
  return path.split('/').pop() === 'CHANGELOG.md';
}

function isTestFile(path) {
  return /\.(test|spec)\.tsx?$/.test(path) || path.split('/').includes('__tests__');
}

/** Whether `path` is exempt from the scan, per the allowlist documented above. */
export function isExempt(path) {
  if (ALLOWED_FILES.has(path)) return true;
  if (isChangelog(path)) return true;
  if (isTestFile(path)) return true;
  return ALLOWED_DIR_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Pure — takes an in-memory file list so the scan logic is unit-testable
 * (and mutation-provable) without touching disk or git. Returns one
 * `path:line` entry per violation, empty when clean.
 */
export function findViolations(files) {
  const hits = [];
  for (const { path, content } of files) {
    if (isExempt(path)) continue;
    const idx = content.indexOf(OLD_NAME);
    if (idx === -1) continue;
    const lineNo = content.slice(0, idx).split('\n').length;
    hits.push(`${path}:${lineNo}`);
  }
  return hits;
}

/** Every git-tracked file path under `repoRoot`, repo-relative, `/`-separated. */
export function trackedFilePaths(repoRoot) {
  return execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/**
 * Read every tracked file's content for the real scan. Binary files that
 * fail UTF-8 decoding are skipped (never a source of the literal string this
 * guard cares about) rather than crashing the scan.
 */
export function readTrackedFiles(repoRoot) {
  const files = [];
  for (const path of trackedFilePaths(repoRoot)) {
    let content;
    try {
      content = readFileSync(join(repoRoot, path), 'utf8');
    } catch {
      continue;
    }
    // A byte that survived latin1-ish decoding as U+FFFD replacement chars in
    // bulk is a strong binary signal; skip rather than false-flag garbage.
    if (content.includes('\u0000')) continue;
    files.push({ path, content });
  }
  return files;
}

// CLI entry: `node scripts/check-config-filename-mentions.mjs [repoRoot]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const repoRoot = process.argv[2] ?? process.cwd();
  const violations = findViolations(readTrackedFiles(repoRoot));
  if (violations.length > 0) {
    console.error(
      `${violations.length} file(s) still say "${OLD_NAME}" outside the migration error (#1559):`,
    );
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log('OK — no stray kn-next.config mentions outside the migration error.');
}
