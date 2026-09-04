/**
 * S2 — the native-integrity ABSENCE exception gets a clock and an off switch.
 *
 * `sharp-addon-dlopen.mjs` warns-and-loads when there is no `.integrity.json`
 * beside the addon. That is the right default for a fleet that may still run
 * pre-pinning images, and it is bounded today only because both Dockerfiles fail
 * the build without a manifest — a property of two Dockerfiles, not of the
 * runtime. With no expiry and no fail-closed switch it is precisely the ADR-0044
 * shape: a deferral that quietly becomes the design.
 *
 * So two things are asserted here, and BOTH halves of each:
 *
 *   1. `KNEXT_REQUIRE_NATIVE_INTEGRITY=1` REFUSES an absent manifest — and the
 *      same tree without the variable still loads, so a shim that simply threw
 *      on absence could not pass. A tampered payload stays fatal either way.
 *   2. The exception is declared with a justification and an `expires`, read by
 *      the shared `dated-exemptions.mjs`. This test reds the day the clock runs
 *      out, forcing a human decision. The expiry is NOT enforced inside the shim
 *      on purpose: a wall-clock branch in the runtime would brick running pods
 *      at midnight, converting a documented debt into an outage.
 */

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  activeNativeIntegrityExemptions,
  NATIVE_INTEGRITY_ABSENCE,
  NATIVE_INTEGRITY_EXEMPTIONS,
} from '../scripts/lib/native-integrity-policy.mjs';

const SHIM = resolve(
  import.meta.dirname,
  '../packages/kn-next/src/adapters/sharp-addon-dlopen.mjs',
);

/** A staged native tree with NO manifest — the pre-pinning image. */
function stageUnpinned(): { dir: string; addon: string } {
  const dir = mkdtempSync(join(tmpdir(), 'knext-s2-unpinned-'));
  const lib = join(dir, 'native', 'sharp-linux-x64', 'lib');
  mkdirSync(lib, { recursive: true });
  const addon = join(lib, 'sharp-linux-x64.node');
  writeFileSync(addon, 'ADDON BYTES');
  return { dir, addon };
}

/** A staged tree WITH a matching manifest. */
function stagePinned(): { dir: string; addon: string } {
  const { dir, addon } = stageUnpinned();
  const sha = createHash('sha256').update(readFileSync(addon)).digest('hex');
  writeFileSync(
    join(dir, 'native', '.integrity.json'),
    JSON.stringify({
      version: 1,
      algorithm: 'sha256',
      packages: {},
      files: { 'sharp-linux-x64/lib/sharp-linux-x64.node': sha },
    }),
  );
  return { dir, addon };
}

