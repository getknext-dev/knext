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
