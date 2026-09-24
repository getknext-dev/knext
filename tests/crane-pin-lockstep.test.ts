import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import {
  assertLockstep,
  filenameForPin,
  parseChecksumsTxt,
  scanCranePins,
  verifyPinAgainstChecksums,
} from '../scripts/lib/crane-pin.mjs';

/**
 * #1211 item 2: the crane checksum/version pin used by
 * `operator-e2e-nightly.yml` (TWO copies — the preflight job and the scale
 * job) and `supply-chain.yml` (the production pin #1210 cross-checked by
 * eye) was guarded only by STEP NAME
 * (`tests/operator-e2e-scale-image-preflight.test.ts`'s `name.includes('Install
 * crane')` checks) — the pin's actual VALUE (version + checksum) had no
 * guard of its own. A silently-drifted or hand-edited checksum on any one
 * copy would pass every existing test.
 *
 * Two guards, both here:
 *   1. LOCKSTEP (PR-gated) — every CRANE_VERSION/CRANE_SHA256 pair found
 *      across `.github/workflows/**` must be identical. A single accidental
 *      edit to one copy (or a copy that drifts during a future crane bump)
 *      reds immediately, rather than only being caught by someone eyeballing
 *      a diff (#1210's own review method).
 *   2. UPSTREAM VERIFICATION (pure logic here, wired to a nightly script) —
 *      the pinned checksum must match the REAL `checksums.txt` the
 *      `CRANE_VERSION` release actually published. Unreachable upstream is a
 *      FAILURE, never a pass (the same fail-closed rule as the action-pin and
 *      image-pin nightlies) — proved with an injected transport double, no
 *      live network from this test.
 */

const WORKFLOWS_DIR = resolve(import.meta.dirname, '../.github/workflows');

