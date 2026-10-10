import { describe, expect, it } from 'bun:test';
import {
  decidePublishedBytesScope,
  OVERRIDE_MARKER_FIELD,
  overrideMarkerIntroducedByPr,
  overrideMarkerValidity,
  PIN_FILE,
  PIN_FILE_V13,
  ROOT_BUILD_INPUT_FILES,
  releaseLine,
  selectPinFile,
  touchesPublishableScope,
} from '../scripts/lib/published-bytes-freeze-check.mjs';

/**
 * `scripts/lib/published-bytes-freeze-check.mjs` (#1663) — the pure decision
 * half of the PR-time published-bytes freeze check. See that module's header
 * for the full design rationale; these tests cover every acceptance
 * criterion from the issue at the pure-function level, with the CLI wrapper's
 * own tests (`tests/published-bytes-freeze-check-cli.test.ts`) covering the
 * wiring (tag resolution, spawning the diff, exit codes, announcements).
 *
 * Round 2 (PR #1680 review): `decidePublishedBytesScope` now takes
 * `basePin`/`headPin`/`mergeBasePin` instead of a single `pin` — see the
 * module header's "WHICH PIN STATE" section. The suite below covers the four
 * scenarios that review named explicitly: closing the window together with a
 * bytes change must still proceed; closing the window ALONE must skip; an
 * override marker inherited from the merge base must NOT be honoured; one
 * introduced by this PR must be.
 */

const NOW = new Date('2026-09-30T00:00:00Z');
const packageDirs = ['packages/kn-next', 'packages/lib', 'packages/db', 'packages/kn-next-alias'];

describe('touchesPublishableScope', () => {
  it('matches a file directly under a publishable package directory', () => {
    const r = touchesPublishableScope({
      changedFiles: ['packages/kn-next/src/cli/deploy.ts'],
      packageDirs,
    });
    expect(r.touches).toBe(true);
    expect(r.matched).toEqual(['packages/kn-next/src/cli/deploy.ts']);
  });

  it('matches a package README (npm always packs it regardless of the files allowlist)', () => {
    const r = touchesPublishableScope({
      changedFiles: ['packages/kn-next/README.md'],
      packageDirs,
    });
    expect(r.touches).toBe(true);
  });

  it('matches a root build-input file (e.g. bun.lock, which pins devDependency versions)', () => {
    const r = touchesPublishableScope({ changedFiles: ['bun.lock'], packageDirs });
    expect(r.touches).toBe(true);
    expect(r.matched).toEqual(['bun.lock']);
  });

  it('does NOT match a docs-only or CI-only change', () => {
    const r = touchesPublishableScope({
      changedFiles: ['docs/RELEASING.md', '.github/workflows/ci.yml'],
      packageDirs,
    });
    expect(r.touches).toBe(false);
    expect(r.matched).toEqual([]);
  });

  it('does NOT match a similarly-named but unrelated package directory (prefix boundary)', () => {
    // packages/kn-next-action is a real, DIFFERENT workspace member; a naive
    // startsWith("packages/kn-next") would wrongly absorb it.
    const r = touchesPublishableScope({
      changedFiles: ['packages/kn-next-action/src/index.ts'],
      packageDirs: ['packages/kn-next'],
    });
    expect(r.touches).toBe(false);
  });

  it('matches the package directory itself, not only files below it', () => {
    const r = touchesPublishableScope({ changedFiles: ['packages/kn-next'], packageDirs });
    expect(r.touches).toBe(true);
  });

  it('ROOT_BUILD_INPUT_FILES is used as the default when not overridden', () => {
    for (const f of ROOT_BUILD_INPUT_FILES) {
      const r = touchesPublishableScope({ changedFiles: [f], packageDirs: [] });
      expect(r.touches).toBe(true);
    }
  });

  it('does NOT match the credential pin file itself (never a package dir or root build input)', () => {
    // Load-bearing for decidePublishedBytesScope's "no separate pin-only
    // case needed" claim — a diff touching only the pin file must already
    // fail this check on its own.
    const r = touchesPublishableScope({
      changedFiles: ['.github/compat-credential-ref.json'],
      packageDirs,
    });
    expect(r.touches).toBe(false);
  });
});

