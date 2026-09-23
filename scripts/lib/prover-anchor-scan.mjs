#!/usr/bin/env node
/**
 * Static anchor-drift scan for the mutation-prover fleet (#1223).
 *
 * WHY THIS EXISTS
 * ----------------
 * `scripts/mutation-prove-compat-window-audit.mjs` mutation #4 anchored on text
 * `scripts/compat-window-audit.mjs` no longer carried — the prover ABORTED
 * instead of proving the guard, and nothing caught it until a human ran the
 * script by hand. Every prover in this repo has the same failure mode: a
 * hardcoded text anchor is a snapshot of source that WILL move under an
 * unrelated edit, and `mutate()`'s own "occurs exactly once" check only fires
 * when someone actually RUNS the prover — which no CI job does (see
 * `tests/publish-markers-proof-runnable.test.ts`, the one-off precedent this
 * generalises to the whole fleet).
 *
 * WHAT THIS DOES
 * --------------
 * Scans every tracked `scripts/mutation-prove-*.mjs` (discovered via `git
 * ls-files`, never enumerated) and extracts every literal text anchor it can
 * find WITHOUT running the prover or spawning its spec:
 *
 *   - a literal string 2nd argument to a `mutate(snap, '...', ...)` call;
 *   - a literal `anchor: '...'` property (table-driven `MUTATIONS` arrays);
 *   - a `const XAnchor = '...'` constant referenced by name inside a
 *     `mutate(...)` call.
 *
 * and every literal repo-relative FILE PATH the prover mentions via
 * `resolve(<root-identifier>, '<literal>')` — the shape every prover in this
 * repo uses to name its subject(s).
 *
 * THE CHECK, deliberately the CHEAP direction rather than the precise one
 * -------------------------------------------------------------------------
 * Pairing a specific anchor to the SPECIFIC file it targets requires either
 * running the prover or a real parser tracking object-literal scope — both
 * more than "cheap" buys, and a buggy pairing heuristic is worse than an
 * honest, looser one. So the check this module makes is:
 *
 *   - when a prover names exactly ONE subject file, every anchor it declares
 *     must occur EXACTLY ONCE in that file (the precise case, and also the
 *     common one — most provers mutate a single target);
 *   - when a prover names more than one subject file (a multi-file prover,
 *     e.g. a handler + its `.d.ts`), every anchor must occur AT LEAST ONCE
 *     somewhere across the union — looser, but it still catches exactly
 *     #1223's failure mode (an anchor absent from every subject the prover
 *     touches), just not "anchor moved to the wrong sibling file".
 *
 * WHAT THIS DELIBERATELY DOES NOT COVER
 * --------------------------------------
 * An anchor COMPUTED at run time (extracted from the live workflow YAML, a
 * regex match, string concatenation, a shared `HATCH_SHAPES` table) is not a
 * hardcoded snapshot and cannot go stale the way #1223's did — it re-derives
 * itself from whatever the subject currently contains. Such provers surface
 * here with zero resolved anchors and are correctly left unchecked;
 * `mutate()`'s own runtime assertion is still the backstop for those. A
 * prover whose subject file cannot be resolved to any literal path at all is
 * also left unchecked, and is distinguishable via `unresolvedAnchorCount` for
 * anyone auditing coverage — it is never silently reported as clean.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { activeExemptions } from './dated-exemptions.mjs';

/**
 * Every tracked prover matches this shape — `readdirSync` + a glob, like
 * `discoverProvers` in `scripts/lib/prover-lane.mjs`, deliberately NOT `git
 * ls-files`: this module has no legitimate reason to spawn a child process,
 * and `tests/mutation-prover-lane.test.ts`'s runner-resolution audit treats
 * any `execFileSync`/`spawnSync` call as a prover-shaped spawn that must go
 * through `resolveTestRunner`/`resolveSpecRunner` — neither of which applies
 * to listing files.
 */
const PROVER_FILE_RE = /^mutation-prove-.*\.mjs$/;

/**
 * Provers this scan found ALREADY stale beyond #1223's own mutation #4 —
 * discovered running this scan for the first time, not introduced by it.
 * Re-anchoring each one needs the same git-history archaeology #1223's fix
 * did (which workflow/job reshuffle moved the text, and what the anchor
 * should become to keep testing the SAME guarded behaviour) — not "trivially
 * re-anchorable", so they are dated exceptions here, tracked by #1249 rather
 * than fixed blind.
 */
