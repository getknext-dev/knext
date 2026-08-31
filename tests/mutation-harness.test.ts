import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MUTATION_MARKER, mutate, restore, snapshot } from '../scripts/lib/mutation-harness.mjs';

/**
 * Snapshot-based mutation harness (#645, proposal B).
 *
 * Incident 2 of #645: a harness restored TWO edits to the same file by replaying
 * the inverse edits in FORWARD order. The first inverse edit put the file back
 * into the INTERMEDIATE state, the second then matched nothing (or matched the
 * wrong thing), and a live `NORMALIZED = []` mutation survived. `git status`
 * showed `M` — expected and correct for that PR — so it proved nothing.
 *
 * The fix is content-addressed: snapshot the bytes BEFORE the first mutation and
 * write those bytes back, never replay inverse edits. Then re-assert every anchor
 * occurs exactly once, so a restore that silently lands on the wrong content is
 * loud rather than green.
 */

function tempFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'knext-mutation-harness-'));
  const file = join(dir, 'subject.go');
  writeFileSync(file, contents, 'utf8');
  return file;
}

const SUBJECT = [
  'package controller',
  '',
  'func revalidationDeferred(app *NextApp) bool {',
  '\treturn app.Spec.Revalidation != nil',
  '}',
  '',
  'var NORMALIZED = []string{"a", "b"}',
  '',
].join('\n');

describe('mutation harness: snapshot + restore (#645 B)', () => {
  it('restores byte-identically after TWO sequential mutations to the same file (incident 2)', () => {
    const file = tempFile(SUBJECT);
    const before = readFileSync(file);

    const snap = snapshot(file);
    mutate(snap, '\treturn app.Spec.Revalidation != nil', '\treturn true');
    mutate(snap, 'var NORMALIZED = []string{"a", "b"}', 'var NORMALIZED = []string{}');

    // Both mutations are live at once — this is the shape that defeated the
    // forward-replay restore.
    const mutated = readFileSync(file, 'utf8');
    expect(mutated).toContain('return true');
    expect(mutated).toContain('[]string{}');

    restore(snap);

    expect(readFileSync(file).equals(before)).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toContain(MUTATION_MARKER);
    rmSync(file, { force: true });
  });

  it('marks every mutation with the standard marker so residue is detectable', () => {
    const file = tempFile(SUBJECT);
    const snap = snapshot(file);
    mutate(snap, '\treturn app.Spec.Revalidation != nil', '\treturn true');

    expect(readFileSync(file, 'utf8')).toContain(MUTATION_MARKER);
    restore(snap);
    rmSync(file, { force: true });
  });

  it('refuses a mutation whose anchor does not occur exactly once', () => {
    const file = tempFile(SUBJECT);
    const snap = snapshot(file);

    expect(() => mutate(snap, 'no-such-anchor', 'x')).toThrow(/occurs 0 times/);
    expect(() => mutate(snap, 'app', 'x')).toThrow(/occurs \d+ times/);

    // A refused mutation must not have touched the file.
    expect(readFileSync(file, 'utf8')).toEqual(SUBJECT);
    rmSync(file, { force: true });
  });

  it('refuses a replacement that would leave UNDETECTABLE residue (mark disabled, no marker)', () => {
    const file = tempFile(SUBJECT);
    const snap = snapshot(file);

    expect(() =>
      mutate(snap, '\treturn app.Spec.Revalidation != nil', '\treturn true', { mark: false }),
    ).toThrow(/marker/i);
    expect(readFileSync(file, 'utf8')).toEqual(SUBJECT);

    // mark:false is allowed when the caller embeds the marker itself.
    mutate(snap, '\treturn app.Spec.Revalidation != nil', `\treturn true // ${MUTATION_MARKER}`, {
      mark: false,
    });
    expect(readFileSync(file, 'utf8')).toContain(MUTATION_MARKER);
    restore(snap);
    rmSync(file, { force: true });
  });

  it('refuses a substitution that changes nothing', () => {
    const file = tempFile(SUBJECT);
    const snap = snapshot(file);
    expect(() =>
      mutate(snap, 'var NORMALIZED = []string{"a", "b"}', 'var NORMALIZED = []string{"a", "b"}', {
        mark: false,
      }),
    ).toThrow(/marker/i);
    rmSync(file, { force: true });
  });

  it('re-asserts every anchor exactly once after restore, and fails loudly when one is missing', () => {
    const file = tempFile(SUBJECT);
    const snap = snapshot(file);
    mutate(snap, '\treturn app.Spec.Revalidation != nil', '\treturn true');

    expect(() => restore(snap, { anchors: ['this anchor is not in the file'] })).toThrow(
      /occurs 0 times/,
    );
    // Even when the anchor re-assertion fails, the BYTES are back: the throw is a
    // report, not a reason to leave a mutated file on disk.
    expect(readFileSync(file, 'utf8')).toEqual(SUBJECT);
    rmSync(file, { force: true });
  });

  it('restores a file that was deleted mid-proof (the stalled-agent case)', () => {
    const file = tempFile(SUBJECT);
    const snap = snapshot(file);
    mutate(snap, '\treturn app.Spec.Revalidation != nil', '\treturn true');
    rmSync(file);
    expect(existsSync(file)).toBe(false);

    restore(snap);
    expect(readFileSync(file, 'utf8')).toEqual(SUBJECT);
    rmSync(file, { force: true });
  });

  it('exposes a CLI so non-Node harnesses (the operator bash harness) can use it', () => {
    const file = tempFile(SUBJECT);
    const cli = join(__dirname, '..', 'scripts', 'lib', 'mutation-harness.mjs');
    const snapPath = join(tmpdir(), `knext-snap-${process.pid}.json`);

    execFileSync('node', [cli, 'snapshot', file, snapPath]);
    execFileSync('node', [
      cli,
      'mutate',
      snapPath,
      '\treturn app.Spec.Revalidation != nil',
      '\treturn true',
    ]);
    expect(readFileSync(file, 'utf8')).toContain(MUTATION_MARKER);

    execFileSync('node', [cli, 'restore', snapPath]);
    expect(readFileSync(file, 'utf8')).toEqual(SUBJECT);

    rmSync(file, { force: true });
    rmSync(snapPath, { force: true });
  });
});
