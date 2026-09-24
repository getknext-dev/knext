import { describe, expect, it } from 'bun:test';
import {
  ensureGroupPublished,
  GroupStillIncoherentError,
  isAlreadyPublishedConflict,
  pollResolves,
  RegistryUnreachableError,
} from '../scripts/ensure-published-group.mjs';

/**
 * `scripts/ensure-published-group.mjs` is the SELF-HEAL step wired into
 * `release.yml` AFTER `changeset publish` and BEFORE the `--post` coherence
 * guard. It exists because `changeset publish` has TWICE PARTIAL-published the
 * `@getknext/*` fixed group: `core`+`kn-next` landed at the target version but
 * `lib`/`db` did NOT, leaving `npm install @getknext/core` broken (ETARGET on an
 * unresolvable sibling). `verify-published-group.mjs --post` DETECTS that but
 * cannot PREVENT it (core is already published, immutable). A manual re-run then
 * published the missing members — proving the partial is transient/per-package.
 *
 * This step closes that gap in-run: for every fixed-group member NOT resolvable
 * at the target version, it re-publishes JUST that member's already-built +
 * workspace-rewritten tarball, with bounded retries + backoff for read-after-
 * write lag, then fails closed if the group is still incoherent.
 *
 * The pure decision/retry logic is unit-tested here with an INJECTED registry
 * resolver + publish spawn — no network, no real publish. Every verdict is a
 * return value or a thrown error the CLI maps to an exit code (never output
 * grep).
 */

const MEMBERS = ['@getknext/core', '@getknext/lib', '@getknext/db', 'kn-next'];
const TARGET = '0.5.0';

/** An injected publish spy that records which members it was asked to publish. */
function publishSpy(behaviour: (name: string) => boolean) {
  const calls: string[] = [];
  return {
    calls,
    publish: (name: string) => {
      calls.push(name);
      return { ok: behaviour(name), stderr: '' };
    },
  };
}

describe('ensureGroupPublished — re-publishes ONLY the missing members', () => {
  it('re-publishes exactly the members missing at the target, not the present ones', async () => {
    // core + kn-next landed; lib + db did NOT (the observed partial shape).
    const present = new Set(['@getknext/core', 'kn-next']);
    const { publish, calls } = publishSpy(() => true);

    const result = await ensureGroupPublished({
      members: MEMBERS,
      targetVersion: TARGET,
      probe: () => true,
      // After a member has been (re-)published, it resolves at the target.
      resolves: (name: string, version: string) =>
        version === TARGET && (present.has(name) || calls.includes(name)),
      publish,
      sleep: async () => {},
      maxAttempts: 5,
    });

    // Exactly the two missing members were re-published — core/kn-next never were.
    expect(calls.sort()).toEqual(['@getknext/db', '@getknext/lib']);
    expect(result.published.sort()).toEqual(['@getknext/db', '@getknext/lib']);
  });

  it('does nothing (no publish) when the whole group already resolves', async () => {
    const { publish, calls } = publishSpy(() => true);
    const result = await ensureGroupPublished({
      members: MEMBERS,
      targetVersion: TARGET,
      probe: () => true,
      resolves: (_name: string, version: string) => version === TARGET,
      publish,
      sleep: async () => {},
      maxAttempts: 5,
    });
    expect(calls).toEqual([]);
    expect(result.published).toEqual([]);
  });
});

