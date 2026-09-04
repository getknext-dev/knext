/**
 * Content hygiene gate for the public docs site (apps/docs/content/docs/**).
 *
 * The docs site is USER-FACING. Two standing rules are enforced here so they
 * cannot silently rot back in:
 *
 *  1. **One package scope.** The published packages are `@getknext/core`,
 *     `@getknext/lib` and `@getknext/db` on the public npm registry. No page may
 *     tell a reader to substitute an alternate scope, nor hedge that the
 *     packages are "not yet published" / on an "interim channel".
 *  2. **No internal jargon.** No ADR numbers, no issue/PR numbers — a reader of
 *     the docs site has no way to resolve them.
 *
 * It also pins the install/CLI story that Getting started must actually show.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const DOCS_DIR = resolve(import.meta.dirname, 'content/docs');

function mdxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return mdxFiles(full);
    return full.endsWith('.mdx') ? [full] : [];
  });
}

const FILES = mdxFiles(DOCS_DIR);

/** Every `file:line` in the docs content whose text matches `re`. */
function hits(re: RegExp): string[] {
  const out: string[] = [];
  for (const file of FILES) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      if (re.test(line)) out.push(`${relative(DOCS_DIR, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

describe('docs content — published package scope', () => {
  it('has mdx pages to check', () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  it('never mentions an alternate/interim package scope', () => {
    expect(hits(/@getknext-dev\b/)).toEqual([]);
  });

  it('never hedges that the packages are unpublished', () => {
    // Only lines that talk about packages/npm AND hedge about availability.
    // Honest status notes about *features* ("not yet shipped") stay legitimate.
    const hedge = /not yet|interim|goes live|is provisioned|are provisioned|coming soon/i;
    const subject = /npm|registry|@getknext\/(core|lib|db)|package/i;
    expect(hits(new RegExp(`(?=.*${subject.source})(?=.*${hedge.source})`, 'i'))).toEqual([]);
  });

  it('never points installs at the GitHub Packages registry', () => {
    expect(hits(/npm\.pkg\.github\.com/)).toEqual([]);
  });
});

describe('docs content — user-facing language', () => {
  it('contains no ADR references', () => {
    expect(hits(/\bADR-?\s?\d/i)).toEqual([]);
  });

  it('contains no issue or PR numbers', () => {
    expect(hits(/(?:\bPR |\bissue |\(|\s)#\d+\b/i)).toEqual([]);
  });
});

describe('docs content — install & CLI story', () => {
  const gettingStarted = readFileSync(join(DOCS_DIR, 'getting-started.mdx'), 'utf-8');

  it('shows `npm i @getknext/core` as the first install command', () => {
    const firstInstall = gettingStarted.match(/^npm i .*$/m)?.[0];
    expect(firstInstall).toBeDefined();
    expect(firstInstall).toContain('@getknext/core');
  });

  it('shows the CLI as `npx kn-next`', () => {
    expect(gettingStarted).toMatch(/npx kn-next/);
  });

  it('documents each published package', () => {
    for (const pkg of ['@getknext/core', '@getknext/lib', '@getknext/db']) {
      expect(gettingStarted, `getting-started should mention ${pkg}`).toContain(pkg);
    }
  });
});

describe('docs content — CLI reference matches the real verb set', () => {
  const cli = readFileSync(join(DOCS_DIR, 'cli.mdx'), 'utf-8');

  // The bin dispatches exactly these subcommands; anything else runs `deploy`.
  // Source of truth: packages/kn-next/src/cli/deploy.ts (dispatcher).
  it('documents every bin-dispatched subcommand', () => {
    for (const verb of ['doctor', 'status', 'db bind', 'db migrate', 'rollback', 'gc']) {
      expect(cli, `cli.mdx should document \`kn-next ${verb}\``).toContain(`kn-next ${verb}`);
    }
  });

  it('documents the gc --dry-run flag', () => {
    expect(cli).toContain('--dry-run');
    expect(cli).toMatch(/kn-next gc[^\n]*--dry-run|`--dry-run` \| Compute/);
  });

  it('does not invent bin subcommands that the dispatcher does not route', () => {
    // `preview` and `loadtest` ship as directly runnable entries, NOT as bin
    // subcommands. (`build`/`cleanup` became routed verbs with the dispatch
    // contract, and `validate` joined it with the placeholder-preflight change
    // — both list and comment here track the dispatcher's truth, and this
    // enumeration is the guard's known weakness: it names non-verbs, so a verb
    // GAINING routing must remove its entry in the same PR.)
    for (const notAVerb of ['kn-next deploy-all', 'kn-next init']) {
      expect(cli).not.toContain(notAVerb);
    }
  });
});
