/**
 * A small lcov parser / merger / summariser (#884).
 *
 * knext has TWO coverage producers and neither is the truth on its own:
 *
 *   - `vitest` collects 3 test files but enumerates every source file, so it
 *     supplies the honest DENOMINATOR — untouched files present at 0%;
 *   - `scripts/bun-test.mjs` runs the suite one PROCESS per test file, so it
 *     supplies almost the whole NUMERATOR, spread across ~338 reports.
 *
 * Merging them is what makes the gate mean something again. The rules, and why:
 *
 *   - the set of KNOWN lines is the union across reports. bun reports only the
 *     files a given test loaded, so intersecting would let the bun half shrink
 *     the denominator — the exact dishonesty the gate exists to prevent;
 *   - a line's hits are SUMMED. Only `> 0` is load-bearing, but summing keeps
 *     the merged report a truthful lcov rather than a boolean mask;
 *   - functions merge to a conservative LOWER BOUND (see coverage-policy.mjs:
 *     bun emits `FNF`/`FNH` counts with no per-function identity);
 *   - branches are not represented, because bun emits none.
 *
 * No dependency: this runs under plain `node` in CI before anything is built.
 */

/** @typedef {{ lines: Map<number, number>, fnFound: number, fnHit: number, fnNames: Map<string, number> }} FileCoverage */

/**
 * Parse lcov text into a map of source path -> coverage.
 *
 * Tolerant by design: it reads the records both producers actually emit (`SF`,
 * `DA`, `FN`, `FNDA`, `FNF`, `FNH`) and ignores everything else, including the
 * `LF`/`LH` totals — those are DERIVED from `DA` on the way out, so a merged
 * report can never carry a total that disagrees with its own lines.
 *
 * @param {string} text
 * @returns {Map<string, FileCoverage>}
 */
export function parseLcov(text) {
  /** @type {Map<string, FileCoverage>} */
  const files = new Map();
  /** @type {FileCoverage | null} */
  let current = null;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon);
    const value = line.slice(colon + 1);

    if (key === 'SF') {
      const path = normalisePath(value);
      current = files.get(path) ?? { lines: new Map(), fnFound: 0, fnHit: 0, fnNames: new Map() };
      files.set(path, current);
      continue;
    }
    if (current === null) continue;

    switch (key) {
      case 'DA': {
        const [num, hits] = value.split(',');
        const lineNo = Number(num);
        const count = Number(hits);
        if (!Number.isFinite(lineNo) || !Number.isFinite(count)) break;
        current.lines.set(lineNo, (current.lines.get(lineNo) ?? 0) + count);
        break;
      }
      case 'FNDA': {
        // `FNDA:<hits>,<name>` — the name may itself contain commas.
        const comma = value.indexOf(',');
        if (comma === -1) break;
        const hits = Number(value.slice(0, comma));
        const name = value.slice(comma + 1);
        if (!Number.isFinite(hits)) break;
        current.fnNames.set(name, (current.fnNames.get(name) ?? 0) + hits);
        break;
      }
      case 'FN': {
        // `FN:<line>,<name>` — declares a function that may never be hit.
        const comma = value.indexOf(',');
        if (comma === -1) break;
        const name = value.slice(comma + 1);
        if (!current.fnNames.has(name)) current.fnNames.set(name, 0);
        break;
      }
      case 'FNF':
        current.fnFound = Math.max(current.fnFound, Number(value) || 0);
        break;
      case 'FNH':
        current.fnHit = Math.max(current.fnHit, Number(value) || 0);
        break;
      case 'end_of_record':
        current = null;
        break;
      default:
        break;
    }
  }

  return files;
}

/**
 * Merge lcov texts (or already-parsed maps) into one coverage map.
 *
 * @param {Array<string | Map<string, FileCoverage>>} sources
 * @returns {Map<string, FileCoverage>}
 */
