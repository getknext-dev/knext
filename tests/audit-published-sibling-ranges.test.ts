import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// eslint-disable-next-line -- the script guards its main() behind an
// entrypoint check specifically so this suite can import the pure helper.
import { siblingRangeProblems } from '../scripts/audit-published.mjs';

/**
 * F1 of the #942 review — the drifted-lockfile shape, pinned as a test.
 *
 * MEASURED, not assumed: `bun pm pack` rewrites `workspace:^` from the version
 * BUN.LOCK records for the sibling workspace member, not from the sibling's
 * package.json. `changeset version` bumps only the manifests; bun.lock keeps
 * the previous release's member versions, and `bun install --frozen-lockfile`
 * never refreshes them. So on the release AFTER any version bump, the packed
 * `@getknext/core` declares the PREVIOUS `@getknext/lib` range, `npm install
 * <tarballs>` quietly fetches the old sibling from the registry, and the
 * publish-blocking audit + CycloneDX SBOM describe a closure nobody is about
 * to publish. Exit 0, nothing says so.
 *
 * `siblingRangeProblems` is the post-pack tripwire: every packed manifest's
 * `@getknext/*` range must be satisfied by the CO-PACKED sibling's version, or
 * the audit dies loud. Asserted here at PR time so the tripwire itself cannot
 * rot; the audit script wires it between pack and install.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

type Manifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const lib = (version: string): Manifest => ({ name: '@getknext/lib', version });
const core = (version: string, libRange: string): Manifest => ({
  name: '@getknext/core',
  version,
  dependencies: { '@getknext/lib': libRange, 'pg-boss': '^10.0.0' },
});

describe('#942 F1 — packed sibling ranges must be satisfied by the co-packed siblings', () => {
  it('REDS on the drifted-lock shape: core declares the PREVIOUS release of lib', () => {
    // The exact failure measured in review: manifests bumped 0.3.1 -> 0.4.0,
    // bun.lock still says 0.3.1, pack emits ^0.3.1 — satisfied only by the
    // REGISTRY copy of the old release, never by the tarball beside it.
    const problems = siblingRangeProblems([lib('0.4.0'), core('0.4.0', '^0.3.1')]);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain('@getknext/core');
    expect(problems.join('\n')).toContain('@getknext/lib');
  });

  it('stays green when every sibling range matches the co-packed version', () => {
    expect(siblingRangeProblems([lib('0.4.0'), core('0.4.0', '^0.4.0')])).toEqual([]);
  });

  it('REDS when a declared sibling is missing from the packed set entirely (#255/#256 shape)', () => {
    // The GHP incident: a lib+core-only publish set shipped a core whose db
    // dep could only 404. The same assertion covers it for the audit closure.
    expect(siblingRangeProblems([core('0.4.0', '^0.4.0')]).length).toBeGreaterThan(0);
  });

  it('REDS on a range shape it cannot vouch for, rather than guessing (fail-closed)', () => {
    // A surviving `workspace:^` (the EUNSUPPORTEDPROTOCOL class) or any
    // non-caret spelling is a question, and an unanswerable question is never
    // answered "coherent".
    expect(
      siblingRangeProblems([lib('0.4.0'), core('0.4.0', 'workspace:^')]).length,
      'workspace:^ must be a problem',
    ).toBeGreaterThan(0);
  });

  it('caret semantics are real, not string equality — a NEWER compatible sibling satisfies', () => {
    // ^0.3.1 is NOT satisfied by 0.4.0 (0.x minors are breaking under caret),
    // but ^1.2.0 IS satisfied by 1.3.0. String equality would get both wrong
    // and red on every legitimate future shape.
    expect(siblingRangeProblems([lib('1.3.0'), core('1.4.0', '^1.2.0')])).toEqual([]);
    expect(siblingRangeProblems([lib('0.4.0'), core('0.4.0', '^0.3.1')]).length).toBeGreaterThan(0);
  });

  it('the audit script actually CALLS the tripwire between pack and install', () => {
    // The helper being correct is worth nothing if main() never consults it —
    // the guards-must-assert-both-halves rule this repo keeps relearning.
    const source = readFileSync(resolve(REPO_ROOT, 'scripts/audit-published.mjs'), 'utf8');
    const packIdx = source.indexOf('packPublished(');
    const checkIdx = source.indexOf('siblingRangeProblems(');
    const installIdx = source.indexOf("'install',");
    expect(packIdx, 'pack call missing').toBeGreaterThan(-1);
    expect(checkIdx, 'main() never calls siblingRangeProblems').toBeGreaterThan(-1);
    expect(installIdx, 'install call missing').toBeGreaterThan(-1);
    expect(checkIdx, 'the tripwire must sit AFTER packing').toBeGreaterThan(packIdx);
    expect(installIdx, 'the tripwire must sit BEFORE the closure install').toBeGreaterThan(
      checkIdx,
    );
  });
});
