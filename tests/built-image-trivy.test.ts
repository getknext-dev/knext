import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * Built-image Trivy enforcement for the shipped docs + bun-exec images (#981).
 *
 * ## Why this exists
 *
 * #971 added `base-image-trivy`, which scans the pinned alpine BASE references
 * (`oven/bun:1.4.0-alpine`, `node:22-alpine`). oven-bun-pin-exempt: historical
 * — records the Bun THAT WAS PINNED when #971 landed, not the current pin.
 * It landed enforce-on-main and
 * immediately red-lined main, because the base-ref carries the very HIGH/CRITICAL
 * CVEs the Dockerfiles' build-time `apk upgrade --no-cache` clears in the SHIPPED
 * image. #982 made that base-ref scan REPORT-ONLY (a digest-bump signal). That
 * left a real gap: an actionable HIGH that SURVIVES the build-time upgrade in the
 * docs (`apps/docs/Dockerfile`) or bun-exec (`examples/bun-exec/Dockerfile.node`)
 * runtime OS layer failed no gate — only the file-manager BUILT image was
 * enforce-scanned.
 *
 * #981 closes it: the two shipped images' runtime OS layers (base + `apk upgrade`
 * + the runtime `apk add`) are now BUILT in CI and Trivy-scanned enforce-on-main,
 * phased report-on-PR/enforce-on-main exactly like the file-manager gate. The
 * minimal `*.trivyscan` Dockerfiles reproduce each shipped image's runtime OS
 * layer (the app JS closures are scanned by the closure gates; native sharp is
 * the acknowledged native-provenance gap).
 *
 * This guard asserts BOTH halves so neither can quietly rot:
 *   1. the workflow BUILDS + enforce-scans each shipped image's runtime OS layer;
 *   2. the scan fixtures do not DRIFT from the shipped Dockerfiles they mirror —
 *      same runtime base digest, same whole-base `apk upgrade`.
 */

const REPO_ROOT = join(__dirname, '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/supply-chain.yml');
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

