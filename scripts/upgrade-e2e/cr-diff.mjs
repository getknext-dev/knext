#!/usr/bin/env node
/**
 * cr-diff — pure comparison of a NextApp CR's `spec` before and after an
 * operator/CRD upgrade, for the operator upgrade-under-load e2e (#1668).
 *
 * "CRs reconcile unchanged" means the user's DECLARED intent (spec) is
 * untouched by an upgrade — status, metadata.resourceVersion, managedFields
 * and similar server-stamped bookkeeping are expected to move and are not
 * compared. Kept pure (no fs) so it is unit-testable — see
 * tests/upgrade-e2e-cr-diff.test.ts.
 */

/**
 * @param {unknown} before - `spec` from `kubectl get nextapp -o json` before
 *   the upgrade.
 * @param {unknown} after - `spec` after the upgrade.
 * @returns {{ok: boolean, diffPaths: string[]}}
 */
export function specUnchanged(before, after) {
  const diffPaths = [];
  diffAt(before, after, '$', diffPaths);
  return { ok: diffPaths.length === 0, diffPaths };
}

function diffAt(a, b, path, out) {
  if (a === b) return;
  const aIsObj = a !== null && typeof a === 'object';
  const bIsObj = b !== null && typeof b === 'object';
  if (!aIsObj || !bIsObj) {
    out.push(path);
    return;
  }
  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr !== bIsArr) {
    out.push(path);
    return;
  }
  if (aIsArr) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      diffAt(a[i], b[i], `${path}[${i}]`, out);
    }
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    diffAt(a[key], b[key], `${path}.${key}`, out);
  }
}

/**
 * CLI entry: `node cr-diff.mjs <before-spec.json> <after-spec.json>`.
 */
async function main() {
  const { readFileSync } = await import('node:fs');
  const [, , beforePath, afterPath] = process.argv;
  if (!beforePath || !afterPath) {
    console.error('usage: cr-diff.mjs <before-spec.json> <after-spec.json>');
    process.exit(2);
  }
  const before = JSON.parse(readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(readFileSync(afterPath, 'utf8'));
  const result = specUnchanged(before, after);
  console.log(JSON.stringify(result));
  if (!result.ok) {
    console.error(`cr-diff FAILED: spec changed at ${result.diffPaths.join(', ')}`);
    process.exit(1);
  }
}

const isMain = (() => {
  try {
    return process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main();
}
