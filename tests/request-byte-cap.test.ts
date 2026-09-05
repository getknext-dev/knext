/**
 * ADR-0044 Option C — the in-process request byte cap, wiring half.
 *
 * The behavioural half lives in `examples/bun-exec/test/request-byte-cap.test.ts`,
 * which boots a real listener and sends real oversize bodies. This file is the
 * half that has to hold for EVERY copy of the entry rather than the one the e2e
 * happens to boot: five files carry `knext-bun-entry.mjs`, and a cap wired into
 * two of them ships a scaffolded app with no cap at all while the e2e stays
 * green. That is the exact shape of the #911 image-intercept drift, one sprint
 * later, so the guard is a SCAN, not a list.
 *
 * What the scan is over, and why it is not the runtime-entry basename list: the
 * property is "anything that serves through `srvx/bun` caps its request bodies".
 * `examples/bun-exec/test/srvx-close-harness.mjs` is not named
 * `knext-bun-entry.mjs`, mirrors the entry's wiring on purpose, and is what the
 * e2e actually boots — a basename scan would leave the file the proof runs
 * against unpinned. So the subject is "imports srvx/bun and calls serve".
 *
 * Written RED-first: with the cap unwired, `auditRequestByteCap` reports one
 * finding per serve call in every one of those files.
 */

import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import {
  auditRequestByteCap,
  BUN_COUNTED_BODY_FLOOR,
  DEFAULT_MAX_REQUEST_BYTES,
  discoverSrvxServeSites,
  ENV_VAR,
  isSrvxServeSite,
  loadCapResolver,
  METRICS_MAX_REQUEST_BYTES,
  serveCalls,
} from '../scripts/lib/request-byte-cap.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');

describe('ADR-0044 Option C: every srvx serve site caps request bodies', () => {
  it('discovers the serve sites by scanning, and finds the ones we know exist', () => {
    const sites = discoverSrvxServeSites(REPO_ROOT);
    // A FLOOR, never the complete set — an audit over zero discovered files
    // reports zero findings and reads as a clean tree.
    for (const known of [
      'packages/kn-next/templates/app/knext-bun-entry.mjs.hbs',
      'turbo/generators/templates/zone/knext-bun-entry.mjs.hbs',
      'apps/docs/knext-bun-entry.mjs',
      'apps/file-manager/knext-bun-entry.mjs',
      'examples/bun-exec/knext-bun-entry.mjs',
      'examples/bun-exec/test/srvx-close-harness.mjs',
    ]) {
      expect(sites, `the scan missed ${known}`).toContain(known);
    }
  });

  it('reports nothing — every serve call in every serve site carries the cap', async () => {
    expect(await auditRequestByteCap({ repoRoot: REPO_ROOT })).toEqual([]);
  });
});

describe('isSrvxServeSite: only a real import counts', () => {
  it('matches an import statement', () => {
    expect(isSrvxServeSite("import { serve } from 'srvx/bun';\n")).toBe(true);
    expect(isSrvxServeSite("import {\n  serve,\n} from 'srvx/bun';\n")).toBe(true);
  });

  it('does NOT match a mention in a comment or inside a string', () => {
    expect(isSrvxServeSite("// import { serve } from 'srvx/bun';\n")).toBe(false);
    // Not hypothetical: this very file builds such a fixture below, and the
    // first version of the scan reported the test file as an uncapped listener.
    expect(isSrvxServeSite('const s = "import { serve } from \'srvx/bun\';";\n')).toBe(false);
  });
});

describe('serveCalls: the two listeners are told apart, comments do not count', () => {
  it('classifies the srvx app serve and the Bun metrics serve separately', () => {
    const src = [
      "import { serve } from 'srvx/bun';",
      'const a = serve({ port: 1, maxRequestBodySize: 10 });',
      'const b = Bun.serve({ port: 2, maxRequestBodySize: 20 });',
    ].join('\n');
    const calls = serveCalls(src);
    expect(calls.map((c) => c.kind)).toEqual(['srvx', 'bun']);
  });

  it('does not accept a MENTION of the option in a comment or a string', () => {
    const src = [
      "import { serve } from 'srvx/bun';",
      '// maxRequestBodySize goes here one day',
      'const a = serve({ port: 1 });',
      "const b = Bun.serve({ port: 2, note: 'maxRequestBodySize' });",
    ].join('\n');
    for (const call of serveCalls(src)) expect(call.hasCap).toBe(false);
  });
});