/** Comment-stripped, line-continuations joined — so prose can't trip a match. */
function readJoinedDockerfile(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8')
    .replace(/\\\n/g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/** The LAST `FROM` in a Dockerfile is its runtime stage; return the pinned ref. */
function runtimeFrom(rel: string): string {
  const body = readJoinedDockerfile(rel);
  const froms = [...body.matchAll(/^FROM\s+(\S+)/gim)].map((m) => m[1]);
  if (froms.length === 0) throw new Error(`no FROM in ${rel}`);
  return froms[froms.length - 1];
}

/** The two shipped images #981 brings under enforce-grade built-image scanning. */
const IMAGES = [
  {
    name: 'apps/docs runtime',
    shipped: 'apps/docs/Dockerfile',
    scanFixture: 'apps/docs/Dockerfile.trivyscan',
  },
  {
    name: 'examples/bun-exec Dockerfile.node',
    shipped: 'examples/bun-exec/Dockerfile.node',
    scanFixture: 'examples/bun-exec/Dockerfile.node.trivyscan',
  },
];

/** Slice out the `built-image-trivy` job body (up to the next top-level job). */
function builtImageJob(): string {
  const start = workflow.indexOf('built-image-trivy:');
  expect(start, 'the built-image-trivy job must exist in supply-chain.yml').toBeGreaterThan(-1);
  const rest = workflow.slice(start + 'built-image-trivy:'.length);
  // A top-level job header is two-space-indented `name:` at column 2; find the
  // next job by the next line matching `^  \w[\w-]*:$` after this one.
  const next = rest.search(/\n {2}[A-Za-z][\w-]*:\n/);
  return next === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + 'built-image-trivy:'.length + next);
}

describe('#981 — the two shipped images are Trivy-scanned as BUILT, enforce-on-main', () => {
  it('has a built-image-trivy job that BUILDS then scans (input:, not image-ref:)', () => {
    const job = builtImageJob();
    expect(job).toMatch(/docker\/build-push-action/);
    expect(job).toMatch(/aquasecurity\/trivy-action/);
    // A BUILT-image scan reads the local build (input:), NOT a remote ref
    // (image-ref:), which is what the report-only base-ref gate does.
    expect(job).toMatch(/input:\s*image-oci/);
    expect(job).not.toMatch(/image-ref:/);
  });

  it('enforces on main, reports on PR (phased continue-on-error), HIGH/CRITICAL, ignore-unfixed', () => {
    const job = builtImageJob();
    // Same phased rollout the file-manager gate uses: block only on main.
    expect(job).toMatch(
      /continue-on-error:\s*\$\{\{\s*github\.ref\s*!=\s*'refs\/heads\/main'\s*\}\}/,
    );
    expect(job).toMatch(/severity:\s*HIGH,CRITICAL/);
    expect(job).toMatch(/exit-code:\s*["']?1["']?/);
    expect(job).toMatch(/ignore-unfixed:\s*true/);
  });

  it('runs on merge_group so it does not silently vanish from the queue ref', () => {
    // The workflow triggers on merge_group (top-level `on:`); the job carries no
    // job-level `if:` that would exclude the queue ref. It is deliberately NOT a
    // required status check (founder-owned branch protection), so running
    // report-only on the queue ref is safe and cannot hang the queue.
    const doc = parse(workflow) as Record<string, unknown>;
    const on = (doc.on ?? (doc as Record<string, unknown>)[true as unknown as string]) as Record<
      string,
      unknown
    >;
    expect('merge_group' in on).toBe(true);
  });

  for (const img of IMAGES) {
    it(`builds ${img.name} via its scan fixture ${img.scanFixture}`, () => {
      const job = builtImageJob();
      expect(job).toContain(img.scanFixture);
    });

    it(`${img.scanFixture} does not DRIFT from ${img.shipped} (same runtime base digest)`, () => {
      // If the shipped image bumps its runtime base digest and the scan fixture
      // does not, the enforce-scan would be measuring a stale artifact. Tie them.
      expect(runtimeFrom(img.scanFixture)).toBe(runtimeFrom(img.shipped));
    });

    it(`${img.scanFixture} reproduces the whole-base apk upgrade`, () => {
      const body = readJoinedDockerfile(img.scanFixture);
      expect(body).toMatch(/apk\s+upgrade\s+--no-cache/);
      // No pinned package versions — they go stale like the digest (same rule as
      // base-image-cve-hygiene).
      expect(body).not.toMatch(/apk\s+(add|upgrade)[^\n]*=\d/);
    });
  }
});

/**
 * #703 — the node:22-alpine base ships a bundled npm whose vendored
 * `node_modules` carry HIGH/CRITICAL CVEs (tar gzip-bomb, pacote, sigstore, …)
 * under `/usr/local/lib/node_modules/npm/node_modules/...`. These are JS library
 * packages, not apk packages, so the whole-base `apk upgrade --no-cache` above
 * CANNOT patch them and the enforce-on-main built-image Trivy scan reds.
 *
 * The shipped runtime only runs `node server.js` — npm/npx/corepack are UNUSED at
 * runtime (node ≠ npm). The fix ELIMINATES the surface rather than suppressing it:
 * both the shipped Dockerfile.node and its lockstep trivyscan fixture rm the
 * bundled npm + corepack after the apk upgrade. This guard mutation-fails if a
 * future edit drops the removal from either file.
 *
 * Scoped to the node pair on purpose: the docs (oven/bun) arm ships no npm, so its
 * built-image scan is green and needs no strip.
 */
describe('#703 — the node image strips the base-bundled npm/corepack CVE surface', () => {
  const NODE_PAIR = [
    'examples/bun-exec/Dockerfile.node',
    'examples/bun-exec/Dockerfile.node.trivyscan',
  ];

  for (const rel of NODE_PAIR) {
    it(`${rel} removes the bundled npm and corepack after the apk upgrade`, () => {
      const body = readJoinedDockerfile(rel);
      // A single rm step that clears BOTH the npm and the corepack trees — the
      // whole vulnerable closure lives under node_modules/npm, corepack is the
      // sibling package manager, neither is used by `node server.js`.
      const rm = [...body.matchAll(/^RUN\s+rm\s+-rf\s+.+$/gim)].map((m) => m[0]);
      const strip = rm.find(
        (line) => /node_modules\/npm(\b|\/)/.test(line) && /corepack/.test(line),
      );
      expect(strip, `${rel} must rm the bundled npm + corepack`).toBeDefined();

      // It must run AFTER the whole-base apk upgrade (the ordering the shipped
      // Dockerfile documents), so the strip is not accidentally undone.
      const upgradeAt = body.search(/apk\s+upgrade\s+--no-cache/);
      const stripAt = body.indexOf(strip as string);
      expect(upgradeAt).toBeGreaterThanOrEqual(0);
      expect(stripAt).toBeGreaterThan(upgradeAt);
    });
  }
});
