/**
 * Which HTTP transport a single-exec compat-smoke run is serving over.
 *
 * Two compiled executables now exist and they serve over DIFFERENT transports,
 * whose Bun keep-alive fixes diverged (check (h) in compat-smoke.mjs):
 *
 *   - the vinext executable serves over Bun.serve — its reuse-reset is still
 *     present at Bun 1.4.2, so the baked-in guard is always on and every
 *     response MUST carry `Connection: close`;
 *   - the compiled standalone executable is Next's own server, i.e. node:http —
 *     that reset was fixed at Bun 1.4.0 and its guard self-disables, exactly
 *     like the uncompiled `bun server.js` lane.
 *
 * So "single-exec" alone no longer says which contract applies. The default
 * stays `bun-serve` (every existing single-exec run is the vinext binary);
 * `SMOKE_EXEC_TRANSPORT=node-http` states the compiled standalone. Both halves
 * are asserted — the default did not move, and the new value is reachable —
 * and a typo or a transport on a non-single-exec run is refused, not ignored.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  resolveExecTransport,
  SMOKE_EXEC_TRANSPORTS,
} from '../apps/file-manager/scripts/compat-smoke-mode.mjs';

describe('resolveExecTransport', () => {
  it('defaults a single-exec run to bun-serve (the vinext executable — unchanged)', () => {
    expect(resolveExecTransport({ singleExec: true, transport: undefined })).toBe('bun-serve');
    expect(resolveExecTransport({ singleExec: true, transport: '' })).toBe('bun-serve');
  });

  it('accepts node-http for the compiled standalone executable', () => {
    expect(resolveExecTransport({ singleExec: true, transport: 'node-http' })).toBe('node-http');
  });

  it('is not applicable to a standalone (script) run', () => {
    expect(resolveExecTransport({ singleExec: false, transport: undefined })).toBeNull();
  });

  it('REFUSES a transport stated for a non-single-exec run (it would be silently ignored)', () => {
    expect(() => resolveExecTransport({ singleExec: false, transport: 'node-http' })).toThrow(
      /single-exec/,
    );
  });

  it('REFUSES an unknown transport rather than falling back', () => {
    expect(() => resolveExecTransport({ singleExec: true, transport: 'node' })).toThrow(
      /not a transport/,
    );
  });

  it('knows exactly the two transports', () => {
    expect([...SMOKE_EXEC_TRANSPORTS].sort()).toEqual(['bun-serve', 'node-http']);
  });
});

describe('compat-smoke.mjs wiring', () => {
  const src = readFileSync(
    resolve(import.meta.dir, '..', 'apps/file-manager/scripts/compat-smoke.mjs'),
    'utf8',
  );

  it('derives the transport from the helper and the env var', () => {
    expect(src).toContain('resolveExecTransport(');
    expect(src).toContain('process.env.SMOKE_EXEC_TRANSPORT');
  });

  it("probes a compiled executable's embedded Bun with BUN_BE_BUN, never a bare --version (which boots a second server)", () => {
    expect(src).toMatch(/BUN_BE_BUN:\s*'1'/);
  });
});
