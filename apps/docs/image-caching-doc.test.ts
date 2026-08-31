/**
 * The "Cold starts & image caching" page is the user-facing half of the image
 * pre-pull feature: without it, `scaling.imagePrewarm` ships as a CR field with
 * no guidance anywhere a user will look, and the per-node cost — the whole
 * reason it is opt-in — exists only in operator source comments.
 *
 * These assertions are deliberately about the page's LOAD-BEARING content, not
 * its prose: it must be reachable from the sidebar, it must name the flag a
 * reader has to set, it must state the disk + pod-slot cost honestly, and it
 * must say what the readiness condition is called so a reader can check it.
 * The general user-facing-language rules (no internal references) are enforced
 * for every page by content-hygiene.test.ts.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DOCS_DIR = resolve(import.meta.dirname, 'content/docs');
const PAGE = join(DOCS_DIR, 'image-caching.mdx');

/** The body of an `## <heading>` section, up to the next `## ` heading. */
function section(page: string, heading: RegExp): string {
  const lines = page.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## ') && heading.test(l));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

describe('docs — cold starts & image caching', () => {
  const page = readFileSync(PAGE, 'utf-8');
  const costSection = section(page, /costs?/i);

  it('has a section devoted to the cost of enabling it', () => {
    // If the heading is renamed away, every cost assertion below would silently
    // read an empty string and pass. Fail here instead.
    expect(costSection.trim().length).toBeGreaterThan(200);
  });

  it('is listed in the sidebar navigation', () => {
    const meta = JSON.parse(readFileSync(join(DOCS_DIR, 'meta.json'), 'utf-8')) as {
      pages: string[];
    };
    expect(meta.pages).toContain('image-caching');
  });

  it('has front matter with a title and description', () => {
    expect(page).toMatch(/^---\n(?:.*\n)*?title: .+\n(?:.*\n)*?description: .+\n---/);
  });

  it('names the exact config flag a reader must set', () => {
    expect(page).toContain('imagePrewarm');
    // Shown in the real config shape, not just mentioned in prose.
    expect(page).toMatch(/scaling:\s*\{[\s\S]*imagePrewarm:\s*true/);
  });

  it('states the per-node disk cost honestly, in the cost section', () => {
    // A copy of the image lands on EVERY schedulable node, including nodes the
    // app never serves from. Hiding that turns a trade-off into a surprise.
    //
    // Scoped to the cost section deliberately: asserting these phrases against
    // the whole page passes on incidental matches elsewhere ("on every node",
    // "never runs your server"), which makes the guard decorative — the cost
    // paragraph can then be deleted outright and nothing goes red.
    expect(costSection).toMatch(/every schedulable node/i);
    expect(costSection).toMatch(/never serves from/i);
    expect(costSection).toMatch(/disk/i);
  });

  it('states the pod-slot cost across multiple apps, in the cost section', () => {
    // One prewarm pod per app per node counts against each node's max-pods
    // limit, so heavy use can crowd out application scheduling.
    expect(costSection).toMatch(/max[- ]pods|pod (?:slot|limit)/i);
    expect(costSection).toMatch(/crowd out|capacity/i);
  });

  it('tells the reader how to check whether the cache is ready', () => {
    expect(page).toContain('ImageCacheReady');
  });

  it('says a prewarm failure does not make the app unhealthy', () => {
    expect(page).toMatch(/does not|never/i);
    expect(page).toMatch(/ImageCacheReady[\s\S]{0,600}?Ready/);
  });

  it('says how to turn it off', () => {
    expect(page).toMatch(/imagePrewarm[\s\S]{0,400}?(false|remove)/i);
  });
});
