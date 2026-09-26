/**
 * Upstream-retirement harness (#1450). Three halves:
 *
 *  1. the toolchain the probes run IS the pinned one (Bun on PATH ==
 *     tests/bun-version-pins.test.ts's pin; installed vinext == @getknext/core's
 *     pin) — a probe against the wrong version proves nothing;
 *  2. every registry entry's repro still reproduces its upstream problem. When
 *     one stops reproducing, the bump that did it must delete the shim in the
 *     same PR: this test stays red until the entry and its markers are gone;
 *  2b. every upstream issue/PR the registry cites exists with the title it
 *     records (a typo'd number that happens to exist still reds);
 *  3. every `// @upstream-shim <id>` marker under packages/kn-next/src/adapters has
 *     an entry, every entry has at least one marker, and no marker is malformed.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crossCheck, scanMarkers } from './marker-scan';
import { bunOnPath, bunVersionOf, pinnedBunVersion, pinnedVinext, REPO_ROOT } from './probe-kit';
import { REGISTRY } from './registry';

const ADAPTERS = join(REPO_ROOT, 'packages/kn-next/src/adapters');
const PROBE_TIMEOUT = 120_000;

describe('upstream-retirement: the probes run the pinned toolchain', () => {
  it('the bun on PATH is the pinned Bun', () => {
    expect(bunVersionOf(bunOnPath())).toBe(pinnedBunVersion());
  });

  it('the installed vinext is the version @getknext/core pins', () => {
    const { pin, installed } = pinnedVinext();
    expect(installed).toBe(pin);
  });
});

describe('upstream-retirement: every registered upstream problem still reproduces', () => {
  it('registry ids are unique', () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  for (const entry of REGISTRY) {
    it(
      `${entry.id} (${entry.upstream})`,
      async () => {
        const probe = await entry.repro();
        if (!probe.stillBroken) {
          throw new Error(
            `upstream fixed — delete shim ${entry.id} and close ${entry.issue} ` +
              `(${entry.upstream} no longer reproduces on the pinned ${entry.against}). ` +
              `Remove every \`// @upstream-shim ${entry.id}\` shim and this registry entry in the same PR as the bump.\n` +
              `evidence: ${probe.evidence}`,
          );
        }
        expect(probe.stillBroken).toBe(true);
      },
      PROBE_TIMEOUT,
    );
  }
});

/** Every upstream ref the registry cites, with the title fragment it claims. */
function citedRefs(): { ref: string; title: string; mustBePr: boolean; by: string }[] {
  const out: { ref: string; title: string; mustBePr: boolean; by: string }[] = [];
  for (const e of REGISTRY) {
    out.push({ ref: e.upstream, title: e.upstreamTitle, mustBePr: false, by: e.id });
    if (e.fixedBy)
      out.push({ ref: e.fixedBy.ref, title: e.fixedBy.title, mustBePr: true, by: e.id });
  }
  return out;
}

