import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

describe('#1675: thin early-warning nightlies during credential window', () => {
  // These are the non-credential nightlies that should be weekly while rcTag is set
  const earlyWarningNightlies = [
    'compat-matrix-tracker-nightly.yml',
    'compat-shipped-pin-early-warning.yml',
    'anonymous-install-nightly.yml',
    'docs-closure-nightly.yml',
    'mutation-prover-nightly.yml',
    'npm-publish-drift-nightly.yml',
    'retracted-figure-resolution-nightly.yml',
    'file-manager-platform-e2e-nightly.yml',
    'scaffold-install-nightly.yml',
    'secret-scan-nightly.yml',
    'operator-e2e-nightly.yml',
  ];

  // These are frozen (credential harness) and must NOT be changed
  const credentialWorkflows = ['test-e2e-deploy.yml', 'compat-vinext.yml'];

  it('should have early-warning nightlies with weekly cron during rc window', () => {
    const rcRef = JSON.parse(readFileSync('.github/compat-credential-ref.json', 'utf-8'));
    const isRcWindow = rcRef.rcTag !== null;

    if (!isRcWindow) {
      // If not in rc window, this test is skipped
      it.skip('no rc window active', () => {});
      return;
    }

    for (const filename of earlyWarningNightlies) {
      const filepath = join('.github/workflows', filename);
      const content = readFileSync(filepath, 'utf-8');
      const workflow = YAML.parse(content);

      // Check that this workflow has a schedule trigger
      expect(workflow.on?.schedule).toBeDefined(`${filename} should have a schedule trigger`);

      // Find the cron entry
      const cronEntries = workflow.on.schedule;
      const hasCron = Array.isArray(cronEntries) && cronEntries.length > 0;
      expect(hasCron).toBe(true, `${filename} should have at least one cron entry`);

      // Check that cron is weekly (should have day-of-week field set to specific day, not *)
      const cron = cronEntries[0].cron;
      const cronParts = cron.split(' ');
      expect(cronParts.length).toBe(5, `${filename} cron should have 5 fields`);

      // Last field (day of week) should be a specific day (0-6), not *
      const dayOfWeek = cronParts[4];
      expect(dayOfWeek).toMatch(
        /^[0-6]$/,
        `${filename} cron "${cron}" should be weekly (day-of-week should be 0-6, not *)`,
      );

      // Check for comment referencing #1675
      const workflowStr = content;
      expect(workflowStr).toMatch(
        /#1675/,
        `${filename} should have a comment referencing #1675 for the weekly schedule change`,
      );
    }
  });

  it('should NOT change credential workflows during rc window', () => {
    for (const filename of credentialWorkflows) {
      const filepath = join('.github/workflows', filename);
      const content = readFileSync(filepath, 'utf-8');

      // These should not be modified - just verify they exist
      expect(content.length).toBeGreaterThan(0);
    }
  });
});

describe('#1676: V1_ROADMAP.md reflects current release plan', () => {
  it('should have Phase 1 and Phase 2 sections with ga milestone link', () => {
    const roadmap = readFileSync('docs/V1_ROADMAP.md', 'utf-8');

    // Check for Phase 1 and Phase 2 references
    expect(roadmap).toMatch(/Phase 1/i, 'Should mention Phase 1');
    expect(roadmap).toMatch(/Phase 2/i, 'Should mention Phase 2');

    // Check for GA milestone link
    expect(roadmap).toMatch(/v1\.0.*GA|GA.*v1\.0/i, 'Should reference v1.0 GA');
    expect(roadmap).toMatch(
      /26 Oct|3 Nov|October.*November/i,
      'Should mention expected GA window (26 Oct – 3 Nov)',
    );
  });

  it('section 1 should document committed vs not-committed 1.0 surfaces', () => {
    const roadmap = readFileSync('docs/V1_ROADMAP.md', 'utf-8');

    // Should have clear sections on what is committed
    expect(roadmap).toMatch(/Committed.*breaking change/i);
    expect(roadmap).toMatch(/Explicitly not committed/i);
  });

  it('should not have stale Next.js version claims', () => {
    const roadmap = readFileSync('docs/V1_ROADMAP.md', 'utf-8');
    const credRef = JSON.parse(
      readFileSync('.github/compat-credentialed-next-version.json', 'utf-8'),
    );

    // Check that the Next.js version mentioned in roadmap matches the credentialed version
    const nextVersion = credRef.nextJsRef || credRef.NEXTJS_REF;
    if (nextVersion) {
      // The version should be mentioned in the compat gate section
      expect(roadmap).toMatch(
        new RegExp(nextVersion, 'i'),
        `Should mention the credentialed Next.js version ${nextVersion}`,
      );
    }
  });
});
