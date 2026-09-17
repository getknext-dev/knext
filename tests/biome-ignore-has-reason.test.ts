/**
 * Every `biome-ignore` suppression must carry a reason (#1056).
 *
 * A suppression comment silences a lint rule for one line. Without an inline
 * reason after the rule (`// biome-ignore lint/rule/name: why`), the next
 * reader cannot tell whether the suppression is still load-bearing or has gone
 * stale — and a stale suppression hides exactly the drift the rule would now
 * catch. Biome's own `suppressions/unused` warning flags a directive that no
 * longer suppresses anything, but it is a WARNING: `biome check .` exits 0 with
 * it present, so it does not gate CI. This test gates the reason half.
 *
 * The audit that motivated it removed three genuinely-unused directives
 * (`suppressions/unused` confirmed, mutation-proved by deleting the line and
 * watching lint stay green); every survivor was mutation-proved LIVE and
 * carries a reason. This guard keeps that invariant from silently eroding.
 *
 * It SCANS rather than enumerates: an enumerated allowlist is how the next
 * reasonless directive gets missed. The matcher requires a real biome category
 * token (`lint`/`format`/`assist`/`syntax`) after the marker so prose that
 * merely mentions "biome-ignore" in a comment is not mistaken for a directive.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = basename(fileURLToPath(import.meta.url));

/**
 * Real `biome-ignore` directives whose reason (the text after the first colon
 * following the category/rule token) is empty. Returns a short fragment of each
 * offender for a legible failure. Deliberately anchored on a biome category
 * token so a sentence like "the biome-ignore is required" — prose, not a
 * directive — is not reported.
 */
function biomeIgnoresMissingReason(source: string): string[] {
  const offenders: string[] = [];
  const re = /biome-ignore(?:-start|-end)?\s+(?:lint|format|assist|syntax)\b([^\n]*)/g;
  for (const m of source.matchAll(re)) {
    const rest = m[1];
    const colon = rest.indexOf(':');
    const reason = colon === -1 ? '' : rest.slice(colon + 1).trim();
    if (reason.length === 0) offenders.push(m[0].slice(0, 100).trim());
  }
  return offenders;
}

function countDirectives(source: string): number {
  return (source.match(/biome-ignore(?:-start|-end)?\s+(?:lint|format|assist|syntax)\b/g) ?? [])
    .length;
}

function sourceFiles(): string[] {
  return (
    execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.mjs', '*.js', '*.cjs', '*.hbs'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean)
      // This file carries reasonless SAMPLE literals below; excluding it keeps
      // those from being read as real offenders. The matcher unit-tests cover it.
      .filter((f) => basename(f) !== SELF)
  );
}

describe('every biome-ignore carries a reason (#1056)', () => {
  const files = sourceFiles();

  it('finds directives at all — the guard must not pass vacuously', () => {
    const total = files.reduce(
      (n, f) => n + countDirectives(readFileSync(resolve(repoRoot, f), 'utf8')),
      0,
    );
    expect(total).toBeGreaterThan(30);
  });

  it('no tracked biome-ignore is missing its reason', () => {
    const offenders = files.flatMap((f) =>
      biomeIgnoresMissingReason(readFileSync(resolve(repoRoot, f), 'utf8')).map(
        (frag) => `${f}: ${frag}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});

describe('the reason matcher', () => {
  it('flags a directive with no reason', () => {
    expect(biomeIgnoresMissingReason('// biome-ignore lint/suspicious/noExplicitAny')).toHaveLength(
      1,
    );
  });

  it('flags a directive with an empty reason after the colon', () => {
    expect(
      biomeIgnoresMissingReason('// biome-ignore lint/suspicious/noExplicitAny:  '),
    ).toHaveLength(1);
  });

  it('accepts a directive that carries a reason', () => {
    expect(
      biomeIgnoresMissingReason('// biome-ignore lint/suspicious/noExplicitAny: untyped module'),
    ).toEqual([]);
  });

  it('accepts the range and format forms with a reason', () => {
    expect(biomeIgnoresMissingReason('// biome-ignore-start lint/style/useConst: batch')).toEqual(
      [],
    );
    expect(biomeIgnoresMissingReason('// biome-ignore format: keep alignment')).toEqual([]);
  });

  it('ignores prose that merely mentions biome-ignore, not a directive', () => {
    expect(
      biomeIgnoresMissingReason('// the biome-ignore is required both ways — its autofix would'),
    ).toEqual([]);
  });
});
