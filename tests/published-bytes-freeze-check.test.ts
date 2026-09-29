import { describe, expect, it } from 'bun:test';
import {
  decidePublishedBytesScope,
  OVERRIDE_MARKER_FIELD,
  overrideMarkerValidity,
  ROOT_BUILD_INPUT_FILES,
  touchesPublishableScope,
} from '../scripts/lib/published-bytes-freeze-check.mjs';

/**
 * `scripts/lib/published-bytes-freeze-check.mjs` (#1663) — the pure decision
 * half of the PR-time published-bytes freeze check. See that module's header
 * for the full design rationale; these tests cover every acceptance
 * criterion from the issue at the pure-function level, with the CLI wrapper's
 * own tests (`tests/published-bytes-freeze-check-cli.test.ts`) covering the
 * wiring (tag resolution, spawning the diff, exit codes, announcements).
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

describe('decidePublishedBytesScope', () => {
  const base = { changedFiles: ['packages/kn-next/src/index.ts'], packageDirs, now: NOW };

  it('SKIPS quickly when rcTag is null (no window open)', () => {
    const d = decidePublishedBytesScope({ ...base, pin: { rcTag: null } });
    expect(d.action).toBe('skip');
    expect(d.reason).toMatch(/rcTag is null/);
  });

  it('SKIPS quickly on a docs/CI-only PR even with a window open', () => {
    const d = decidePublishedBytesScope({
      ...base,
      pin: { rcTag: 'v1.0.0-rc.1' },
      changedFiles: ['docs/RELEASING.md'],
    });
    expect(d.action).toBe('skip');
    expect(d.reason).toMatch(/touches no path/);
  });

  it('PROCEEDS when rcTag is set and the PR touches package source', () => {
    const d = decidePublishedBytesScope({ ...base, pin: { rcTag: 'v1.0.0-rc.1' } });
    expect(d.action).toBe('proceed');
    if (d.action === 'proceed') {
      expect(d.rcTag).toBe('v1.0.0-rc.1');
      expect(d.matchedFiles).toEqual(['packages/kn-next/src/index.ts']);
    }
  });

  it('PROCEEDS on a package README edit (the exact #1663 acceptance example)', () => {
    const d = decidePublishedBytesScope({
      ...base,
      pin: { rcTag: 'v1.0.0-rc.1' },
      changedFiles: ['packages/kn-next/README.md'],
    });
    expect(d.action).toBe('proceed');
  });

  it('SKIPS when a valid override marker is present, even though scope is touched', () => {
    const d = decidePublishedBytesScope({
      ...base,
      pin: {
        rcTag: 'v1.0.0-rc.1',
        [OVERRIDE_MARKER_FIELD]: {
          date: '2026-09-25',
          expires: '2026-10-02',
          reason: 'intentional rc.2',
        },
      },
    });
    expect(d.action).toBe('skip');
    expect(d.reason).toMatch(/exempts this PR/);
  });

  it('does NOT skip on an EXPIRED override marker — falls through to proceed', () => {
    const d = decidePublishedBytesScope({
      ...base,
      pin: {
        rcTag: 'v1.0.0-rc.1',
        [OVERRIDE_MARKER_FIELD]: { date: '2026-08-01', expires: '2026-08-10', reason: 'stale' },
      },
    });
    expect(d.action).toBe('proceed');
  });

  it('treats a malformed (non-string, non-null) rcTag as SKIP rather than crashing', () => {
    const d = decidePublishedBytesScope({ ...base, pin: { rcTag: 42 } });
    expect(d.action).toBe('skip');
  });
});