describe('ensureGroupPublished — read-after-write lag', () => {
  it('publishes a missing member ONCE and waits out lag rather than re-publishing (immutability)', async () => {
    const { publish, calls } = publishSpy(() => true);
    // lib is missing; after we publish it, it stays unresolvable for one more
    // round (registry lag) before finally resolving. A second publish of an
    // already-published version would be a 403 — must NOT happen.
    let libResolveChecks = 0;
    const result = await ensureGroupPublished({
      members: MEMBERS,
      targetVersion: TARGET,
      probe: () => true,
      resolves: (name: string, version: string) => {
        if (version !== TARGET) return false;
        if (name === '@getknext/lib') {
          // published in round 0; first two post-publish checks lag → false,
          // then resolves.
          if (!calls.includes('@getknext/lib')) return false;
          libResolveChecks += 1;
          return libResolveChecks > 1;
        }
        return true;
      },
      publish,
      sleep: async () => {},
      maxAttempts: 5,
    });
    // lib published exactly once despite lag.
    expect(calls.filter((c) => c === '@getknext/lib').length).toBe(1);
    expect(result.published).toEqual(['@getknext/lib']);
  });
});

describe('ensureGroupPublished — absorbs an already-published 403 as proof-of-publication', () => {
  // The bug this covers: on the HAPPY path the upstream `changeset publish` step
  // already shipped a member, but it is not yet registry-visible at round 0
  // (read-after-write lag). It is NOT in publishedThisRun (heal never published
  // it), so the loop calls publish() on an already-published, immutable version —
  // npm returns a 403 "cannot publish over the previously published versions".
  // That 403 is POSITIVE PROOF the member is on the registry: the healer must
  // ABSORB it (treat as published, no failure, no re-hammer), and let the normal
  // resolve loop confirm it once lag clears.
  it('treats an npm "cannot publish over" 403 as published and does not re-publish that member', async () => {
    // lib was shipped by upstream publish but lags; publishing it yields the
    // benign 403. After the first (absorbed) publish attempt, lag clears and it
    // resolves. Every other member resolves immediately.
    const calls: string[] = [];
    let libAttempted = false;
    const result = await ensureGroupPublished({
      members: MEMBERS,
      targetVersion: TARGET,
      probe: () => true,
      resolves: (name: string, version: string) => {
        if (version !== TARGET) return false;
        if (name === '@getknext/lib') return libAttempted; // visible only after lag clears
        return true;
      },
      publish: (name: string) => {
        calls.push(name);
        if (name === '@getknext/lib') {
          libAttempted = true;
          return {
            ok: false,
            stderr:
              'npm error code E403\n' +
              'npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@getknext%2flib - ' +
              'You cannot publish over the previously published versions: 0.5.0.',
          };
        }
        return { ok: true, stderr: '' };
      },
      sleep: async () => {},
      maxAttempts: 5,
    });

    // lib was attempted exactly once (absorbed, never re-hammered) and the run
    // reports it as published — no throw.
    expect(calls.filter((c) => c === '@getknext/lib').length).toBe(1);
    expect(result.published).toContain('@getknext/lib');
  });
});

describe('ensureGroupPublished — fail closed', () => {
  it('throws GroupStillIncoherentError when a member stays missing after max retries', async () => {
    const { publish } = publishSpy(() => false); // publish never succeeds
    await expect(
      ensureGroupPublished({
        members: MEMBERS,
        targetVersion: TARGET,
        probe: () => true,
        resolves: (name: string, version: string) => version === TARGET && name !== '@getknext/lib', // lib never lands
        publish,
        sleep: async () => {},
        maxAttempts: 3,
      }),
    ).rejects.toBeInstanceOf(GroupStillIncoherentError);
  });

  it('does NOT absorb a non-benign 403 (auth/forbidden) — keeps retrying and fails closed', async () => {
    // A 403 that is NOT "cannot publish over an existing version" (e.g. auth) is
    // a real failure: it must NOT be swallowed as proof-of-publication. A
    // swallowed 403 would mark lib published and STOP retrying it after round 0;
    // a real failure must be RE-ATTEMPTED every round. lib is genuinely missing
    // and every publish is auth-rejected, so the run both keeps retrying lib AND
    // fails closed rather than certifying a partial group.
    const libCalls: string[] = [];
    const maxAttempts = 3;
    await expect(
      ensureGroupPublished({
        members: MEMBERS,
        targetVersion: TARGET,
        probe: () => true,
        resolves: (name: string, version: string) => version === TARGET && name !== '@getknext/lib',
        publish: (name: string) => {
          if (name === '@getknext/lib') {
            libCalls.push(name);
            return {
              ok: false,
              stderr:
                'npm error code E403\n' +
                'npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@getknext%2flib - ' +
                'Forbidden: you do not have permission to publish "@getknext/lib". Are you logged in?',
            };
          }
          return { ok: true, stderr: '' };
        },
        sleep: async () => {},
        maxAttempts,
      }),
    ).rejects.toBeInstanceOf(GroupStillIncoherentError);
    // Retried every round — NOT absorbed-and-skipped after the first attempt.
    expect(libCalls.length).toBe(maxAttempts);
  });

  it('throws RegistryUnreachableError when the reachability probe fails (never certifies from an unreachable registry)', async () => {
    const { publish } = publishSpy(() => true);
    await expect(
      ensureGroupPublished({
        members: MEMBERS,
        targetVersion: TARGET,
        probe: () => false,
        resolves: () => true,
        publish,
        sleep: async () => {},
        maxAttempts: 3,
      }),
    ).rejects.toBeInstanceOf(RegistryUnreachableError);
  });
});

