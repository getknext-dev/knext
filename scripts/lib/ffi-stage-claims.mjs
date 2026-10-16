/**
 * The product-stage claim scanner for in-process Rust (`bun:ffi`) text.
 *
 * ADR-0069 keeps the feature Beta while Bun labels `bun:ffi` experimental. A
 * user-facing page or a release note that calls it "stable" or
 * "production-ready" while the ADR says Beta is a claim the product cannot back.
 * This module is the pure half of `tests/ffi-stage-claims.test.ts`: nothing
 * here reads the tree on import.
 *
 * Two deliberate choices:
 *   - The ADR is READ, never copied: the stage is the parenthetical that ends
 *     ADR-0069's title, cross-checked against its Status block. When the ADR
 *     graduates the feature the guard relaxes by itself, and an ADR whose
 *     stage cannot be read FAILS rather than relaxing (a guard that goes quiet
 *     when its input is unparseable is decoration).
 *   - A claim is a sentence that names the feature AND uses a stage word with
 *     no negation or condition in the same sentence ("not stable", "until it
 *     is stable"). Files are found by scanning for their class, not by name.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The ADR this guard reads. */
export const ADR_PATH = 'docs/adr/0069-bun-ffi-inprocess-rust.md';

/** Stages that mean "claims of stability are fine". Anything else enforces. */
const GRADUATED = /^(stable|ga|generally available|production|production-ready)$/;

/**
 * Read the stage out of the ADR text.
 *
 * @param {string} adr
 * @returns {{ stage: string, enforce: boolean }}
 */
export function adrStage(adr) {
  const title = adr.split('\n').find((l) => l.startsWith('# '));
  if (!title) throw new Error('ADR-0069 has no "# " title line; the stage cannot be read');
  const m = title.match(/\(([^()]+)\)\s*$/);
  if (!m) {
    throw new Error(
      `ADR-0069's title does not end with a parenthesised stage (got ${JSON.stringify(title)}); ` +
        'the stage cannot be read, so this guard refuses to relax',
    );
  }
  const stage = m[1].trim().toLowerCase();
  const start = adr.indexOf('- **Status:**');
  if (start === -1) throw new Error('ADR-0069 has no "- **Status:**" line');
  const rest = adr.slice(start + 1);
  const next = rest.indexOf('\n- **');
  const status = (next === -1 ? rest : rest.slice(0, next)).toLowerCase();
  if (!status.includes(stage)) {
    throw new Error(
      `ADR-0069's title says "${stage}" but its Status block never mentions it: the two disagree, ` +
        'so the stage is unreliable. Make them agree.',
    );
  }
  return { stage, enforce: !GRADUATED.test(stage) };
}

const SUBJECT =
  /\bin[- ]process\s+(?:rust|native)\b|\brust\s+in[- ]process\b|\bbun:ffi\b|\bffi\b|\bin[- ]process\s+(?:zone|rust)\s+code\b/i;
const CLAIM_WORDS =
  /\b(?:stable|production[- ](?:ready|grade)|generally available|general availability)\b/i;
// "GA" counts only upper-case: the lower-case letters are an ordinary word fragment.
const CLAIM_GA = /\bGA\b/;
const HEDGE =
  /\b(?:not|no|never|nor|cannot|until|unless|before|once|yet|if|when|whether|graduat\w*)\b|n[’']t\b/i;

const FORWARD_CONDITION = /\b(?:once|when|until|unless|if|after|whenever)\b/i;

/** How many words before a stage word a negation or condition still excuses it. */
const HEDGE_WINDOW = 8;

/**
 * Does this clause use a stage word that nothing just before it negates or
 * conditions? "not yet stable", "until it is production-ready" and "when GA"
 * are excused; "production-ready, not experimental" is not (the "not" comes
 * AFTER the claim and is about something else).
 */
function claimsStage(clause) {
  const re = new RegExp(`${CLAIM_WORDS.source}|${CLAIM_GA.source}`, 'gi');
  for (const m of clause.matchAll(re)) {
    if (!CLAIM_WORDS.test(m[0]) && !CLAIM_GA.test(m[0])) continue;
    const before = clause.slice(0, m.index).split(/\s+/).slice(-HEDGE_WINDOW).join(' ');
    const after = clause
      .slice(m.index + m[0].length)
      .split(/\s+/)
      .slice(0, 4)
      .join(' ');
    // "becomes stable once Bun drops …" is a condition, not a claim.
    if (!HEDGE.test(before) && !FORWARD_CONDITION.test(after)) return true;
  }
  return false;
}

/** Split text into sentences; blank lines, table rows, headings and list items end a unit. */
export function sentences(text) {
  const units = [];
  for (const block of text.split(/\n\s*\n/)) {
    let cur = [];
    const flush = () => {
      if (cur.length) units.push(cur.join(' '));
      cur = [];
    };
    for (const line of block.split('\n')) {
      if (/^\s*(?:[|#>*-]|\d+\.)/.test(line)) flush();
      cur.push(line.trim());
      if (/^\s*[|#]/.test(line)) flush();
    }
    flush();
  }
  const out = [];
  for (const u of units) {
    const parts = u.split(/(?<=[.!?])\s+/);
    parts.forEach((p, i) => {
      out.push({ text: p, prev: parts[i - 1] ?? '' });
    });
  }
  return out;
}

/**
 * Every sentence of `text` that claims the feature is stable.
 *
 * @param {string} text
 * @returns {string[]} the offending sentences
 */
export function findClaims(text) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  const hits = [];
  for (const { text: s, prev } of sentences(body)) {
    const pronoun = /^\W*(?:it|this|that|they|these)\b/i.test(s);
    if (!SUBJECT.test(s) && !(pronoun && SUBJECT.test(prev))) continue;
    // The feature is named in (or, for "It ...", just before) this sentence.
    if (claimsStage(s)) hits.push(s.trim());
  }
  return hits;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'target', 'dist', '.next', '.turbo']);

/** Every file under `root` whose repo-relative path satisfies `want`. */
function walk(root, want) {
  const found = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) visit(p);
      else if (want(relative(root, p).split('\\').join('/'))) found.push(p);
    }
  };
  visit(root);
  return found;
}

/**
 * The text the guard covers, by CLASS not by name: user-facing docs
 * (apps/docs/content), changesets, release notes (any CHANGELOG.md) and the
 * crate and package READMEs. A new page or changeset is covered the moment it
 * exists.
 */
export function isCovered(rel) {
  if (rel.startsWith('apps/docs/content/') && /\.mdx?$/.test(rel)) return true;
  if (/^\.changeset\/.+\.md$/.test(rel) && rel !== '.changeset/README.md') return true;
  if (/(^|\/)CHANGELOG\.md$/.test(rel)) return true;
  return /^(?:packages|crates)\/(?:[^/]+\/)?README\.md$/.test(rel);
}

/**
 * Scan the covered files under `root`.
 *
 * @param {string} root
 * @returns {{ file: string, claim: string }[]}
 */
export function scanTree(root) {
  const out = [];
  for (const p of walk(root, isCovered)) {
    for (const claim of findClaims(readFileSync(p, 'utf8'))) {
      out.push({ file: relative(root, p).split('\\').join('/'), claim });
    }
  }
  return out;
}

/** How many files the scan covers (a guard that scans nothing is decoration). */
export function coveredCount(root) {
  return walk(root, isCovered).length;
}
