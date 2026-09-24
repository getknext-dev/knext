import { describe, expect, it } from 'bun:test';
import {
  fixedGroupProblems,
  POST_POLL_MAX_MS,
  pollViewVersion,
  RegistryUnreachableError,
  registryGroupProblems,
  workspaceProtocolProblems,
} from '../scripts/verify-published-group.mjs';

/**
 * `scripts/verify-published-group.mjs` is the GUARD that keeps a broken
 * `@getknext/*` set off the registry after two live incidents:
 *
 *   1. PARTIAL PUBLISH — `core`+`db` shipped, `lib` skipped, so `core` needed a
 *      `lib` version that did not exist. (post-publish coherence catches this.)
 *   2. `workspace:` PROTOCOL LEAK — `core@0.4.0` shipped with
 *      `@getknext/lib: workspace:^` unrewritten, uninstallable everywhere.
 *      (pre-publish `workspace:` scan on the packed tarballs catches this.)
 *
 * The pure decision logic is unit-tested here without a network or a real
 * publish; the script wires it to `npm pack` (pre) and `npm view` (post).
 */

describe('workspaceProtocolProblems — the leak that shipped 0.4.0', () => {
  it('flags any dep group still carrying a workspace: spec', () => {
    const problems = workspaceProtocolProblems([
      {
        name: '@getknext/core',
        version: '0.4.0',
        dependencies: { '@getknext/lib': 'workspace:^', '@getknext/db': 'workspace:^' },
      },
    ]);
    expect(problems.length).toBe(2);
    expect(problems.join('\n')).toContain('@getknext/lib');
    expect(problems.join('\n')).toContain('workspace:');
  });

  it('is clean when every range has been rewritten to a concrete range', () => {
    const problems = workspaceProtocolProblems([
      {
        name: '@getknext/core',
        version: '0.4.0',
        dependencies: { '@getknext/lib': '^0.4.0', '@getknext/db': '^0.4.0', pino: '^9.6.0' },
        peerDependencies: { next: '>=16.0.0' },
      },
    ]);
    expect(problems).toEqual([]);
  });

  it('inspects peer and optional groups too, not just dependencies', () => {
    const problems = workspaceProtocolProblems([
      {
        name: 'x',
        version: '1.0.0',
        peerDependencies: { '@getknext/lib': 'workspace:*' },
        optionalDependencies: { '@getknext/db': 'workspace:~' },
      },
    ]);
    expect(problems.length).toBe(2);
  });
});

describe('fixedGroupProblems — the packed set must be internally coherent', () => {
  const fixed = ['@getknext/core', '@getknext/lib', '@getknext/db', 'kn-next'];

  const coherent = [
    { name: '@getknext/lib', version: '0.4.0', dependencies: {} },
    { name: '@getknext/db', version: '0.4.0', dependencies: { '@getknext/lib': '^0.4.0' } },
    {
      name: '@getknext/core',
      version: '0.4.0',
      dependencies: { '@getknext/lib': '^0.4.0', '@getknext/db': '^0.4.0' },
    },
    { name: 'kn-next', version: '0.4.0', dependencies: { '@getknext/core': '^0.4.0' } },
  ];

  it('passes a coherent, same-version, caret-satisfiable set', () => {
    expect(fixedGroupProblems(coherent, fixed)).toEqual([]);
  });

  it('flags a MISSING fixed-group member (the partial-publish shape)', () => {
    const missingLib = coherent.filter((m) => m.name !== '@getknext/lib');
    const problems = fixedGroupProblems(missingLib, fixed);
    expect(problems.join('\n')).toContain('@getknext/lib');
  });

  it('flags a member at a DIFFERENT version than the rest of the group', () => {
    const skewed = coherent.map((m) =>
      m.name === '@getknext/db' ? { ...m, version: '0.3.1' } : m,
    );
    const problems = fixedGroupProblems(skewed, fixed);
    expect(problems.join('\n')).toContain('0.3.1');
  });

  it('flags a sibling ^-dep the co-packed sibling does not satisfy', () => {
    const stale = coherent.map((m) =>
      m.name === '@getknext/db' ? { ...m, dependencies: { '@getknext/lib': '^0.3.0' } } : m,
    );
    const problems = fixedGroupProblems(stale, fixed);
    expect(problems.join('\n')).toContain('@getknext/lib');
  });

  it('flags a surviving workspace: sibling range as un-vouchable', () => {
    const leak = coherent.map((m) =>
      m.name === '@getknext/db' ? { ...m, dependencies: { '@getknext/lib': 'workspace:^' } } : m,
    );
    expect(fixedGroupProblems(leak, fixed).length).toBeGreaterThan(0);
  });
});