describe('isAlreadyPublishedConflict — the exact #1360 wording', () => {
  it('absorbs npm E409 "Cannot publish over previously staged version" (the real production message)', () => {
    // Verbatim from release run 36040935670 (0.4.3) — the exact bug report.
    const result = {
      ok: false,
      stderr:
        'npm error code E409\n' +
        'npm error 409 Conflict - PUT https://registry.npmjs.org/@getknext%2fcore - ' +
        'Cannot publish over previously staged version "0.4.3".\n' +
        'npm error A complete log of this run can be found in: /home/runner/.npm/_logs/x-debug-0.log',
    };
    expect(isAlreadyPublishedConflict(result)).toBe(true);
  });

  it('still absorbs the older E403 "cannot publish over the previously published versions" wording', () => {
    const result = {
      ok: false,
      stderr:
        'npm error code E403\n' +
        'npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@getknext%2flib - ' +
        'You cannot publish over the previously published versions: 0.5.0.',
    };
    expect(isAlreadyPublishedConflict(result)).toBe(true);
  });

  it('does NOT absorb a real E409 that is not the version-conflict shape', () => {
    // A 409 for a different reason (hypothetical) must stay a real failure —
    // the match is on the specific "cannot publish over" / "staged|published
    // version" wording, never the bare status code.
    const result = {
      ok: false,
      stderr:
        'npm error code E409\nnpm error 409 Conflict - PUT https://registry.npmjs.org/@getknext%2fcore - ' +
        'a transient registry lock, try again later.',
    };
    expect(isAlreadyPublishedConflict(result)).toBe(false);
  });

  it('does NOT absorb an ok result, or one with no stderr/message at all', () => {
    expect(
      isAlreadyPublishedConflict({
        ok: true,
        stderr: 'Cannot publish over previously staged version',
      }),
    ).toBe(false);
    expect(isAlreadyPublishedConflict(undefined)).toBe(false);
    expect(isAlreadyPublishedConflict({ ok: false })).toBe(false);
  });
});

describe('pollResolves — retries a single registry read before giving up', () => {
  it('returns true as soon as resolves() flips, without exhausting maxAttempts', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const ok = await pollResolves({
      name: '@getknext/core',
      version: TARGET,
      resolves: () => {
        calls += 1;
        return calls >= 2; // false, then true
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      maxAttempts: 5,
    });
    expect(ok).toBe(true);
    expect(calls).toBe(2);
    expect(sleeps.length).toBe(1); // slept once, between attempt 1 and 2
  });

  it('returns false after exhausting maxAttempts, never oversleeping past the last attempt', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const ok = await pollResolves({
      name: '@getknext/core',
      version: TARGET,
      resolves: () => {
        calls += 1;
        return false;
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      maxAttempts: 3,
    });
    expect(ok).toBe(false);
    expect(calls).toBe(3);
    expect(sleeps.length).toBe(2); // no sleep after the LAST attempt
  });
});

