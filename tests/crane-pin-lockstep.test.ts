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
 * job), `supply-chain.yml`, and `operator-supply-chain.yml` was guarded
 * only by STEP NAME (`tests/operator-e2e-scale-image-preflight.test.ts`'s
 * `name.includes('Install crane')` checks) — the pin's actual VALUE
 * (version + checksum) had no guard of its own. A silently-drifted or
 * hand-edited checksum on any one copy would pass every existing test.
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
 *
 * rev-1390 review hardened `scanCranePins` itself (see
 * `scripts/lib/crane-pin.mjs`'s own header for the full rationale):
 *   - BUILT-INS ONLY — no more `yaml` import (a devDependency the nightly
 *     job never installs, which filed a false RED every night);
 *   - a download-URL cross-check that FAILS CLOSED on any of: the version
 *     written as an unresolved `${{ }}` expression, the version/checksum
 *     split across separate `env:` blocks, or values inlined directly into
 *     a `run:` step with no named env vars at all — every shape a reviewer
 *     named as a way a 5th copy could slip the lockstep check unnoticed.
 */

const WORKFLOWS_DIR = resolve(import.meta.dirname, '../.github/workflows');

/** A realistic synthetic "Install crane" step: named env vars AND the
 * download URL, matching every real copy's shape — required now that
 * `scanCranePins` cross-checks the two. */
function syntheticCraneStep(version: string, sha256: string): string {
  return (
    'jobs:\n  p:\n    steps:\n      - name: Install crane\n        env:\n' +
    `          CRANE_VERSION: ${version}\n` +
    `          CRANE_SHA256: ${sha256}\n` +
    '        run: |\n' +
    '          curl -fsSL -o /tmp/crane.tar.gz \\\n' +
    '            "https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_Linux_x86_64.tar.gz"\n'
  );
}

describe('scanCranePins — finds every CRANE_VERSION/CRANE_SHA256 pair', () => {
  it('finds at least 4 real occurrences (2 in operator-e2e-nightly.yml, 1 in supply-chain.yml, 1 in operator-supply-chain.yml) — floor, not a ceiling', () => {
    const pins = scanCranePins(WORKFLOWS_DIR);
    expect(pins.length).toBeGreaterThanOrEqual(4);
    const files = new Set(pins.map((p) => p.file));
    expect(files.has('operator-e2e-nightly.yml')).toBe(true);
    expect(files.has('supply-chain.yml')).toBe(true);
    expect(files.has('operator-supply-chain.yml')).toBe(true);
  });

  it('every occurrence has a well-formed version (vX.Y.Z) and a 64-hex sha256', () => {
    const pins = scanCranePins(WORKFLOWS_DIR);
    for (const p of pins) {
      expect(p.version, `${p.file}: bad version ${p.version}`).toMatch(/^v\d+\.\d+\.\d+$/);
      expect(p.sha256, `${p.file}: bad sha256 ${p.sha256}`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('self-test: parses a synthetic step env block (with its download URL, per the cross-check)', () => {
    const pins = scanCranePins(WORKFLOWS_DIR, {
      readSource: () => syntheticCraneStep('v9.9.9', 'a'.repeat(64)),
      listFiles: () => ['synthetic.yml'],
    });
    expect(pins).toEqual([{ file: 'synthetic.yml', version: 'v9.9.9', sha256: 'a'.repeat(64) }]);
  });

  it('a file with none of the three signals (no pin at all) is silently skipped, not a violation', () => {
    const pins = scanCranePins(WORKFLOWS_DIR, {
      readSource: () => 'jobs:\n  p:\n    steps:\n      - run: echo hi\n',
      listFiles: () => ['unrelated.yml'],
    });
    expect(pins).toEqual([]);
  });

  describe('rev-1390: the download-URL cross-check catches every named drift shape', () => {
    it('a CRANE_VERSION written as an unresolved ${{ }} expression is a VIOLATION, not silently dropped', () => {
      // The version regex correctly refuses to match `${{ inputs.x }}` (it is
      // not a version), so without the cross-check this file would silently
      // report ZERO pins — indistinguishable from "no crane step here at
      // all" — even though the download URL proves a crane install IS
      // happening, just with an unresolvable pin.
      const text =
        'jobs:\n  p:\n    steps:\n      - name: Install crane\n        env:\n' +
        '          CRANE_VERSION: ${{ inputs.craneVersion }}\n' +
        `          CRANE_SHA256: ${'a'.repeat(64)}\n` +
        '        run: |\n' +
        '          curl -fsSL -o /tmp/crane.tar.gz \\\n' +
        '            "https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_Linux_x86_64.tar.gz"\n';
      expect(() =>
        scanCranePins(WORKFLOWS_DIR, {
          readSource: () => text,
          listFiles: () => ['synthetic.yml'],
        }),
      ).toThrow(/UNACCOUNTED-FOR/);
    });

    it('version and checksum split across SEPARATE env blocks — ordinal pairing accepts it, no proximity required', () => {
      const text =
        'jobs:\n' +
        '  a:\n    steps:\n      - name: Install crane (part 1)\n        env:\n' +
        '          CRANE_VERSION: v9.9.9\n' +
        '  b:\n    steps:\n      - name: Install crane (part 2)\n        env:\n' +
        `          CRANE_SHA256: ${'b'.repeat(64)}\n` +
        '        run: |\n' +
        '          curl -fsSL -o /tmp/crane.tar.gz \\\n' +
        '            "https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_Linux_x86_64.tar.gz"\n';
      const pins = scanCranePins(WORKFLOWS_DIR, {
        readSource: () => text,
        listFiles: () => ['synthetic.yml'],
      });
      expect(pins).toEqual([{ file: 'synthetic.yml', version: 'v9.9.9', sha256: 'b'.repeat(64) }]);
    });

    it('TWO pairs in one file pair by ORDER of appearance (1st version with 1st checksum, 2nd with 2nd) — not by any other correspondence', () => {
      const text =
        `${syntheticCraneStep('v1.1.1', 'a'.repeat(64))}\n` +
        syntheticCraneStep('v2.2.2', 'b'.repeat(64));
      const pins = scanCranePins(WORKFLOWS_DIR, {
        readSource: () => text,
        listFiles: () => ['synthetic.yml'],
      });
      expect(pins).toEqual([
        { file: 'synthetic.yml', version: 'v1.1.1', sha256: 'a'.repeat(64) },
        { file: 'synthetic.yml', version: 'v2.2.2', sha256: 'b'.repeat(64) },
      ]);
    });

    it('values inlined into run: with NO named env vars at all — the URL-vs-pair count mismatch catches it', () => {
      const text =
        'jobs:\n  p:\n    steps:\n      - name: Install crane\n        run: |\n' +
        '          curl -fsSL -o /tmp/crane.tar.gz \\\n' +
        '            "https://github.com/google/go-containerregistry/releases/download/v9.9.9/go-containerregistry_Linux_x86_64.tar.gz"\n' +
        `          echo "${'c'.repeat(64)}  /tmp/crane.tar.gz" | sha256sum -c -\n`;
      expect(() =>
        scanCranePins(WORKFLOWS_DIR, {
          readSource: () => text,
          listFiles: () => ['synthetic.yml'],
        }),
      ).toThrow(/UNACCOUNTED-FOR/);
    });

    it('a 5th copy that names CRANE_VERSION/CRANE_SHA256 correctly but has NO download URL is still a violation (extra pair, no URL)', () => {
      const text =
        'jobs:\n  p:\n    steps:\n      - name: Install crane\n        env:\n' +
        '          CRANE_VERSION: v9.9.9\n' +
        `          CRANE_SHA256: ${'a'.repeat(64)}\n` +
        '        run: echo "no curl here"\n';
      expect(() =>
        scanCranePins(WORKFLOWS_DIR, {
          readSource: () => text,
          listFiles: () => ['synthetic.yml'],
        }),
      ).toThrow(/UNACCOUNTED-FOR/);
    });
  });

  describe('rev-ci-1390-1396: a commented pin must not offset a real, wrong inline install (#1390)', () => {
    it('a comment containing a CORRECT-looking CRANE_VERSION/CRANE_SHA256/URL text must not balance the counts against a real WRONG inline install with no named vars', () => {
      // The real "Install crane" step below inlines a WRONG version+checksum
      // directly into `run:` with no named env vars at all — exactly the
      // shape the download-URL cross-check exists to catch (see the "no
      // named env vars" test above), which on its own throws because
      // versions=0, checksums=0, urlCount=1.
      //
      // But a `#`-comment sits right above it, DOCUMENTING the historically
      // correct pin in prose — `CRANE_VERSION: v9.9.9` / `CRANE_SHA256:
      // <hex>` — and even mentions the download-URL host+path once. Without
      // comment stripping, that ONE comment line alone supplies
      // versions=1, checksums=1, urlCount=1 (comment) + urlCount=1 (real) =
      // 2 — no, more precisely: the comment contributes 1 version, 1
      // checksum, and 1 URL mention; the real inline step contributes 0
      // versions, 0 checksums, 1 URL. Totals: versions=1, checksums=1,
      // urlCount=2 — WOULD still mismatch (1 != 2) and throw... unless the
      // comment's URL mention is dropped (a comment that names the version
      // and checksum in prose but does not literally repeat the download
      // URL text, which is the realistic "documents the old pin" shape).
      // That is exactly the fixture below: the comment supplies exactly one
      // version and one checksum and NO url text, so pre-fix the totals are
      // versions=1, checksums=1, urlCount=1 (the real step's own URL) — a
      // perfect, silent balance — while the pin `scanCranePins` reports is
      // the COMMENT's (correct-looking) value, not the real wrong one the
      // step actually installs.
      const text =
        'jobs:\n  p:\n    steps:\n      - name: Install crane (version + checksum pinned)\n' +
        `        # Historically pinned to CRANE_VERSION: v9.9.9 CRANE_SHA256: ${'a'.repeat(64)} — matches the other copies.\n` +
        '        run: |\n' +
        '          curl -fsSL -o /tmp/crane.tar.gz \\\n' +
        '            "https://github.com/google/go-containerregistry/releases/download/v1.0.0-WRONG/go-containerregistry_Linux_x86_64.tar.gz"\n' +
        `          echo "${'b'.repeat(64)}  /tmp/crane.tar.gz" | sha256sum -c -\n`;
      expect(() =>
        scanCranePins(WORKFLOWS_DIR, {
          readSource: () => text,
          listFiles: () => ['synthetic.yml'],
        }),
      ).toThrow(/UNACCOUNTED-FOR/);
    });

    it("an INDENTED full-line comment (matching this repo's actual step indentation) is also stripped, not just column-0 comments", () => {
      const text =
        'jobs:\n  p:\n    steps:\n      - name: Install crane (version + checksum pinned)\n' +
        '        env:\n' +
        `            # CRANE_VERSION: v9.9.9\n` +
        `            # CRANE_SHA256: ${'a'.repeat(64)}\n` +
        '        run: |\n' +
        '          curl -fsSL -o /tmp/crane.tar.gz \\\n' +
        '            "https://github.com/google/go-containerregistry/releases/download/v1.0.0-WRONG/go-containerregistry_Linux_x86_64.tar.gz"\n' +
        `          echo "${'b'.repeat(64)}  /tmp/crane.tar.gz" | sha256sum -c -\n`;
      expect(() =>
        scanCranePins(WORKFLOWS_DIR, {
          readSource: () => text,
          listFiles: () => ['synthetic.yml'],
        }),
      ).toThrow(/UNACCOUNTED-FOR/);
    });

    it('non-vacuity: a genuinely commented-out DUPLICATE of the same real pin does not itself cause a false violation once stripped', () => {
      // Guard against over-correcting: stripping comments must not turn a
      // legitimate single real pin into zero signals (which would silently
      // skip the file instead of recognising the pin).
      const version = 'v9.9.9';
      const sha256 = 'a'.repeat(64);
      const text =
        `        # CRANE_VERSION: ${version} (comment only, no real effect)\n` +
        syntheticCraneStep(version, sha256);
      const pins = scanCranePins(WORKFLOWS_DIR, {
        readSource: () => text,
        listFiles: () => ['synthetic.yml'],
      });
      expect(pins).toEqual([{ file: 'synthetic.yml', version, sha256 }]);
    });
  });

  it('does not match a CRANE_VERSION that is an unresolved GitHub Actions expression as a real pin count (self-test: superseded by the cross-check test above, kept as a direct regression pin on the throw)', () => {
    expect(() =>
      scanCranePins(WORKFLOWS_DIR, {
        readSource: () =>
          'jobs:\n  p:\n    steps:\n      - name: Install crane\n        env:\n          CRANE_VERSION: ${{ inputs.craneVersion }}\n          CRANE_SHA256: ' +
          'a'.repeat(64) +
          '\n        run: |\n          curl ... "https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_Linux_x86_64.tar.gz"\n',
        listFiles: () => ['synthetic.yml'],
      }),
    ).toThrow();
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
