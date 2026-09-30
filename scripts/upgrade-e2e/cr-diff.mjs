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
 *
 * `ignoreKeys` (top-level `spec.*` keys only) exists for ONE narrow, real
 * case, found on the first live run of this e2e: a newer CRD can add a
 * field with a structural-schema `default` (e.g. `selfContained: false`,
 * #1522) that a NEXT reconcile/apply materializes onto an existing CR that
 * never set it. The user's declared intent did not change — the field was
 * always absent from what they wrote — so a bare deep-equal flags a false
 * positive on every upgrade that adds a defaulted field, which would make
 * this assertion fail on EVERY real upgrade rather than on a real spec
 * drift. This does NOT ignore removed fields, changed values on fields the
 * before-spec DID set, or anything below the top level — only "was absent,
 * is now present with a value" on an explicitly named key.
 */
export function specUnchanged(before, after, ignoreKeys = []) {
  const diffPaths = [];
  diffAt(before, after, '$', diffPaths, new Set(ignoreKeys));
  return { ok: diffPaths.length === 0, diffPaths };
}

function diffAt(a, b, path, out, ignoreKeys) {
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
      diffAt(a[i], b[i], `${path}[${i}]`, out, ignoreKeys);
    }
    return;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    // Only the narrow "absent -> defaulted value" case documented above,
    // and only at the top level ($.<key>) — an ignored key nested deeper
    // still gets compared normally.
    if (path === '$' && ignoreKeys.has(key) && !(key in a) && key in b) {
      continue;
    }
    diffAt(a[key], b[key], `${path}.${key}`, out, ignoreKeys);
  }
}

/**
 * CLI entry: `node cr-diff.mjs <before-spec.json> <after-spec.json> [ignoreKeysCsv]`.
 */
async function main() {
  const { readFileSync } = await import('node:fs');
  const [, , beforePath, afterPath, ignoreKeysCsv] = process.argv;
  if (!beforePath || !afterPath) {
    console.error('usage: cr-diff.mjs <before-spec.json> <after-spec.json> [ignoreKeysCsv]');
    process.exit(2);
  }
  const ignoreKeys = ignoreKeysCsv
    ? ignoreKeysCsv
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)
    : [];
  const before = JSON.parse(readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(readFileSync(afterPath, 'utf8'));
  const result = specUnchanged(before, after, ignoreKeys);
  console.log(JSON.stringify(result));
  if (ignoreKeys.length > 0) {
    console.error(
      `cr-diff: ignoring top-level keys (absent -> defaulted only): ${ignoreKeys.join(', ')}`,
    );
  }
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