/** Import the REAL shim with `process.dlopen` stubbed. */
function loadShim(
  addon: string,
  dir: string,
  extraEnv: Record<string, string> = {},
): { status: number; stderr: string; stdout: string } {
  const harness = join(dir, 'harness.mjs');
  writeFileSync(
    harness,
    `process.dlopen = (m) => { m.exports = { KNEXT_STUB: true }; };\n` +
      `const mod = await import(${JSON.stringify(`file://${SHIM}`)});\n` +
      `if (!mod.default?.KNEXT_STUB) { console.error('shim did not dlopen'); process.exit(3); }\n` +
      `console.log('DLOPENED');\n`,
  );
  const r = spawnSync(process.execPath, [harness], {
    encoding: 'utf8',
    env: { ...process.env, KNEXT_SHARP_ADDON: addon, ...extraEnv },
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

describe('S2 KNEXT_REQUIRE_NATIVE_INTEGRITY is a fail-closed switch', () => {
  it('REFUSES an absent manifest when the variable is 1', () => {
    const { dir, addon } = stageUnpinned();
    const r = loadShim(addon, dir, { KNEXT_REQUIRE_NATIVE_INTEGRITY: '1' });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('DLOPENED');
    expect(r.stderr).toContain('KNEXT_REQUIRE_NATIVE_INTEGRITY');
  });

  it('still warns-and-loads on absence WITHOUT the variable (the fleet default)', () => {
    // The other half. Without it, a shim that refuses on absence unconditionally
    // — the fleet outage this exception exists to prevent — would read as a pass.
    const { dir, addon } = stageUnpinned();
    const r = loadShim(addon, dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DLOPENED');
    expect(r.stderr).toContain('no native integrity manifest');
  });

  it('does not change the PINNED path — a matching tree loads with the variable set', () => {
    const { dir, addon } = stagePinned();
    const r = loadShim(addon, dir, { KNEXT_REQUIRE_NATIVE_INTEGRITY: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DLOPENED');
  });

  it('a TAMPERED payload is fatal with the variable set too', () => {
    const { dir, addon } = stagePinned();
    writeFileSync(addon, 'aDDON BYTES');
    const r = loadShim(addon, dir, { KNEXT_REQUIRE_NATIVE_INTEGRITY: '1' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('does not match the integrity manifest');
  });

  it('an explicit OFF value stays permissive — it does not fail a fleet closed by accident', () => {
    const { dir, addon } = stageUnpinned();
    for (const value of ['0', 'false', 'no', 'off', '', '  ']) {
      const r = loadShim(addon, dir, { KNEXT_REQUIRE_NATIVE_INTEGRITY: value });
      expect(r.status, `KNEXT_REQUIRE_NATIVE_INTEGRITY=${JSON.stringify(value)}`).toBe(0);
    }
  });

  it('the usual spellings of ON all fail closed — the switch does not silently mean nothing', () => {
    // The fail-OPEN bug this closes. `KNEXT_REQUIRE_NATIVE_INTEGRITY=true` used
    // to fall through to the permissive warn path with no signal at all, so an
    // operator who believed their fleet refused an unverifiable native tree had
    // in fact changed nothing. A security opt-in that quietly means "off" is
    // worse than no opt-in, because it is *believed*.
    const { dir, addon } = stageUnpinned();
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' 1 ', 'True']) {
      const r = loadShim(addon, dir, { KNEXT_REQUIRE_NATIVE_INTEGRITY: value });
      expect(r.status, `KNEXT_REQUIRE_NATIVE_INTEGRITY=${JSON.stringify(value)}`).not.toBe(0);
      expect(r.stdout).not.toContain('DLOPENED');
    }
  });

  it('an UNRECOGNISED value REFUSES rather than guessing which way it meant', () => {
    // Neither direction is safe to assume for a value nobody can parse:
    // guessing "off" is the fail-open bug above, and guessing "on" bricks a
    // fleet on a typo. Refusing names the mistake and stops. The message must
    // say what the accepted values are, or the operator cannot act on it.
    const { dir, addon } = stageUnpinned();
    for (const value of ['banana', '2', 'enabled', 'require']) {
      const r = loadShim(addon, dir, { KNEXT_REQUIRE_NATIVE_INTEGRITY: value });
      expect(r.status, `KNEXT_REQUIRE_NATIVE_INTEGRITY=${JSON.stringify(value)}`).not.toBe(0);
      expect(r.stderr).toContain('KNEXT_REQUIRE_NATIVE_INTEGRITY');
      expect(r.stderr).toMatch(/1 \| true \| yes \| on/);
    }
  });

  it('the switch is documented on the shim itself, where an operator reads it', () => {
    expect(readFileSync(SHIM, 'utf8')).toContain('KNEXT_REQUIRE_NATIVE_INTEGRITY');
  });
});

describe('S2 the absence exception carries a clock', () => {
  it('is declared exactly once, with a justification and an expiry', () => {
    expect(NATIVE_INTEGRITY_EXEMPTIONS).toHaveLength(1);
    const [entry] = NATIVE_INTEGRITY_EXEMPTIONS;
    expect(entry?.exception).toBe(NATIVE_INTEGRITY_ABSENCE);
    // The shared reader enforces shape (unknown key, missing `expires`, an
    // `expires` on or before `added`, a stub justification). Calling it IS the
    // assertion: a malformed entry throws.
    expect(activeNativeIntegrityExemptions(new Date(`${entry?.added}T12:00:00Z`))).toContain(
      NATIVE_INTEGRITY_ABSENCE,
    );
  });

  it('is STILL LIVE today — this reds on the expiry date and forces the decision', () => {
    // The whole point of the clock. When this goes red, the answer is to flip
    // the default to fail-closed (or to re-date the entry deliberately), never
    // to delete the assertion.
    expect(
      activeNativeIntegrityExemptions(),
      'the native-integrity absence exception has EXPIRED — flip the shim default to ' +
        'fail-closed, or re-date the entry in scripts/lib/native-integrity-policy.mjs with a ' +
        'reason. Do not weaken this test.',
    ).toContain(NATIVE_INTEGRITY_ABSENCE);
  });

  it('lapses once the expiry passes — the clock is real, not decorative', () => {
    const [entry] = NATIVE_INTEGRITY_EXEMPTIONS;
    const after = new Date(`${entry?.expires}T00:00:01Z`);
    expect(activeNativeIntegrityExemptions(after).size).toBe(0);
  });
});