describe('overrideMarkerValidity', () => {
  const validMarker = {
    [OVERRIDE_MARKER_FIELD]: {
      date: '2026-09-25',
      expires: '2026-10-02',
      reason: 'intentional rc.2',
    },
  };

  it('is invalid when no marker is present', () => {
    expect(overrideMarkerValidity({}, NOW).valid).toBe(false);
    expect(overrideMarkerValidity(null, NOW).valid).toBe(false);
  });

  it('is valid for a well-formed, non-expired, capped marker', () => {
    const r = overrideMarkerValidity(validMarker, NOW);
    expect(r.valid).toBe(true);
  });

  it('is invalid once expired', () => {
    const pin = {
      [OVERRIDE_MARKER_FIELD]: { date: '2026-09-01', expires: '2026-09-10', reason: 'x' },
    };
    expect(overrideMarkerValidity(pin, NOW).valid).toBe(false);
  });

  it('is invalid when dated in the future relative to now', () => {
    const pin = {
      [OVERRIDE_MARKER_FIELD]: { date: '2026-10-05', expires: '2026-10-10', reason: 'x' },
    };
    expect(overrideMarkerValidity(pin, NOW).valid).toBe(false);
  });

  it('is invalid when the span from today exceeds the 14-day cap', () => {
    const pin = {
      [OVERRIDE_MARKER_FIELD]: { date: '2026-09-01', expires: '2026-10-20', reason: 'x' },
    };
    expect(overrideMarkerValidity(pin, NOW).valid).toBe(false);
  });

  it('is invalid with a missing reason', () => {
    const pin = {
      [OVERRIDE_MARKER_FIELD]: { date: '2026-09-25', expires: '2026-10-02', reason: '  ' },
    };
    expect(overrideMarkerValidity(pin, NOW).valid).toBe(false);
  });

  it('is invalid on a malformed calendar date (2026-02-30)', () => {
    const pin = {
      [OVERRIDE_MARKER_FIELD]: { date: '2026-02-30', expires: '2026-03-05', reason: 'x' },
    };
    expect(overrideMarkerValidity(pin, NOW).valid).toBe(false);
  });
});

describe('overrideMarkerIntroducedByPr (#1635 rule, applied to publishedBytesBumpMarker)', () => {
  const marker = { date: '2026-09-25', expires: '2026-10-02', reason: 'intentional rc.2' };

  it('is false when head carries no marker at all', () => {
    expect(overrideMarkerIntroducedByPr({}, {})).toBe(false);
  });

  it('is true when merge-base has no marker but head does (a brand-new authorization)', () => {
    expect(overrideMarkerIntroducedByPr({}, { [OVERRIDE_MARKER_FIELD]: marker })).toBe(true);
  });

  it('is false when merge-base already carries the SAME marker (inherited, not introduced)', () => {
    const mergeBasePin = { rcTag: 'v1.0.0-rc.1', [OVERRIDE_MARKER_FIELD]: marker };
    const headPin = { rcTag: 'v1.0.0-rc.1', [OVERRIDE_MARKER_FIELD]: marker };
    expect(overrideMarkerIntroducedByPr(mergeBasePin, headPin)).toBe(false);
  });

  it('is true when head changes the date (a new, reviewed authorization replacing a stale one)', () => {
    const mergeBasePin = { [OVERRIDE_MARKER_FIELD]: marker };
    const headPin = { [OVERRIDE_MARKER_FIELD]: { ...marker, date: '2026-09-29' } };
    expect(overrideMarkerIntroducedByPr(mergeBasePin, headPin)).toBe(true);
  });

  it('is true when head changes the reason', () => {
    const mergeBasePin = { [OVERRIDE_MARKER_FIELD]: marker };
    const headPin = { [OVERRIDE_MARKER_FIELD]: { ...marker, reason: 'a different justification' } };
    expect(overrideMarkerIntroducedByPr(mergeBasePin, headPin)).toBe(true);
  });

  it('is false when only expires changes (narrowing/widening the span is not a new authorization)', () => {
    const mergeBasePin = { [OVERRIDE_MARKER_FIELD]: marker };
    const headPin = { [OVERRIDE_MARKER_FIELD]: { ...marker, expires: '2026-10-01' } };
    expect(overrideMarkerIntroducedByPr(mergeBasePin, headPin)).toBe(false);
  });
});