function githubToken(): string | undefined {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env;
  const gh = Bun.which('gh');
  if (!gh) return undefined;
  const r = spawnSync(gh, ['auth', 'token'], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? r.stdout.trim() || undefined : undefined;
}

/**
 * Unreachable GitHub is a hard failure in CI (`CI`/`GITHUB_ACTIONS` set) — a
 * check that goes green when it cannot reach its oracle is worse than none.
 * Locally it is a skip: every ref is still tried independently and each skip
 * prints a warning (bun-test.mjs shows only `ok` per file in CI, so this
 * local-only warning is not relied on there).
 */
export const inCI = (env: Record<string, string | undefined> = process.env): boolean =>
  Boolean(env.CI || env.GITHUB_ACTIONS);

export type RefCheckDeps = {
  fetch: typeof fetch;
  ci: boolean;
  token?: string;
  warn: (msg: string) => void;
};

/** Check every ref independently; returns the failures (empty = all verified or locally skipped). */
export async function checkRefs(
  refs: ReturnType<typeof citedRefs>,
  deps: RefCheckDeps,
): Promise<string[]> {
  const failures: string[] = [];
  for (const { ref, title, mustBePr, by } of refs) {
    const [repo, num] = ref.split('#');
    let res: Response;
    try {
      res = await deps.fetch(`https://api.github.com/repos/${repo}/issues/${num}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'knext-upstream-retirement',
          ...(deps.token ? { authorization: `Bearer ${deps.token}` } : {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      const why = `GitHub unreachable (${String((e as Error)?.message ?? e)})`;
      if (deps.ci) failures.push(`${by}: ${ref} could not be verified in CI — ${why}`);
      else deps.warn(`SKIPPED upstream-ref validation of ${ref}: ${why}`);
      continue;
    }
    if (
      res.status === 429 ||
      (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')
    ) {
      const why = `GitHub API rate limit (HTTP ${res.status}, ${deps.token ? 'authenticated' : 'unauthenticated'})`;
      if (deps.ci) failures.push(`${by}: ${ref} could not be verified in CI — ${why}`);
      else deps.warn(`SKIPPED upstream-ref validation of ${ref}: ${why}`);
      continue;
    }
    if (res.status !== 200) {
      failures.push(`${by}: ${ref} → HTTP ${res.status}`);
      continue;
    }
    const body = (await res.json()) as { title: string; pull_request?: unknown };
    if (!body.title.includes(title))
      failures.push(`${by}: ${ref} is "${body.title}", not "…${title}…" — wrong number?`);
    if (mustBePr && !body.pull_request) failures.push(`${by}: fixedBy ${ref} is not a PR`);
  }
  return failures;
}

describe('upstream-retirement: every cited upstream ref is the issue/PR it claims to be', () => {
  it(
    'each ref exists on GitHub with the recorded title (unreachable = red in CI, a warned skip only locally)',
    async () => {
      const failures = await checkRefs(citedRefs(), {
        fetch,
        ci: inCI(),
        token: githubToken(),
        warn: (m) => process.stderr.write(`${m}\n`),
      });
      expect(failures).toEqual([]);
    },
    PROBE_TIMEOUT,
  );

  const refs = [
    { ref: 'oven-sh/bun#1', title: 'expected-fragment', mustBePr: false, by: 'first' },
    { ref: 'oven-sh/bun#2', title: 'expected-fragment', mustBePr: false, by: 'second' },
  ];
  const ok = (title: string) => new Response(JSON.stringify({ title }), { status: 200 });

  it('CI: an unreachable GitHub fails closed, naming the ref and the cause', async () => {
    const down = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const f = await checkRefs(refs, { fetch: down, ci: true, warn: () => {} });
    expect(f).toHaveLength(2);
    expect(f[0]).toContain('first: oven-sh/bun#1 could not be verified in CI');
    expect(f[0]).toContain('ECONNREFUSED');
  });

  it('CI: a rate limit fails closed', async () => {
    const limited = (() =>
      Promise.resolve(new Response('', { status: 429 }))) as unknown as typeof fetch;
    expect(await checkRefs(refs, { fetch: limited, ci: true, warn: () => {} })).toHaveLength(2);
  });

  it('local: unreachable is a warned skip, one warning per ref', async () => {
    const down = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    const warned: string[] = [];
    expect(await checkRefs(refs, { fetch: down, ci: false, warn: (m) => warned.push(m) })).toEqual(
      [],
    );
    expect(warned).toHaveLength(2);
  });

  it('each ref is checked independently: an unreachable first ref does not skip the second', async () => {
    let n = 0;
    const flaky = (() =>
      ++n === 1
        ? Promise.reject(new Error('blip'))
        : Promise.resolve(ok('WRONG TITLE'))) as unknown as typeof fetch;
    const f = await checkRefs(refs, { fetch: flaky, ci: false, warn: () => {} });
    expect(f).toHaveLength(1);
    expect(f[0]).toContain('second: oven-sh/bun#2 is "WRONG TITLE"');
  });

  it('inCI reads CI and GITHUB_ACTIONS', () => {
    expect(inCI({})).toBe(false);
    expect(inCI({ CI: 'true' })).toBe(true);
    expect(inCI({ GITHUB_ACTIONS: 'true' })).toBe(true);
  });
});

describe('upstream-retirement: @upstream-shim markers ↔ registry', () => {
  const ids = REGISTRY.map((e) => e.id);

  it('no marker is malformed', () => {
    expect(scanMarkers(ADAPTERS).malformed).toEqual([]);
  });

  it('every marker has a registry entry', () => {
    const { markers } = scanMarkers(ADAPTERS);
    expect(crossCheck(markers, ids).orphanMarkers).toEqual([]);
  });

  it('every registry entry has at least one marker', () => {
    const { markers } = scanMarkers(ADAPTERS);
    expect(crossCheck(markers, ids).unmarkedEntries).toEqual([]);
  });

  it('the scanner sees a marker in a new file, recurses, rejects malformed forms, and skips __tests__', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knext-marker-scan-'));
    try {
      mkdirSync(join(dir, 'nested/deep'), { recursive: true });
      mkdirSync(join(dir, '__tests__'));
      writeFileSync(join(dir, 'a.mjs'), '// @upstream-shim alpha\nexport {};\n');
      writeFileSync(join(dir, 'nested/deep/b.cjs'), 'x;\n  // @upstream-shim beta-two\n');
      writeFileSync(
        join(dir, 'c.ts'),
        '/* @upstream-shim gamma */\n// @upstream-shim Bad_Id\n// @upstream-shim\n',
      );
      writeFileSync(join(dir, '__tests__/d.test.ts'), '// @upstream-shim ignored\n');
      const { markers, malformed } = scanMarkers(dir);
      expect(markers.map((m) => `${m.file}:${m.id}`).sort()).toEqual([
        'a.mjs:alpha',
        'nested/deep/b.cjs:beta-two',
      ]);
      expect(malformed).toHaveLength(3);
      expect(crossCheck(markers, ['alpha', 'delta'])).toEqual({
        orphanMarkers: ['nested/deep/b.cjs:2 (beta-two)'],
        unmarkedEntries: ['delta'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
