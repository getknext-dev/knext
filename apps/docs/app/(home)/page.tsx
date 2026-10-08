import Link from 'next/link';
import { currentPillText } from '../../lib/version-label';
import styles from './home.module.css';

/**
 * knext landing page — ports the "acid-lime-on-void" hero from the original static
 * _design-reference/index.html into a React Server Component. Copy is honesty-gated:
 * the official-suite claim below states the 14-night credential is IN PROGRESS, as
 * documented in /docs/compat-suite — it must not say "verified" or "credentialed"
 * until all four default cells reach 14/14. Detailed compat status lives in
 * /docs/compat-matrix.
 */
export default function HomePage() {
  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.wrap}>
          <div className={styles.eyebrow}>
            scale-to-zero next.js · knative · single-binary deploys
          </div>
          <h1 className={styles.h1}>
            Scale&#8209;to&#8209;<span className={styles.z}>zero</span> Next.js, on Knative.
          </h1>
          <p className={styles.lede}>
            knext deploys Next.js apps on Knative with true <b>scale-to-zero</b> — pods drop to
            nothing when idle and wake on the first request with an <b>optimized cold start</b>:
            every build bakes in a bytecode cache at build time, so cold pods skip JS recompilation.
            One operator. Any cloud. No lock-in.
          </p>
          <div className={styles.cta}>
            <Link className={`${styles.btn} ${styles.btnPrimary}`} href="/docs/learn">
              Deploy ACME — step by step
            </Link>
            <Link className={`${styles.btn} ${styles.btnGhost}`} href="/docs">
              Read the docs
            </Link>
            <a
              className={`${styles.btn} ${styles.btnGhost}`}
              href="https://github.com/getknext-dev/knext"
            >
              Star on GitHub
            </a>
          </div>
          <p className={styles.ctaNote}>
            New to Kubernetes? The tutorial starts with the six words you need, then deploys ACME —
            a small storefront — and gives it a database.
          </p>

          <div className={styles.meter}>
            <div className={styles.meterBar}>
              <span className={`${styles.dot} ${styles.live}`} /> replicas · autoscaler: KPA ·
              target idle → 0
            </div>
            <div className={styles.pods}>
              {Array.from({ length: 8 }).map((_, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <div key={i} className={styles.pod} />
              ))}
            </div>
            <div className={styles.meterFoot}>
              <span>
                idle cost: <b>$0</b> · pods scaled to zero
              </span>
              <span>cold wake: bytecode cache skips JS recompile</span>
            </div>
          </div>
        </div>
      </header>

      <section className={styles.section}>
        <div className={styles.wrap}>
          <div className={styles.sectLabel}>{'// why knext'}</div>
          <div className={styles.grid}>
            <div className={styles.cell}>
              <div className={styles.n}>01</div>
              <h3>Measured in the open — claims match the code</h3>
              <p>
                The default build runs on the official Next.js Deployment Adapter API, packaged as a
                bytecode-cached standalone executable. knext&apos;s compatibility record is public
                and honest: Next.js&apos;s own deploy-mode e2e suite runs against it nightly, and
                its compatibility credential is <b>in progress</b> — not yet complete. An optional{' '}
                <b>vinext</b> build (an open-source Vite-based Next.js implementation, compiled into
                one binary) is also available as a Beta, with its measured suite results published.
                Scope, exclusions, and what each claim covers:{' '}
                <Link href="/docs/compat-suite">the compatibility credential</Link>.
              </p>
            </div>
            <div className={styles.cell}>
              <div className={styles.n}>02</div>
              <h3>True scale-to-zero</h3>
              <p>
                Knative KPA + activator: idle services drop to{' '}
                <span className={styles.signal}>0 replicas</span> and wake on demand through the
                activator. You pay for requests, not idle containers.
              </p>
            </div>
            <div className={styles.cell}>
              <div className={styles.n}>03</div>
              <h3>Bytecode-cached cold starts</h3>
              <p>
                Every image bakes in a compiled bytecode cache at build time — every cold pod skips
                JS recompilation, with nothing to enable. On a real cluster, scheduling and
                container start dominate the wake time; see{' '}
                <Link href="/docs/scale-to-zero">scale-to-zero &amp; cold starts</Link> for measured
                numbers. Self-hosted, on your cluster.
              </p>
            </div>
            <div className={styles.cell}>
              <div className={styles.n}>04</div>
              <h3>Multi-cloud, no lock-in</h3>
              <p>
                One Go operator + a <code>NextApp</code> CRD, on any Kubernetes cluster running
                Knative Serving. Verified end-to-end on <strong>GKE and OKE</strong> (and on kind in
                CI); the core deploy path is also validated on <strong>EKS</strong>. AKS, OpenShift
                and bare-metal are portable by design, not yet live-validated there. Object storage
                via gcs, s3, azure or minio. Your manifests are yours.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.wrap}>
          <div className={styles.sectLabel}>{'// declare it, the operator reconciles it'}</div>
          <div className={styles.codewrap}>
            <div className={styles.codetext}>
              <h2>Your app is a resource.</h2>
              <p>
                Describe the deployment once as a <span className={styles.signal}>NextApp</span>{' '}
                custom resource. The operator — the single source of truth for cluster state —
                builds the Knative Service, wires scale-to-zero, and rejects any image that is not
                digest-pinned.
              </p>
              <ul className={styles.steps}>
                <li>
                  <span>01</span> push a digest-pinned image
                </li>
                <li>
                  <span>02</span> apply the NextApp CR
                </li>
                <li>
                  <span>03</span> operator reconciles → reachable URL, scaled to zero
                </li>
              </ul>
            </div>
            <pre className={styles.code}>
              <code>{`# the whole deployment, declared
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: acme
spec:
  image: registry/acme@sha256:9f1c...   # digest-pinned (required)
  scaling:
    minScale: 0      # scale to zero
    maxScale: 20
  # bytecode cache is baked into the image — nothing to configure`}</code>
            </pre>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.wrap}>
          <div className={styles.sectLabel}>{'// databases — bring your own Postgres'}</div>
          <div className={styles.codewrap}>
            <div className={styles.codetext}>
              <h2>Bring your own database.</h2>
              <p>
                knext is <b>engine-agnostic</b>: it provisions{' '}
                <span className={styles.signal}>nothing</span> and manages no database. You bring
                your own Postgres — a CloudNativePG cluster in the same cluster, or a managed /
                serverless provider — and knext <b>binds its DSN</b> from a Kubernetes Secret into
                your pods as <code>DATABASE_URL</code>. Swapping providers is a Secret change: no
                app or CR schema change.
              </p>
              <ul className={styles.steps}>
                <li>
                  <span>01</span> put your Postgres DSN in a Kubernetes <code>Secret</code>
                </li>
                <li>
                  <span>02</span> reference it with <code>spec.database.secretRef</code> — the
                  operator wires <code>DATABASE_URL</code> (+ optional <code>roSecretRef</code> →{' '}
                  <code>DATABASE_URL_RO</code>)
                </li>
                <li>
                  <span>03</span> query it with typed{' '}
                  <a href="/docs/databases">
                    <code>@getknext/db</code>
                  </a>{' '}
                  (Drizzle) — writer / bounded-stale reader split
                </li>
                <li>
                  <span>04</span> front Postgres with a <b>connection pooler</b> (PgBouncer / pgcat)
                  so scale-to-zero fan-out never storms the database
                </li>
              </ul>
            </div>
            <pre className={styles.code}>
              <code>{`# bring your own Postgres — bind an existing Secret
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: acme
spec:
  image: registry/acme@sha256:9f1c...
  scaling:
    minScale: 0                      # the app scales to zero
  database:
    secretRef: { name: acme-db }   # → DATABASE_URL from a K8s Secret
    roSecretRef: { name: acme-db }  # optional → DATABASE_URL_RO
    # point the DSN at a pooler, not the primary`}</code>
            </pre>
          </div>
        </div>
      </section>

      <footer className={styles.footer}>
        <div className={styles.wrap}>
          <div>
            <span className={styles.pill}>{currentPillText}</span> &nbsp; the scale-to-zero Next.js
            adapter for Knative. Apache-2.0.
          </div>
          <div>
            <Link href="/docs/getting-started">getting started</Link> ·{' '}
            <Link href="/docs/operator">operator + CRD</Link> ·{' '}
            <Link href="/docs/compat-matrix">compat matrix</Link> ·{' '}
            <a href="https://github.com/getknext-dev/knext/tree/main/packages/scale-zero-pg">
              scale-zero-pg
            </a>{' '}
            · <a href="https://knext-platform.dev/">knext-platform.dev</a>
          </div>
        </div>
      </footer>
    </main>
  );
}
