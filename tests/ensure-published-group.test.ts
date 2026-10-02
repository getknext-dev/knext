import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureGroupPublished,
  extractConflictVersion,
  fixedGroupVersionMismatches,
  GroupStillIncoherentError,
  isAlreadyPublishedConflict,
  pollResolves,
  prereleaseDistTag,
  RegistryUnreachableError,
} from '../scripts/ensure-published-group.mjs';

const SCRIPT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'ensure-published-group.mjs',
);

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

describe('isAlreadyPublishedConflict — the exact #1360 wording, version-scoped (#1364)', () => {
  it('absorbs npm E409 "Cannot publish over previously staged version" WHEN it names the target version', () => {
    // Verbatim from release run 36040935670 (0.4.3) — the exact bug report.
    const result = {
      ok: false,
      stderr:
        'npm error code E409\n' +
        'npm error 409 Conflict - PUT https://registry.npmjs.org/@getknext%2fcore - ' +
        'Cannot publish over previously staged version "0.4.3".\n' +
        'npm error A complete log of this run can be found in: /home/runner/.npm/_logs/x-debug-0.log',
    };
    expect(isAlreadyPublishedConflict(result, '0.4.3')).toBe(true);
  });

  it('still absorbs the older E403 "cannot publish over the previously published versions" wording, version-scoped', () => {
    const result = {
      ok: false,
      stderr:
        'npm error code E403\n' +
        'npm error 403 403 Forbidden - PUT https://registry.npmjs.org/@getknext%2flib - ' +
        'You cannot publish over the previously published versions: 0.5.0.',
    };
    expect(isAlreadyPublishedConflict(result, '0.5.0')).toBe(true);
  });

  it('#1364 finding 2: does NOT absorb a conflict naming a DIFFERENT version than the one being published', () => {
    // The exact hole: a conflict about 0.4.2 must never be read as proof 0.4.3
    // landed. Absorbing this would silently treat a stale/wrong-version
    // conflict as success.
    const result = {
      ok: false,
      stderr:
        'npm error code E409\nnpm error 409 Conflict - PUT https://registry.npmjs.org/@getknext%2fcore - ' +
        'Cannot publish over previously staged version "0.4.2".',
    };
    expect(isAlreadyPublishedConflict(result, '0.4.3')).toBe(false);
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
    expect(isAlreadyPublishedConflict(result, '0.4.3')).toBe(false);
  });

  it('fails closed on a conflict-shaped message with NO parseable version (never blindly absorbed)', () => {
    const result = {
      ok: false,
      stderr: 'npm error code EPUBLISHCONFLICT\nnpm error cannot publish over an existing thing',
    };
    expect(isAlreadyPublishedConflict(result, '0.4.3')).toBe(false);
  });

  it('does NOT absorb without a targetVersion to check against', () => {
    const result = {
      ok: false,
      stderr: 'Cannot publish over previously staged version "0.4.3".',
    };
    expect(isAlreadyPublishedConflict(result, undefined)).toBe(false);
    expect(isAlreadyPublishedConflict(result, '')).toBe(false);
  });

  it('does NOT absorb an ok result, or one with no stderr/message at all', () => {
    expect(
      isAlreadyPublishedConflict(
        {
          ok: true,
          stderr: 'Cannot publish over previously staged version "0.4.3"',
        },
        '0.4.3',
      ),
    ).toBe(false);
    expect(isAlreadyPublishedConflict(undefined, '0.4.3')).toBe(false);
    expect(isAlreadyPublishedConflict({ ok: false }, '0.4.3')).toBe(false);
  });
});