describe(`${ENV_VAR}: the operator override, and what an invalid value must not do`, () => {
  it('defaults to 8 MiB when unset — above Next’s 1 MB Server-Action limit', async () => {
    const { resolveMaxRequestBytes } = await loadCapResolver(REPO_ROOT);
    expect(DEFAULT_MAX_REQUEST_BYTES).toBe(8 * 1024 * 1024);
    // Deliberately NOT 1 MB: two layers answering different errors at one
    // threshold is how a support ticket becomes unanswerable (ADR-0044 D4).
    expect(DEFAULT_MAX_REQUEST_BYTES).toBeGreaterThan(1024 * 1024);
    expect(resolveMaxRequestBytes({}).bytes).toBe(DEFAULT_MAX_REQUEST_BYTES);
    expect(resolveMaxRequestBytes({}).source).toBe('default');
  });

  it('honours a positive integer override', async () => {
    const { resolveMaxRequestBytes } = await loadCapResolver(REPO_ROOT);
    const got = resolveMaxRequestBytes({ [ENV_VAR]: '1024' });
    expect(got.bytes).toBe(1024);
    expect(got.source).toBe('env');
  });

  it('treats 0 as EXPLICITLY uncapped, and says so loudly', async () => {
    const { resolveMaxRequestBytes } = await loadCapResolver(REPO_ROOT);
    const got = resolveMaxRequestBytes({ [ENV_VAR]: '0' });
    // `undefined` is the value srvx and Bun both read as "no option given";
    // anything else (0, Infinity) would be passed through and misbehave.
    expect(got.bytes).toBeUndefined();
    expect(got.source).toBe('uncapped');
    expect(got.warning).toMatch(/uncapped/i);
    expect(got.warning).toContain(ENV_VAR);
  });

  it('FALLS BACK TO THE DEFAULT on any invalid value — never to uncapped', async () => {
    const { resolveMaxRequestBytes } = await loadCapResolver(REPO_ROOT);
    // The security-relevant direction: a typo must not silently remove the cap.
    for (const raw of ['', 'abc', '-1', '1.5', '1e9x', ' ', 'NaN', 'Infinity']) {
      const got = resolveMaxRequestBytes({ [ENV_VAR]: raw });
      expect(got.bytes, `${JSON.stringify(raw)} must fall back to the default`).toBe(
        DEFAULT_MAX_REQUEST_BYTES,
      );
      expect(got.source).toBe('invalid');
      expect(got.warning).toContain(ENV_VAR);
    }
  });

  it('caps the :9464 metrics listener small, and FIXED — the knob must not reach it', async () => {
    const { resolveMaxRequestBytes } = await loadCapResolver(REPO_ROOT);
    expect(METRICS_MAX_REQUEST_BYTES).toBe(64 * 1024);
    // The metrics listener answers one GET. `KNEXT_MAX_REQUEST_BYTES=0` is an
    // app-side escape hatch; it must not re-open the co-resident-pod path
    // ADR-0044's threat scope names, so the constant is not a function of env.
    expect(resolveMaxRequestBytes({ [ENV_VAR]: '0' }).metricsBytes).toBe(METRICS_MAX_REQUEST_BYTES);
  });
});

describe('the counted-bytes guarantee depends on the Bun floor, so pin the link', () => {
  it(`keeps the vinext build floor at or above Bun ${BUN_COUNTED_BODY_FLOOR}`, async () => {
    // MEASURED, not assumed. On Bun 1.3.5 `maxRequestBodySize` refuses an honest
    // Content-Length but PASSES a chunked body of the same size to the handler
    // (413 / 200); on 1.4.0 both are 413. So ADR-0044 Decision 4's counted-bytes
    // constraint is satisfied by the runtime only at >= 1.4.0, and the build
    // floor in `vinext-build.ts` is what makes every shipped binary carry it.
    // Lowering that floor would silently downgrade a security control, which is
    // why the link is asserted here rather than left in a comment.
    const findings = await auditRequestByteCap({ repoRoot: REPO_ROOT });
    expect(findings.filter((f) => /bun floor/i.test(f))).toEqual([]);
  });
});
