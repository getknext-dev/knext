'use client';

// A CLIENT component that carries a CSS-Module class.
//
// WHY IT EXISTS. The CSS-Modules test previously claimed "server/client hash
// agreement" while the example contained no `'use client'` component at all —
// nothing was ever hydrated, so the CLIENT graph's class hashes were never read
// and the claim was wider than the evidence (spec review). A module build whose
// client graph hashed differently from its server graph would have passed
// everything: the page renders correctly from SSR and then breaks on hydration,
// which is the same shape as #657 one layer up.
//
// Deliberately trivial. It exists to put a module-hashed class into the client
// bundle, not to test React.
import styles from './page.module.css';

export default function Counter() {
  return (
    <button type="button" className={styles.badge} data-testid="client-badge">
      client component
    </button>
  );
}
