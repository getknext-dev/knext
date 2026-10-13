/**
 * Keeps the ISR & caching page's `'use cache'` section honest about the 1.x
 * line: the directive has no shared store behind it, so an entry is
 * per-process (not shared across pods, lost on scale-to-zero), and under the
 * scaffold's `cacheMaxMemorySize: 0` it is effectively a no-op. The page must
 * also describe what `knext doctor` actually checks -- the directive in the
 * app's source, not the cacheComponents flag.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PAGE = join(resolve(import.meta.dirname, 'content/docs'), 'isr-caching.mdx');
const page = readFileSync(PAGE, 'utf-8');

function useCacheSection(): string {
  const start = page.indexOf("## `'use cache'`");
  expect(start).toBeGreaterThan(-1);
  const next = page.indexOf('\n## ', start + 4);
  return next === -1 ? page.slice(start) : page.slice(start, next);
}

describe("docs — 'use cache' on 1.x", () => {
  const section = useCacheSection();

  it('says an entry is per-process, not shared across pods, and lost on scale-to-zero', () => {
    expect(section).toMatch(/per-process/);
    expect(section).toMatch(/not shared (?:between|across) pods/);
    expect(section).toMatch(/scale-to-zero/);
  });

  it("says the directive is a no-op under the scaffold's cacheMaxMemorySize: 0", () => {
    expect(section).toContain('cacheMaxMemorySize: 0');
    expect(section).toMatch(/no-op/);
  });

  it("says knext doctor warns when the app's source uses the directive", () => {
    expect(section).toMatch(/`knext doctor` warns when your (?:app's )?source uses `'use cache'`/);
    expect(section).not.toMatch(/warns when your `next\.config` enables/);
  });

  it('defers the shared store to a future major version without a date or internal references', () => {
    expect(section).toMatch(/future major version/);
    expect(section).not.toMatch(/#\d+|ADR|\bv?2\.0\b|20\d\d/);
  });
});
