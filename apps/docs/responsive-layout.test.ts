/**
 * Responsive-layout guard for the public docs site (apps/docs). Runs in CI: the
 * root `bun test` suite (job `lint-and-test`, step "Run tests (bun — the suite)").
 *
 * Bug class: a grid track sized with a bare `1fr` is `minmax(auto, 1fr)`, so its
 * minimum is the min-content width of its contents. A `pre` code block (881px of
 * unwrapped YAML) inside such a track widens the page past the viewport. Below
 * 1000px that happened on the landing page (320-980px).
 *
 * Rules this guard enforces:
 *  1. Narrow viewports (inside any `max-width` media block): no bare `fr` grid
 *     track. The narrow tracks are `minmax(0, 1fr)`.
 *  2. The narrow-only overflow rules exist inside the `max-width: 999px` block:
 *     prose `code`/`strong`/headings may break, and the landing step list wraps.
 *  3. Desktop (base rules, outside any max-width block) keeps its bare `1fr`
 *     tracks. They are PINNED to an exact list, so a new desktop bare track fails
 *     here and must be reviewed. The pinned desktop tracks are deliberate: changing
 *     them changes the 1280px layout (see the PR).
 *
 * What this cannot catch: a layout that is wide for another reason (a fixed-px
 * width, a flex child missing `min-width: 0` outside these rules). The rendered
 * crawl (`scripts/viewport-overflow-crawl.mjs`, manual, not in CI) catches those.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HOME_CSS = resolve(import.meta.dirname, 'app/(home)/home.module.css');
const GLOBAL_CSS = resolve(import.meta.dirname, 'app/global.css');

const TRACK_DECL =
  /grid-(?:template(?:-columns|-rows)?|auto-columns|auto-rows)\s*:\s*([^;}]*)[;}]/g;

/** Every grid-track declaration whose value has a bare `fr` track (not minmax(0, ...)). */
export function bareFrTracks(css: string): string[] {
  const offenders: string[] = [];
  for (const m of css.matchAll(TRACK_DECL)) {
    const stripped = m[1].replace(/minmax\(\s*0\s*,[^)]*\)/g, '');
    if (/\b\d*fr\b/.test(stripped)) offenders.push(m[0].trim());
  }
  return offenders;
}

