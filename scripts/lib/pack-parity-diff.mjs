#!/usr/bin/env node
/**
 * pack-parity-diff.mjs — pure comparison logic for the G3 nightly pack-parity
 * check (#1734, residual of #1614).
 *
 * WHY: the compat CREDENTIAL lanes (`test-e2e-deploy.yml`, `compat-vinext.yml`)
 * pack the `@getknext/*` publishable group with `bun pm pack`, while the real
 * publish tool (`changeset publish` -> `npm publish` for a bun workspace) ships
 * `npm pack` bytes (see `scripts/lib/pack-publishable-group.mjs`'s header for
 * the measured divergence: a different `workspace:` rewrite source, and a
 * duplicate tar entry for a multi-`bin`-key target). #1614 fixed every lane
 * THIS REPO CONTROLS to pack with `npm pack`; the two credential lanes above
 * are explicitly OUT of scope — they are frozen by ADR-0056/ADR-0039 for the
 * length of the compat-credential window, so they cannot be changed to match
 * without restarting the 14-night window. This module is the comparator a
 * nightly, non-required job (`scripts/verify-rc-pack-parity.mjs`) uses to
 * measure — not assume — whether that divergence is actually present in the
 * bytes real users install from npm for the pinned rc tag.
 *
 * SCOPE: this is a SAME-VERSION, byte-identity comparison — unlike
 * `scripts/lib/ga-tarball-diff.mjs` (which allows an rc->GA version
 * substitution), nothing here is "allowed" to differ. Every entry must match
 * by NAME and TYPE; every FILE entry must match by raw content bytes. Tar
 * metadata the two packers are expected to disagree on and that carries no
 * runtime meaning (mtime; entry order) is never read by
 * `scripts/lib/tar-entries.mjs` in the first place, so it cannot leak into
 * this comparison. Entry `mode` is deliberately NOT compared here (unlike
 * `compareTarEntries` in `ga-tarball-diff.mjs`): this check's purpose is
 * "would a user's node_modules/<pkg> differ", and mode is not content.
 */

/**
 * @typedef {{name: string, type: string, mode: number, linkname: string|null, size: number, data: Buffer|null}} TarEntry
 */

/**
 * Compare two tar-entry sets (as read by `readTarEntries`) for byte-identical
 * content, ignoring metadata that carries no runtime meaning (mtime, mode,
 * entry order). An entry present on only one side, a type change (e.g.
 * file<->symlink), or a file whose bytes differ is reported in the result;
 * nothing here throws — the caller decides how to report/fail.
 *
 * @param {TarEntry[]} aEntries
 * @param {TarEntry[]} bEntries
 * @returns {{identical: boolean, onlyInA: string[], onlyInB: string[], differingFiles: string[]}}
 */
export function comparePackedTarballEntries(aEntries, bEntries) {
  const aByName = new Map(aEntries.map((e) => [e.name, e]));
  const bByName = new Map(bEntries.map((e) => [e.name, e]));

  const onlyInA = [...aByName.keys()].filter((name) => !bByName.has(name)).sort();
  const onlyInB = [...bByName.keys()].filter((name) => !aByName.has(name)).sort();

  const differingFiles = [];
  for (const [name, aEntry] of aByName) {
    const bEntry = bByName.get(name);
    if (!bEntry) continue; // already reported via onlyInA
    if (aEntry.type !== bEntry.type) {
      differingFiles.push(name);
      continue;
    }
    if (aEntry.type !== 'file') continue; // directories/symlinks: name+type already checked
    const aData = aEntry.data ?? Buffer.alloc(0);
    const bData = bEntry.data ?? Buffer.alloc(0);
    if (!aData.equals(bData)) differingFiles.push(name);
  }
  differingFiles.sort();

  return {
    identical: onlyInA.length === 0 && onlyInB.length === 0 && differingFiles.length === 0,
    onlyInA,
    onlyInB,
    differingFiles,
  };
}

