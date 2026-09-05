/**
 * #911 — the runtime entry is ONE file with five homes, so pin all five.
 *
 * `create-scaffold-parity.test.ts` already compares the two TEMPLATE trees to
 * each other, and that guard was green the whole time the drift measured at
 * close was accumulating: the drift was not between the templates, it was
 * between the templates and the three checked-in app copies. `apps/docs` (+47
 * lines) and `apps/file-manager` (+56) carried a `/_next/image` optimizer
 * intercept the templates lacked — so `CLAUDE.md` §9 recorded image
 * optimization as delivered while every scaffolded app silently shipped
 * without it. Third instance of that class after #895 and the missing health
 * route (#910).
 *
 * Written RED-first: at the tip of `agent/sprint-close-blockers` this file
 * reports three offenders (both app entries and, once reconciled, nothing).
 *
 * The subjects are DISCOVERED, never enumerated. A test naming
 * `apps/docs/knext-bun-entry.mjs`, `apps/file-manager/knext-bun-entry.mjs` and
 * `examples/bun-exec/knext-bun-entry.mjs` is a test that will be green on the
 * day someone adds a fourth copy — which is exactly the shape that let this
 * drift live. So the scan walks the tree by basename, and the audit reports an
 * unrecognised copy as a failure rather than skipping it.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  auditRuntimeEntryCopies,
  CANONICAL_TEMPLATE_DIR,
  COPY_BASENAMES,
  DIVERGENT,
  discoverRuntimeEntryCopies,
  GENERATED_BY_MARKER,
  sha256,
  stripGeneratedByHeader,
} from '../scripts/lib/runtime-entry-copies.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');

describe('#911 every runtime-entry copy is pinned to the template', () => {
  it('discovers the copies by scanning, and finds the ones we know exist', () => {
    const copies = discoverRuntimeEntryCopies(REPO_ROOT);
    // A vacuous scan is the failure mode this whole guard is exposed to: an
    // audit over zero discovered files passes. So the known homes are asserted
    // as a FLOOR (they must be found), never as the complete set.
    for (const known of [
      `${CANONICAL_TEMPLATE_DIR}/knext-bun-entry.mjs.hbs`,
      `${CANONICAL_TEMPLATE_DIR}/runtime-contract.mjs.hbs`,
      'turbo/generators/templates/zone/knext-bun-entry.mjs.hbs',
      'turbo/generators/templates/zone/runtime-contract.mjs.hbs',
      'apps/docs/knext-bun-entry.mjs',
      'apps/docs/runtime-contract.mjs',
      'apps/file-manager/knext-bun-entry.mjs',
      'apps/file-manager/runtime-contract.mjs',
      'examples/bun-exec/knext-bun-entry.mjs',
      'examples/bun-exec/runtime-contract.mjs',
    ]) {
      expect(copies, `the scan missed ${known}`).toContain(known);
    }
  });

  it('every discovered copy matches its template apart from the sanctioned header', () => {
    expect(auditRuntimeEntryCopies({ repoRoot: REPO_ROOT })).toEqual([]);
  });

  it('the canonical templates still carry the generated-by header the strip is anchored on', () => {
    for (const base of COPY_BASENAMES) {
      const src = readFileSync(join(REPO_ROOT, CANONICAL_TEMPLATE_DIR, `${base}.hbs`), 'utf8');
      expect(src).toContain(GENERATED_BY_MARKER);
    }
  });

  it('the header strip removes ONLY the sanctioned block', () => {
    const sanctioned = `/**\n * ${GENERATED_BY_MARKER} — blah.\n */\nbody\n`;
    expect(stripGeneratedByHeader(sanctioned)).toBe('body\n');
    // An unrelated leading docblock must survive, or "add a comment" becomes a
    // way to hide a divergence from the comparison.
    const unrelated = '/**\n * something else entirely.\n */\nbody\n';
    expect(stripGeneratedByHeader(unrelated)).toBe(unrelated);
  });

  it('every recorded divergence exists, is hashed, and carries a reason', () => {
    const copies = discoverRuntimeEntryCopies(REPO_ROOT);
    for (const [rel, entry] of Object.entries(DIVERGENT)) {
      expect(copies, `${rel} is exempted but no longer exists`).toContain(rel);
      expect(entry.reason.length, `${rel} has no reason recorded`).toBeGreaterThan(40);
      expect(entry.sha256, `${rel} must pin its bytes by hash`).toMatch(/^[0-9a-f]{64}$/);
      expect(sha256(readFileSync(join(REPO_ROOT, rel), 'utf8'))).toBe(entry.sha256);
    }
  });
});
