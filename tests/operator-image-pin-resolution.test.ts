/**
 * Offline coverage for `scripts/verify-image-pins.mjs` — the run-time resolution
 * of every image the OPERATOR pins, against the tag its own reference claims.
 *
 * WHY IT EXISTS (#471 code review). The operator's prewarm helper carries a
 * `tag@digest` reference and two Go unit tests:
 *   - `TestPrewarmHelperImage_DigestPinned` — there is a 64-hex digest;
 *   - `TestPrewarmHelperImage_IsStaticallyLinkedVariant` — the TAG TEXT ends in
 *     `-uclibc` / `-musl`.
 * The kubelet resolves the DIGEST and ignores the tag entirely, so
 * `busybox:1.36.1-uclibc@sha256:73aaf090…` — the uclibc tag carrying the glibc
 * digest that CrashLoopBackOff'd on OKE — passes both while reintroducing
 * exactly the regression this PR fixes. Those tests prove the LABEL; only
 * resolving the tag upstream proves the ARTIFACT.
 *
 * Same division of labour as the action pins (security.md): FORM at PR time,
 * VALUE at run time against an injected-then-real transport, never frozen into a
 * committed assertion.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  discoverGoSources,
  discoverSources,
  parseImagePins,
  resolveTagDigest,
  verifyImagePin,
} from '../scripts/verify-image-pins.mjs';

const ROOT = resolve(import.meta.dirname, '..');

const GLIBC = 'sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662';
const UCLIBC = 'sha256:0872fb3a7632ba9d0ae46a8e832a62b30ce83a6f220b8bb52903d9cf477dabe3';

/** A transport double: tag -> digest, plus explicit failure shapes. */
const fakeApi = (table: Record<string, string | { status: number }>) => {
  return async ({ repository, tag }: { repository: string; tag: string }) => {
    const hit = table[`${repository}:${tag}`];
    if (hit === undefined) return { status: 404, digest: undefined };
    if (typeof hit === 'object') return { status: hit.status, digest: undefined };
    return { status: 200, digest: hit };
  };
};

describe('parseImagePins', () => {
  it('extracts a tag@digest reference from Go source', () => {
    const pins = parseImagePins(
      'const prewarmHelperImage = "busybox:1.36.1-uclibc@sha256:' + 'a'.repeat(64) + '"\n',
      'x.go',
    );
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      registry: 'registry-1.docker.io',
      repository: 'library/busybox',
      tag: '1.36.1-uclibc',
      digest: `sha256:${'a'.repeat(64)}`,
      line: 1,
    });
  });

  it('retains a digest-only reference as a finding rather than dropping it', () => {
    // A digest with no tag cannot be resolved against anything, so it must be
    // REPORTED, not silently skipped — skipping is how a pin escapes the check
    // by removing the very field that makes it auditable.
    const pins = parseImagePins(`var x = "example.com/ns/app@sha256:${'b'.repeat(64)}"\n`, 'x.go');
    expect(pins).toHaveLength(1);
    expect(pins[0].tag).toBeUndefined();
  });

  it('parses a registry with a port and a multi-segment repository', () => {
    const pins = parseImagePins(`"reg.example.com:5000/a/b/c:v1@sha256:${'c'.repeat(64)}"`, 'x.go');
    expect(pins[0]).toMatchObject({
      registry: 'reg.example.com:5000',
      repository: 'a/b/c',
      tag: 'v1',
    });
  });

  it('ignores strings that are not image references', () => {
    expect(parseImagePins('const s = "no image here"\n', 'x.go')).toEqual([]);
  });
});