/**
 * Render a `comparePackedTarballEntries` result as a human-readable report
 * (used for the job-summary listing). Returns `null` when identical.
 *
 * @param {string} label e.g. "@getknext/core"
 * @param {{identical: boolean, onlyInA: string[], onlyInB: string[], differingFiles: string[]}} result
 * @param {{aLabel: string, bLabel: string}} sides e.g. {aLabel: 'bun pm pack', bLabel: 'npm registry'}
 * @returns {string | null}
 */
export function formatPackParityReport(label, result, sides) {
  if (result.identical) return null;
  const lines = [`${label}: NOT identical (${sides.aLabel} vs ${sides.bLabel})`];
  for (const name of result.onlyInA) {
    lines.push(`  - only in ${sides.aLabel}: ${name}`);
  }
  for (const name of result.onlyInB) {
    lines.push(`  - only in ${sides.bLabel}: ${name}`);
  }
  for (const name of result.differingFiles) {
    lines.push(`  - content differs: ${name}`);
  }
  return lines.join('\n');
}

// --- tolerant comparison: #1562-aware (#1734 review refinement) ------------
//
// `comparePackedTarballEntries`/`formatPackParityReport` above answer "are
// these two tarballs byte-identical" and are UNCHANGED by everything below -
// every existing call site, test, and mutation proof for them still holds.
//
// The functions below answer a narrower, more useful question for THIS
// check's actual purpose ("do the credential lanes test the bytes we ship?"):
// a tarball read with `{ allowDuplicates: true }` may legitimately contain
// MORE THAN ONE occurrence of a path (the measured #1562 `bun pm pack`
// multi-`bin`-key duplicate). What a real install ends up with is whatever
// `tar -x` (and the credential harness's own `npm install` of that tarball)
// actually extracts to disk: later entries overwrite earlier ones at the
// same path, so the LAST occurrence wins. Rejecting the tarball outright
// because it contains a duplicate measures a stricter property than "does
// the credential lane test what we ship" - this answers that question
// instead, while still surfacing the duplicate as a named, visible fact
// rather than silently extracting the last copy and saying nothing.

/**
 * @param {TarEntry[]} allEntries every occurrence of every path, in file
 *   order (as read by `readTarEntries(path, { allowDuplicates: true })`)
 * @returns {Map<string, TarEntry[]>} path -> every occurrence, in file order
 */
export function groupTarEntriesByName(allEntries) {
  const groups = new Map();
  for (const entry of allEntries) {
    const list = groups.get(entry.name);
    if (list) list.push(entry);
    else groups.set(entry.name, [entry]);
  }
  return groups;
}

/**
 * Do two occurrences of the SAME path carry the same content (ignoring
 * mode/mtime, same scope as `comparePackedTarballEntries`)?
 *
 * @param {TarEntry} a
 * @param {TarEntry} b
 * @returns {boolean}
 */
function tarEntriesAgree(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === 'file') {
    const aData = a.data ?? Buffer.alloc(0);
    const bData = b.data ?? Buffer.alloc(0);
    return aData.equals(bData);
  }
  if (a.type === 'symlink' || a.type === 'hardlink') return a.linkname === b.linkname;
  return true; // directories etc.: name + type already identify them
}

