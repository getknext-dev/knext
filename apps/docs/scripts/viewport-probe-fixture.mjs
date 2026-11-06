#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noConsole: a CLI that reports to stdout by design
/**
 * Fixture proof for viewport-probe.mjs: the probe must FAIL the planted offences
 * and PASS the clean and scroller-contained documents. Manual (needs Playwright +
 * Chromium, like viewport-overflow-crawl.mjs). Exits 1 if any row misses.
 *
 *   bun scripts/viewport-probe-fixture.mjs
 */

import { chromium } from 'playwright';
import { probeViewport } from './viewport-probe.mjs';

const WIDTH = 375;
const FIXTURES = [
  {
    name: 'clean paragraph',
    html: '<main style="width:300px"><p>short words wrap normally</p></main>',
    expectFail: false,
  },
  {
    name: 'PLANTED clipped text (overflow:clip box, unbreakable run)',
    html: `<div style="width:200px;overflow:clip"><p>${'x'.repeat(300)}</p></div>`,
    expectFail: true,
    expectKind: 'clipped',
  },
  {
    name: 'PLANTED wide element past viewport',
    html: '<div style="width:500px"><p>wide</p></div>',
    expectFail: true,
    expectKind: 'past-viewport',
  },
  {
    name: 'intentional ellipsis truncation (text-overflow: ellipsis, must pass)',
    html: `<p style="width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0">${'x'.repeat(300)}</p>`,
    expectFail: false,
  },
  {
    name: 'horizontal scroller contains the long run (must pass)',
    html: `<pre style="overflow-x:auto;width:200px;white-space:pre">${'x'.repeat(300)}</pre>`,
    expectFail: false,
  },
];

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const page = await browser.newPage({ viewport: { width: WIDTH, height: 600 } });
let misses = 0;
for (const fx of FIXTURES) {
  await page.setContent(`<!doctype html><html><body style="margin:0">${fx.html}</body></html>`);
  const res = await page.evaluate(probeViewport);
  const failed = res.overflow || res.offenderCount > 0;
  const kinds = [...new Set(res.offenders.map((o) => o.kind))];
  const kindOk = !fx.expectKind || kinds.includes(fx.expectKind);
  const ok = failed === fx.expectFail && kindOk;
  if (!ok) misses++;
  console.log(
    `${ok ? 'PASS' : 'MISS'}\t${failed ? 'RED ' : 'green'}\t${fx.name}\tkinds=[${kinds.join(',')}]`,
  );
}
await browser.close();
console.log(`FIXTURE_MISSES=${misses}/${FIXTURES.length}`);
process.exit(misses ? 1 : 0);
