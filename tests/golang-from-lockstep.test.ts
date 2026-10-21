/**
 * Every `FROM golang:` line in the repo is digest-pinned to a point release and
 * that release is the one its module's go.mod names. A floating `golang:1.26`
 * (the scale-zero-pg gateway used to) rebuilds with whatever Go is current,
 * and a Dockerfile older than its go.mod builds with a Go the module rejects.
 */
import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const EXPECTED = [
  'packages/kn-next-operator/Dockerfile',
  'packages/scale-zero-pg/gateway/Dockerfile',
  'templates/go/Dockerfile',
];

const dockerfiles = execFileSync('git', ['ls-files', '*Dockerfile*'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .filter((f) => existsSync(resolve(REPO_ROOT, f)))
  .filter((f) =>
    /^\s*FROM\s+(?:--\S+\s+)?golang:/m.test(readFileSync(resolve(REPO_ROOT, f), 'utf8')),
  );

describe('golang FROM lines are digest-pinned and match their module go directive', () => {
  it('finds the template, the operator and the gateway (the scan is not vacuous)', () => {
    for (const e of EXPECTED) expect(dockerfiles).toContain(e);
  });

  for (const file of dockerfiles) {
    it(`${file}: golang:X.Y.Z@sha256:<digest>, equal to go.mod's go directive`, () => {
      const src = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      const froms = [
        ...src.matchAll(/^\s*FROM\s+(?:--\S+\s+)?(golang:\S+)(?:\s+AS\s+\S+)?\s*$/gim),
      ];
      expect(froms.length).toBeGreaterThan(0);
      const goMod = resolve(REPO_ROOT, dirname(file), 'go.mod');
      expect(existsSync(goMod), `${file}: no go.mod beside it`).toBe(true);
      const directive = readFileSync(goMod, 'utf8').match(/^go (\d+\.\d+\.\d+)$/m);
      expect(directive, `${goMod}: go directive must be a full X.Y.Z`).not.toBeNull();
      const version = (directive as RegExpMatchArray)[1];
      for (const [, ref] of froms) {
        expect(ref).toMatch(/^golang:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
        expect(ref.split('@')[0]).toBe(`golang:${version}`);
      }
    });
  }
});
