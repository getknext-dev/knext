import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * #1458 — the first end-to-end `selfContained=true` compat dispatch (run
 * 36367366852) went 16/16 shards red, 100% deterministic, zero deploys
 * booted: `scripts/e2e-deploy.sh` passed `--self-contained true` while
 * `standalone-compile.mjs`'s validator accepts ONLY the literal string `"1"`
 * (`fail("--self-contained takes 1, got ...")` otherwise) — landed by N1
 * (#1456) after the harness's own comment was written and never updated.
 * Nobody caught it because `KNEXT_SELF_CONTAINED=1` is dispatch-only, never
 * scheduled.
 *
 * This is a LOCKSTEP assertion in the sense of `metrics-port-lockstep.test.ts`
 * and `compat-bun-lane-lockstep.test.ts`: it does not restate one literal on
 * both sides, it reads the value EACH harness script passes and the value
 * EACH compile script's own validator accepts, off their real source, and
 * asserts they cannot diverge. A change on either side that breaks the pair
 * reds this file — mutation-proved by hand (see the PR body), not merely
 * inspected.
 */

const REPO_ROOT = resolve(import.meta.dir, '..');

type Pair = {
  /** Human label for failure messages. */
  label: string;
  /** The harness script that forwards `--self-contained <value>`. */
  harnessPath: string;
  /** The compile script whose own validator accepts a specific literal. */
  compilePath: string;
  /** Extract the value the harness script passes, e.g. `(--self-contained 1)`. */
  harnessValue: (src: string) => string | null;
  /** Extract the literal the compile script's validator accepts. */
  acceptedValue: (src: string) => string | null;
};

const pairs: Pair[] = [
  {
    label: 'standalone (e2e-deploy.sh ↔ standalone-compile.mjs)',
    harnessPath: resolve(REPO_ROOT, 'scripts/e2e-deploy.sh'),
    compilePath: resolve(REPO_ROOT, 'packages/kn-next/src/adapters/standalone-compile.mjs'),
    harnessValue: (src) => {
      const m = src.match(/STANDALONE_COMPILE_ARGS\+=\(--self-contained\s+(\S+)\)/);
      return m ? m[1] : null;
    },
    acceptedValue: (src) => {
      // standalone-compile.mjs fails closed on anything but this literal —
      // read it from the fail() guard itself, not the SELF_CONTAINED const,
      // so a change that loosens/tightens the check is also caught.
      const m = src.match(
        /args\["self-contained"\]\s*!==\s*undefined\s*&&\s*args\["self-contained"\]\s*!==\s*"([^"]+)"/,
      );
      return m ? m[1] : null;
    },
  },
  {
    label: 'vinext (e2e-deploy-vinext.sh ↔ vinext-compile.mjs)',
    harnessPath: resolve(REPO_ROOT, 'scripts/e2e-deploy-vinext.sh'),
    compilePath: resolve(REPO_ROOT, 'packages/kn-next/src/adapters/vinext-compile.mjs'),
    harnessValue: (src) => {
      const m = src.match(/VINEXT_COMPILE_ARGS\+=\(--self-contained\s+(\S+)\)/);
      return m ? m[1] : null;
    },
    acceptedValue: (src) => {
      const m = src.match(/const SELF_CONTAINED = args\["self-contained"\] === "([^"]+)"/);
      return m ? m[1] : null;
    },
  },
];

describe('#1458 — harness self-contained flag value locksteps the compile script', () => {
  for (const pair of pairs) {
    it(`${pair.label}: the value passed equals the value accepted`, () => {
      const harnessSrc = readFileSync(pair.harnessPath, 'utf8');
      const compileSrc = readFileSync(pair.compilePath, 'utf8');

      const passed = pair.harnessValue(harnessSrc);
      const accepted = pair.acceptedValue(compileSrc);

      expect(
        passed,
        `could not find a "--self-contained <value>" forward in ${pair.harnessPath}`,
      ).not.toBeNull();
      expect(
        accepted,
        `could not find the accepted self-contained literal in ${pair.compilePath}`,
      ).not.toBeNull();

      expect(
        passed,
        `${pair.harnessPath} passes --self-contained ${passed}, but ` +
          `${pair.compilePath} only accepts "${accepted}" — a real dispatch ` +
          'with KNEXT_SELF_CONTAINED=1 fails or silently no-ops (#1458).',
      ).toBe(accepted);
    });
  }

  it('KNEXT_SELF_CONTAINED gating still guards both forwards (no bare, unconditional flag)', () => {
    for (const pair of pairs) {
      const harnessSrc = readFileSync(pair.harnessPath, 'utf8');
      expect(harnessSrc).toMatch(/if \[ "\$\{KNEXT_SELF_CONTAINED:-0\}" = "1" \]; then/);
    }
  });
});
