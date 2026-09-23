/**
 * #1284 — the ROOT `.dockerignore` must exclude `.vinext`/`.output` at ANY
 * depth, not just at the context root.
 *
 * Root cause, proved end to end (real `docker build` of the unmodified
 * `apps/file-manager/Dockerfile`, no source changes):
 *
 *   1. `kn-next deploy` / `kn-next build` run the app's own `vite build` on
 *      the HOST before the Docker build. vinext's `createGoogleFontsPlugin`
 *      (`fetchAndCacheFont`) caches a self-hosted Google Font's CSS at
 *      `.vinext/fonts/<hash>/style.css`, with `src: url(<ABSOLUTE
 *      cacheDir>/…)` baked in at fetch time. Its rewrite to a served URL
 *      (`_rewriteCachedFontCssToServedUrls`) only fires when that baked-in
 *      path matches the CURRENT build's `cacheDir` — a plain substring check.
 *   2. `requireBuildContext` (packages/kn-next/src/cli/tracing-root.ts)
 *      resolves file-manager's Docker build context to the WORKSPACE ROOT —
 *      this repo's root, not `apps/file-manager/` — so it is THIS root
 *      `.dockerignore` that gates what `COPY . .` in
 *      `apps/file-manager/Dockerfile` stages into `/repo`, not any
 *      `apps/file-manager/.dockerignore`.
 *   3. Docker's `.dockerignore` matching is NOT recursive by default, unlike
 *      `.gitignore`: a bare pattern (`.vinext`) matches only a file/dir
 *      NAMED THAT at the CONTEXT ROOT. `apps/file-manager/.vinext` is one
 *      level below this file, so a bare `.vinext` line here compiles, looks
 *      right, and silently excludes nothing. Proved with a minimal
 *      reproduction: a nested `subdir/.vinext/` survived a bare `.vinext`
 *      .dockerignore line and was excluded only once the pattern became
 *      `**\/.vinext`.
 *   4. Without the recursive exclusion, the HOST's `.vinext` cache — keyed to
 *      the HOST's absolute path — rides `COPY . .` into the builder stage,
 *      the in-image `RUN vite build` hits a cache HIT on it, the substring
 *      check in step 1 fails (the image's `cacheDir` is
 *      `/repo/apps/file-manager/.vinext/fonts`, not the host's path), and the
 *      HOST's absolute path is embedded verbatim into the served page —
 *      exactly the shape #1284 reported. Confirmed by exec'ing into the
 *      builder stage of a real build and finding `/repo/apps/file-manager/
 *      .vinext/fonts/<hash>/style.css` present with the HOST's absolute path
 *      baked into its `url(...)`, even with a BARE (non-recursive) `.vinext`
 *      line already in place — the bare line compiled but excluded nothing.
 *   5. With `**\/.vinext` (this file, as committed), a real `docker build` of
 *      the unmodified Dockerfile served every `next/font/google` reference at
 *      `/_next/static/_vinext_fonts/...`, 200 `font/woff2`, no leaked path.
 *
 * `.output` is excluded for the same staleness reason (host build OUTPUT the
 * in-image `vite build` fully regenerates) and needs the same `**\/` prefix.
 *
 * NOTE (not this issue's scope, flagged so it is not lost): the SAME
 * non-recursive-match gap likely affects several of the bare patterns already
 * in this file (`node_modules`, `.next`, `.turbo`, `dist`, `coverage`,
 * `docs`) — all of those also exist nested under `apps/*`/`packages/*`, not
 * only at the repo root. It has not obviously broken those (`bun install`
 * reinstalls `node_modules` regardless of what rode in with it), but it is
 * the same latent hazard class and worth a dedicated look.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const DOCKERIGNORE = readFileSync(join(REPO_ROOT, '.dockerignore'), 'utf8');
/** Exact-line match — a substring hit (e.g. inside a comment) must not count. */
const lines = new Set(DOCKERIGNORE.split('\n').map((l) => l.trim()));

describe('#1284 root .dockerignore — .vinext/.output excluded RECURSIVELY', () => {
  it('excludes **/.vinext (a bare `.vinext` line does NOT match the nested apps/file-manager/.vinext)', () => {
    expect(
      lines.has('**/.vinext'),
      'the root .dockerignore must contain the line "**/.vinext" exactly — a bare ' +
        '".vinext" line only matches a dir named that AT THE CONTEXT ROOT (this file’s ' +
        'own directory), not apps/file-manager/.vinext one level below, so it silently ' +
        'excludes nothing and the build-machine font path leaks into the served page (#1284)',
    ).toBe(true);
    // The stale, non-recursive shape must not still be present as an
    // (ineffective) alternative — a reader who sees BOTH lines could
    // reasonably assume the bare one is intentional and remove the working one.
    expect(
      lines.has('.vinext'),
      'a bare ".vinext" line does nothing here (see the doc comment) and must not linger ' +
        'as if it were the fix',
    ).toBe(false);
  });

  it('excludes **/.output (same non-recursive-match hazard, same staleness reason)', () => {
    expect(lines.has('**/.output')).toBe(true);
    expect(lines.has('.output')).toBe(false);
  });
});
