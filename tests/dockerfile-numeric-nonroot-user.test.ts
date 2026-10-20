import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every image a NextApp or BackendService runs must name a NUMERIC, non-zero
 * user.
 *
 * The operator renders `runAsNonRoot: true` on the serving container. The
 * kubelet cannot check that a user NAME (`USER node`) is non-root, so it
 * refuses to start such a container ("image has non-numeric user (node),
 * cannot verify user is non-root"); an image with no `USER` at all runs as root
 * and is refused the same way. Both are discovered at pod start, in a cluster,
 * not at build time, so this is the place that catches them: a Dockerfile this
 * repo ships that would be refused.
 *
 * The list is explicit on purpose: only images the operator runs belong here.
 * Builder stages and benchmark scratch images are out of scope.
 *
 * `minUsers` is the number of runtime stages a file defines, so deleting the
 * `USER` line of one stage in a multi-stage template cannot hide behind the
 * stages that still have theirs.
 */

const REPO_ROOT = join(__dirname, '..');

const SHIPPED_RUNTIME_IMAGES: { file: string; minUsers: number }[] = [
  { file: 'apps/file-manager/Dockerfile', minUsers: 1 },
  { file: 'apps/docs/Dockerfile', minUsers: 1 },
  { file: 'examples/bun-exec/Dockerfile', minUsers: 1 },
  { file: 'examples/bun-exec/Dockerfile.node', minUsers: 1 },
  { file: 'templates/go/Dockerfile', minUsers: 1 },
  { file: 'templates/rust/Dockerfile', minUsers: 1 },
  { file: 'packages/kn-next/templates/app/Dockerfile.hbs', minUsers: 1 },
  { file: 'packages/kn-next/templates/app/Dockerfile.self-contained.hbs', minUsers: 1 },
  { file: 'packages/kn-next/templates/app/Dockerfile.vinext-node.hbs', minUsers: 1 },
  // bun, bun self-contained, node: one runtime stage each.
  { file: 'packages/kn-next/templates/runtime-standalone/Dockerfile.standalone.hbs', minUsers: 3 },
  { file: 'packages/grpc/e2e/z7-identity-kind/zone-caller/Dockerfile', minUsers: 1 },
  { file: 'packages/scale-zero-pg/demo/app/Dockerfile', minUsers: 1 },
];

const userDirectives = (rel: string): string[] =>
  readFileSync(join(REPO_ROOT, rel), 'utf8')
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^USER\s/i.test(l))
    .map((l) => l.replace(/^USER\s+/i, '').trim());

type Verdict = 'ok' | 'named' | 'root';

/** The single rule both the shipped-image check and the negative cases use. */
const classify = (u: string): Verdict => {
  const m = /^(\d+)(?::(\d+))?$/.exec(u);
  if (!m) return 'named';
  return Number(m[1]) > 0 ? 'ok' : 'root';
};

describe.each(SHIPPED_RUNTIME_IMAGES)('$file runs as a numeric, non-root user', ({
  file,
  minUsers,
}) => {
  it(`has at least ${minUsers} USER directive(s)`, () => {
    expect(userDirectives(file).length).toBeGreaterThanOrEqual(minUsers);
  });

  it('every USER is `<uid>[:<gid>]` with uid > 0', () => {
    for (const u of userDirectives(file)) {
      expect(
        classify(u),
        `USER ${u}: the kubelet refuses a named or root user under runAsNonRoot`,
      ).toBe('ok');
    }
  });
});

describe('the checker can say no', () => {
  it.each([
    ['65532:65532', 'ok'],
    ['1000', 'ok'],
    ['node', 'named'],
    ['nonroot:nonroot', 'named'],
    ['0', 'root'],
    ['0:0', 'root'],
  ] as [string, Verdict][])('USER %s -> %s', (u, want) => {
    expect(classify(u)).toBe(want);
  });
});
