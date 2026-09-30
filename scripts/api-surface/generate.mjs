#!/usr/bin/env node
/**
 * #1669 — regenerate the committed public API type-surface reports
 * (api-surface/*.d.ts.report) from source. Run this after an intentional
 * public API change; commit the diff alongside the code change so it is
 * reviewed like any other part of the PR.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generatePackageReport, PACKAGES, REPO_ROOT, reportPath } from './lib.mjs';

mkdirSync(path.join(REPO_ROOT, 'api-surface'), { recursive: true });

for (const pkg of PACKAGES) {
  const report = generatePackageReport(pkg);
  writeFileSync(reportPath(pkg), report);
  console.log(`wrote ${path.relative(REPO_ROOT, reportPath(pkg))}`);
}