describe('verifyImagePin', () => {
  const pin = {
    file: 'image_prewarm.go',
    line: 1,
    registry: 'registry-1.docker.io',
    repository: 'library/busybox',
    tag: '1.36.1-uclibc',
    digest: UCLIBC,
    ref: `busybox:1.36.1-uclibc@${UCLIBC}`,
  };

  it('passes when the digest is the one the tag resolves to', async () => {
    const api = fakeApi({ 'library/busybox:1.36.1-uclibc': UCLIBC });
    expect(await verifyImagePin(pin, { api })).toBeUndefined();
  });

  it('CATCHES the uclibc tag carrying the glibc digest — the exact bypass', async () => {
    // This is the reviewer's build-and-run bypass: both Go tests stay green and
    // containerd resolves the glibc image that crash-looped on every OKE node.
    const api = fakeApi({ 'library/busybox:1.36.1-uclibc': UCLIBC });
    const finding = await verifyImagePin({ ...pin, digest: GLIBC }, { api });
    expect(finding?.reason).toBe('digest-mismatch');
    expect(finding?.actualDigest).toBe(UCLIBC);
  });

  it('reports a tag that does not exist upstream', async () => {
    const api = fakeApi({});
    expect((await verifyImagePin(pin, { api }))?.reason).toBe('tag-missing');
  });

  it('reports an unreachable registry as a FAILURE, never a pass', async () => {
    const api = fakeApi({ 'library/busybox:1.36.1-uclibc': { status: 500 } });
    expect((await verifyImagePin(pin, { api }))?.reason).toBe('api-error');
  });

  it('reports a transport that throws as a failure, not an unhandled crash', async () => {
    const api = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    const finding = await verifyImagePin(pin, { api });
    expect(finding?.reason).toBe('api-error');
    expect(finding?.message).toMatch(/ENOTFOUND/);
  });

  it('reports a pin with no tag: nothing states what the digest is meant to be', async () => {
    const api = fakeApi({ 'library/busybox:1.36.1-uclibc': UCLIBC });
    expect((await verifyImagePin({ ...pin, tag: undefined }, { api }))?.reason).toBe('no-tag');
  });
});

