#!/usr/bin/env node
/**
 * Summarise a Trivy `fs`-mode JSON report as a Markdown job-summary block:
 * counts by severity, plus the top affected packages by vulnerability count.
 *
 * Used by supply-chain.yml's `js-closure-fs-trivy` job (#1722, report-only —
 * see that job's header). Tolerant of a missing/empty report file (the scan
 * can fail before Trivy ever writes one): prints an honest "no report" note
 * rather than throwing, so the `always()` summary step never itself fails
 * the job.
 *
 * Usage: node scripts/summarize-trivy-fs-report.mjs <report.json>
 */

import { existsSync, readFileSync } from 'node:fs';

const reportPath = process.argv[2];

function printNoReport(reason) {
  console.log('## JS closure Trivy scan (fs mode, report-only)\n');
  console.log(`No report to summarise: ${reason}\n`);
}

if (!reportPath) {
  printNoReport('no report path given');
  process.exit(0);
}

if (!existsSync(reportPath)) {
  printNoReport(`\`${reportPath}\` does not exist`);
  process.exit(0);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (err) {
  printNoReport(`\`${reportPath}\` is not valid JSON (${err.message})`);
  process.exit(0);
}

const severityCounts = { CRITICAL: 0, HIGH: 0 };
/** @type {Map<string, number>} */
const packageCounts = new Map();

for (const result of report.Results ?? []) {
  for (const vuln of result.Vulnerabilities ?? []) {
    if (!(vuln.Severity in severityCounts)) continue;
    severityCounts[vuln.Severity] += 1;
    const pkg = vuln.PkgName ?? 'unknown';
    packageCounts.set(pkg, (packageCounts.get(pkg) ?? 0) + 1);
  }
}

const total = severityCounts.CRITICAL + severityCounts.HIGH;
const topPackages = [...packageCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

console.log('## JS closure Trivy scan (fs mode, report-only)\n');
console.log(
  `Findings (HIGH/CRITICAL, unfixed ignored): **${total}** — ` +
    `${severityCounts.CRITICAL} CRITICAL, ${severityCounts.HIGH} HIGH.\n`,
);

if (topPackages.length > 0) {
  console.log('| Package | Findings |');
  console.log('| --- | --- |');
  for (const [pkg, count] of topPackages) {
    console.log(`| \`${pkg}\` | ${count} |`);
  }
  console.log('');
}

console.log(
  "This job is REPORT-ONLY (#1722 — see `supply-chain.yml`'s `js-closure-fs-trivy` " +
    'job header). It does not fail the build.',
);