describe('registryGroupProblems — post-publish, the whole group must have landed', () => {
  const members = ['@getknext/core', '@getknext/lib', '@getknext/db', 'kn-next'];
  const target = '0.4.0';

  it('is clean when every member resolves to the target version', () => {
    const problems = registryGroupProblems({
      members,
      targetVersion: target,
      probeOk: true,
      viewVersion: () => '0.4.0',
    });
    expect(problems).toEqual([]);
  });

  it('flags a member the registry does not have (partial publish, incident #1)', () => {
    const problems = registryGroupProblems({
      members,
      targetVersion: target,
      probeOk: true,
      viewVersion: (name: string) => (name === '@getknext/lib' ? null : '0.4.0'),
    });
    expect(problems.join('\n')).toContain('@getknext/lib');
  });

  it('flags a member stuck at the previous version', () => {
    const problems = registryGroupProblems({
      members,
      targetVersion: target,
      probeOk: true,
      viewVersion: (name: string) => (name === '@getknext/db' ? '0.3.1' : '0.4.0'),
    });
    expect(problems.join('\n')).toContain('0.3.1');
  });

  it('FAILS CLOSED: an unreachable registry throws, never reads as coherent', () => {
    expect(() =>
      registryGroupProblems({
        members,
        targetVersion: target,
        probeOk: false,
        viewVersion: () => '0.4.0',
      }),
    ).toThrow(RegistryUnreachableError);
  });
});

describe('pollViewVersion — the #1364 finding-1 bounded confirmation poll (round 2: target-scoped)', () => {
  it('returns true as soon as resolvesAtTarget flips, without waiting out the full budget', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const hit = await pollViewVersion({
      name: '@getknext/core',
      resolvesAtTarget: () => {
        calls += 1;
        return calls >= 3; // false, false, true
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      maxTotalMs: 60_000,
    });
    expect(hit).toBe(true);
    expect(calls).toBe(3);
    expect(sleeps.length).toBe(2);
  });

  it('#1364 round 2 — THE REPLAYED BUG: a stale OLD version at every read (non-null, exit 0) must NOT be read as success', async () => {
    // The exact defect: the round-1 shape polled a bare `npm view <name>
    // version`, which reports whatever `latest` currently resolves to. During
    // lag that is the OLD version — non-null, npm exit 0 — so a poll that
    // only checked "did SOMETHING come back" returned on round ONE with
    // elapsed=0, reproducing the original false-red immediately. Simulate
    // exactly that: `resolvesAtTarget` (the name@TARGET exit-code check)
    // stays false for several rounds (the stale version keeps answering the
    // untargeted probe, but never the targeted one), then flips true once the
    // target version is actually live.
    let attempts = 0;
    const hit = await pollViewVersion({
      name: '@getknext/core',
      resolvesAtTarget: () => {
        attempts += 1;
        return attempts >= 4; // stale @ 0.4.2 for 3 rounds, then 0.4.3 lands
      },
      sleep: async () => {},
      maxTotalMs: 60_000,
    });
    expect(hit).toBe(true);
    expect(attempts).toBe(4); // did NOT stop early on the stale-but-non-null read
  });

  it('#1364 finding 1: a real production shape — the exact ~2.5 minute lag observed in run 36040935670, using the DEFAULT backoff', async () => {
    // core's read-after-write lag ran from 18:30:46 (absorbed via conflict) to
    // 18:33:00 (npm's own `time` field) — about 134s. A fake CLOCK (`now`) and
    // an instant `sleep` that advances it by exactly the requested amount:
    // this exercises pollViewVersion's REAL elapsed-time gating (it compares
    // `now() - start`), not a parallel bookkeeping variable the function never
    // reads.
    let clock = 0;
    let calls = 0;
    const hit = await pollViewVersion({
      name: '@getknext/core',
      resolvesAtTarget: () => {
        calls += 1;
        return clock >= 134_000;
      },
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
      maxTotalMs: POST_POLL_MAX_MS,
      // DEFAULT backoff (capped exponential) — proves the real shape reaches
      // 134s comfortably inside the ~5-minute budget, not just that SOME
      // budget would eventually work.
    });
    expect(hit).toBe(true);
    expect(calls).toBeGreaterThan(1);
    expect(clock).toBeLessThan(POST_POLL_MAX_MS);
  });

  it('#1364 finding 1: fails (returns false) when the target version NEVER appears within the budget — must not hang forever either', async () => {
    let clock = 0;
    const hit = await pollViewVersion({
      name: '@getknext/core',
      resolvesAtTarget: () => false, // stuck at some other version forever
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => clock,
      maxTotalMs: 20_000,
      backoffMs: () => 5_000,
    });
    expect(hit).toBe(false);
    // Never overshoots the budget by more than one backoff step.
    expect(clock).toBeLessThanOrEqual(20_000);
  });

  it('never sleeps at all when the very first read already resolves at the target', async () => {
    let slept = false;
    const hit = await pollViewVersion({
      name: '@getknext/core',
      resolvesAtTarget: () => true,
      sleep: async () => {
        slept = true;
      },
    });
    expect(hit).toBe(true);
    expect(slept).toBe(false);
  });
});