/** Every `@media (... max-width ...) { ... }` block: [start, end, body] (brace-matched). */
export function maxWidthBlocks(css: string): Array<{ start: number; end: number; body: string }> {
  const blocks: Array<{ start: number; end: number; body: string }> = [];
  for (const m of css.matchAll(/@media[^{]*max-width[^{]*\{/g)) {
    const start = m.index ?? 0;
    const bodyStart = start + m[0].length;
    let depth = 1;
    let i = bodyStart;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
    }
    blocks.push({ start, end: i, body: css.slice(bodyStart, i - 1) });
  }
  return blocks;
}

/** The CSS outside every max-width media block (the desktop base rules). */
export function desktopCss(css: string): string {
  let out = '';
  let cursor = 0;
  for (const b of maxWidthBlocks(css)) {
    out += css.slice(cursor, b.start);
    cursor = b.end;
  }
  return out + css.slice(cursor);
}

/** Bare tracks inside narrow-viewport media blocks: must be empty. */
export function narrowBareFrTracks(css: string): string[] {
  return maxWidthBlocks(css).flatMap((b) => bareFrTracks(b.body));
}

/** Named narrow-only rules missing from the css's max-width:999px block. */
export function narrowRuleGaps(globalCss: string, homeCss: string): string[] {
  const narrow = (css: string, width: string) =>
    maxWidthBlocks(css)
      .filter((b) => new RegExp(`max-width:\\s*${width}px`).test(css.slice(b.start, b.start + 60)))
      .map((b) => b.body)
      .join('\n');
  const g999 = narrow(globalCss, '999');
  const h999 = narrow(homeCss, '999');
  const h820 = narrow(homeCss, '820');
  const checks: Array<[string, string, RegExp]> = [
    [
      'prose code/strong/headings may break',
      g999,
      /\.prose code:not\(pre code\),\s*\.prose strong,\s*\.prose :is\(h1, h2, h3, h4\)\s*\{\s*overflow-wrap:\s*anywhere;/,
    ],
    [
      'landing grid 2-col tracks are minmax(0, 1fr)',
      h999,
      /\.grid \{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/,
    ],
    [
      'landing codewrap tracks are minmax(0, 1fr)',
      h999,
      /\.codewrap \{\s*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\);/,
    ],
    ['landing step list wraps', h999, /\.steps li \{\s*min-width:\s*0;\s*flex-wrap:\s*wrap;/],
    ['landing step code may break', h999, /\.steps code \{\s*overflow-wrap:\s*anywhere;/],
    [
      'landing single-column tracks at 820px',
      h820,
      /\.grid,\s*\.codewrap \{\s*grid-template-columns:\s*minmax\(0, 1fr\);/,
    ],
  ];
  return checks.filter(([, block, re]) => !re.test(block)).map(([name]) => name);
}

const DESKTOP_PINNED = [
  'grid-template-columns: repeat(2, 1fr);',
  'grid-template-columns: 1fr 1fr;',
];

describe('docs stylesheets: narrow viewports never use a bare fr grid track', () => {
  it('home.module.css has no bare fr track inside a max-width block', () => {
    expect(narrowBareFrTracks(readCss(HOME_CSS))).toEqual([]);
  });

  it('global.css has no bare fr track inside a max-width block', () => {
    expect(narrowBareFrTracks(readCss(GLOBAL_CSS))).toEqual([]);
  });

  it('the narrow-only overflow rules exist in their max-width blocks', () => {
    expect(narrowRuleGaps(readCss(GLOBAL_CSS), readCss(HOME_CSS))).toEqual([]);
  });

  it('desktop base tracks in home.module.css are exactly the pinned list (a new one must be reviewed)', () => {
    expect(bareFrTracks(desktopCss(readCss(HOME_CSS)))).toEqual(DESKTOP_PINNED);
  });

  it('global.css has no desktop-base grid track at all', () => {
    expect(bareFrTracks(desktopCss(readCss(GLOBAL_CSS)))).toEqual([]);
  });

  it('flags a bare fr inside a max-width block (negative case)', () => {
    const planted = '@media (max-width: 820px) { .codewrap { grid-template-columns: 1fr; } }';
    expect(narrowBareFrTracks(planted)).toEqual(['grid-template-columns: 1fr;']);
  });

  it('flags a bare fr in grid-auto-columns, grid-auto-rows and the shorthand (negative cases)', () => {
    expect(bareFrTracks('.a { grid-auto-columns: 1fr; }')).toEqual(['grid-auto-columns: 1fr;']);
    expect(bareFrTracks('.a { grid-auto-rows: 1fr; }')).toEqual(['grid-auto-rows: 1fr;']);
    expect(bareFrTracks('.a { grid-template: auto / 1fr 1fr; }')).toEqual([
      'grid-template: auto / 1fr 1fr;',
    ]);
  });

  it('accepts minmax(0, 1fr) in every grid-track property (positive case)', () => {
    const safe = [
      '.a { grid-template-columns: repeat(2, minmax(0, 1fr)); }',
      '.b { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }',
      '.c { grid-auto-columns: minmax(0, 1fr); }',
      '.d { grid-template: auto / minmax(0, 1fr); }',
    ].join('\n');
    expect(bareFrTracks(safe)).toEqual([]);
  });

  it('a planted removal of the prose rule is reported as a gap (negative case)', () => {
    const g = readCss(GLOBAL_CSS).replace(
      '.prose :is(h1, h2, h3, h4) {\n    overflow-wrap: anywhere;',
      '.prose :is(h1, h2, h3, h4) {\n    color: inherit;',
    );
    expect(narrowRuleGaps(g, readCss(HOME_CSS))).toEqual(['prose code/strong/headings may break']);
  });

  it('a planted removal of the step-list wrap is reported as a gap (negative case)', () => {
    const h = readCss(HOME_CSS).replace(
      '    min-width: 0;\n    flex-wrap: wrap;',
      '    min-width: 0;',
    );
    expect(narrowRuleGaps(readCss(GLOBAL_CSS), h)).toEqual(['landing step list wraps']);
  });
});

function readCss(path: string): string {
  return readFileSync(path, 'utf8');
}
