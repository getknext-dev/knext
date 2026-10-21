/**
 * Every golang base image in the repo is digest-pinned to a point release and
 * that release is the one its module's go.mod names. A floating `golang:1.26`
 * (the scale-zero-pg gateway used to) rebuilds with whatever Go is current,
 * and a Dockerfile older than its go.mod builds with a Go the module rejects.
 *
 * The scan is deliberately wide and fails LOUD: a golang reference it cannot
 * read as `golang:X.Y.Z@sha256:<digest>` is an error, never a silent skip.
 * It looks at FROM and ARG lines (an `ARG X=golang:...` later used in FROM),
 * accepts a registry prefix (`docker.io/library/golang:`), and covers
 * Containerfiles as well as Dockerfiles.
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

const REGISTRY = /^(?:(?:index\.|registry-1\.)?docker\.io\/)?(?:library\/)?/;
const STRICT = /^golang:(\d+\.\d+\.\d+)@sha256:[0-9a-f]{64}$/;

/** Every golang image reference on a FROM or ARG line, registry prefix stripped. */
export function golangRefs(src: string): string[] {
  const refs: string[] = [];
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    let candidate: string | undefined;
    const from = line.match(/^FROM\s+(?:--\S+\s+)*(\S+)/i);
    if (from) candidate = from[1];
    const arg = line.match(/^ARG\s+\S+?=(\S*)/i);
    if (arg) candidate = arg[1].replace(/^["']|["']$/g, '');
    if (!candidate) continue;
    const bare = candidate.replace(REGISTRY, '');
    if (/^golang(?:[:@]|$)/.test(bare)) refs.push(bare);
  }
  return refs;
}

/** Returns the problems with a Dockerfile's golang refs against a go.mod version. */
export function problems(src: string, goVersion: string): string[] {
  const refs = golangRefs(src);
  if (refs.length === 0) return ['no golang image reference found'];
  const out: string[] = [];
  for (const ref of refs) {
    const m = ref.match(STRICT);
    if (!m) out.push(`${ref}: must be golang:X.Y.Z@sha256:<64 hex>`);
    else if (m[1] !== goVersion) out.push(`${ref}: go.mod says ${goVersion}`);
  }
  return out;
}

const D = `@sha256:${'a'.repeat(64)}`;

describe('the golang scan itself', () => {
  it('accepts a digest-pinned point release equal to go.mod', () => {
    expect(problems(`FROM golang:1.26.9${D} AS build\n`, '1.26.9')).toEqual([]);
  });

  it('rejects a mismatched version', () => {
    expect(problems(`FROM golang:1.26.8${D}\n`, '1.26.9')[0]).toMatch(/go\.mod says/);
  });

  it('errors, rather than skipping, a floating, tag-only or digest-only ref', () => {
    for (const bad of ['golang:1.26', 'golang:1.26.9', `golang${D}`, 'golang', 'golang:latest']) {
      expect(problems(`FROM ${bad} AS build\n`, '1.26.9')[0], bad).toMatch(/must be/);
    }
  });

  it('sees a registry-prefixed ref', () => {
    for (const p of ['docker.io/library/', 'docker.io/', 'library/', 'index.docker.io/library/']) {
      expect(problems(`FROM ${p}golang:1.26${D}\n`, '1.26.9')[0], p).toMatch(/must be/);
      expect(problems(`FROM ${p}golang:1.26.9${D}\n`, '1.26.9'), p).toEqual([]);
    }
  });

  it('sees a FROM with flags', () => {
    expect(problems('FROM --platform=$BUILDPLATFORM golang:1.26 AS b\n', '1.26.9')[0]).toMatch(
      /must be/,
    );
  });

  it('sees a golang ref in an ARG line used later in FROM', () => {
    const src = `ARG GO_IMAGE=golang:1.26\nFROM \${GO_IMAGE} AS build\n`;
    expect(problems(src, '1.26.9')[0]).toMatch(/must be/);
    expect(problems(`ARG GO_IMAGE=golang:1.26.9${D}\nFROM \${GO_IMAGE}\n`, '1.26.9')).toEqual([]);
  });

  it('errors when a file selected for the scan holds no golang ref at all', () => {
    expect(problems('FROM scratch\n', '1.26.9')).toEqual(['no golang image reference found']);
  });

  it('ignores commented lines and non-golang images', () => {
    expect(
      problems(
        `# FROM golang:1.20\nFROM golang:1.26.9${D}\nFROM gcr.io/distroless/static\n`,
        '1.26.9',
      ),
    ).toEqual([]);
  });
});

const dockerfiles = execFileSync(
  'git',
  ['ls-files', '*Dockerfile*', '*Containerfile*', '*.dockerfile'],
  { cwd: REPO_ROOT, encoding: 'utf8' },
)
  .split('\n')
  .filter(Boolean)
  .filter((f) => existsSync(resolve(REPO_ROOT, f)))
  .filter((f) => golangRefs(readFileSync(resolve(REPO_ROOT, f), 'utf8')).length > 0);

describe('golang base images are digest-pinned and match their module go directive', () => {
  it('finds the template, the operator and the gateway (the scan is not vacuous)', () => {
    for (const e of EXPECTED) expect(dockerfiles).toContain(e);
  });

  for (const file of dockerfiles) {
    it(`${file}: golang:X.Y.Z@sha256:<digest>, equal to go.mod's go directive`, () => {
      const goMod = resolve(REPO_ROOT, dirname(file), 'go.mod');
      expect(existsSync(goMod), `${file}: no go.mod beside it`).toBe(true);
      const directive = readFileSync(goMod, 'utf8').match(/^go (\d+\.\d+\.\d+)$/m);
      expect(directive, `${goMod}: go directive must be a full X.Y.Z`).not.toBeNull();
      expect(
        problems(
          readFileSync(resolve(REPO_ROOT, file), 'utf8'),
          (directive as RegExpMatchArray)[1],
        ),
      ).toEqual([]);
    });
  }
});
