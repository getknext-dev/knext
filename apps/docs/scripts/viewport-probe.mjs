/**
 * In-page probe for viewport-overflow-crawl.mjs and viewport-probe-fixture.mjs.
 *
 * Passed to `page.evaluate()`, so it must be self-contained: it closes over
 * nothing from this module. It reports three kinds of offence:
 *
 *  - `page-scroll`: `documentElement.scrollWidth > innerWidth`, the page scrolls
 *    sideways.
 *  - `past-viewport`: an element's right edge is past the viewport and no
 *    horizontal scroller contains it (outermost such element only).
 *  - `clipped`: a box with overflow hidden/clip whose content is wider than the
 *    box (`scrollWidth > clientWidth`). Its overflowing text is cut off with no
 *    scrollbar, and `scrollWidth` of the document does not see it.
 *
 * Horizontal scrollers (overflow-x auto/scroll that really overflow, such as a
 * `pre`) are excluded from `past-viewport` and `clipped`, because they scroll on
 * purpose.
 */

export function probeViewport() {
  const iw = window.innerWidth;
  const sw = document.documentElement.scrollWidth;

  const label = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls =
      typeof el.className === 'string' && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : '';
    return `${el.tagName.toLowerCase()}${id}${cls}`;
  };

  const insideScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth) return true;
    }
    return false;
  };

  const offenders = [];
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (insideScroller(el)) continue;

    if (r.right > iw + 0.5) {
      const parent = el.parentElement;
      const parentPast =
        parent && parent !== document.body && parent.getBoundingClientRect().right > iw + 0.5;
      if (!parentPast) {
        offenders.push({
          kind: 'past-viewport',
          el: label(el),
          right: Math.round(r.right),
          width: Math.round(r.width),
        });
      }
    }

    const cs = getComputedStyle(el);
    // `truncate` (overflow hidden + text-overflow: ellipsis) cuts text on purpose and
    // shows an ellipsis, so it is design, not silent clipping. Only unmarked clipping counts.
    const clips =
      (cs.overflowX === 'hidden' || cs.overflowX === 'clip') && cs.textOverflow !== 'ellipsis';
    if (
      clips &&
      cs.display !== 'inline' &&
      el.clientWidth > 0 &&
      el.scrollWidth > el.clientWidth + 1
    ) {
      offenders.push({
        kind: 'clipped',
        el: label(el),
        over: el.scrollWidth - el.clientWidth,
        width: Math.round(r.width),
      });
    }
  }

  return {
    iw,
    sw,
    overflow: sw > iw,
    offenders: offenders.slice(0, 15),
    offenderCount: offenders.length,
  };
}
