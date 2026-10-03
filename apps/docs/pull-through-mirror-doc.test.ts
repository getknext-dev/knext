/**
 * The "Advanced: in-cluster pull-through mirror" page documents an OPTIONAL,
 * cluster-level recipe for shortening a cold-start image pull when
 * `imagePrewarm` cannot cover every node. These assertions pin the load-bearing
 * content a reader needs: that `imagePrewarm` stays the primary recommendation,
 * the CRI-O and containerd setup steps, the reload-not-restart distinction, the
 * operational risks (durability, statefulness, credentials), and that knext
 * does not install or manage this mirror itself.
 *
 * General user-facing-language rules (no internal references) are enforced for
 * every page by content-hygiene.test.ts.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DOCS_DIR = resolve(import.meta.dirname, 'content/docs');
const PAGE = join(DOCS_DIR, 'pull-through-mirror.mdx');

/** The body of an `## <heading>` section, up to the next `## ` heading. */
function section(page: string, heading: RegExp): string {
  const lines = page.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## ') && heading.test(l));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

describe('docs — in-cluster pull-through mirror', () => {
  const page = readFileSync(PAGE, 'utf-8');

  it('has front matter with a title and description', () => {
    expect(page).toMatch(/^---\n(?:.*\n)*?title: .+\n(?:.*\n)*?description: .+\n---/);
  });

  it('is listed in the sidebar navigation', () => {
    const meta = JSON.parse(readFileSync(join(DOCS_DIR, 'meta.json'), 'utf-8')) as {
      pages: string[];
    };
    expect(meta.pages).toContain('pull-through-mirror');
  });

  it('is linked from the image-caching page', () => {
    const imageCaching = readFileSync(join(DOCS_DIR, 'image-caching.mdx'), 'utf-8');
    expect(imageCaching).toContain('/docs/pull-through-mirror');
  });

  it('presents imagePrewarm as the primary recommendation, the mirror as optional', () => {
    expect(page).toMatch(/imagePrewarm/);
    expect(page).toMatch(/primary\s+(?:answer|recommendation)/i);
    expect(page).toMatch(/optional/i);
  });

  it('states plainly that knext does not install or manage the mirror', () => {
    expect(page).toMatch(/knext does not (?:install|run|manage)/i);
    expect(page).toMatch(/cluster infrastructure/i);
  });

  it('gives the CRI-O registries.conf.d drop-in with a registry.mirror stanza', () => {
    const crio = section(page, /CRI-O setup/i);
    expect(crio).toMatch(/registries\.conf\.d/);
    expect(crio).toMatch(/\[\[registry\.mirror\]\]/);
  });

  it('says to reload CRI-O, not restart it, and that no pod restarts', () => {
    const crio = section(page, /CRI-O setup/i);
    expect(crio).toMatch(/systemctl reload crio/);
    expect(crio).not.toMatch(/systemctl restart crio/);
  });

  it('gives the containerd certs.d/hosts.toml equivalent', () => {
    const containerd = section(page, /containerd setup/i);
    expect(containerd).toMatch(/certs\.d/);
    expect(containerd).toMatch(/hosts\.toml/);
  });

  it('mentions Spegel as a containerd-only P2P alternative', () => {
    expect(page).toMatch(/Spegel/);
    expect(page).toMatch(/containerd-only/i);
  });

  it('states the node-replacement durability risk', () => {
    const risks = section(page, /Risks/i);
    expect(risks).toMatch(/node (?:replacement|pool)/i);
    expect(risks).toMatch(/bootstrap|cloud-init/i);
  });

  it('states the mirror is a stateful component to run and secure', () => {
    const risks = section(page, /Risks/i);
    expect(risks).toMatch(/stateful/i);
  });

  it('states the mirror holds its own registry credentials', () => {
    const risks = section(page, /Risks/i);
    expect(risks).toMatch(/credential/i);
  });

  it('gives the measured numbers with their conditions, not as bare figures', () => {
    expect(page).toMatch(/10\.95\s*s/);
    expect(page).toMatch(/5\.73\s*s/);
    expect(page).toMatch(/2\.25\s*s/);
    // Conditions: measurement basis must be named, not just the numbers.
    expect(page).toMatch(/median/i);
    expect(page).toMatch(/CRI-O/i);
  });

  it('states the mirror-miss cost relative to a direct pull', () => {
    expect(page).toMatch(/miss/i);
    expect(page).toMatch(/0\.8\s*second/i);
  });

  it('says the benefit narrows with a same-region registry', () => {
    expect(page).toMatch(/same[- ]region/i);
  });
});
