/**
 * Guard for the `'use cache'` metrics docs: the section names the counter family
 * and every event label the handler renders, taken from the render itself and
 * never from a list typed here, plus where the series are served and the build
 * that has none.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  renderUseCacheMetrics,
  USE_CACHE_EVENTS,
} from '../../packages/kn-next/src/adapters/use-cache-handler.js';

const DOCS_DIR = resolve(import.meta.dirname, 'content/docs');
const HEADING = "### `'use cache'` metrics";

function section(page: string): string {
  const start = page.indexOf(HEADING);
  expect(start).toBeGreaterThan(-1);
  const end = page.indexOf('\n#', start + 1);
  return page.slice(start, end === -1 ? undefined : end);
}

describe("'use cache' metrics docs", () => {
  const page = readFileSync(join(DOCS_DIR, 'isr-caching.mdx'), 'utf-8');

  it('names the family the handler renders', () => {
    const families = [...renderUseCacheMetrics().matchAll(/^# TYPE (\S+) /gm)].map((m) => m[1]);
    expect(families.length).toBe(1);
    for (const f of families) expect(section(page)).toContain(`\`${f}\``);
  });

  it('documents every event label the handler renders, and no other', () => {
    const rendered = [...renderUseCacheMetrics().matchAll(/\{event="([a-z_]+)"\}/g)].map(
      (m) => m[1],
    );
    expect(rendered.length).toBe(Object.keys(USE_CACHE_EVENTS).length);
    const text = section(page);
    for (const label of rendered) expect(text).toContain(`| \`${label}\` |`);
    const documented = [...text.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
    expect(documented.sort()).toEqual([...rendered].sort());
  });

  it('says where the series are served, how an older app gets them, and the build with none', () => {
    const text = section(page);
    expect(text).toContain('`9464`');
    expect(text).toContain('/docs/observability#deep-health-existing-apps');
    expect(text).toMatch(/`vinext` build[^.]*serves no `'use cache'` series/);
    // Overlapping events are spelled out, so a hit ratio is not computed wrong.
    expect(text).toMatch(/`corrupt`[^.]*`expired`[^.]*also counted as `miss`/);
  });

  it('the observability page lists the family with the standalone series', () => {
    const obs = readFileSync(join(DOCS_DIR, 'observability.mdx'), 'utf-8');
    expect(obs).toContain('`knext_use_cache_events_total`');
    expect(obs).toContain('/docs/isr-caching#use-cache-metrics');
  });
});
