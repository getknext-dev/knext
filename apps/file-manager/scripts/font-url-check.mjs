/**
 * #1284 — the vinext build must never leak the BUILD MACHINE's absolute
 * filesystem path into a served `next/font` URL.
 *
 * Before the fix (upstream vinext, `createGoogleFontsPlugin`), the `<link
 * rel="preload" as="font">` tags and the injected `<style data-vinext-fonts>`
 * block referenced a self-hosted Google Font by the path it was cached at on
 * disk during the build — e.g.
 * `/home/runner/work/knext/knext/apps/file-manager/.vinext/fonts/geist-.../geist-....woff2`.
 * That 404s at request time (the origin has no `/home/...` route) and leaks
 * the build machine's directory layout into public HTML.
 *
 * The fixed shape is a served, content-hashed, asset-prefix-relative URL:
 * `/_next/static/_vinext_fonts/geist-.../geist-....woff2`.
 *
 * This module is pure (no `fetch`/`http` import at call time — the caller
 * injects a `request` function), so it can be exercised both:
 *   - hermetically, against synthetic HTML fixtures (`font-url-check.test.ts`),
 *     including a fixture carrying the EXACT leaked-path shape #1284 reported;
 *   - for real, against a live server (`compat-smoke.mjs`).
 */

/** Matches a `<link rel="preload" ... as="font" ... href="...">` tag's href, order-agnostic. */
const LINK_TAG_RE = /<link\b[^>]*>/gi;
const HREF_ATTR_RE = /\bhref=["']([^"']+)["']/i;
const AS_FONT_RE = /\bas=["']font["']/i;

/**
 * Every `<link rel="preload" as="font" href="...">` URL referenced by a page's
 * HTML, in document order. Returns an EMPTY array on no match — the caller
 * decides whether zero is itself a failure (a page that uses `next/font` must
 * have at least one).
 */
export function extractFontPreloadUrls(html) {
  const urls = [];
  for (const tag of html.match(LINK_TAG_RE) ?? []) {
    if (!AS_FONT_RE.test(tag)) continue;
    const href = HREF_ATTR_RE.exec(tag)?.[1];
    if (href) urls.push(href);
  }
  return urls;
}

/**
 * Every `url(...)` reference inside `<style data-vinext-fonts>...</style>` —
 * where vinext injects the self-hosted `@font-face` CSS. Absent that block
 * (an app with no `next/font/google` usage), returns an empty array.
 */
export function extractFontFaceCssUrls(html) {
  const block = /<style[^>]*data-vinext-fonts[^>]*>([\s\S]*?)<\/style>/i.exec(html)?.[1];
  if (!block) return [];
  return [...block.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1].replace(/^["']|["']$/g, ''));
}

/**
 * A URL that looks like an absolute BUILD-MACHINE filesystem path rather than
 * a served, origin-relative URL — the #1284 shape. A served URL always starts
 * with a single `/` followed by a route segment (`_next`, `api`, …); a leaked
 * path repeats path segments that look like a home directory / checkout
 * (`/home/`, `/Users/`, `/root/`, or any segment containing `.vinext/fonts`
 * mid-path rather than as the served `_vinext_fonts` asset namespace).
 */
const LEAKED_FS_PATH_RE = /^\/(home|Users|root)\/|\.vinext\/fonts\//;

/** True when `url` is the shape #1284 leaked — an absolute build-machine path. */
export function isLeakedFsPath(url) {
  return LEAKED_FS_PATH_RE.test(url);
}

/**
 * Scan arbitrary served text (HTML, CSS, JS) for an absolute filesystem path
 * that could only have come from the machine that ran the build — never a
 * legitimate served URL. Returns every match found (empty = clean).
 *
 * Deliberately broader than `isLeakedFsPath`: this also catches a leak that
 * lands somewhere OTHER than a `<link>`/`<style>` tag (e.g. inlined into a
 * JSON payload or a JS string), which is exactly how #1284 was first missed —
 * the exemption in `platform-e2e-checks.mjs` only ever inspected asset URLs
 * reached by crawling `<link>`/`<style>`, never a raw text scan.
 */
export function findAbsoluteFsPathLeaks(text) {
  const re = /\/(?:home|Users|root)\/[^\s"'<>)]*\.vinext\/fonts\/[^\s"'<>)]*/g;
  return [...new Set(text.match(re) ?? [])];
}

/**
 * The full assertion: every font URL a page references must be served at a
 * real, origin-relative URL (never a leaked filesystem path) and must
 * actually 200 with a `font/*` content-type when requested.
 *
 * `request(url)` must resolve `{ status, headers }` (a subset of the
 * `compat-smoke.mjs` / `platform-e2e-http.mjs` request shape — both satisfy
 * this without adaptation).
 *
 * Throws a single `Error` describing every violation found, rather than
 * failing on the first — so a caller sees the whole picture in one run.
 */
export async function checkFontsServed(html, { request }) {
  const problems = [];

  const leaks = findAbsoluteFsPathLeaks(html);
  if (leaks.length > 0) {
    problems.push(
      `${leaks.length} absolute build-machine path(s) leaked into the served HTML: ${leaks.join(', ')}`,
    );
  }

  const preloadUrls = extractFontPreloadUrls(html);
  const cssUrls = extractFontFaceCssUrls(html);
  const allUrls = [...new Set([...preloadUrls, ...cssUrls])];

  if (allUrls.length === 0) {
    problems.push(
      'no font URL found (neither a <link as="font"> preload nor a ' +
        '<style data-vinext-fonts> @font-face url()) — the page is expected ' +
        'to use next/font/google; update this check if that changed',
    );
  }

  for (const url of allUrls) {
    if (isLeakedFsPath(url)) {
      problems.push(`font URL is a leaked build-machine path, not a served URL: ${url}`);
      continue; // fetching a leaked path would just re-report its 404 — redundant
    }
    if (!url.startsWith('/_next/static/')) {
      problems.push(
        `font URL is not under the served static-asset prefix (/_next/static/): ${url}`,
      );
    }
    const res = await request(url);
    if (res.status !== 200) {
      problems.push(`GET ${url} -> ${res.status}, expected 200`);
      continue;
    }
    const ct = res.headers['content-type'] || res.headers.get?.('content-type') || '';
    if (!ct.startsWith('font/')) {
      problems.push(`GET ${url} -> content-type "${ct}", expected font/*`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `checkFontsServed found ${problems.length} problem(s):\n- ${problems.join('\n- ')}`,
    );
  }

  return { preloadUrls, cssUrls, checked: allUrls.length };
}
