// Minimal App-Router page. No next/image, no ISR, no middleware — the
// bun-exec-eligible surface only (ADR-0036). Apps that need those features fall
// back to the default `node` build target.
//
// Also exercises CSS MODULES on this build target (see page.module.css): a
// global `import './globals.css'` and a `*.module.css` import are different
// pipelines, and only the former had ever been tested here.
import styles from './page.module.css';

export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1 data-testid="hello">knext bun-exec sample</h1>
      <div className={styles.card} data-testid="css-module-card">
        <span className={styles.badge}>bun-exec</span>
      </div>
      <p>
        This page is served by a <code>bun --compile --bytecode</code> single executable built from
        a vinext build — the opt-in, experimental <code>bun-exec</code> target. The default target
        is still node.
      </p>
    </main>
  );
}