export function mergeLcov(sources) {
  /** @type {Map<string, FileCoverage>} */
  const merged = new Map();

  for (const source of sources) {
    const parsed = typeof source === 'string' ? parseLcov(source) : source;
    for (const [path, cov] of parsed) {
      const target = merged.get(path) ?? {
        lines: new Map(),
        fnFound: 0,
        fnHit: 0,
        fnNames: new Map(),
      };
      for (const [lineNo, hits] of cov.lines) {
        target.lines.set(lineNo, (target.lines.get(lineNo) ?? 0) + hits);
      }
      for (const [name, hits] of cov.fnNames) {
        target.fnNames.set(name, (target.fnNames.get(name) ?? 0) + hits);
      }
      // Counts, not identities: max is the tightest bound that cannot overstate.
      target.fnFound = Math.max(target.fnFound, cov.fnFound);
      target.fnHit = Math.max(target.fnHit, cov.fnHit);
      merged.set(path, target);
    }
  }

  // Named records, when present, are strictly better than the counts: they DO
  // union. Take whichever is larger, per file.
  for (const cov of merged.values()) {
    if (cov.fnNames.size > 0) {
      cov.fnFound = Math.max(cov.fnFound, cov.fnNames.size);
      let hit = 0;
      for (const hits of cov.fnNames.values()) if (hits > 0) hit++;
      cov.fnHit = Math.max(cov.fnHit, hit);
    }
    // A file can never have more hit functions than found ones; a merge of a
    // bound and a union could otherwise produce that.
    cov.fnHit = Math.min(cov.fnHit, cov.fnFound);
  }

  return merged;
}

/**
 * Render a coverage map back to lcov, so the merged report is a real artifact
 * (uploadable to codecov, readable by `genhtml`) and not just a number.
 *
 * @param {Map<string, FileCoverage>} files
 * @returns {string}
 */
export function formatLcov(files) {
  const out = [];
  for (const path of [...files.keys()].sort()) {
    const cov = /** @type {FileCoverage} */ (files.get(path));
    out.push('TN:', `SF:${path}`);
    for (const [name, hits] of cov.fnNames) out.push(`FNDA:${hits},${name}`);
    out.push(`FNF:${cov.fnFound}`, `FNH:${cov.fnHit}`);
    let found = 0;
    let hit = 0;
    for (const lineNo of [...cov.lines.keys()].sort((a, b) => a - b)) {
      const hits = /** @type {number} */ (cov.lines.get(lineNo));
      out.push(`DA:${lineNo},${hits}`);
      found++;
      if (hits > 0) hit++;
    }
    out.push(`LF:${found}`, `LH:${hit}`, 'end_of_record');
  }
  return `${out.join('\n')}\n`;
}

/**
 * Totals over a coverage map, optionally restricted to a glob.
 *
 * @param {Map<string, FileCoverage>} files
 * @param {string} [glob] e.g. `packages/kn-next/src/**`
 */
export function summarize(files, glob) {
  let linesFound = 0;
  let linesHit = 0;
  let fnFound = 0;
  let fnHit = 0;
  let fileCount = 0;

  for (const [path, cov] of files) {
    if (glob !== undefined && !matchesGlob(path, glob)) continue;
    fileCount++;
    for (const hits of cov.lines.values()) {
      linesFound++;
      if (hits > 0) linesHit++;
    }
    fnFound += cov.fnFound;
    fnHit += cov.fnHit;
  }

  return {
    fileCount,
    linesFound,
    linesHit,
    linesPct: pct(linesHit, linesFound),
    fnFound,
    fnHit,
    functionsPct: pct(fnHit, fnFound),
  };
}

/** 0 found is 0%, never NaN and never a vacuous 100% that would pass a floor. */
function pct(hit, found) {
  return found === 0 ? 0 : (hit / found) * 100;
}

/** Repo-relative, forward slashes, no `./` prefix — both producers vary here. */
export function normalisePath(path) {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Minimal glob matcher covering exactly what the coverage policy uses:
 * `**` (any depth, including none), `*` (one segment), and `{a,b}` alternation.
 *
 * Hand-rolled rather than pulled from `minimatch`: this runs under plain `node`
 * in CI before any install of the tooling workspace, and the pattern set is
 * fixed and tiny.
 */
export function matchesGlob(path, glob) {
  return globToRegExp(glob).test(normalisePath(path));
}

const globCache = new Map();

function globToRegExp(glob) {
  const cached = globCache.get(glob);
  if (cached !== undefined) return cached;

  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches any number of leading segments, including none.
        if (glob[i + 2] === '/') {
          re += '(?:[^/]*/)*';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
      continue;
    }
    if (c === '{') {
      const close = glob.indexOf('}', i);
      if (close !== -1) {
        const alts = glob
          .slice(i + 1, close)
          .split(',')
          .map(escapeRe);
        re += `(?:${alts.join('|')})`;
        i = close;
        continue;
      }
    }
    if (c === '?') {
      re += '[^/]';
      continue;
    }
    re += escapeRe(c);
  }

  const compiled = new RegExp(`^${re}$`);
  globCache.set(glob, compiled);
  return compiled;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
