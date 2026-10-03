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

  it('scopes the CRI-O drop-in with a repository prefix, not a bare registry host', () => {
    // A bare-host [[registry]] entry mirrors every image on that host. The recipe must show
    // `prefix` scoped to a specific repository, matching the discipline the source measurement
    // used (one repository alias, so no unrelated image ref could match), and say why.
    const crio = section(page, /CRI-O setup/i);
    expect(crio).toMatch(/prefix\s*=\s*"[^"]+\/[^"]+"/);
    expect(crio).toMatch(/typo|overly broad|broad match/i);
  });

  it('says to reload CRI-O, not restart it, and that no pod restarts', () => {
    const crio = section(page, /CRI-O setup/i);
    expect(crio).toMatch(/systemctl reload crio/);
    expect(crio).not.toMatch(/systemctl restart crio/);
  });

  it('hedges the mirror-down fallback claim as observed, not drilled', () => {
    // The fallback-to-upstream behavior was seen during the measurement but never deliberately
    // tested with the mirror taken down, so the recipe must not present it as proven.
    const crio = section(page, /CRI-O setup/i);
    expect(crio).toMatch(/falls\s+back to the upstream/i);
    expect(crio).toMatch(/observed/i);
    expect(crio).toMatch(/did not drill|not drilled|never drilled/i);
  });

  it('gives the containerd certs.d/hosts.toml equivalent', () => {
    const containerd = section(page, /containerd setup/i);
    expect(containerd).toMatch(/certs\.d/);
    expect(containerd).toMatch(/hosts\.toml/);
  });

  it('says containerd needed a config edit and a restart on GKE, not a reload', () => {
    // On GKE (COS, containerd 2.2) the legacy docker.io mirrors block and config_path
    // cannot coexist, so hosts.toml mirrors are silently ignored without a config edit.
    // Unlike CRI-O, there is no reload-only path here — a restart is required.
    const containerd = section(page, /containerd setup/i);
    expect(containerd).toMatch(/GKE/);
    expect(containerd).toMatch(/config_path/);
    expect(containerd).toMatch(/restart/i);
  });

  it('warns a containerd restart can disrupt pods and belongs at node bootstrap', () => {
    const containerd = section(page, /containerd setup/i);
    expect(containerd).toMatch(/disrupt/i);
    expect(containerd).toMatch(/node bootstrap|bootstrap process|cloud-init/i);
  });

  it('mentions Spegel as a containerd-only P2P alternative, not validated by knext', () => {
    expect(page).toMatch(/Spegel/);
    expect(page).toMatch(/containerd-only/i);
    expect(page).toMatch(/not validated/i);
    expect(page).toMatch(/not recommending/i);
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

  it('gives the OKE (remote-registry) measured numbers with their conditions', () => {
    expect(page).toMatch(/10\.95\s*s/);
    expect(page).toMatch(/5\.73\s*s/);
    expect(page).toMatch(/2\.25\s*s/);
    // Conditions: measurement basis must be named, not just the numbers.
    expect(page).toMatch(/median/i);
    expect(page).toMatch(/CRI-O 1\.34\.8/);
  });

  it('gives the GKE (same-region-registry) measured numbers with their conditions', () => {
    expect(page).toMatch(/9\.83\s*s/);
    expect(page).toMatch(/8\.62\s*s/);
    expect(page).toMatch(/3\.78\s*s/);
    expect(page).toMatch(/e2-standard-4/);
    expect(page).toMatch(/Artifact Registry/);
  });

  it('states the mirror-miss cost relative to a direct pull, for both measurements', () => {
    expect(page).toMatch(/miss/i);
    expect(page).toMatch(/0\.8\s*second/i);
    expect(page).toMatch(/0\.2\s*second/i);
  });

  it('says the benefit narrows with a same-region registry, with a headline percentage per cluster', () => {
    expect(page).toMatch(/same[- ]region/i);
    expect(page).toMatch(/48\s*%/);
    expect(page).toMatch(/12\s*%/);
  });

  it('hedges the same-region effect as fragile under a sensitivity check', () => {
    // The A-vs-B GKE contrast holds at p = 0.016 on the full run but only p = 0.058 once two
    // excluded cycles are counted back in — the doc must not present it as a stable guarantee.
    expect(page).toMatch(/fragile/i);
    expect(page).toMatch(/0\.058/);
  });
});
