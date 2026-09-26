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

describe('docs content — scale-to-zero database upgrade order', () => {
  const upgrading = readFileSync(join(DOCS_DIR, 'upgrading.mdx'), 'utf-8');

  it('tells operators to roll the failover controller image before its new config', () => {
    // The scale-to-zero database ships its own failover controller; a manifest that
    // wires new controller configuration must not be applied ahead of the image that
    // reads it, or the configuration is inert. This mirrors operator-then-CLI.
    expect(upgrading).toMatch(/scale-to-zero (database|Postgres)/i);
    expect(upgrading).toMatch(/failover controller/i);
    expect(upgrading).toMatch(
      /before applying|before you apply|roll[^\n]*image[^\n]*(first|before)/i,
    );
  });
});

describe('docs content — install & CLI story', () => {
  const gettingStarted = readFileSync(join(DOCS_DIR, 'getting-started.mdx'), 'utf-8');

  it('shows `npm i @getknext/core` as the first install command', () => {
    const firstInstall = gettingStarted.match(/^npm i .*$/m)?.[0];
    expect(firstInstall).toBeDefined();
    expect(firstInstall).toContain('@getknext/core');
  });

  it('shows the CLI as `npx knext`', () => {
    expect(gettingStarted).toMatch(/npx knext/);
  });

  it('documents each published package', () => {
    for (const pkg of ['@getknext/core', '@getknext/lib', '@getknext/db']) {
      expect(gettingStarted, `getting-started should mention ${pkg}`).toContain(pkg);
    }
  });
});

describe('docs content — no stale `kn-next` command text', () => {
  // `kn-next` was renamed to `knext` (the deprecated alias still runs, but
  // every USER-FACING command example must show the canonical name). Three
  // things are enforced, not one:
  //
  //  1. `kn-next <verb>` never appears as a command to run, anywhere.
  //     Matched STRUCTURALLY — `kn-next` + whitespace + a token starting
  //     with a letter — never against an enumerated verb list. An
  //     enumerated list is exactly what went stale here the first time
  //     (missed the shipped `init-ci` verb); this regex needs no updating
  //     when a verb is added, because it does not know what a verb IS, only
  //     that `kn-next` followed by whitespace and a word is a command
  //     example. It does not match `kn-next.config.ts` (a `.`, not
  //     whitespace, follows), `kn-next-operator`/`kn-next-action` (a `-`),
  //     or a path segment like `packages/kn-next/...` (a `/`) — all of
  //     those are followed by a non-whitespace character.
  //  2. `npx kn-next` never appears, regardless of what (if anything)
  //     follows — this is the exact hazard getting-started.mdx's own
  //     warning callout names: the unscoped `knext` name on the public npm
  //     registry belongs to someone else, and so, by the same logic, would
  //     an unscoped bare `kn-next` invocation outside a project where the
  //     package is already installed.
  //  3. The bare WORD `kn-next` — not part of `kn-next.config.ts`,
  //     `kn-next-operator`/`kn-next-action`, or a `packages/kn-next/...`
  //     path (none of those name the COMMAND) — appears ONLY on the one
  //     page that documents the deprecated alias: getting-started.mdx's own
  //     callout, which explains the rename rather than telling a reader to
  //     type `kn-next`. This is the rule the comment here used to CLAIM
  //     without a test backing it; it is enforced now, not just described.
  const staleVerbCommand = /\bkn-next\s+[a-z][\w-]*/;
  const staleNpxInvocation = /\bnpx\s+kn-next\b/;
  const bareKnNextWord = /(?<![\w/])kn-next(?![\w.\-/])/;
  const DEPRECATION_CALLOUT_PAGE = 'getting-started.mdx';

  it('never shows `kn-next <verb>` as a command to run, anywhere in the docs', () => {
    expect(hits(staleVerbCommand)).toEqual([]);
  });

  it('never shows a bare `npx kn-next` invocation', () => {
    expect(hits(staleNpxInvocation)).toEqual([]);
  });

  it(`the bare word \`kn-next\` appears only in ${DEPRECATION_CALLOUT_PAGE}'s deprecation callout`, () => {
    const offPage = hits(bareKnNextWord).filter(
      (hit) => !hit.startsWith(`${DEPRECATION_CALLOUT_PAGE}:`),
    );
    expect(offPage).toEqual([]);
  });

  it('mutation control: each guard actually matches the stale form it exists to catch, and none trips on the legitimate callout text', () => {
    // Not a doc-content check — proves the regexes themselves are live, so a
    // typo above cannot silently make the checks above pass by matching
    // nothing.
    expect(staleVerbCommand.test('run `kn-next deploy` first')).toBe(true);
    expect(staleVerbCommand.test('run `kn-next init-ci` first')).toBe(true);
    expect(staleVerbCommand.test('run `knext deploy` first')).toBe(false);
    expect(staleNpxInvocation.test('run `npx kn-next` first')).toBe(true);
    expect(staleNpxInvocation.test('run `npx knext` first')).toBe(false);
    expect(bareKnNextWord.test('the CLI, `kn-next`, is deprecated')).toBe(true);
    expect(bareKnNextWord.test('see `kn-next.config.ts`')).toBe(false);
    expect(bareKnNextWord.test('the `kn-next-operator` Deployment')).toBe(false);
    expect(bareKnNextWord.test('packages/kn-next/src/cli')).toBe(false);
    // The deprecation callout's own bare-alias sentence must not trip the
    // VERB/npx guards (only the bare-word guard is meant to see it, and
    // only to confirm it stays confined to its one page).
    expect(staleVerbCommand.test('The CLI command was renamed from `kn-next` to `knext`.')).toBe(
      false,
    );
    expect(staleNpxInvocation.test('The CLI command was renamed from `kn-next` to `knext`.')).toBe(
      false,
    );
  });
});

describe('docs content — CLI reference matches the real verb set', () => {
  const cli = readFileSync(join(DOCS_DIR, 'cli.mdx'), 'utf-8');

  // The bin dispatches exactly these subcommands; anything else runs `deploy`.
  // Source of truth: packages/kn-next/src/cli/deploy.ts (dispatcher).
  it('documents every bin-dispatched subcommand', () => {
    for (const verb of ['doctor', 'status', 'db bind', 'db migrate', 'rollback', 'gc']) {
      expect(cli, `cli.mdx should document \`knext ${verb}\``).toContain(`knext ${verb}`);
    }
  });

  it('documents the gc --dry-run flag', () => {
    expect(cli).toContain('--dry-run');
    expect(cli).toMatch(/knext gc[^\n]*--dry-run|`--dry-run` \| Compute/);
  });

  it('does not invent bin subcommands that the dispatcher does not route', () => {
    // `preview` and `loadtest` ship as directly runnable entries, NOT as bin
    // subcommands. (`build`/`cleanup` became routed verbs with the dispatch
    // contract, and `validate` joined it with the placeholder-preflight change
    // — both list and comment here track the dispatcher's truth, and this
    // enumeration is the guard's known weakness: it names non-verbs, so a verb
    // GAINING routing must remove its entry in the same PR.)
    for (const notAVerb of ['knext deploy-all', 'knext init']) {
      expect(cli).not.toContain(notAVerb);
    }
  });
});