describe('scope: the operator sources are discovered, not enumerated', () => {
  it('finds the file that carries the prewarm helper pin', () => {
    const files = discoverGoSources(ROOT);
    expect(files).toContain('packages/kn-next-operator/internal/controller/image_prewarm.go');
  });

  it('the discovered set actually yields the prewarm helper pin', () => {
    // Both halves: the scan must SEE the file, and the parse must produce the
    // pin from it — a discovery that returns files nothing parses is decoration.
    const pins = discoverGoSources(ROOT).flatMap((file) =>
      parseImagePins(readFileSync(resolve(ROOT, file), 'utf8'), file),
    );
    const helper = pins.find((p) => p.repository === 'library/busybox');
    expect(helper).toBeDefined();
    expect(helper?.tag).toMatch(/-(uclibc|musl)$/);
    expect(helper?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('scope covers every image this repo RUNS, not only the Go ones', () => {
  // The nightly's original walk was `packages/kn-next-operator/**.go` — which
  // excludes the two pins the same PR added: the harness's privileged hostPID
  // `nsenter` pod (`nodesh.sh`) and the in-cluster builder (kaniko, which holds
  // the registry PUSH credential). The PR's own finding is that the artifact
  // behind a tag is mutable and load-bearing; a scope that misses the most
  // privileged pins in the tree does not carry that finding.
  const files = discoverSources(ROOT);

  it('discovers the benchmark shell and YAML sources alongside the Go ones', () => {
    expect(files).toContain('packages/kn-next-operator/internal/controller/image_prewarm.go');
    expect(files).toContain('benchmarks/image-prewarm-oke/nodesh.sh');
    expect(files).toContain('benchmarks/image-prewarm-oke/build-unique-image.job.yaml');
  });

  it('actually yields the privileged and credential-bearing pins from them', () => {
    // Both halves: discovery must see the files AND parsing must produce the
    // pins — a walk that returns files nothing parses is decoration.
    const pins = files.flatMap((file) =>
      parseImagePins(readFileSync(resolve(ROOT, file), 'utf8'), file),
    );
    const alpine = pins.find((p) => p.file.endsWith('nodesh.sh'));
    expect(alpine, 'the privileged hostPID pod image is unchecked').toBeDefined();
    expect(alpine?.tag).toBeTruthy();
    expect(alpine?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const kaniko = pins.find((p) => p.repository.includes('kaniko'));
    expect(kaniko, 'the image holding the registry push credential is unchecked').toBeDefined();
    expect(kaniko?.registry).toBe('gcr.io');
    expect(kaniko?.tag).toBeTruthy();
  });

  it('parses an unquoted YAML/shell reference, not only a Go string literal', () => {
    const digest = `sha256:${'e'.repeat(64)}`;
    const yaml = parseImagePins(`        image: alpine:3.20@${digest}\n`, 'x.yaml');
    expect(yaml).toHaveLength(1);
    expect(yaml[0]).toMatchObject({ repository: 'library/alpine', tag: '3.20', digest });

    const sh = parseImagePins(`image: \${NODESH_IMAGE:-alpine:3.20@${digest}}\n`, 'x.sh');
    expect(sh[0]).toMatchObject({ repository: 'library/alpine', tag: '3.20', digest });
  });
});

describe('the check is actually wired to run', () => {
  const workflow = readFileSync(
    resolve(ROOT, '.github/workflows/image-pin-resolution-nightly.yml'),
    'utf8',
  );

  // PARSED, not grepped. A substring match for `pull_request:` is satisfied by
  // `_disabled_pull_request:` and by a commented-out block — mutation-proved:
  // renaming the key left the grep form green, which is the "guard that stays
  // green when its subject is removed" this repo calls decoration.
  const triggers =
    (parse(workflow) as { true?: unknown; on?: unknown }).true ?? // YAML 1.1: `on` is a boolean key
    (parse(workflow) as { on?: unknown }).on;
  const pr = (triggers as { pull_request?: { paths?: string[] } })?.pull_request;

  /**
   * A GitHub `paths:` glob as a RegExp over repo-relative POSIX paths.
   * `**` crosses `/` (and may match zero directories); `*` and `?` do not.
   */
  const globToRegExp = (glob: string): RegExp => {
    const body = glob
      .split(/(\*\*\/|\*\*|\*|\?)/)
      .map((part) => {
        if (part === '**/') return '(?:[^/]+/)*';
        if (part === '**') return '.*';
        if (part === '*') return '[^/]*';
        if (part === '?') return '[^/]';
        return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      })
      .join('');
    return new RegExp(`^${body}$`);
  };

  it('the glob translation itself is right — the comparison below rests on it', () => {
    // Both halves: it must match what GitHub matches and reject what it does not.
    const re = globToRegExp('benchmarks/**/*.yaml');
    expect(re.test('benchmarks/image-prewarm-oke/build-unique-image.job.yaml')).toBe(true);
    expect(re.test('benchmarks/a.yaml')).toBe(true); // `**` may match zero directories
    expect(re.test('benchmarks/image-prewarm-oke/nodesh.sh')).toBe(false);
    expect(re.test('benchmarks/deep/er/still.yaml')).toBe(true);
    expect(re.test('other/a.yaml')).toBe(false);
    expect(
      globToRegExp('scripts/verify-image-pins.mjs').test('scripts/verify-image-pinsXmjs'),
    ).toBe(
      false, // the `.` is escaped, not a wildcard
    );
  });

  it('a nightly workflow runs the checker', () => {
    expect(workflow).toMatch(/node scripts\/verify-image-pins\.mjs/);
    expect(workflow).toMatch(/schedule:/);
  });

  it('a diff that could INTRODUCE a bad pin is checked at proposal time', () => {
    // Nightly-only leaves a window from 05:41 to the next night in which a bad
    // pin is merged and unreported. A `pull_request` trigger scoped to the
    // paths that can carry a pin closes it without putting a third-party
    // registry in front of every merge (which is what would make the gate
    // flaky — anonymous Docker Hub resolution is rate-limited per source IP,
    // and shared runners share one).
    expect(pr, 'no pull_request trigger: nothing checks a pin at proposal time').toBeDefined();
    expect(pr?.paths).toBeDefined();
    for (const path of [
      'packages/kn-next-operator/**/*.go',
      'benchmarks/**/*.yaml',
      'benchmarks/**/*.sh',
      'scripts/verify-image-pins.mjs',
    ]) {
      expect(pr?.paths).toContain(path);
    }
  });

  it('EVERY file the checker walks is covered by the `paths:` filter', () => {
    // The half the previous version claimed and did not have. It asserted four
    // hardcoded path strings plus `scanned.some(f => f.startsWith('benchmarks/'))`
    // — both of which stay green while the two lists drift apart, because
    // neither compares them. Extending `discoverBenchmarkSources` to another
    // extension or directory left the `paths:` filter stale and the test green:
    // a gate that cannot fire on the diffs that matter, under a comment saying
    // it asserts both halves.
    //
    // This compares them: every file the walk yields must be matched by at
    // least one glob in the trigger, so the two can only diverge loudly. The
    // extensions happen to line up today (`.go`, `.yaml`, `.yml`, `.sh` are all
    // in both) — that is the point. Nothing was asserting it, so the next
    // extension or directory added to the walk would have lined up with nothing.
    const patterns = (pr?.paths ?? []).map(globToRegExp);
    const uncovered = discoverSources(ROOT).filter((file) =>
      patterns.every((re) => !re.test(file)),
    );
    expect(
      uncovered,
      'these sources are scanned by verify-image-pins.mjs but a PR that changes them does not ' +
        'trigger the check — the pin can be introduced and merged unreported',
    ).toEqual([]);
  });

  it('the coverage check can actually fail — proved on the walk it polices', () => {
    // Mutation-proof in-test, so the assertion above is not decoration: a file
    // the walk could plausibly grow (the harness's own `.mjs` sources) is NOT
    // matched by any pattern in the trigger today.
    const patterns = (pr?.paths ?? []).map(globToRegExp);
    expect(patterns.some((re) => re.test('benchmarks/image-prewarm-oke/lib.mjs'))).toBe(false);
    expect(patterns.some((re) => re.test('benchmarks/image-prewarm-oke/nodesh.sh'))).toBe(true);
  });

  it('the red-alert issue is only raised by the NIGHTLY, never by a PR run', () => {
    // Both halves: the alert job must exist AND be gated to the schedule — a PR
    // that trips the check reports on the PR, it does not pin a repo issue.
    expect(workflow).toMatch(/nightly-red-alert:/);
    expect(workflow).toMatch(/github\.event_name == 'schedule'/);
  });

  it('nothing lets a finding pass: no continue-on-error, no `|| true`', () => {
    // Both halves — the invocation must be present AND unable to be green while
    // the script exits non-zero. A guard wired with `|| true` is decoration.
    expect(workflow).not.toMatch(/continue-on-error:\s*true/);
    expect(workflow).not.toMatch(/verify-image-pins\.mjs[^\n]*\|\|/);
  });
});

describe('resolveTagDigest handles the OCI token dance', () => {
  it('retries with a bearer token when the registry answers 401', async () => {
    const calls: string[] = [];
    const httpDouble = async (url: string, headers: Record<string, string>) => {
      calls.push(url);
      if (url.includes('/manifests/') && !headers.authorization) {
        return {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://auth.example.com/token",service="registry.example.com",scope="repository:library/busybox:pull"',
          },
          json: async () => ({}),
        };
      }
      if (url.startsWith('https://auth.example.com/token')) {
        return { status: 200, headers: {}, json: async () => ({ token: 'T' }) };
      }
      return { status: 200, headers: { 'docker-content-digest': UCLIBC }, json: async () => ({}) };
    };
    const result = await resolveTagDigest(
      { registry: 'registry.example.com', repository: 'library/busybox', tag: '1.36.1-uclibc' },
      { http: httpDouble },
    );
    expect(result).toEqual({ status: 200, digest: UCLIBC });
    expect(calls.some((u) => u.startsWith('https://auth.example.com/token'))).toBe(true);
  });

  it('does not treat a missing Docker-Content-Digest header as a pass', async () => {
    const httpDouble = async () => ({ status: 200, headers: {}, json: async () => ({}) });
    const result = await resolveTagDigest(
      { registry: 'registry.example.com', repository: 'library/busybox', tag: 'v1' },
      { http: httpDouble },
    );
    expect(result.digest).toBeUndefined();
  });
});