describe('scanCranePins — finds every CRANE_VERSION/CRANE_SHA256 pair', () => {
  it('finds at least 3 real occurrences (2 in operator-e2e-nightly.yml, 1 in supply-chain.yml) — floor, not a ceiling', () => {
    const pins = scanCranePins(WORKFLOWS_DIR);
    expect(pins.length).toBeGreaterThanOrEqual(3);
    const files = new Set(pins.map((p) => p.file));
    expect(files.has('operator-e2e-nightly.yml')).toBe(true);
    expect(files.has('supply-chain.yml')).toBe(true);
  });

  it('every occurrence has a well-formed version (vX.Y.Z) and a 64-hex sha256', () => {
    const pins = scanCranePins(WORKFLOWS_DIR);
    for (const p of pins) {
      expect(p.version, `${p.file}: bad version ${p.version}`).toMatch(/^v\d+\.\d+\.\d+$/);
      expect(p.sha256, `${p.file}: bad sha256 ${p.sha256}`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('self-test: parses a synthetic step env block', () => {
    const pins = scanCranePins(WORKFLOWS_DIR, {
      readSource: () =>
        'jobs:\n  p:\n    steps:\n      - name: Install crane\n        env:\n          CRANE_VERSION: v9.9.9\n          CRANE_SHA256: ' +
        'a'.repeat(64) +
        '\n',
      listFiles: () => ['synthetic.yml'],
    });
    expect(pins).toEqual([{ file: 'synthetic.yml', version: 'v9.9.9', sha256: 'a'.repeat(64) }]);
  });

  it('does not match a CRANE_VERSION that is an unresolved GitHub Actions expression, not a real version', () => {
    // A field named CRANE_VERSION with a value like `${{ inputs.craneVersion }}`
    // is not a version at all — matching it anyway would report a fake pin
    // whose "version" the lockstep/upstream checks could never resolve
    // sensibly against a real release.
    const pins = scanCranePins(WORKFLOWS_DIR, {
      readSource: () =>
        'jobs:\n  p:\n    steps:\n      - name: Install crane\n        env:\n          CRANE_VERSION: ${{ inputs.craneVersion }}\n          CRANE_SHA256: ' +
        'a'.repeat(64) +
        '\n',
      listFiles: () => ['synthetic.yml'],
    });
    expect(pins).toEqual([]);
  });
});

describe('assertLockstep — every scanned pin must be identical', () => {
  it('passes when all pins agree', () => {
    expect(() =>
      assertLockstep([
        { file: 'a.yml', version: 'v1.0.0', sha256: 'x'.repeat(64) },
        { file: 'b.yml', version: 'v1.0.0', sha256: 'x'.repeat(64) },
      ]),
    ).not.toThrow();
  });

  it('throws on ANY divergence — version or checksum', () => {
    expect(() =>
      assertLockstep([
        { file: 'a.yml', version: 'v1.0.0', sha256: 'x'.repeat(64) },
        { file: 'b.yml', version: 'v1.0.1', sha256: 'x'.repeat(64) },
      ]),
    ).toThrow(/lockstep/i);
    expect(() =>
      assertLockstep([
        { file: 'a.yml', version: 'v1.0.0', sha256: 'x'.repeat(64) },
        { file: 'b.yml', version: 'v1.0.0', sha256: 'y'.repeat(64) },
      ]),
    ).toThrow(/lockstep/i);
  });

  it('throws on an EMPTY pin set — a scanner that finds nothing proves nothing (non-vacuity)', () => {
    expect(() => assertLockstep([])).toThrow(/no crane pins found/i);
  });

  it('the real scanned pins across the repo are in lockstep TODAY (live, not just unit-tested)', () => {
    expect(() => assertLockstep(scanCranePins(WORKFLOWS_DIR))).not.toThrow();
  });
});

describe('parseChecksumsTxt — the real go-containerregistry release asset format', () => {
  it('parses "<sha256>  <filename>" lines into a map', () => {
    const text =
      `${'a'.repeat(64)}  go-containerregistry_Linux_x86_64.tar.gz\n` +
      `${'b'.repeat(64)}  go-containerregistry_Darwin_arm64.tar.gz\n`;
    const map = parseChecksumsTxt(text);
    expect(map.get('go-containerregistry_Linux_x86_64.tar.gz')).toBe('a'.repeat(64));
    expect(map.get('go-containerregistry_Darwin_arm64.tar.gz')).toBe('b'.repeat(64));
  });

  it('ignores blank lines and is tolerant of a leading "*" binary-mode marker', () => {
    const text = `\n${'c'.repeat(64)}  *go-containerregistry_Linux_x86_64.tar.gz\n\n`;
    const map = parseChecksumsTxt(text);
    expect(map.get('go-containerregistry_Linux_x86_64.tar.gz')).toBe('c'.repeat(64));
  });

  it('throws on a body with no parseable lines at all (fail closed on a malformed/empty asset)', () => {
    expect(() => parseChecksumsTxt('not a checksums file\n')).toThrow();
    expect(() => parseChecksumsTxt('')).toThrow();
  });
});

describe('filenameForPin — the exact release asset this workflow downloads', () => {
  it('is the Linux x86_64 tarball, matching the curl URL in the workflow', () => {
    expect(filenameForPin()).toBe('go-containerregistry_Linux_x86_64.tar.gz');
  });
});

describe('verifyPinAgainstChecksums — fail-closed comparison', () => {
  const filename = filenameForPin();

  it('passes when the pinned sha256 matches the real checksums map', () => {
    const map = new Map([[filename, 'd'.repeat(64)]]);
    expect(() =>
      verifyPinAgainstChecksums({ version: 'v1.0.0', sha256: 'd'.repeat(64) }, map),
    ).not.toThrow();
  });

  it('throws when the pinned sha256 does NOT match upstream', () => {
    const map = new Map([[filename, 'd'.repeat(64)]]);
    expect(() =>
      verifyPinAgainstChecksums({ version: 'v1.0.0', sha256: 'e'.repeat(64) }, map),
    ).toThrow(/does not match/i);
  });

  it('throws when the release checksums map has no entry for this filename (fail closed, never silently skip)', () => {
    const map = new Map([['some-other-file.tar.gz', 'd'.repeat(64)]]);
    expect(() =>
      verifyPinAgainstChecksums({ version: 'v1.0.0', sha256: 'd'.repeat(64) }, map),
    ).toThrow(/no checksums entry/i);
  });
});
