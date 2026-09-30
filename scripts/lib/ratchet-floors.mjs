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
 * `/** ... *\/` block comment. `findMarkedDeclarations` SCANS source text for
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
 * FAIL CLOSED, NEVER CRASH (review round 2, #1253). A marked declaration this
 * module cannot make sense of — missing entirely, not a `const` at all, an
 * RHS whose evaluation throws (e.g. it references an identifier that does
 * not exist in a standalone `Function` scope) — is reported as a STRUCTURED
 * error via `extractRatchetFloors`'s `errors` array, never thrown as an
 * uncaught exception that crashes the CLI with a raw stack trace. The CALLER
 * (`scripts/check-ratchet-floors.mjs`) treats any such error, at either ref,
 * as a violation: "cannot evaluate floor X" is exactly as much a reason to
 * fail the guard as a floor that measurably went down — an unparseable
 * marked declaration could otherwise hide a lowering behind a RHS bug.
 *
 * FLATTENING. A value is flattened to `{ "<path>": number }` pairs, where
 * `<path>` for a bare scalar is just its declared name, and for an object is
 * `NAME.key` or `NAME.key.subkey` for one level of nesting. Only numeric
 * leaves are compared — string/other leaves are ignored, so a floor's
 * metadata (if any) can never itself register as a comparable ratchet.
 */

export const RATCHET_FLOOR_MARKER = '@ratchet-floor';

/**
 * A line COUNTS as the marker only when, after stripping a leading comment
 * prefix (`//`, `/**`, `*`, `/*`) and whitespace, it STARTS WITH the marker
 * literal. This is deliberately narrower than "contains the marker
 * substring": both this file's and the CLI's own header docs quote
 * `@ratchet-floor` in prose (describing the contract), and a substring match
 * would misread that prose as a real marker with no declaration beneath it.
 * A real marker line reads `// @ratchet-floor` or `* @ratchet-floor`
 * (optionally followed by an em-dash explanation) with nothing before it.
 */
function isMarkerLine(line) {
  const stripped = line.replace(/^\s*(\/\*\*|\/\*|\*\/|\*|\/\/)\s*/, '').trimStart();
  return stripped.startsWith(RATCHET_FLOOR_MARKER);
}

/**
 * @typedef {{ name: string, raw: string, line: number }} MarkedDeclaration
 */

/**
 * @param {string} source
 * @param {string} filePath repo-relative path, used only for error messages
 * @returns {{ decls: MarkedDeclaration[], errors: string[] }}
 */
function findMarkedDeclarations(source, filePath) {
  const lines = source.split('\n');
  /** @type {MarkedDeclaration[]} */
  const decls = [];
  /** @type {string[]} */
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isMarkerLine(lines[i])) continue;
    // Walk forward past any remaining comment lines to the declaration.
    let j = i + 1;
    while (j < lines.length && (/^\s*(\*|\/\/|\/\*)/.test(lines[j]) || lines[j].trim() === '')) {
      j++;
    }
    if (j >= lines.length) {
      errors.push(`${RATCHET_FLOOR_MARKER} at ${filePath}:${i + 1} has no following declaration`);
      continue;
    }
    const declLine = lines[j];
    const nameMatch = declLine.match(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/);
    if (!nameMatch) {
      errors.push(
        `${RATCHET_FLOOR_MARKER} at ${filePath}:${i + 1} must be followed by a "const NAME = ..." declaration, got: ${declLine.trim()}`,
      );
      continue;
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
      errors.push(
        `${RATCHET_FLOOR_MARKER} declaration for ${name} in ${filePath} never terminates with ';'`,
      );
      continue;
    }
    // Trim the trailing `;` (and anything after it on the terminating line).
    const semiIdx = rhs.lastIndexOf(';');
    rhs = rhs.slice(0, semiIdx);
    decls.push({ name, raw: rhs.trim(), line: i + 1 });
  }
  return { decls, errors };
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
 * NEVER THROWS. A structural problem (marker with no declaration, an RHS
 * that fails to evaluate, ...) is reported via the returned `errors` array
 * instead — see the file header ("FAIL CLOSED, NEVER CRASH").
 *
 * @param {string} source
 * @param {string} filePath repo-relative path (used for error text + returned keys)
 * @returns {{ floors: Record<string, number>, errors: string[] }} `floors` keyed by `"<filePath>::<dotted-path>"`
 */
export function extractRatchetFloors(source, filePath) {
  const { decls, errors } = findMarkedDeclarations(source, filePath);
  /** @type {Record<string, number>} */
  const floors = {};
  for (const { name, raw, line } of decls) {
    let value;
    try {
      // eslint-disable-next-line no-new-func
      value = new Function(`"use strict"; return (${raw});`)();
    } catch (err) {
      errors.push(
        `cannot evaluate floor ${name} at ${filePath}:${line}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    const leaves = flattenNumericLeaves(name, value);
    for (const [path, num] of Object.entries(leaves)) {
      floors[`${filePath}::${path}`] = num;
    }
  }
  return { floors, errors };
}

/**
 * @typedef {{ file: string, path: string, reason: string, date: string }} AllowlistEntry
 */

/**
 * Compares HEAD floors against BASE floors, returning every regression not
 * covered by an allowlist entry INTRODUCED by this PR (i.e. present at HEAD
 * but absent, for the same file+path, at BASE — an inherited entry exempts
 * nothing). A regression is either:
 *
 *   - a floor whose HEAD value is strictly lower than its BASE value, or
 *   - a floor present at BASE and ABSENT at HEAD entirely — deleting the
 *     `@ratchet-floor` marker, renaming the constant, or moving/removing the
 *     declaration is exactly as much a "lowering" as editing the number
 *     (review round 2, #1253): treating a removed floor as "not this
 *     guard's concern" made deleting the marker a bypass.
 *
 * @param {Record<string, number>} baseFloors
 * @param {Record<string, number>} headFloors
 * @param {AllowlistEntry[]} headAllowlist
 * @param {AllowlistEntry[]} baseAllowlist
 * @returns {Array<{ key: string, base: number, head: number | null }>}
 */
export function findLoweredFloors(baseFloors, headFloors, headAllowlist = [], baseAllowlist = []) {
  const introducedKeys = new Set(
    headAllowlist
      .filter((entry) => !baseAllowlist.some((b) => b.file === entry.file && b.path === entry.path))
      .map((entry) => `${entry.file}::${entry.path}`),
  );

  const violations = [];
  for (const [key, baseValue] of Object.entries(baseFloors)) {
    if (introducedKeys.has(key)) continue;
    if (!(key in headFloors)) {
      violations.push({ key, base: baseValue, head: null });
      continue;
    }
    const headValue = headFloors[key];
    if (headValue < baseValue) {
      violations.push({ key, base: baseValue, head: headValue });
    }
  }
  return violations;
}
