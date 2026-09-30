import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `.github/ISSUE_TEMPLATE/` is what GitHub renders on "New issue" — a
 * stranger with no template sees a blank body and no guidance on where a
 * security report or a "how do I..." question actually belongs. These
 * assertions check the templates GitHub itself requires structurally
 * (YAML issue forms need `name`/`description`/`body`, and a redirect
 * config needs `contact_links`), not their prose.
 */

const DIR = resolve(import.meta.dirname, '..', '.github', 'ISSUE_TEMPLATE');

function read(file: string): string {
  const p = resolve(DIR, file);
  return existsSync(p) ? readFileSync(p, 'utf-8') : '';
}

describe('.github/ISSUE_TEMPLATE', () => {
  it('the directory exists', () => {
    expect(existsSync(DIR)).toBe(true);
  });

  describe('bug_report', () => {
    const body = read('bug_report.yml');
    it('exists as a YAML issue form', () => {
      expect(body.length).toBeGreaterThan(0);
    });
    it('declares name, description and labels', () => {
      expect(body).toMatch(/^name:/m);
      expect(body).toMatch(/^description:/m);
      expect(body).toMatch(/^labels:/m);
    });
    it('asks for the knext version and cluster environment', () => {
      expect(body).toMatch(/version/i);
      expect(body).toMatch(/kubernetes|cluster|knative/i);
    });
  });

  describe('feature_request', () => {
    const body = read('feature_request.yml');
    it('exists as a YAML issue form', () => {
      expect(body.length).toBeGreaterThan(0);
    });
    it('declares name and description', () => {
      expect(body).toMatch(/^name:/m);
      expect(body).toMatch(/^description:/m);
    });
  });

  describe('question redirects to discussions, never becomes its own form', () => {
    const config = read('config.yml');
    it('disables the blank issue and links out for questions', () => {
      expect(config).toMatch(/blank_issues_enabled:\s*false/);
      expect(config).toContain('contact_links');
      expect(config).toMatch(/question/i);
      expect(config).toMatch(/discussion/i);
    });
  });

  describe('security reports are steered off the public tracker', () => {
    const config = read('config.yml');
    it('points a security report at SECURITY.md, not a public issue form', () => {
      expect(config).toMatch(/security/i);
      expect(config).toMatch(/SECURITY\.md|security\/advisories/i);
    });
  });
});
