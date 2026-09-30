#!/usr/bin/env node
/**
 * #1669 — CI guard: fails if the checked-in public API type-surface reports
 * (api-surface/*.d.ts.report) are stale relative to source. A rename, a
 * removal, or a narrowed type in a public subpath's own exported surface
 * changes what `generatePackageReport` emits, so it changes this diff.
 *
 * Exit 0 = every report matches source. Exit 1 = at least one is stale;
 * prints which package and a unified-ish diff, and tells the caller how to
 * fix it.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { generatePackageReport, PACKAGES, REPO_ROOT, reportPath } from './lib.mjs';

let ok = true;

for (const pkg of PACKAGES) {
  const current = generatePackageReport(pkg);
  const baselinePath = reportPath(pkg);
  if (!existsSync(baselinePath)) {
    ok = false;
    console.error(
      `[api-surface] MISSING baseline report for ${pkg.name}: ${path.relative(REPO_ROOT, baselinePath)}`,
    );
    console.error('  Run `node scripts/api-surface/generate.mjs` and commit the result.');
    continue;
  }
  const baseline = readFileSync(baselinePath, 'utf8');
  if (baseline !== current) {
    ok = false;
    console.error(
      `[api-surface] STALE public API type-surface report for ${pkg.name} (${path.relative(REPO_ROOT, baselinePath)}).`,
    );
    console.error(printDiff(baseline, current));
    console.error(
      '  If this change is intentional: `node scripts/api-surface/generate.mjs` and commit the updated report.',
    );
    console.error(
      '  If not: an export was renamed/removed, or a type was narrowed — fix the source instead.',
    );
  }
}

if (!ok) {
  process.exit(1);
}
console.log('[api-surface] all public API type-surface reports match source.');

function printDiff(before, after) {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const max = Math.max(beforeLines.length, afterLines.length);
  const out = [];
  for (let i = 0; i < max; i++) {
    const b = beforeLines[i];
    const a = afterLines[i];
    if (b === a) continue;
    if (b !== undefined) out.push(`  - ${b}`);
    if (a !== undefined) out.push(`  + ${a}`);
  }
  return out.slice(0, 60).join('\n');
}