describe('decidePublishedBytesScope', () => {
  const base = { changedFiles: ['packages/kn-next/src/index.ts'], packageDirs, now: NOW };

  it('SKIPS quickly when rcTag is null at base (no window open before this PR)', () => {
    const d = decidePublishedBytesScope({
      ...base,
      basePin: { rcTag: null },
      headPin: { rcTag: null },
    });
    expect(d.action).toBe('skip');
    expect(d.reason).toMatch(/rcTag is null at this PR's base/);
  });

  it('SKIPS quickly on a docs/CI-only PR even with a window open at base', () => {
    const d = decidePublishedBytesScope({
      ...base,
      basePin: { rcTag: 'v1.0.0-rc.1' },
      headPin: { rcTag: 'v1.0.0-rc.1' },
      changedFiles: ['docs/RELEASING.md'],
    });
    expect(d.action).toBe('skip');
    expect(d.reason).toMatch(/touches no path/);
  });

  it('PROCEEDS when rcTag is set at base and the PR touches package source', () => {
    const d = decidePublishedBytesScope({
      ...base,
      basePin: { rcTag: 'v1.0.0-rc.1' },
      headPin: { rcTag: 'v1.0.0-rc.1' },
    });
    expect(d.action).toBe('proceed');
    if (d.action === 'proceed') {
      expect(d.rcTag).toBe('v1.0.0-rc.1');
      expect(d.matchedFiles).toEqual(['packages/kn-next/src/index.ts']);
    }
  });

  it('PROCEEDS on a package README edit (the exact #1663 acceptance example)', () => {
    const d = decidePublishedBytesScope({
      ...base,
      basePin: { rcTag: 'v1.0.0-rc.1' },
      headPin: { rcTag: 'v1.0.0-rc.1' },
      changedFiles: ['packages/kn-next/README.md'],
    });
    expect(d.action).toBe('proceed');
  });

  it('SKIPS when a valid override marker introduced by this PR is present, even though scope is touched', () => {
    const d = decidePublishedBytesScope({
      ...base,
      basePin: { rcTag: 'v1.0.0-rc.1' },
      headPin: {
        rcTag: 'v1.0.0-rc.1',
        [OVERRIDE_MARKER_FIELD]: {
          date: '2026-09-25',
          expires: '2026-10-02',
          reason: 'intentional rc.2',
        },
      },
      // mergeBasePin defaults to basePin, which carries no marker — so this
      // marker counts as introduced by this PR.
    });
    expect(d.action).toBe('skip');
    expect(d.reason).toMatch(/introduced by this PR exempts it/);
  });

  it('does NOT skip on an EXPIRED override marker — falls through to proceed', () => {
    const d = decidePublishedBytesScope({
      ...base,
      basePin: { rcTag: 'v1.0.0-rc.1' },
      headPin: {
        rcTag: 'v1.0.0-rc.1',
        [OVERRIDE_MARKER_FIELD]: { date: '2026-08-01', expires: '2026-08-10', reason: 'stale' },
      },
    });
    expect(d.action).toBe('proceed');
  });

  it('treats a malformed (non-string, non-null) rcTag at base as SKIP rather than crashing', () => {
    const d = decidePublishedBytesScope({
      ...base,
      basePin: { rcTag: 42 },
      headPin: { rcTag: 42 },
    });
    expect(d.action).toBe('skip');
  });

  // ── Round 2 (PR #1680 review): the four scenarios named explicitly ───────

  it('a diff that CLOSES the window together with a published-bytes change still PROCEEDS', () => {
    const d = decidePublishedBytesScope({
      basePin: { rcTag: 'v1.0.0-rc.1' },
      headPin: { rcTag: null },
      mergeBasePin: { rcTag: 'v1.0.0-rc.1' },
      changedFiles: ['.github/compat-credential-ref.json', 'packages/kn-next/src/index.ts'],
      packageDirs,
      now: NOW,
    });
    expect(d.action).toBe('proceed');
    if (d.action === 'proceed') {
      expect(d.rcTag).toBe('v1.0.0-rc.1');
    }
  });

  it('a diff that CLOSES the window and touches nothing else SKIPS', () => {
    const d = decidePublishedBytesScope({
      basePin: { rcTag: 'v1.0.0-rc.1' },
      headPin: { rcTag: null },
      mergeBasePin: { rcTag: 'v1.0.0-rc.1' },
      changedFiles: ['.github/compat-credential-ref.json'],
      packageDirs,
      now: NOW,
    });
    expect(d.action).toBe('skip');
  });

  it('an override marker INHERITED from the merge base (not introduced by this PR) is NOT honoured', () => {
    const marker = { date: '2026-09-25', expires: '2026-10-02', reason: 'intentional rc.2' };
    const d = decidePublishedBytesScope({
      basePin: { rcTag: 'v1.0.0-rc.1', [OVERRIDE_MARKER_FIELD]: marker },
      headPin: { rcTag: 'v1.0.0-rc.1', [OVERRIDE_MARKER_FIELD]: marker },
      mergeBasePin: { rcTag: 'v1.0.0-rc.1', [OVERRIDE_MARKER_FIELD]: marker },
      changedFiles: ['packages/kn-next/src/index.ts'],
      packageDirs,
      now: NOW,
    });
    expect(d.action).toBe('proceed');
  });

  it('an override marker INTRODUCED BY THIS PR (absent at merge base) IS honoured', () => {
    const marker = { date: '2026-09-25', expires: '2026-10-02', reason: 'intentional rc.2' };
    const d = decidePublishedBytesScope({
      basePin: { rcTag: 'v1.0.0-rc.1' },
      headPin: { rcTag: 'v1.0.0-rc.1', [OVERRIDE_MARKER_FIELD]: marker },
      mergeBasePin: { rcTag: 'v1.0.0-rc.1' },
      changedFiles: ['packages/kn-next/src/index.ts'],
      packageDirs,
      now: NOW,
    });
    expect(d.action).toBe('skip');
  });

  it('mergeBasePin defaults to basePin when omitted', () => {
    const marker = { date: '2026-09-25', expires: '2026-10-02', reason: 'intentional rc.2' };
    // basePin carries the SAME marker as headPin -> not introduced, since
    // mergeBasePin defaults to basePin.
    const d = decidePublishedBytesScope({
      basePin: { rcTag: 'v1.0.0-rc.1', [OVERRIDE_MARKER_FIELD]: marker },
      headPin: { rcTag: 'v1.0.0-rc.1', [OVERRIDE_MARKER_FIELD]: marker },
      changedFiles: ['packages/kn-next/src/index.ts'],
      packageDirs,
      now: NOW,
    });
    expect(d.action).toBe('proceed');
  });

  it('opening a window for the first time in this PR (base null -> head set) is unrestricted, mirroring the sibling guard', () => {
    const d = decidePublishedBytesScope({
      basePin: { rcTag: null },
      headPin: { rcTag: 'v1.0.0-rc.1' },
      changedFiles: ['packages/kn-next/src/index.ts'],
      packageDirs,
      now: NOW,
    });
    expect(d.action).toBe('skip');
    expect(d.reason).toMatch(/rcTag is null at this PR's base/);
  });
});

describe('release-line scope (#2098): the pin guards the line whose bytes are credentialed, not whatever main carries', () => {
  const pinned = { rcTag: 'v1.0.0-rc.6' };
  const args = {
    basePin: pinned,
    headPin: pinned,
    changedFiles: ['packages/kn-next/src/index.ts'],
    packageDirs,
    now: NOW,
  };

  it('releaseLine: major.minor of a version or an rc tag; null when unparseable', () => {
    expect(releaseLine('1.3.0')).toBe('1.3');
    expect(releaseLine('v1.3.0-rc.10')).toBe('1.3');
    expect(releaseLine('1.0.0-rc.6')).toBe('1.0');
    expect(releaseLine('v2.10.4')).toBe('2.10');
    expect(releaseLine('not-a-version')).toBeNull();
    expect(releaseLine('')).toBeNull();
    expect(releaseLine(undefined)).toBeNull();
  });

  it('(a) SKIPS with a visible reason when the base carries a different line than the pinned tag (main on 1.3, pin v1.0.0-rc.6)', () => {
    const d = decidePublishedBytesScope({ ...args, baseVersion: '1.3.0' });
    expect(d.action).toBe('skip');
    expect(d.reason).toMatch(/line 1\.3/);
    expect(d.reason).toMatch(/line 1\.0/);
    expect(d.reason).toMatch(/not the line whose bytes are credentialed/);
  });

  it('(b) still PROCEEDS when the base carries the SAME line as the pinned tag', () => {
    const d = decidePublishedBytesScope({ ...args, baseVersion: '1.0.4' });
    expect(d.action).toBe('proceed');
  });

  it('(b) still PROCEEDS on the 1.3 line against a v1.3 rc pin', () => {
    const v13 = { rcTag: 'v1.3.0-rc.10', line: 'v1.3' };
    const d = decidePublishedBytesScope({
      ...args,
      basePin: v13,
      headPin: v13,
      baseVersion: '1.3.0',
    });
    expect(d.action).toBe('proceed');
  });

  it('the line skip comes before the scope check: a docs-only PR on a mismatched line reports the line reason', () => {
    const d = decidePublishedBytesScope({
      ...args,
      baseVersion: '1.3.0',
      changedFiles: ['docs/x.md'],
    });
    expect(d.action).toBe('skip');
    expect(d.reason).toMatch(/not the line whose bytes are credentialed/);
  });

  it('still PROCEEDS when no baseVersion is supplied (fail closed: an unknown line is guarded)', () => {
    expect(decidePublishedBytesScope(args).action).toBe('proceed');
  });

  it('still PROCEEDS when the base version is unparseable (fail closed)', () => {
    expect(decidePublishedBytesScope({ ...args, baseVersion: 'garbage' }).action).toBe('proceed');
  });
});

describe('selectPinFile (#2098): pick the pin whose line this base is credentialing', () => {
  const v10 = { file: PIN_FILE, pin: { rcTag: 'v1.0.0-rc.6' } };
  const v13 = { file: PIN_FILE_V13, pin: { rcTag: 'v1.3.0-rc.10', line: 'v1.3' } };
  const candidates = [v10, v13];

  it('main on 1.3 does NOT select the v1.3 pin (credential runs pack from the rc tag cut on integration/v1.3, not main) — falls back to the primary pin', () => {
    expect(selectPinFile({ baseVersion: '1.3.0', baseRef: 'main', candidates })).toBe(PIN_FILE);
  });

  it('integration/v1.3 on 1.3 selects the v1.3 pin (bare and refs/heads/-qualified)', () => {
    expect(selectPinFile({ baseVersion: '1.3.0', baseRef: 'integration/v1.3', candidates })).toBe(
      PIN_FILE_V13,
    );
    expect(
      selectPinFile({ baseVersion: '1.3.0', baseRef: 'refs/heads/integration/v1.3', candidates }),
    ).toBe(PIN_FILE_V13);
  });

  it('a base on the v1.0 line selects the primary pin regardless of its ref', () => {
    expect(selectPinFile({ baseVersion: '1.0.4', baseRef: 'main', candidates })).toBe(PIN_FILE);
    expect(selectPinFile({ baseVersion: '1.0.4', baseRef: 'release/1.x', candidates })).toBe(
      PIN_FILE,
    );
  });

  it('a v1.3 pin with a null rcTag (window closed) is never selected', () => {
    const closed = { file: PIN_FILE_V13, pin: { rcTag: null, line: 'v1.3' } };
    expect(
      selectPinFile({
        baseVersion: '1.3.0',
        baseRef: 'integration/v1.3',
        candidates: [v10, closed],
      }),
    ).toBe(PIN_FILE);
  });

  it('an unknown base ref or an unparseable version falls back to the primary pin (fail closed: guarded as before)', () => {
    expect(selectPinFile({ baseVersion: 'garbage', baseRef: 'integration/v1.3', candidates })).toBe(
      PIN_FILE,
    );
    expect(selectPinFile({ baseVersion: '1.3.0', baseRef: undefined, candidates })).toBe(PIN_FILE);
  });
});