/**
 * Compare a possibly-duplicate-containing entry set (side A, e.g. a
 * `bun pm pack` tarball read with `allowDuplicates: true`) against a normal,
 * duplicate-free entry set (side B, e.g. the npm registry's tarball).
 *
 * A path that occurs more than once in A is never silently collapsed:
 *   - if every occurrence agrees with the others, it is reported as a
 *     STRUCTURAL note (named for #1562) and does NOT, by itself, fail the
 *     comparison;
 *   - if the occurrences DISAGREE with each other, that path's name is
 *     reported in `conflictingDuplicates` and the comparison FAILS - an
 *     internally-inconsistent archive is a real finding regardless of which
 *     copy a given extractor happens to keep.
 *
 * The LAST occurrence of a duplicated path is what extraction (`tar -x`, and
 * therefore the credential harness's own `npm install` of this tarball)
 * actually ends up with, so that is what is compared against side B for
 * content/file-list purposes — a duplicate whose LAST copy diverges from the
 * registry is caught exactly like any other content difference, by that same
 * comparison, with no special-casing needed.
 *
 * @param {TarEntry[]} allEntriesA
 * @param {TarEntry[]} entriesB
 * @returns {{
 *   identical: boolean,
 *   onlyInA: string[],
 *   onlyInB: string[],
 *   differingFiles: string[],
 *   structuralDuplicates: Array<{name: string, count: number}>,
 *   conflictingDuplicates: string[],
 * }}
 */
export function compareTarballEntriesTolerant(allEntriesA, entriesB) {
  const groupsA = groupTarEntriesByName(allEntriesA);

  const structuralDuplicates = [];
  const conflictingDuplicates = [];
  const dedupedA = [];
  for (const [name, copies] of groupsA) {
    dedupedA.push(copies[copies.length - 1]); // last occurrence wins, as extraction would
    if (copies.length <= 1) continue;
    const allAgree = copies.every((c) => tarEntriesAgree(c, copies[0]));
    if (allAgree) structuralDuplicates.push({ name, count: copies.length });
    else conflictingDuplicates.push(name);
  }
  structuralDuplicates.sort((x, y) => x.name.localeCompare(y.name));
  conflictingDuplicates.sort();

  const contentResult = comparePackedTarballEntries(dedupedA, entriesB);

  return {
    identical: contentResult.identical && conflictingDuplicates.length === 0,
    onlyInA: contentResult.onlyInA,
    onlyInB: contentResult.onlyInB,
    differingFiles: contentResult.differingFiles,
    structuralDuplicates,
    conflictingDuplicates,
  };
}

/**
 * Render a `compareTarballEntriesTolerant` result. Unlike
 * `formatPackParityReport`, this returns a (non-failing) report even when
 * `identical` is `true`, as long as there is a structural note to surface -
 * the #1562 duplicate is a fact worth putting in the job summary on every
 * run, not only on a run that happens to fail for an unrelated reason.
 *
 * @param {string} label
 * @param {ReturnType<typeof compareTarballEntriesTolerant>} result
 * @param {{aLabel: string, bLabel: string}} sides
 * @returns {string | null} `null` only when there is NOTHING to report:
 *   identical AND no structural duplicates.
 */
export function formatTolerantPackParityReport(label, result, sides) {
  if (result.identical && result.structuralDuplicates.length === 0) return null;

  const lines = [
    result.identical
      ? `${label}: identical (${sides.aLabel} vs ${sides.bLabel}) - with a structural note`
      : `${label}: NOT identical (${sides.aLabel} vs ${sides.bLabel})`,
  ];
  for (const name of result.onlyInA) {
    lines.push(`  - only in ${sides.aLabel}: ${name}`);
  }
  for (const name of result.onlyInB) {
    lines.push(`  - only in ${sides.bLabel}: ${name}`);
  }
  for (const name of result.differingFiles) {
    lines.push(`  - content differs: ${name}`);
  }
  for (const name of result.conflictingDuplicates) {
    lines.push(`  - FAIL: duplicate tar entry "${name}" has copies that disagree with each other`);
  }
  for (const { name, count } of result.structuralDuplicates) {
    lines.push(
      `  - STRUCTURAL NOTE (#1562, non-failing): "${name}" appears ${count} times in ` +
        `${sides.aLabel}'s tarball, all copies byte-identical to each other and to the ` +
        'extracted (last-wins) content — the known bun-pm-pack multi-bin-key duplicate-entry ' +
        'quirk, not a content divergence from the registry.',
    );
  }
  return lines.join('\n');
}
