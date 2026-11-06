#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noConsole: a CLI that reports to stdout by design
/**
 * Rendered responsive-overflow crawl for the docs site.
 *
 * Loads EVERY docs page (derived from content/docs, plus the landing page) at
 * each viewport width and fails a check on any of the offences in
 * `viewport-probe.mjs`: the page scrolls sideways (`page-scroll`), an element is
 * past the viewport (`past-viewport`), or text is clipped by an overflow:hidden/clip
 * box (`clipped`). Horizontal scrollers (overflow-x auto, such as a `pre`) are
 * excluded because they scroll on purpose.
 *
 * NOT RUN IN CI. It needs a real browser (Playwright + Chromium) and a built
 * site; adding that to the docs job would cost minutes per run, so it is a manual
 * check. CI runs `responsive-layout.test.ts` (static) instead, and the probe's own
 * fixture (`viewport-probe-fixture.mjs`) is also manual.
 *
 * Setup (once, not committed to the lockfile):
 *   cd apps/docs && bun add --no-save playwright && bunx playwright install chromium
 * Run against a production build:
 *   cd apps/docs && bun run build && PORT=3100 bun .output/server/index.mjs &
 *   bun scripts/viewport-overflow-crawl.mjs http://localhost:3100
 * Options: --widths=a,b,c   --json=out.json
 *          CHROME=/path/to/chrome   (optional: use an existing Chromium binary)
 */

import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { chromium } from 'playwright';
import { probeViewport } from './viewport-probe.mjs';

const args = process.argv.slice(2);
const base = args.find((a) => !a.startsWith('--'));
if (!base) {
  console.error('usage: viewport-overflow-crawl.mjs <baseUrl> [--widths=a,b,c] [--json=path]');
  process.exit(2);
}
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const DEFAULT_WIDTHS = [320, 360, 375, 390, 414, 600, 768, 820, 900, 1000, 1024, 1100, 1200, 1280];
const widths = opt('widths', DEFAULT_WIDTHS.join(',')).split(',').map(Number);
const jsonOut = opt('json', '');

const CONTENT_DIR = resolve(import.meta.dirname, '../content/docs');

function mdxFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return mdxFiles(full);
    return full.endsWith('.mdx') ? [full] : [];
  });
}

// Route table from the content tree: index.mdx -> /docs, foo/index.mdx -> /docs/foo.
const routes = new Set(['/']);
for (const file of mdxFiles(CONTENT_DIR)) {
  let rel = relative(CONTENT_DIR, file).replace(/\.mdx$/, '');
  rel = rel === 'index' ? '' : rel.replace(/\/index$/, '');
  routes.add(rel ? `/docs/${rel}` : '/docs');
}

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const results = [];
for (const width of widths) {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  const page = await context.newPage();
  for (const route of routes) {
    const url = base.replace(/\/$/, '') + route;
    let res;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(400);
      res = { route, width, ...(await page.evaluate(probeViewport)) };
    } catch (err) {
      res = { route, width, error: String(err).slice(0, 200) };
    }
    results.push(res);
    const bad = res.error || res.overflow || res.offenderCount > 0;
    const tag = res.error ? 'ERR' : bad ? 'FAIL' : 'ok';
    console.log(
      `${tag}\t${width}\t${route}\t${res.sw ?? ''}/${res.iw ?? ''}\t${res.offenderCount ?? ''}`,
    );
  }
  await context.close();
}
await browser.close();

// A check fails on a navigation error, a page-scroll, or any offence in the probe.
const failing = results.filter((r) => r.error || r.overflow || r.offenderCount > 0);
console.log(
  `\nSUMMARY pages=${routes.size} widths=${widths.join(',')} checks=${results.length} failing=${failing.length}`,
);
for (const r of failing) {
  console.log(`  ${r.route} @${r.width}: ${r.error ?? JSON.stringify(r.offenders)}`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2));
process.exit(failing.length ? 1 : 0);
