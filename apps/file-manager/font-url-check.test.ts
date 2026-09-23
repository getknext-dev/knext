// @vitest-environment node
//
// #1284 — hermetic (no network, no build) proof that `font-url-check.mjs`
// can tell a leaked build-machine font path apart from a properly served
// one, using the EXACT leaked-path shape the issue reported and the EXACT
// served shape a fixed vinext build emits (captured from a real local
// build of this app, see the module docstring).

import { describe, expect, it, mock } from 'bun:test';
import {
  checkFontsServed,
  extractFontFaceCssUrls,
  extractFontPreloadUrls,
  findAbsoluteFsPathLeaks,
  isLeakedFsPath,
} from './scripts/font-url-check.mjs';

const LEAKED_URL =
  '/home/runner/work/knext/knext/apps/file-manager/.vinext/fonts/geist-8ac0455e797f/geist-98bbbccb.woff2';
const SERVED_URL = '/_next/static/_vinext_fonts/geist-8ac0455e797f/geist-98bbbccb.woff2';

const HTML_LEAKED = `<!doctype html><html><head>
<link rel="preload" href="${LEAKED_URL}" as="font" type="font/woff2" crossorigin />
</head><body>
<style data-vinext-fonts>@font-face { font-family: 'Geist'; src: url(${LEAKED_URL}) format('woff2'); }</style>
</body></html>`;

const HTML_SERVED = `<!doctype html><html><head>
<link rel="preload" href="${SERVED_URL}" as="font" type="font/woff2" crossorigin />
</head><body>
<style data-vinext-fonts>@font-face { font-family: 'Geist'; src: url(${SERVED_URL}) format('woff2'); }</style>
</body></html>`;

const HTML_NO_FONTS = `<!doctype html><html><head></head><body>hello</body></html>`;

describe('#1284 extractFontPreloadUrls', () => {
  it('extracts every <link as="font"> href, in order', () => {
    const html = `<link rel="preload" href="/a.woff2" as="font"><link rel="preload" href="/b.woff2" as="font">`;
    expect(extractFontPreloadUrls(html)).toEqual(['/a.woff2', '/b.woff2']);
  });

  it('ignores <link> tags that are not font preloads', () => {
    const html = `<link rel="stylesheet" href="/a.css"><link rel="preload" href="/b.woff2" as="font">`;
    expect(extractFontPreloadUrls(html)).toEqual(['/b.woff2']);
  });

  it('returns an empty array when there are no font preloads', () => {
    expect(extractFontPreloadUrls(HTML_NO_FONTS)).toEqual([]);
  });

  it('extracts the exact leaked-path shape #1284 reported', () => {
    expect(extractFontPreloadUrls(HTML_LEAKED)).toEqual([LEAKED_URL]);
  });
});

describe('#1284 extractFontFaceCssUrls', () => {
  it('extracts url(...) references from the injected <style data-vinext-fonts> block', () => {
    expect(extractFontFaceCssUrls(HTML_SERVED)).toEqual([SERVED_URL]);
  });

  it('returns an empty array when the page has no vinext font style block', () => {
    expect(extractFontFaceCssUrls(HTML_NO_FONTS)).toEqual([]);
  });
});

describe('#1284 isLeakedFsPath', () => {
  it('flags an absolute build-machine path under .vinext/fonts/', () => {
    expect(isLeakedFsPath(LEAKED_URL)).toBe(true);
    expect(isLeakedFsPath('/Users/dev/app/.vinext/fonts/geist-x/geist-y.woff2')).toBe(true);
  });

  it('does not flag a real served asset URL', () => {
    expect(isLeakedFsPath(SERVED_URL)).toBe(false);
  });
});

describe('#1284 findAbsoluteFsPathLeaks', () => {
  it('finds a leaked path anywhere in a text blob, not only inside a <link>/<style> tag', () => {
    const text = `some JS: var f = "${LEAKED_URL}";`;
    expect(findAbsoluteFsPathLeaks(text)).toEqual([LEAKED_URL]);
  });

  it('finds nothing in text with no leaked path', () => {
    expect(findAbsoluteFsPathLeaks(HTML_SERVED)).toEqual([]);
  });
});

describe('#1284 checkFontsServed — RED on the leaked shape, GREEN on the served shape', () => {
  it('FAILS on the exact leaked-path shape #1284 reported (proves this check can go red)', async () => {
    const request = mock(async () => ({ status: 404, headers: {} }));
    await expect(checkFontsServed(HTML_LEAKED, { request })).rejects.toThrow(
      /leaked build-machine path/,
    );
  });

  it('PASSES when every font URL is served (/_next/static/…) and returns 200 font/woff2', async () => {
    const request = mock(async (url: string) => {
      expect(url).toBe(SERVED_URL);
      return { status: 200, headers: { 'content-type': 'font/woff2' } };
    });
    const result = await checkFontsServed(HTML_SERVED, { request });
    expect(result.checked).toBe(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('FAILS if the served URL 404s even though it is not a leaked path (a different regression)', async () => {
    const request = mock(async () => ({ status: 404, headers: {} }));
    await expect(checkFontsServed(HTML_SERVED, { request })).rejects.toThrow(
      /-> 404, expected 200/,
    );
  });

  it('FAILS if the served URL 200s with the wrong content-type', async () => {
    const request = mock(async () => ({
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    }));
    await expect(checkFontsServed(HTML_SERVED, { request })).rejects.toThrow(/expected font\/\*/);
  });

  it('FAILS when the page has no font reference at all (the app is expected to use next/font)', async () => {
    const request = mock(async () => ({ status: 200, headers: {} }));
    await expect(checkFontsServed(HTML_NO_FONTS, { request })).rejects.toThrow(/no font URL found/);
  });

  it('FAILS on a raw text leak even when the <link>/<style> shapes look clean (defense in depth)', async () => {
    const html = `${HTML_SERVED}<script>var f="${LEAKED_URL}";</script>`;
    const request = mock(async () => ({ status: 200, headers: { 'content-type': 'font/woff2' } }));
    await expect(checkFontsServed(html, { request })).rejects.toThrow(
      /leaked into the served HTML/,
    );
  });
});