describe('ensureGroupPublished — #1360 regression: an absorbed conflict is TERMINAL', () => {
  // The exact observed shape: all four members were genuinely published
  // upstream, but read-after-write lag made ALL of them look "missing" at
  // round 0. Every re-publish hit the benign conflict (proof-of-publication).
  // core and kn-next then lagged on `npm view` WORSE than lib/db — past what
  // used to be the OLD final re-check — and the run wrongly reported them
  // incoherent even though the conflict had already proven they were on the
  // registry. Once absorbed, a member must never re-enter "missing" no matter
  // how long ITS OWN registry-read lag runs — even past every retry round.
  it('does not fail the group when an absorbed member never resolves via npm view within the whole retry budget', async () => {
    const neverResolves = new Set(['@getknext/core', 'kn-next']); // #1360's stuck pair
    const publishCalls: string[] = [];
    const result = await ensureGroupPublished({
      members: MEMBERS,
      targetVersion: TARGET,
      probe: () => true,
      // Every member is "missing" at every read UNTIL its own publish attempt
      // has run (matching the observed log: the upstream publish step had
      // already shipped all four, but round-0 reads saw none of them). After
      // absorption, lib/db's lag clears; core/kn-next's NEVER does.
      resolves: (name: string) => publishCalls.includes(name) && !neverResolves.has(name),
      publish: (name: string) => {
        publishCalls.push(name);
        // Every member was already shipped upstream — every publish attempt
        // hits the immutable-version conflict, this run's exact wording.
        return {
          ok: false,
          stderr:
            'npm error code E409\nnpm error 409 Conflict - PUT https://registry.npmjs.org/x - ' +
            `Cannot publish over previously staged version "${TARGET}".`,
        };
      },
      sleep: async () => {},
      maxAttempts: 6,
    });

    // Every member absorbed exactly once (never re-hammered) and the whole
    // group is reported published — no throw, even though core/kn-next NEVER
    // resolved via `resolves()` at any point in the run.
    expect(new Set(publishCalls)).toEqual(new Set(MEMBERS));
    expect(publishCalls.filter((c) => c === '@getknext/core').length).toBe(1);
    expect(publishCalls.filter((c) => c === 'kn-next').length).toBe(1);
    expect(result.published.sort()).toEqual([...MEMBERS].sort());
    // The best-effort confirmation poll ran but could not confirm the two
    // stuck members — reported honestly, not silently dropped.
    expect(result.confirmed).not.toContain('@getknext/core');
    expect(result.confirmed).not.toContain('kn-next');
    expect(result.confirmed).toContain('@getknext/lib');
    expect(result.confirmed).toContain('@getknext/db');
  });

  it('polls before deciding a member is missing, so brief lag never triggers an unnecessary publish/conflict round-trip', async () => {
    // core is ALREADY published upstream but the first registry read lags;
    // the SECOND read (inside the inner poll, same round) sees it. No publish
    // call should ever happen for core.
    let coreReadCount = 0;
    const publishCalls: string[] = [];
    const result = await ensureGroupPublished({
      members: MEMBERS,
      targetVersion: TARGET,
      probe: () => true,
      resolves: (name: string) => {
        if (name === '@getknext/core') {
          coreReadCount += 1;
          return coreReadCount >= 2; // lag clears on the 2nd read
        }
        return true; // everyone else present immediately
      },
      publish: (name: string) => {
        publishCalls.push(name);
        return { ok: true, stderr: '' };
      },
      sleep: async () => {},
      maxAttempts: 5,
    });

    expect(publishCalls).toEqual([]); // never published — the lag cleared inside the poll
    expect(result.published).toEqual([]);
    expect(coreReadCount).toBeGreaterThanOrEqual(2);
  });
});
