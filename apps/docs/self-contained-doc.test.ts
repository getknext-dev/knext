/**
 * The "Self-contained mode" section on the build-pipeline page is where a user
 * deciding whether to turn the flag on actually looks. It must quote the
 * measured compatibility and cold-start numbers honestly, describe the known
 * gaps as behaviours a reader can recognise (not as issue-tracker links), and
 * say plainly that the default build — not self-contained mode — is the one
 * covered by knext's compatibility credential.
 *
 * The general user-facing-language rules (no ADR/issue/PR references, no
 * internal codenames) are enforced for every page by content-hygiene.test.ts;
 * this file checks this page's load-bearing content specifically.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DOCS_DIR = resolve(import.meta.dirname, 'content/docs');
const PAGE = join(DOCS_DIR, 'build-pipeline.mdx');

/** The body of a `### <heading>` section, up to the next `### ` heading. */
function section(page: string, heading: RegExp): string {
  const lines = page.split('\n');
  const start = lines.findIndex((l) => l.startsWith('### ') && heading.test(l));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('### ') || l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

describe('docs — self-contained mode', () => {
  const page = readFileSync(PAGE, 'utf-8');
  const scSection = section(page, /self-contained/i);

  it('has a self-contained section on the build-pipeline page', () => {
    // If the heading text drifts, every assertion below would silently read an
    // empty string and pass. Fail here instead.
    expect(scSection.trim().length).toBeGreaterThan(500);
  });

  it('quotes the measured compatibility numbers exactly', () => {
    // Standalone-on-Bun, official Next.js compat suite, served from an empty
    // directory: 763/792 turbopack, 767/792 webpack, against 792/792 with
    // self-contained off.
    expect(scSection).toContain('763');
    expect(scSection).toContain('767');
    expect(scSection).toMatch(/792/);
    // vinext: 719/778 self-contained against 728/778 regular.
    expect(scSection).toContain('719');
    expect(scSection).toContain('728');
    expect(scSection).toMatch(/778/);
  });

  it('quotes the measured cold-start numbers exactly, and states it as no measured win', () => {
    expect(scSection).toMatch(/2\.07\s*s/);
    expect(scSection).toMatch(/2\.93\s*s/);
    expect(scSection).toMatch(/101\s*MB/);
    expect(scSection).toMatch(/115\s*MB/);
    expect(scSection).toMatch(
      /not(?:\s+\(yet\))?\s+a\s+(?:measured|proven)\s+(?:win|speed win)|within the run-to-run spread/i,
    );
  });

  it('says the default build is the one covered by the compatibility credential', () => {
    expect(scSection).toMatch(/default build[\s\S]{0,120}?(?:credential|covered)/i);
  });

  it('says self-contained mode is opt-in and experimental', () => {
    expect(scSection).toMatch(/opt-in/i);
    expect(scSection).toMatch(/experimental/i);
  });

  it('describes the external-alias gap as a build-time behaviour, not a tracker link', () => {
    expect(scSection).toMatch(/external/i);
    expect(scSection).toMatch(/build[\s\S]{0,80}?fails|fails[\s\S]{0,80}?build/i);
  });

  it('describes the runtime-fs-read gap and the error a reader will see', () => {
    expect(scSection).toMatch(/font|fs|disk/i);
    expect(scSection).toMatch(/server error|500|connection|drops?/i);
  });

  it('describes the native-addon gap', () => {
    expect(scSection).toMatch(/native addon/i);
  });

  it('describes the ISR/PPR resume-path gap', () => {
    expect(scSection).toMatch(/ISR|PPR|Partial Prerendering|revalidat/i);
  });

  it('carries no ADR or issue/PR references in this section', () => {
    expect(scSection).not.toMatch(/\bADR-?\s?\d/i);
    expect(scSection).not.toMatch(/(?:\bPR |\bissue |\(|\s)#\d+\b/i);
  });
});
