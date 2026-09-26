/**
 * Upstream-retirement harness (#1450). Three halves:
 *
 *  1. the toolchain the probes run IS the pinned one (Bun on PATH ==
 *     tests/bun-version-pins.test.ts's pin; installed vinext == @getknext/core's
 *     pin) — a probe against the wrong version proves nothing;
 *  2. every registry entry's repro still reproduces its upstream problem. When
 *     one stops reproducing, the bump that did it must delete the shim in the
 *     same PR: this test stays red until the entry and its markers are gone;
 *  3. every `// @knext-shim <id>` marker under packages/kn-next/src/adapters has
 *     an entry, every entry has at least one marker, and no marker is malformed.
 */
import { describe, expect, it } from 'bun:test';
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
              `Remove every \`// @knext-shim ${entry.id}\` shim and this registry entry in the same PR as the bump.\n` +
              `evidence: ${probe.evidence}`,
          );
        }
        expect(probe.stillBroken).toBe(true);
      },
      PROBE_TIMEOUT,
    );
  }
});

describe('upstream-retirement: @knext-shim markers ↔ registry', () => {
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
      writeFileSync(join(dir, 'a.mjs'), '// @knext-shim alpha\nexport {};\n');
      writeFileSync(join(dir, 'nested/deep/b.cjs'), 'x;\n  // @knext-shim beta-two\n');
      writeFileSync(
        join(dir, 'c.ts'),
        '/* @knext-shim gamma */\n// @knext-shim Bad_Id\n// @knext-shim\n',
      );
      writeFileSync(join(dir, '__tests__/d.test.ts'), '// @knext-shim ignored\n');
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
