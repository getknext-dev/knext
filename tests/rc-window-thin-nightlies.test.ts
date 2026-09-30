import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'bun:test';
import YAML from 'yaml';

describe('#1675: thin early-warning nightlies during credential window', () => {
  // Heavy-runner workflows thinned to weekly (compat suite, e2e/cluster builds)
  const thinnedToWeekly = [
    'compat-matrix-tracker-nightly.yml',
    'file-manager-platform-e2e-nightly.yml',
    'mutation-prover-nightly.yml',
    'operator-e2e-nightly.yml',
    'retracted-figure-resolution-nightly.yml',
  ];

  // Security/supply-chain gates MUST stay daily
  const keptDaily = [
    'secret-scan-nightly.yml',
    'action-pin-resolution-nightly.yml',
    'image-pin-resolution-nightly.yml',
    'docs-closure-nightly.yml',
    'anonymous-install-nightly.yml',
    'scaffold-install-nightly.yml',
    'npm-publish-drift-nightly.yml',
  ];

  // Already weekly
  const alreadyWeekly = ['compat-shipped-pin-early-warning.yml'];

  it('thinned workflows are weekly with #1675 comment', () => {
    const rcRef = JSON.parse(readFileSync('.github/compat-credential-ref.json', 'utf-8'));
    if (!rcRef.rcTag) return; // Skip if not in rc window

    for (const filename of thinnedToWeekly) {
      const filepath = join('.github/workflows', filename);
      const content = readFileSync(filepath, 'utf-8');
      const workflow = YAML.parse(content);

      const cronEntries = workflow.on?.schedule;
      const cron = cronEntries?.[0]?.cron || '';
      const cronParts = cron.split(' ');

      // Must be weekly (day-of-week 0-6, not *)
      expect(cronParts[4]).toMatch(/^[0-6]$/);

      // Must have #1675 comment
      expect(content).toMatch(/#1675/);
    }
  });

  it('security workflows stay daily (never weekly)', () => {
    for (const filename of keptDaily) {
      const filepath = join('.github/workflows', filename);
      const content = readFileSync(filepath, 'utf-8');
      const workflow = YAML.parse(content);

      const cronEntries = workflow.on?.schedule;
      const cron = cronEntries?.[0]?.cron || '';
      const cronParts = cron.split(' ');

      // Must be daily (day-of-week *, not 0-6)
      expect(cronParts[4]).toBe('*');

      // Must NOT have weekly #1675 comment
      expect(content).not.toMatch(/#1675 — WEEKLY/);
    }
  });

  it('already-weekly workflows document #1675', () => {
    for (const filename of alreadyWeekly) {
      const filepath = join('.github/workflows', filename);
      const content = readFileSync(filepath, 'utf-8');
      const workflow = YAML.parse(content);

      const cronEntries = workflow.on?.schedule;
      const cron = cronEntries?.[0]?.cron || '';
      const cronParts = cron.split(' ');

      // Already weekly
      expect(cronParts[4]).toMatch(/^[0-6]$/);

      // Has #1675 reference
      expect(content).toMatch(/#1675/);
    }
  });
});

describe('#1676: V1_ROADMAP.md reflects current release plan', () => {
  it('has Phase 1, Phase 2, and GA timeline', () => {
    const roadmap = readFileSync('docs/V1_ROADMAP.md', 'utf-8');

    expect(roadmap).toMatch(/Phase 1/);
    expect(roadmap).toMatch(/Phase 2/);
    expect(roadmap).toMatch(/26 Oct|3 Nov/);
  });

  it('documents committed vs not-committed surfaces', () => {
    const roadmap = readFileSync('docs/V1_ROADMAP.md', 'utf-8');

    expect(roadmap).toMatch(/Committed/i);
    expect(roadmap).toMatch(/Explicitly not committed/i);
  });
});