export const KNOWN_STALE_PROVER_EXEMPTIONS = Object.freeze([
  Object.freeze({
    prover: 'scripts/mutation-prove-ledger-completeness.mjs',
    justification:
      'Three anchors in this table target .github/workflows/test-e2e-deploy.yml text that no ' +
      'longer exists there (job/step reshuffles across #1147/#850-era commits): "needs: ' +
      'deploy-tests\\n    if: always()\\n", "jobs:\\n  build-next:", and "needs: [build-next, ' +
      'deploy-tests, shard-ledger]". Each needs the same re-anchoring investigation #1223 did ' +
      'for compat-window-audit.mjs, mutation by mutation — filed as a follow-up rather than ' +
      'fixed blind here.',
    added: '2026-09-23',
    expires: '2026-10-23',
  }),
  Object.freeze({
    prover: 'scripts/mutation-prove-compat-lane-pointer.mjs',
    justification:
      'Mutation 5 anchors on "KNEXT_RUNTIME: ${{ github.event.inputs.runtime || \'node\' }}", ' +
      'which the credential-v1.0-per-cell rewrite (#850) replaced with a longer expression ' +
      "carrying two schedule-gated bun branches. Re-anchoring needs to preserve the mutation's " +
      'intent (re-introducing a retired schedule comparison) against the new expression shape, ' +
      'not just restring the anchor.',
    added: '2026-09-23',
    expires: '2026-10-23',
  }),
]);

/** The exemptions still live at `now`. */
export function activeStaleProverExemptions(now = new Date()) {
  return activeExemptions(KNOWN_STALE_PROVER_EXEMPTIONS, { field: 'prover', now });
}

/** Decode the handful of JS string escapes this repo's literal anchors use. */
function unescapeJsString(raw) {
  return raw.replace(/\\(n|t|r|\\|'|"|`)/g, (_, c) => {
    const table = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '`': '`' };
    return table[c];
  });
}

/**
 * A JS string literal, captured WHOLE (quotes included) in a single group,
 * with NO capturing groups inside it. This is deliberate: earlier drafts used
 * a backreference (`(['"\`])...\1`) to match the closing quote, and it broke
 * silently the moment this fragment was embedded after another capturing
 * group in a larger pattern — `\1` then pointed at the WRONG group, and the
 * match ran on past the real closing quote into unrelated source. Splitting
 * the extraction/unescaping into JS (`literalValue` below) instead of relying
 * on regex capture groups avoids the whole class of "group count shifted"
 * bugs when this fragment gets composed into different larger patterns.
 */
const STRING_LITERAL_WHOLE =
  '(?:\'(?:\\\\.|[^\'\\\\])*\'|"(?:\\\\.|[^"\\\\])*"|`(?:\\\\.|[^`\\\\])*`)';

/**
 * Given a matched-whole string literal (quotes included), return its decoded
 * value — or `null` when it is a TEMPLATE literal carrying `${…}`
 * interpolation. An interpolated template's real runtime value is not its
 * source text (`` `${VERSION_PIN[1]}${PIN_MAJOR}` `` is not a stable anchor,
 * it is computed), so treating the raw text as a literal anchor here would be
 * exactly the false-positive class #1223 exists to avoid manufacturing.
 * Callers must treat `null` the same as an unresolved identifier.
 */
