// Minimal App-Router page. No next/image, no ISR, no middleware — the
// bun-exec-eligible surface only (ADR-0036). Apps that need those features fall
// back to the default `node` build target.
export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1 data-testid="hello">knext bun-exec sample</h1>
      <p>
        This page is served by a <code>bun --compile --bytecode</code> single executable built from
        a vinext build — the opt-in, experimental <code>bun-exec</code> target. The default target
        is still node.
      </p>
    </main>
  );
}
