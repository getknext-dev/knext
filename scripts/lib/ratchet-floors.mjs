/**
 * Ratchet-floor extraction + comparison (#1253).
 *
 * WHY THIS EXISTS. Several guards in this repo carry a "raise it, never lower
 * it" comment above a numeric constant — `THRESHOLDS` / `PER_PATH_THRESHOLDS`
 * / `HONEST_THRESHOLDS` / `HONEST_PER_PATH_THRESHOLDS` in
 * `scripts/lib/coverage-policy.mjs`, `MIN_RESOLVED_PAIRS` /
 * `MIN_RESOLVED_PROVERS` in `tests/mutation-prover-anchor-drift.test.ts`. The
 * "never lower" rule lived only in prose, so a PR could quietly lower a floor
 * to get green and nothing mechanical stopped it.
 *
 * MARKER, NOT AN ENUMERATED LIST. A declaration opts into this check by
 * carrying `RATCHET_FLOOR_MARKER` on the line (or block-comment) immediately
 * above it — `// @ratchet-floor` for a line comment, or as the last line of a
 * `/** ... *\/` block comment. `findRatchetDeclarations` SCANS source text for
 * the marker; a new ratchet floor written anywhere in the repo is picked up
 * the next time this runs, with no second place to register it.
 *
 * WHAT A MARKED DECLARATION MUST LOOK LIKE. Either
 *   `const NAME = <number literal>;`               (a bare scalar floor), or
 *   `export const NAME = { ... };`                 (an object of numeric
 *                                                     leaves, optionally
 *                                                     nested one level, e.g.
 *                                                     `PER_PATH_THRESHOLDS`).
 * The object form is evaluated with `Function('return (' + text + ')')()` —
 * safe here because the text is a literal object drawn from a file this repo
 * itself tracks (never external input), the same trust boundary the rest of
 * this repo's own config-literal parsing already relies on.
 *
 * FLATTENING. A value is flattened to `{ "<path>": number }` pairs, where
 * `<path>` for a bare scalar is just its declared name, and for an object is
 * `NAME.key` or `NAME.key.subkey` for one level of nesting. Only numeric
 * leaves are compared — string/other leaves are ignored, so a floor's
 * metadata (if any) can never itself register as a comparable ratchet.
 */

export const RATCHET_FLOOR_MARKER = '@ratchet-floor';

/**
 * @param {string} source
 * @param {string} filePath repo-relative path, used only for error messages
 * @returns {Array<{ name: string, raw: string }>}
 */
function findMarkedDeclarations(source, filePath) {
  const lines = source.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(RATCHET_FLOOR_MARKER)) continue;
    // Walk forward past any remaining comment lines to the declaration.
    let j = i + 1;
    while (j < lines.length && (/^\s*(\*|\/\/|\/\*)/.test(lines[j]) || lines[j].trim() === '')) {
      j++;
    }
    if (j >= lines.length) {
      throw new Error(
        `${RATCHET_FLOOR_MARKER} at ${filePath}:${i + 1} has no following declaration`,
      );
    }
    const declLine = lines[j];
    const nameMatch = declLine.match(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/);
    if (!nameMatch) {
      throw new Error(
        `${RATCHET_FLOOR_MARKER} at ${filePath}:${i + 1} must be followed by a "const NAME = ..." declaration, got: ${declLine.trim()}`,
      );
    }
    const name = nameMatch[1];
    // Capture the RHS: from after the `=` up to the statement-ending `;`
    // that closes the top-level construct (balanced braces/brackets/parens,
    // ignoring `;` inside strings is not needed — none of the shapes we
    // support use semicolons inside their literal).
    const startIdx = declLine.indexOf('=') + 1;
    let rhs = declLine.slice(startIdx);
    let k = j;
    let depth = 0;
    let terminated = false;
    // Track depth across the (possibly multi-line) RHS to find the
    // statement-ending `;` at depth 0.
    const scan = (text) => {
      for (const ch of text) {
        if (ch === '{' || ch === '[' || ch === '(') depth++;
        else if (ch === '}' || ch === ']' || ch === ')') depth--;
        else if (ch === ';' && depth === 0) return true;
      }
      return false;
    };
    if (scan(rhs)) {
      terminated = true;
    } else {
      k++;
      while (k < lines.length) {
        rhs += `\n${lines[k]}`;
        if (scan(lines[k])) {
          terminated = true;
          break;
        }
        k++;
      }
    }
    if (!terminated) {
      throw new Error(
        `${RATCHET_FLOOR_MARKER} declaration for ${name} in ${filePath} never terminates with ';'`,
      );
    }
    // Trim the trailing `;` (and anything after it on the terminating line).
    const semiIdx = rhs.lastIndexOf(';');
    rhs = rhs.slice(0, semiIdx);
    found.push({ name, raw: rhs.trim() });
  }
  return found;
}

/**
 * Flattens a marked declaration's literal value into `{ path: number }`.
 * @param {string} name
 * @param {unknown} value
 * @returns {Record<string, number>}
 */
function flattenNumericLeaves(name, value) {
  /** @type {Record<string, number>} */
  const out = {};
  if (typeof value === 'number') {
    out[name] = value;
    return out;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, v] of Object.entries(value)) {
      if (typeof v === 'number') {
        out[`${name}.${key}`] = v;
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [subKey, subV] of Object.entries(v)) {
          if (typeof subV === 'number') out[`${name}.${key}.${subKey}`] = subV;
        }
      }
    }
  }
  return out;
}

/**
 * Extracts every `@ratchet-floor`-marked numeric leaf from a source string.
 *
 * @param {string} source
 * @param {string} filePath repo-relative path (used for error text + returned keys)
 * @returns {Record<string, number>} keyed by `"<filePath>::<dotted-path>"`
 */
export function extractRatchetFloors(source, filePath) {
  const decls = findMarkedDeclarations(source, filePath);
  /** @type {Record<string, number>} */
  const out = {};
  for (const { name, raw } of decls) {
    // eslint-disable-next-line no-new-func
    const value = new Function(`"use strict"; return (${raw});`)();
    const leaves = flattenNumericLeaves(name, value);
    for (const [path, num] of Object.entries(leaves)) {
      out[`${filePath}::${path}`] = num;
    }
  }
  return out;
}

/**
 * @typedef {{ file: string, path: string, reason: string, date: string }} AllowlistEntry
 */

/**
 * Compares HEAD floors against BASE floors, returning every regression
 * (a floor whose HEAD value is strictly lower than its BASE value) not
 * covered by an allowlist entry INTRODUCED by this PR (i.e. present at HEAD
 * but absent, for the same file+path, at BASE — an inherited entry exempts
 * nothing).
 *
 * @param {Record<string, number>} baseFloors
 * @param {Record<string, number>} headFloors
 * @param {AllowlistEntry[]} headAllowlist
 * @param {AllowlistEntry[]} baseAllowlist
 * @returns {Array<{ key: string, base: number, head: number }>}
 */
export function findLoweredFloors(baseFloors, headFloors, headAllowlist = [], baseAllowlist = []) {
  const introducedKeys = new Set(
    headAllowlist
      .filter((entry) => !baseAllowlist.some((b) => b.file === entry.file && b.path === entry.path))
      .map((entry) => `${entry.file}::${entry.path}`),
  );

  const violations = [];
  for (const [key, baseValue] of Object.entries(baseFloors)) {
    if (!(key in headFloors)) continue; // removed floor entirely — not this guard's concern
    const headValue = headFloors[key];
    if (headValue < baseValue && !introducedKeys.has(key)) {
      violations.push({ key, base: baseValue, head: headValue });
    }
  }
  return violations;
}
