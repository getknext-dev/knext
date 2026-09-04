/**
 * T6c — `singleExec` must not be a STRING-IDENTITY test.
 *
 * `compat-smoke.mjs` decides its whole execution model from one boolean:
 * whether `SERVER_CMD` "is" `SERVER_PATH`. Both are env-overridable, and the
 * comparison was `SERVER_CMD === SERVER_PATH`. Two spellings of the same file —
 * a symlink, a relative path, a trailing slash, a `./` prefix — compare unequal,
 * and the runner then silently takes the STANDALONE branch: it stages a preload
 * (`:300-318`), spawns the binary with a script argument it does not accept, and
 * check (h) re-enters the `--version` probe that boots a second server (the hang
 * measured at sprint close; the fix at `:491` is guarded by exactly this
 * boolean). A mode flip is therefore not a cosmetic difference — it is the
 * difference between the smoke running and the smoke hanging.
 *
 * The fix is `realpathSync` on both sides plus an explicit `SMOKE_MODE` that,
 * when set, must AGREE with what the paths say — a disagreement is a loud
 * failure rather than a silent mode flip.
 *
 * Both halves are asserted: the widened cases resolve to single-exec, AND a
 * genuinely different file still resolves to standalone. Without the second, a
 * `resolveSmokeMode` hard-coded to `true` would pass.
 */

import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { resolveSmokeMode } from '../apps/file-manager/scripts/compat-smoke-mode.mjs';

function stage(): { dir: string; binary: string } {
  const dir = mkdtempSync(join(tmpdir(), 'knext-smoke-mode-'));
  const binary = join(dir, 'knext-smoke-exec');
  writeFileSync(binary, '#!/bin/sh\nexit 0\n');
  return { dir, binary };
}

describe('T6c compat-smoke single-exec mode resolution', () => {
  it('the identical spelling is single-exec (the CI case, unchanged)', () => {
    const { binary } = stage();
    expect(resolveSmokeMode({ serverCmd: binary, serverPath: binary }).singleExec).toBe(true);
  });

  it('a SYMLINK to the binary is still single-exec', () => {
    const { dir, binary } = stage();
    const link = join(dir, 'linked-exec');
    symlinkSync(binary, link);
    expect(resolveSmokeMode({ serverCmd: link, serverPath: binary }).singleExec).toBe(true);
  });

  it('a RELATIVE spelling of the same file is still single-exec', () => {
    const { binary } = stage();
    const rel = relative(process.cwd(), binary);
    expect(resolveSmokeMode({ serverCmd: rel, serverPath: binary }).singleExec).toBe(true);
    // and the `./`-prefixed / non-normalised spelling
    const noisy = join(binary, '..', '.', 'knext-smoke-exec');
    expect(resolveSmokeMode({ serverCmd: noisy, serverPath: binary }).singleExec).toBe(true);
  });

  it('a genuinely DIFFERENT command is standalone — the guard is not hard-coded true', () => {
    const { dir, binary } = stage();
    const other = join(dir, 'node');
    writeFileSync(other, '#!/bin/sh\nexit 0\n');
    expect(resolveSmokeMode({ serverCmd: other, serverPath: binary }).singleExec).toBe(false);
    // The classic standalone shape: a runtime plus a server.js it is handed.
    const tree = join(dir, '.next', 'standalone');
    mkdirSync(tree, { recursive: true });
    const serverJs = join(tree, 'server.js');
    writeFileSync(serverJs, '');
    expect(resolveSmokeMode({ serverCmd: process.execPath, serverPath: serverJs }).singleExec).toBe(
      false,
    );
  });

  it('an UNRESOLVABLE path does not silently read as single-exec', () => {
    const { dir } = stage();
    const missing = join(dir, 'not-built-yet');
    // Neither side exists as the same real file, so the answer must be the
    // conservative one rather than an accidental string match on two ENOENTs.
    expect(resolveSmokeMode({ serverCmd: process.execPath, serverPath: missing }).singleExec).toBe(
      false,
    );
  });

  it('an explicit SMOKE_MODE that CONTRADICTS the paths is a loud failure', () => {
    const { dir, binary } = stage();
    const other = join(dir, 'node');
    writeFileSync(other, '');
    expect(() =>
      resolveSmokeMode({ serverCmd: other, serverPath: binary, smokeMode: 'single-exec' }),
    ).toThrow(/SMOKE_MODE/);
    expect(() =>
      resolveSmokeMode({ serverCmd: binary, serverPath: binary, smokeMode: 'standalone' }),
    ).toThrow(/SMOKE_MODE/);
  });

  it('an explicit SMOKE_MODE that AGREES is accepted, and an unknown value is refused', () => {
    const { binary } = stage();
    expect(
      resolveSmokeMode({ serverCmd: binary, serverPath: binary, smokeMode: 'single-exec' })
        .singleExec,
    ).toBe(true);
    expect(() =>
      resolveSmokeMode({ serverCmd: binary, serverPath: binary, smokeMode: 'compiled' }),
    ).toThrow(/SMOKE_MODE/);
  });

  it('compat-smoke.mjs derives its mode from the helper, not from `===`', () => {
    // Scanned, not trusted: the point of the fix is that the string comparison
    // is GONE from the runner. An enumerated reviewer memory is how it comes
    // back.
    const text = readFileSync(
      resolve(import.meta.dirname, '../apps/file-manager/scripts/compat-smoke.mjs'),
      'utf8',
    );
    expect(text).toContain('resolveSmokeMode');
    expect(text).not.toMatch(/singleExec\s*=\s*SERVER_CMD\s*===\s*SERVER_PATH/);
  });
});
