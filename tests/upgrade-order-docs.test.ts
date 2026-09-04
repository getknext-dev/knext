import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * GUARD TEST for the documented upgrade order (issue #548, sprint-1 T9).
 *
 * Since #547 every `kubectl apply` the CLI issues carries an explicit
 * `--validate=strict`, so a field the CLI emits that the cluster's CRD does not
 * know is REJECTED (`strict decoding error: unknown field …`) rather than
 * silently pruned. That fail-safe makes a previously-invisible constraint real:
 *
 *   upgrade the operator (and therefore the CRD) FIRST, then the CLI.
 *
 * This guard asserts the rule is actually written down where a user upgrading
 * will meet it — `docs/RELEASING.md` — and recorded as a decision in ADR-0020,
 * and that the CLI error a user hits when they get it wrong (`db-bind`'s
 * silent-prune guard) cites the same words so a search lands on the doc.
 *
 * It also asserts the docs stay HONEST about what strict validation does NOT
 * buy: the three residuals recorded in CLAUDE.md §4 (GitOps controllers do not
 * assert strict validation; a `kubectl` shim can append `--validate=ignore` and
 * win because pflag takes the last occurrence; `doctor` checks only that the
 * CRD exists, not that its schema covers what the CLI emits).
 *
 * Mutation proof (scripts/mutate-upgrade-order-anchor.mjs): delete the ordering
 * sentence from RELEASING.md and this suite goes red.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const RELEASING_PATH = resolve(REPO_ROOT, 'docs/RELEASING.md');
const ADR_PATH = resolve(REPO_ROOT, 'docs/adr/0020-release-channels.md');
const DB_BIND_PATH = resolve(REPO_ROOT, 'packages/kn-next/src/cli/db-bind.ts');

/**
 * The canonical wording. Every place that states the rule must use THESE words,
 * so the error message, the runbook and the ADR are one searchable string.
 */
const ORDER_RULE = 'operator/CRD first, then CLI';

/** The doc anchor the CLI error points at. */
const DOC_ANCHOR = 'docs/RELEASING.md#upgrade-order';

/**
 * Collapse whitespace so a Markdown line wrap (or a wrapped string literal in
 * TS) cannot hide the canonical wording from these assertions. The guard is
 * about the WORDS being present, not about how they are laid out.
 */
function flat(text: string): string {
  return text.replace(/["'\\]/g, '').replace(/\s+/g, ' ');
}

/** Raw (line structure intact) — needed for heading/anchor parsing. */
const releasingRaw = readFileSync(RELEASING_PATH, 'utf8');
const releasing = flat(releasingRaw);
const adr = flat(readFileSync(ADR_PATH, 'utf8'));
const dbBind = flat(readFileSync(DB_BIND_PATH, 'utf8'));

/** Slugify a Markdown heading the way GitHub does (enough for our headings). */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function headingSlugs(md: string): string[] {
  return md
    .split('\n')
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) => slug(l.replace(/^#{1,6}\s+/, '')));
}

describe('upgrade order: operator/CRD first, then CLI (#548)', () => {
  describe('docs/RELEASING.md — the user-facing upgrade path', () => {
    it('states the ordering rule in the canonical words', () => {
      expect(releasing).toContain(ORDER_RULE);
    });

    it('has an "Upgrade order" section the CLI error can link to', () => {
      expect(headingSlugs(releasingRaw)).toContain('upgrade-order');
    });

    it('explains WHY: a newer CLI can emit a field an older CRD rejects', () => {
      // The exact apiserver text, so a user who pastes their error finds this doc.
      expect(releasing).toContain('strict decoding error: unknown field');
      expect(releasing).toMatch(/--validate=strict/);
    });

    it('states the safe direction so nobody over-constrains their rollout', () => {
      // older CLI against a newer CRD is always valid — a client emitting a
      // subset of the schema never trips unknown-field validation.
      expect(releasing).toMatch(/older CLI[\s\S]{0,120}newer (CRD|operator)/i);
      expect(releasing).toMatch(/lockstep|always (valid|safe)|is safe/i);
    });

    it('does not overclaim the guarantee — names the residual gaps', () => {
      expect(releasing).toMatch(/Argo ?CD|Flux|GitOps/);
      expect(releasing).toContain('--validate=ignore');
    });
  });

  describe('ADR-0020 — the decision record', () => {
    it('states the ordering rule in the same canonical words', () => {
      expect(adr).toContain(ORDER_RULE);
    });

    it('records the measured behaviour, not an assumption', () => {
      // Pruned vs rejected depends on the apply's validation MODE, not the CRD.
      expect(adr).toContain('strict decoding error: unknown field');
      expect(adr).toContain('--validate=ignore');
      expect(adr).toMatch(/prune/i);
    });

    it('records all three residuals strict validation does NOT cover', () => {
      expect(adr).toMatch(/Argo ?CD/);
      expect(adr).toMatch(/Flux/);
      // a kubectl shim on PATH wins because pflag takes the LAST occurrence
      expect(adr).toMatch(/pflag|last occurrence/i);
      // doctor checks CRD existence, not schema coverage
      expect(adr).toMatch(/doctor[\s\S]{0,200}exists/i);
      // the complete fix is the schema-diff preflight
      expect(adr).toContain('#314');
    });

    it('states the safe direction (older CLI, newer CRD)', () => {
      expect(adr).toMatch(/older CLI[\s\S]{0,120}newer (CRD|operator)/i);
    });

    it('points at the executable runbook rather than duplicating it', () => {
      expect(adr).toContain('docs/RELEASING.md');
    });
  });

  describe('the CLI error a user hits when they get it wrong', () => {
    it('db-bind cites the ordering rule in the canonical words', () => {
      expect(dbBind).toContain(ORDER_RULE);
    });

    it('db-bind cites the doc anchor, and that anchor resolves', () => {
      expect(dbBind).toContain(DOC_ANCHOR);
      const [file, anchor] = DOC_ANCHOR.split('#');
      expect(headingSlugs(readFileSync(resolve(REPO_ROOT, file), 'utf8'))).toContain(anchor);
    });
  });
});