function literalValue(whole) {
  if (whole[0] === '`' && /\$\{/.test(whole)) return null;
  return unescapeJsString(whole.slice(1, -1));
}

/**
 * Every tracked `scripts/mutation-prove-*.mjs`, repo-relative. Discovered,
 * never enumerated — a hardcoded list is exactly what lets a new prover
 * silently evade this scan.
 */
export function findProverFiles(repoRoot) {
  return readdirSync(resolve(repoRoot, 'scripts'))
    .filter((name) => PROVER_FILE_RE.test(name))
    .sort()
    .map((name) => `scripts/${name}`);
}

/**
 * Blank out the INTERIOR of every real top-level JS string literal in `src`,
 * keeping length/line structure intact.
 *
 * A prover that mutates another SCRIPT's source (e.g.
 * `mutation-prove-scratch-space.mjs`, whose `anchor`/`replacement` pairs are
 * themselves JS snippets containing calls like `resolve(repoRoot, 'tests/…')`
 * AS TEXT) would otherwise have that quoted-inside-a-quote text picked up by
 * the subject-file `resolve(...)` scan below as if it named a real target —
 * a false positive this masking exists to prevent. Real string literals
 * cannot nest in JS, so a single linear scan (quote-state + escape handling,
 * no stack) is enough; this is NOT the brace-matching this module's history
 * tried and dropped for being bug-prone — no nesting depth is tracked here.
 *
 * Comments are skipped FIRST, before quote detection: this repo's own prose
 * comments are full of apostrophes ("the run's ledger", "it's"), and an
 * apostrophe inside a `//`/`/* *\/` comment is not a string delimiter. Without
 * this, an odd apostrophe count in a comment desyncs the quote-state tracker
 * for the rest of the file — measured against
 * `mutation-prove-ledger-completeness.mjs`, whose real `resolve(...)` subject
 * declarations vanished entirely until this was added.
 */
function maskStringLiterals(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : close + 2;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += quote;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < src.length) {
        out += quote;
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Index of the matching `)` for an `(` at `openIdx` in `masked` (comments/strings already blanked). */
function findMatchingParen(masked, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i += 1) {
    if (masked[i] === '(') depth += 1;
    else if (masked[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split the text between `start` and `end` (both exclusive of the enclosing
 * parens) on TOP-LEVEL commas only, using `masked` to find split points and
 * recovering the real text from `src` at the same offsets.
 */
function splitTopLevelArgs(src, masked, start, end) {
  const parts = [];
  let depth = 0;
  let segStart = start;
  for (let i = start; i < end; i += 1) {
    const c = masked[i];
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(src.slice(segStart, i).trim());
      segStart = i + 1;
    }
  }
  const last = src.slice(segStart, end).trim();
  if (last !== '') parts.push(last);
  return parts;
}

/**
 * Local wrapper functions of the shape `function prove(label, anchor,
 * replacement)` / `function prove(label, file, anchor, replacement)` (any
 * name, any arity, simple identifier params only — a destructured or
 * defaulted trailing param is tolerated by treating it as unresolvable, not
 * by aborting the whole function). Every prover in this repo names its
 * literal-anchor parameter exactly `anchor`, and its target-file parameter
 * (when present) `file` — both by convention, not by this scan's invention.
 *
 * Returns `name -> { anchorIdx, fileIdx }` (either index may be -1).
 */
function findAnchorParamFunctions(masked) {
  const fns = new Map();
  const declRe = /\bfunction\s+(\w+)\s*\(/g;
  for (const m of masked.matchAll(declRe)) {
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingParen(masked, openIdx);
    if (closeIdx === -1) continue;
    const params = splitTopLevelArgs(masked, masked, openIdx + 1, closeIdx);
    const names = params.map((p) => {
      const base = p.split('=')[0].trim();
      return /^\w+$/.test(base) ? base : null;
    });
    const anchorIdx = names.indexOf('anchor');
    if (anchorIdx === -1) continue;
    const fileIdx = names.indexOf('file') !== -1 ? names.indexOf('file') : names.indexOf('subject');
    fns.set(m[1], { anchorIdx, fileIdx, declOpenIdx: openIdx });
  }
  return fns;
}

/**
 * Resolve literal (anchor, [file]) pairs from every CALL SITE of the
 * functions `findAnchorParamFunctions` found — skipping the declaration
 * itself and any call whose relevant argument is not a plain literal or a
 * known `identToPath`-mapped constant (the `const CI_YML = resolve(ROOT,
 * '.github/workflows/ci.yml')` shape most provers use for their file param).
 *
 * @param {Map<string, string>} identToPath module-level `ident -> literal path`
 */
function scanWrapperCallSites(src, masked, fns, identToPath) {
  const results = [];
  let unresolved = 0;
  for (const [name, { anchorIdx, fileIdx, declOpenIdx }] of fns) {
    const callRe = new RegExp(`\\b${name}\\s*\\(`, 'g');
    for (const m of masked.matchAll(callRe)) {
      const openIdx = m.index + m[0].length - 1;
      if (openIdx === declOpenIdx) continue; // the declaration itself
      const closeIdx = findMatchingParen(masked, openIdx);
      if (closeIdx === -1) continue;
      const args = splitTopLevelArgs(src, masked, openIdx + 1, closeIdx);
      const anchorArg = args[anchorIdx];
      if (anchorArg === undefined) continue;
      const litRe = new RegExp(`^(${STRING_LITERAL_WHOLE})$`);
      const anchorLit = litRe.exec(anchorArg);
      const anchorValue = anchorLit ? literalValue(anchorLit[1]) : null;
      if (anchorValue === null) {
        unresolved += 1;
        continue;
      }
      // `hasFileParam` distinguishes "no file/subject parameter at all" (safe
      // to fall back to the prover's module-level subject files, e.g. plain
      // `prove(label, anchor, replacement)`) from "a file/subject parameter
      // EXISTS but THIS call passed something this scan cannot resolve"
      // (e.g. a template string built at runtime such as `CONTRACT_TEMPLATE`
      // — NOT safe to guess at; the real subject may not be any single
      // tracked file at all). Falling back for the second case is what
      // produced `mutation-prove-bytecap.mjs` false positives during
      // development: its anchors were checked against four UNRELATED files
      // that merely happened to be mentioned elsewhere in the same script.
      let file = null;
      let fileUnresolved = false;
      if (fileIdx !== -1 && args[fileIdx] !== undefined) {
        const fileArg = args[fileIdx];
        const fileLit = litRe.exec(fileArg);
        if (fileLit) file = literalValue(fileLit[1]);
        else if (/^\w+$/.test(fileArg) && identToPath.has(fileArg)) file = identToPath.get(fileArg);
        else fileUnresolved = true;
      }
      results.push({ anchor: anchorValue, file, hasFileParam: fileIdx !== -1, fileUnresolved });
    }
  }
  return { results, unresolved };
}

/**
 * Scan one prover file. Returns:
 *   - `subjectFiles`: every literal repo-relative path found via
 *     `resolve(<ident>, '<literal>')`, deduped;
 *   - `anchors`: every literal text anchor found (decoded), deduped;
 *   - `unresolvedAnchorCount`: anchors referenced by an identifier this scan
 *     could not resolve to a literal (e.g. `mutate(snap, someComputedVar,
 *     ...)`) — informational, never asserted on.
 */
export function scanProverFile(repoRoot, relPath) {
  const src = readFileSync(resolve(repoRoot, relPath), 'utf8');
  // Subject-file resolution scans the MASKED source — see maskStringLiterals.
  // Anchor extraction below intentionally uses the UNMASKED source: an anchor
  // or replacement's own text legitimately lives inside a string literal.
  const structural = maskStringLiterals(src);

  const subjectFiles = new Set();
  // `ident -> literal path`, for `const CI_YML = resolve(ROOT, '...')` style
  // module-level constants passed as a file/subject argument at a wrapper
  // call site.
  const identToPath = new Map();
  for (const m of structural.matchAll(
    new RegExp(
      `const\\s+(\\w+)\\s*=\\s*resolve\\(\\s*\\w+\\s*,\\s*(${STRING_LITERAL_WHOLE})\\s*\\)`,
      'g',
    ),
  )) {
    const litStart = m.index + m[0].indexOf(m[2]);
    const value = literalValue(src.slice(litStart, litStart + m[2].length));
    if (value !== null) identToPath.set(m[1], value);
  }
  for (const m of structural.matchAll(
    new RegExp(`resolve\\(\\s*\\w+\\s*,\\s*(${STRING_LITERAL_WHOLE})\\s*\\)`, 'g'),
  )) {
    // The masked source blanked the literal's INTERIOR, so recover the real
    // value from the same span in the ORIGINAL source.
    const value = literalValue(
      src.slice(m.index + m[0].indexOf(m[1]), m.index + m[0].indexOf(m[1]) + m[1].length),
    );
    if (value !== null) subjectFiles.add(value);
  }

  const anchorConstMap = new Map();
  for (const m of src.matchAll(
    new RegExp(
      `const\\s+(\\w*[Aa][Nn][Cc][Hh][Oo][Rr]\\w*)\\s*=\\s*(${STRING_LITERAL_WHOLE})`,
      'g',
    ),
  )) {
    const value = literalValue(m[2]);
    if (value !== null) anchorConstMap.set(m[1], value);
  }

  const anchors = new Set();
  let unresolvedAnchorCount = 0;

  for (const m of src.matchAll(new RegExp(`\\banchor\\s*:\\s*(${STRING_LITERAL_WHOLE})`, 'g'))) {
    const value = literalValue(m[1]);
    if (value !== null) anchors.add(value);
    else unresolvedAnchorCount += 1;
  }

  for (const m of src.matchAll(/mutate\(\s*[\w.[\]'"]+\s*,\s*([^,]+),/g)) {
    const argText = m[1].trim();
    const litMatch = new RegExp(`^(${STRING_LITERAL_WHOLE})$`).exec(argText);
    if (litMatch && literalValue(litMatch[1]) === null) {
      unresolvedAnchorCount += 1;
      continue;
    }
    if (litMatch) {
      anchors.add(literalValue(litMatch[1]));
      continue;
    }
    if (/^\w+$/.test(argText) && anchorConstMap.has(argText)) {
      anchors.add(anchorConstMap.get(argText));
      continue;
    }
    // Not a literal and not a resolvable const — computed at runtime, or a
    // shape this scan does not model. Leave it to `mutate()`'s own check.
    unresolvedAnchorCount += 1;
  }

  // Tier 2: local wrapper functions (`function prove(label, anchor,
  // replacement)` and friends) — the shape `mutation-prove-compat-window-
  // audit.mjs`, the prover #1223 was filed against, actually uses.
  const wrapperFns = findAnchorParamFunctions(structural);
  const { results: wrapperResults, unresolved: wrapperUnresolved } = scanWrapperCallSites(
    src,
    structural,
    wrapperFns,
    identToPath,
  );
  unresolvedAnchorCount += wrapperUnresolved;

  const soleTarget = subjectFiles.size === 1 ? [...subjectFiles][0] : null;

  /** @type {Array<{anchor: string, subjectFiles: string[]}>} */
  const pairs = [];
  for (const anchor of anchors) {
    if (subjectFiles.size === 0) {
      unresolvedAnchorCount += 1;
      continue;
    }
    pairs.push({ anchor, subjectFiles: [...subjectFiles] });
  }
  for (const r of wrapperResults) {
    if (r.file) {
      pairs.push({ anchor: r.anchor, subjectFiles: [r.file] });
      continue;
    }
    if (r.hasFileParam && r.fileUnresolved) {
      // A file/subject parameter EXISTS but this call's value could not be
      // read as a literal — the real subject may be a computed/synthesised
      // string that is not any single tracked file. Guessing here is what
      // produced false positives during development (see the comment above
      // `hasFileParam` in `scanWrapperCallSites`); leave it to `mutate()`.
      unresolvedAnchorCount += 1;
      continue;
    }
    // No file/subject parameter at all — the common `prove(label, anchor,
    // replacement)` shape. Safe to fall back to whatever this prover's
    // module-level `resolve(...)` calls named.
    const files = soleTarget ? [soleTarget] : [...subjectFiles];
    if (files.length === 0) {
      unresolvedAnchorCount += 1;
      continue;
    }
    pairs.push({ anchor: r.anchor, subjectFiles: files });
  }

  // De-duplicate identical (anchor, subjectFiles-set) pairs — the same
  // literal anchor is often declared once and used by several call sites.
  const seen = new Set();
  const dedupedPairs = [];
  for (const p of pairs) {
    const key = `${[...p.subjectFiles].sort().join('|')}\u0000${p.anchor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedPairs.push(p);
  }

  return {
    file: relPath,
    subjectFiles: [...subjectFiles],
    anchors: [...new Set(dedupedPairs.map((p) => p.anchor))],
    pairs: dedupedPairs,
    unresolvedAnchorCount,
  };
}

/**
 * Audit one scanned prover against the CURRENT file tree. Returns an array of
 * finding strings; empty means either clean, or nothing statically checkable
 * was found (no resolved pairs — not a finding, see the module doc).
 */
export function auditProverAnchors(repoRoot, scanned) {
  const findings = [];
  const fileCache = new Map();
  function readOrNull(f) {
    if (fileCache.has(f)) return fileCache.get(f);
    let text = null;
    try {
      text = readFileSync(resolve(repoRoot, f), 'utf8');
    } catch {
      text = null;
    }
    fileCache.set(f, text);
    return text;
  }

  for (const { anchor, subjectFiles } of scanned.pairs) {
    const missing = subjectFiles.filter((f) => readOrNull(f) === null);
    if (missing.length > 0) {
      findings.push(`${scanned.file}: subject file(s) no longer exist: ${missing.join(', ')}`);
      continue;
    }
    if (subjectFiles.length === 1) {
      const text = readOrNull(subjectFiles[0]);
      const n = text.split(anchor).length - 1;
      if (n !== 1) {
        findings.push(
          `${scanned.file}: anchor occurs ${n}x in ${subjectFiles[0]} (expected exactly 1): ` +
            `${JSON.stringify(anchor.slice(0, 100))}`,
        );
      }
      continue;
    }
    // Multiple subject files: the looser union check (see module doc).
    const total = subjectFiles.reduce(
      (sum, f) => sum + (readOrNull(f).split(anchor).length - 1),
      0,
    );
    if (total === 0) {
      findings.push(
        `${scanned.file}: anchor occurs in NONE of [${subjectFiles.join(', ')}]: ` +
          `${JSON.stringify(anchor.slice(0, 100))}`,
      );
    }
  }
  return findings;
}
