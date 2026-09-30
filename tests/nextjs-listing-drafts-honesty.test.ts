import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * GUARD TEST for the Next.js listing drafts (#1566).
 *
 * Threat model: `docs/release/nextjs-listing/` holds a draft docs PR, founder notes, and a
 * Working Group request draft that must never claim things not yet true — specifically:
 *   (a) an all-green "14/14" (or equivalent 4-cell) credential result without the literal
 *       `[FILL AT GA]` placeholder marker nearby, and
 *   (b) any millisecond-denominated cold-start claim (banned outright, no placeholder escape —
 *       the issue instructions say "no cold-start millisecond numbers or superlatives", full stop).
 *
 * These are DRAFTS ONLY (nothing here is submitted upstream). The danger this guards against is
 * a later edit quietly filling in "14/14" or a cold-start number before the real rc.2 run is
 * actually green, which would misrepresent the credential this whole sprint track exists to earn.
 */

const DRAFT_DIR = resolve(import.meta.dir, '..', 'docs', 'release', 'nextjs-listing');

function draftFiles(): string[] {
  return readdirSync(DRAFT_DIR)
    .filter((f) => f.endsWith('.md') || f.endsWith('.patch'))
    .map((f) => resolve(DRAFT_DIR, f));
}

// Matches "14/14" specifically — the literal all-4-cells-14-consecutive-green shape named in
// the issue. Deliberately NOT a generic N/N regex: this directory legitimately discusses other
// ratios (e.g. "9/9 current unverified entries" in a precedent table) that are not credential
// claims at all, and a generic pattern would false-positive on those.
const ALL_GREEN_RATIO = /\b14\/14\b/g;

// A "14/14" mention is SAFE (not an asserted-as-true claim) when it sits in threshold/conditional
// framing ("reaches 14/14", "until 14/14", "after 14/14 ... never before") describing the RULE,
// rather than reporting a result. It's also safe when the placeholder marker sits nearby.
const THRESHOLD_FRAMING = /\b(reach|reaches|reached|until|before|after|once|when|shows?)\b/i;

// Matches a millisecond-denominated number: "1234ms", "1,234 ms", "18.5ms", etc.
const MS_CLAIM = /\b\d[\d,.]*\s*ms\b/gi;

const FILL_MARKER = '[FILL AT GA]';

describe('nextjs listing drafts stay honest (#1566)', () => {
  it('the draft directory exists and has the three expected files', () => {
    const files = draftFiles().map((f) => f.split('/').pop());
    expect(files).toContain('listing.patch');
    expect(files).toContain('NOTES.md');
    expect(files).toContain('adapters-wg-request-draft.md');
  });

  it('never states a millisecond cold-start number anywhere in the drafts', () => {
    const violations: string[] = [];
    for (const file of draftFiles()) {
      const content = readFileSync(file, 'utf8');
      const matches = content.match(MS_CLAIM);
      if (matches) {
        violations.push(`${file}: ${JSON.stringify(matches)}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('every "14/14" mention is guarded — either threshold/conditional framing or a [FILL AT GA] marker nearby', () => {
    const violations: string[] = [];
    for (const file of draftFiles()) {
      const content = readFileSync(file, 'utf8');
      const ratioRe = new RegExp(ALL_GREEN_RATIO);
      let match: RegExpExecArray | null = ratioRe.exec(content);
      while (match !== null) {
        const idx = match.index;
        const precedingStart = Math.max(0, idx - 60);
        const preceding = content.slice(precedingStart, idx);
        const windowStart = Math.max(0, idx - 200);
        const windowEnd = Math.min(content.length, idx + match[0].length + 200);
        const window = content.slice(windowStart, windowEnd);
        const isThresholdFraming = THRESHOLD_FRAMING.test(preceding);
        const hasFillMarker = window.includes(FILL_MARKER);
        if (!isThresholdFraming && !hasFillMarker) {
          violations.push(
            `${file}: unguarded "14/14" claim (no threshold framing, no [FILL AT GA]) near ${JSON.stringify(window)}`,
          );
        }
        match = ratioRe.exec(content);
      }
    }
    expect(violations).toEqual([]);
  });

  it('does not assert verified/listed status', () => {
    const violations: string[] = [];
    for (const file of draftFiles()) {
      const content = readFileSync(file, 'utf8').toLowerCase();
      // "verified adapter" / "verified status" claimed as fact (not as a described option/no-claim)
      // is banned; the drafts explicitly say "not requesting verified-adapter status" which is fine.
      const hasBannedClaim =
        /\bknext is (a |an )?verified\b/.test(content) || /\bwe are verified\b/.test(content);
      if (hasBannedClaim) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });
});
