/**
 * compat-smoke FIXTURE — ISR / Data Cache revalidation (check k).
 *
 * This route exists ONLY so `scripts/compat-smoke.mjs` can assert ISR against a REAL
 * `REDIS_URL` (docs/compat-matrix.md). The value below is regenerated on every render, so:
 *
 *   - two back-to-back requests returning the SAME value proves the response is CACHED
 *     (a `force-dynamic` page would render a new value each time);
 *   - the value CHANGING after the revalidate window proves it is REVALIDATED
 *     (a permanently-static page would never change).
 *
 * Asserting two 200s would prove neither, which is why the check asserts the CONTENT.
 */

// Short window so the smoke gate stays fast; ISR semantics are identical at any interval.
export const revalidate = 1;

export default async function KnextSmokeIsrPage() {
  const value = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return (
    <main className="p-8">
      <h1 className="text-xl font-bold">knext compat-smoke ISR fixture</h1>
      {/* The value is exposed as an ATTRIBUTE, not as a text node: React splits a dynamic
          text child with a `<!-- -->` separator on the streaming render but not on the
          build-time prerender, so a text marker is not reliably greppable. */}
      <div id="knext-isr-value" data-knext-isr-value={value}>
        knext-isr-value
      </div>
    </main>
  );
}
