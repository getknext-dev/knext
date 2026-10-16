import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  ADR_PATH,
  adrStage,
  coveredCount,
  findClaims,
  scanTree,
} from '../scripts/lib/ffi-stage-claims.mjs';

/**
 * GUARD: no user-facing doc, changeset or release note may call in-process Rust
 * (`bun:ffi` zone code) "stable", "production-ready" or "GA" while ADR-0069's
 * stage is Beta.
 *
 * The stage is READ from the ADR (its title's parenthetical, cross-checked
 * against its Status block), so the guard relaxes by itself the day the ADR
 * graduates the feature, and an ADR it cannot read fails instead of relaxing.
 * Files are found by class (apps/docs/content, .changeset, CHANGELOG.md,
 * package READMEs), so a page added tomorrow is covered tomorrow.
 *
 * Proved both ways: a planted claim is caught while the ADR says Beta, and the
 * same tree is accepted once the ADR says Stable (see the temp-tree cases).
 */

const ROOT = resolve(import.meta.dir, '..');
const adr = () => readFileSync(join(ROOT, ADR_PATH), 'utf8');

/** What the guard reports for a tree: nothing once the ADR has graduated the feature. */
function violations(root: string): { file: string; claim: string }[] {
  const { enforce } = adrStage(readFileSync(join(root, ADR_PATH), 'utf8'));
  return enforce ? scanTree(root) : [];
}

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ffi-stage-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const ADR_BETA = `# ADR-0069: In-process Rust (Beta)

- **Status:** **Accepted.** The product stage stays **Beta**.
- **Depends on:** nothing.
`;
const ADR_STABLE = ADR_BETA.replace('(Beta)', '(Stable)').replace('**Beta**', '**Stable**');

describe('the real tree', () => {
  it('ADR-0069 is readable and still Beta (this guard enforces)', () => {
    const { stage, enforce } = adrStage(adr());
    expect(stage).toBe('beta');
    expect(enforce).toBe(true);
  });

  it('scans a real set of files, not nothing', () => {
    expect(coveredCount(ROOT)).toBeGreaterThan(40);
  });

  it('no user-facing doc, changeset or release note calls in-process Rust stable / production-ready / GA while the ADR says Beta', () => {
    expect(violations(ROOT)).toEqual([]);
  });
});

describe('the stage is read from the ADR, and an unreadable ADR fails', () => {
  it('a Stable title (with a matching Status block) relaxes the guard', () => {
    expect(adrStage(ADR_STABLE)).toEqual({ stage: 'stable', enforce: false });
  });

  it('a title with no parenthesised stage throws rather than relaxing', () => {
    expect(() => adrStage(ADR_BETA.replace(' (Beta)', ''))).toThrow(/cannot be read/);
  });

  it('a title and a Status block that disagree throw', () => {
    expect(() => adrStage(ADR_BETA.replace('**Beta**', '**Preview**'))).toThrow(/disagree/);
  });

  it('a missing Status line throws', () => {
    expect(() => adrStage('# ADR-0069: x (Beta)\n')).toThrow(/Status/);
  });
});

describe('what counts as a claim', () => {
  const claims = [
    'In-process Rust is stable.',
    'In-process Rust is production-ready.',
    'In-process Rust is Production Ready today.',
    'In-process Rust is GA.',
    'bun:ffi zone code is generally available.',
    '`knext ffi` is now stable.',
    '# In-process Rust (Stable)',
    '| Rust in-process | stable |',
    '- In-process Rust: production-grade.',
    'Rust in-process calls are\nstable and fast.',
    'In-process Rust ships in this release. It is production-ready.',
    '---\n"@getknext/core": minor\n---\n\nThe `@getknext/ffi` package is stable.',
  ];
  for (const text of claims) {
    it(`flags ${JSON.stringify(text)}`, () => {
      expect(findClaims(text).length).toBeGreaterThan(0);
    });
  }

  const fine = [
    'In-process Rust is Beta and is not stable.',
    'In-process Rust stays Beta until bun:ffi is stable.',
    'In-process Rust is not production-ready.',
    "In-process Rust isn't GA.",
    'It becomes stable once Bun drops the experimental label on bun:ffi.',
    'When in-process Rust is production-ready, this page changes.',
    'Whether bun:ffi is stable is Bun’s call.',
    'knext v1.0 is a stable, semver-tracked release.',
    'The stable ABI v1 symbol names start with knext_ffi_v1_.',
    'Beta: in-process Rust runs only on Bun.',
    'The official cache interfaces are production-ready.',
    'in-process rust\n\nA stable release of Next.js is required.',
  ];
  for (const text of fine) {
    it(`accepts ${JSON.stringify(text)}`, () => {
      expect(findClaims(text)).toEqual([]);
    });
  }
});

describe('proved both ways on a temp tree', () => {
  const planted = {
    'apps/docs/content/docs/rust-in-process.mdx': '# Rust\n\nIn-process Rust is stable.\n',
    'apps/docs/content/docs/other.mdx': 'A page about something else, which is stable.\n',
    '.changeset/clean.md':
      '---\n"@getknext/core": patch\n---\n\nIn-process Rust (Beta) got faster.\n',
  };

  it('while the ADR says Beta, a planted claim in docs is caught (and only that one)', () => {
    const root = tree({ ...planted, [ADR_PATH]: ADR_BETA });
    try {
      expect(violations(root)).toEqual([
        {
          file: 'apps/docs/content/docs/rust-in-process.mdx',
          claim: 'In-process Rust is stable.',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a planted claim in a changeset or a CHANGELOG is caught too', () => {
    const root = tree({
      '.changeset/bad.md':
        '---\n"@getknext/core": patch\n---\n\nIn-process Rust is production-ready.\n',
      'packages/ffi/CHANGELOG.md': '## 1.0.0\n\n- `knext ffi` is GA.\n',
      [ADR_PATH]: ADR_BETA,
    });
    try {
      expect(
        violations(root)
          .map((v) => v.file)
          .sort(),
      ).toEqual(['.changeset/bad.md', 'packages/ffi/CHANGELOG.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the very same tree is accepted once the ADR says Stable', () => {
    const root = tree({ ...planted, [ADR_PATH]: ADR_STABLE });
    try {
      expect(scanTree(root)).toHaveLength(1); // the claim is still there ...
      expect(violations(root)).toEqual([]); // ... and no longer a violation
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a file added in a new place under a covered class is scanned without being listed', () => {
    const root = tree({
      'apps/docs/content/docs/deep/new/page.md': 'bun:ffi is stable.\n',
      [ADR_PATH]: ADR_BETA,
    });
    try {
      expect(violations(root)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
