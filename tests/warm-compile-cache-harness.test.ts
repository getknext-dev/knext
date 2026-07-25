import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runWarmup, STUB_FLOOR, stubServer } from './helpers/warm-compile-cache-harness';

/**
 * Regression guard for the RED-main CI flake in the baked-compile-cache tests
 * (#439 follow-up).
 *
 * Both bake tests drive the real `scripts/warm-compile-cache.sh` with a stub
 * server that must bind a TCP port. They hardcoded ports in the 343xx/344xx band,
 * which is:
 *   - never auto-assigned on macOS (ephemeral range starts at 49152) → always
 *     green locally, and
 *   - INSIDE the Linux default ephemeral range (32768–60999) → any outbound
 *     socket on a GitHub Actions runner can transiently hold it, the stub dies
 *     with EADDRINUSE, and the run exits 1.
 *
 * The fix is a shared harness that asks the kernel for a free port. These tests
 * pin BOTH halves of it: no hardcoded contended port survives in either bake
 * test, and concurrent runs never collide with one another.
 */

const BAKE_TESTS = [
  resolve(import.meta.dirname, '../apps/docs/dockerfile-compile-cache-bake.test.ts'),
  resolve(import.meta.dirname, '../apps/file-manager/dockerfile-compile-cache-bake.test.ts'),
];

// The Linux default `net.ipv4.ip_local_port_range`. A literal test port inside
// this window is the exact shape of the flake.
const LINUX_EPHEMERAL_LO = 32768;
const LINUX_EPHEMERAL_HI = 60999;

describe('the compile-cache bake tests do not hardcode a contended TCP port', () => {
  for (const file of BAKE_TESTS) {
    it(`${file.split('/').slice(-2).join('/')} allocates its port instead of hardcoding one`, () => {
      const src = readFileSync(file, 'utf8');
      const hardcoded = [...src.matchAll(/\bport\s*:\s*(\d{4,5})\b/g)].map((m) => Number(m[1]));
      const contended = hardcoded.filter((p) => p >= LINUX_EPHEMERAL_LO && p <= LINUX_EPHEMERAL_HI);
      expect(
        contended,
        `hardcoded ports inside the Linux ephemeral range (${LINUX_EPHEMERAL_LO}-${LINUX_EPHEMERAL_HI}) ` +
          'flake on CI while passing on macOS — use the shared harness, which binds :0',
      ).toEqual([]);
    });
  }
});

describe('the shared warm-up harness is collision-free under concurrency', () => {
  it('four simultaneous warm-ups each bake their own cache (impossible on one fixed port)', async () => {
    const runs = await Promise.all(
      Array.from({ length: 4 }, () =>
        runWarmup({
          cacheDir: mkdtempSync(join(tmpdir(), 'knext-harness-parallel-')),
          bootCmd: stubServer(true),
          healthPath: '/',
          env: STUB_FLOOR,
        }),
      ),
    );

    // Distinct ports: the kernel allocation is what removes the contention.
    expect(new Set(runs.map((r) => r.port)).size).toBe(runs.length);
    for (const r of runs) {
      expect(r.status, r.diagnostic).toBe(0);
      expect(r.output, r.diagnostic).toMatch(/baked 1 entries, 8 bytes/);
    }
  }, 60_000);
});