describe('extractConflictVersion — #1364 round 2: a trailing sentence period must not join the version', () => {
  it('does NOT swallow the sentence-ending period after a prerelease version (403 wording)', () => {
    // The exact bug: the old character-class shape put `.` INSIDE what an
    // identifier could match, so it greedily consumed the sentence period
    // too — "1.0.0-rc.1." (wrong) instead of "1.0.0-rc.1" (right).
    const text =
      'npm error 403 403 Forbidden - You cannot publish over the previously published versions: 1.0.0-rc.1.';
    expect(extractConflictVersion(text)).toBe('1.0.0-rc.1');
  });

  it('does NOT swallow the sentence-ending period after build metadata', () => {
    const text =
      'npm error 403 403 Forbidden - You cannot publish over the previously published versions: 1.0.0+abc.';
    expect(extractConflictVersion(text)).toBe('1.0.0+abc');
  });

  it('a prerelease version WITH multiple dot-separated identifiers still parses correctly, quoted (409 wording)', () => {
    const text = 'Cannot publish over previously staged version "2.0.0-alpha.beta.1".';
    expect(extractConflictVersion(text)).toBe('2.0.0-alpha.beta.1');
  });

  it('#1364 round 2 end-to-end: a real prerelease conflict IS absorbed once the trailing period is excluded', () => {
    const result = {
      ok: false,
      stderr:
        'npm error 403 403 Forbidden - You cannot publish over the previously published versions: 1.0.0-rc.1.',
    };
    expect(isAlreadyPublishedConflict(result, '1.0.0-rc.1')).toBe(true);
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

describe('fixedGroupVersionMismatches — #1364 finding 2: a fixed group must actually BE one version', () => {
  it('is empty (coherent) when every member manifest is at the target version', () => {
    const versionByName = new Map(MEMBERS.map((name) => [name, TARGET]));
    expect(fixedGroupVersionMismatches(MEMBERS, versionByName, TARGET)).toEqual([]);
  });

  it('reports a member whose on-disk manifest disagrees with the target version', () => {
    const versionByName = new Map(MEMBERS.map((name) => [name, TARGET]));
    versionByName.set('@getknext/db', '0.4.9'); // a stale/unbumped manifest
    const mismatches = fixedGroupVersionMismatches(MEMBERS, versionByName, TARGET);
    expect(mismatches).toEqual([{ name: '@getknext/db', version: '0.4.9' }]);
  });

  it('reports a member with NO manifest entry at all as a mismatch, not a crash', () => {
    const versionByName = new Map(
      MEMBERS.filter((n) => n !== 'kn-next').map((name) => [name, TARGET]),
    );
    const mismatches = fixedGroupVersionMismatches(MEMBERS, versionByName, TARGET);
    expect(mismatches).toEqual([{ name: 'kn-next', version: undefined }]);
  });

  it('reports every disagreeing member, not just the first', () => {
    const versionByName = new Map(MEMBERS.map((name) => [name, TARGET]));
    versionByName.set('@getknext/lib', '0.4.9');
    versionByName.set('@getknext/db', '0.5.1');
    const mismatches = fixedGroupVersionMismatches(MEMBERS, versionByName, TARGET);
    expect(mismatches.map((m) => m.name).sort()).toEqual(['@getknext/db', '@getknext/lib']);
  });
});

// #1591 round 2 (M1) — npm >= 11 refuses `npm publish` for a prerelease with
// no `--tag`. The heal path must derive that tag from the version itself.
describe('prereleaseDistTag — derives the npm dist-tag from the version, never hard-codes it', () => {
  it('extracts the first prerelease identifier as the tag (rc.1 -> rc)', () => {
    expect(prereleaseDistTag('1.0.0-rc.1')).toBe('rc');
  });

  it('a later rc of the same tuple still derives the same tag', () => {
    expect(prereleaseDistTag('1.0.0-rc.2')).toBe('rc');
  });

  it('is null for a plain (non-prerelease) release — publish keeps defaulting to latest', () => {
    expect(prereleaseDistTag('1.0.0')).toBeNull();
    expect(prereleaseDistTag('0.4.3')).toBeNull();
  });

  it('handles a different prerelease identifier, not just "rc"', () => {
    expect(prereleaseDistTag('2.1.0-beta.3')).toBe('beta');
  });

  it('is null for an unparseable version rather than guessing', () => {
    expect(prereleaseDistTag('not-a-version')).toBeNull();
  });
});

// #1591 round 3 finding 3 — nothing tested that main()'s OWN publish closure
// forwards the derived distTag through to npmPublish. `prereleaseDistTag`
// (above) and `npmPublish`'s real --tag forwarding
// (`tests/ensure-published-group-fake-npm.test.ts`) were both covered in
// round 2, but the WIRING between them lives only inside `main()`, which is
// not exported (it reads the real .changeset/config.json + real workspace
// and shells out to a real `npm view`/`npm publish`, so it cannot be spawned
// here the way the fake-npm suite spawns individual functions). Mutating
// `npmPublish(dirByName.get(name), registry, distTag)` to
// `…, registry, null)` in `main()` left every existing test green — a
// prerelease re-publish would silently ship without `--tag` and npm >= 11
// would refuse it, exactly the M1 defect round 2 already fixed once,
// regressed at the one call site nothing here read.
describe("main()'s publish closure — the derived distTag actually reaches npmPublish (#1591 round 3)", () => {
  const source = readFileSync(SCRIPT_PATH, 'utf8');

  it('the publish closure inside main() passes the npmPublish call the distTag variable, not a hardcoded value', () => {
    // Anchored on the exact call site main() builds for ensureGroupPublished's
    // `publish` callback — scan, don't enumerate: any edit to this call site
    // that stops passing the `distTag` binding through (a literal `null`, a
    // different identifier, a dropped third argument) fails this assertion.
    const anchor = 'return npmPublish(dirByName.get(name), registry, distTag);';
    expect(
      source,
      "main()'s publish closure must call npmPublish(dir, registry, distTag) verbatim — a " +
        'prerelease republish that drops distTag ships without --tag and npm >= 11 refuses it',
    ).toContain(anchor);
  });

  it('distTag itself is derived from prereleaseDistTag(targetVersion, readPreState()), never hard-coded', () => {
    expect(source).toContain('const distTag = prereleaseDistTag(targetVersion, readPreState());');
  });
});

// 1.3.0-rc.1 (integration/v1.3) publishes to dist-tag `next`, while the v1.0
// line keeps `rc` at 1.0.0-rc.5. `changeset publish` takes its dist-tag from
// `.changeset/pre.json`'s `tag` in pre mode — NOT from the version string — so
// a heal that derived `rc` from `1.3.0-rc.1` would re-publish a straggler to
// `rc` and move the tag the v1.0 credential reads. The heal must use the SAME
// tag `changeset publish` used.
describe('prereleaseDistTag — follows the changesets pre-mode tag when one is set', () => {
  it('pre mode {tag: next} + 1.3.0-rc.1 -> next (never the version-derived rc)', () => {
    expect(prereleaseDistTag('1.3.0-rc.1', { mode: 'pre', tag: 'next' })).toBe('next');
  });

  it('pre mode {tag: rc} + 1.0.0-rc.5 -> rc (the v1.0 line is unchanged)', () => {
    expect(prereleaseDistTag('1.0.0-rc.5', { mode: 'pre', tag: 'rc' })).toBe('rc');
  });

  it('no pre state -> falls back to the version-derived id', () => {
    expect(prereleaseDistTag('1.3.0-rc.1', null)).toBe('rc');
  });

  it('pre.json left in "exit" mode is not pre mode -> version-derived id', () => {
    expect(prereleaseDistTag('1.3.0-rc.1', { mode: 'exit', tag: 'next' })).toBe('rc');
  });

  it('a stable version is still null even in pre mode — never ships a stable off latest', () => {
    expect(prereleaseDistTag('1.3.0', { mode: 'pre', tag: 'next' })).toBeNull();
  });
});

// integration/v1.3 ONLY. Pins the branch's publish tag so 1.3.x can never land
// on `rc` (the v1.0 credential + nightlies read it) or `latest`. DELETE this
// block in the PR that merges integration/v1.3 into main after 1.0.0 GA (main
// exits pre mode then, and its own release decides its tag).
describe('integration/v1.3 — the fixed group publishes to dist-tag `next`', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const pre = JSON.parse(readFileSync(resolve(repoRoot, '.changeset/pre.json'), 'utf8'));
  const coreVersion = JSON.parse(
    readFileSync(resolve(repoRoot, 'packages/kn-next/package.json'), 'utf8'),
  ).version;

  it('.changeset/pre.json is in pre mode with tag `next`', () => {
    expect(pre.mode).toBe('pre');
    expect(pre.tag).toBe('next');
  });

  it('the heal tag for the tree version is `next` — never rc, never latest', () => {
    const tag = prereleaseDistTag(coreVersion, pre);
    expect(tag).toBe('next');
    expect(['rc', 'latest']).not.toContain(tag);
  });
});
