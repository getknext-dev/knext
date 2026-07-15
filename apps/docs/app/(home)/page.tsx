import Link from 'next/link';
import styles from './home.module.css';

/**
 * knext landing page — ports the "acid-lime-on-void" hero from the original static
 * _design-reference/index.html into a React Server Component. Copy is honesty-gated:
 * the official-suite claim below (778 tests, Node, nightly) mirrors the verified
 * status documented in /docs/compat-suite and must be withdrawn if the nightly
 * goes red. Detailed compat status lives in /docs/compat-matrix.
 */
export default function HomePage() {
  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <div className={styles.wrap}>
          <div className={styles.eyebrow}>official next.js deployment adapter · knative</div>
          <h1 className={styles.h1}>
            Scale&#8209;to&#8209;<span className={styles.z}>zero</span> Next.js, on Knative.
          </h1>
          <p className={styles.lede}>
            knext is a deployment adapter that runs Next.js on the <b>official Adapter API</b> with
            true <b>scale-to-zero</b> — pods drop to nothing when idle and wake on the first
            request, with <b>bytecode-cached</b> cold starts. One operator. Any cloud. No lock-in.
          </p>
          <div className={styles.cta}>
            <Link className={`${styles.btn} ${styles.btnPrimary}`} href="/docs">
              Read the docs
            </Link>
            <a
              className={`${styles.btn} ${styles.btnGhost}`}
              href="https://github.com/getknext-dev/knext"
            >
              Star on GitHub
            </a>
          </div>

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
              <h3>Official adapter, not a fork</h3>
              <p>
                Built on Next.js&apos;s official Deployment Adapter API (<code>NextAdapter</code>,{' '}
                <code>output:&apos;standalone&apos;</code>). No reverse-engineered runtime.
                Validated against the official Next.js deploy-mode e2e suite —{' '}
                <b>778 tests, zero failures</b> on Node, re-verified nightly. Scope and exclusions:{' '}
                <Link href="/docs/compat-suite">verified compatibility</Link>.
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
                <code>NODE_COMPILE_CACHE</code> persists V8 bytecode to a volume — cold pods skip JS
                recompilation. Or run <Link href="/docs/bun-runtime">Bun</Link> with build-time
                bytecode precompilation (−47% measured boot). Self-hosted, on your cluster.
              </p>
            </div>
            <div className={styles.cell}>
              <div className={styles.n}>04</div>
              <h3>Multi-cloud, no lock-in</h3>
              <p>
                One Go operator + a <code>NextApp</code> CRD reconciles your app on GKE, EKS, AKS,
                OKE, or bare-metal. Object storage via gcs, s3, or minio. Your manifests are yours.
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
  name: storefront
spec:
  image: registry/storefront@sha256:9f1c...   # digest-pinned (required)
  scaling:
    minScale: 0      # scale to zero
    maxScale: 20
  cache:
    enableBytecodeCache: true   # NODE_COMPILE_CACHE on a PVC`}</code>
            </pre>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.wrap}>
          <div className={styles.sectLabel}>{'// the database layer — scale-zero-pg'}</div>
          <div className={styles.codewrap}>
            <div className={styles.codetext}>
              <h2>Your database sleeps too.</h2>
              <p>
                knext scales the <b>app</b> to zero; its companion{' '}
                <span className={styles.signal}>scale-zero-pg</span> scales the <b>database</b> to
                zero. Native Postgres on{' '}
                <a href="https://github.com/neondatabase/neon">Neon&apos;s open-source</a>{' '}
                disaggregated storage, fronted by a small Go <b>wake-on-connect</b> gateway: an idle
                database costs zero compute and wakes on the first client connection in{' '}
                <span className={styles.signal}>~2.5s</span> — or <b>~400ms</b> from an opt-in warm
                tier. Same cluster, two layers, one platform: an app and its database{' '}
                <b>sleep at zero and wake together on a single visitor request</b>.
              </p>
              <ul className={styles.steps}>
                <li>
                  <span>01</span> declare <code>spec.database</code> on your NextApp
                </li>
                <li>
                  <span>02</span> the operator provisions a branch-per-app Postgres and wires{' '}
                  <code>DATABASE_URL</code>
                </li>
                <li>
                  <span>03</span> query it with typed{' '}
                  <a href="/docs/scale-zero-pg/data-sdk">
                    <code>@knext/db</code>
                  </a>{' '}
                  (Drizzle) — writer / bounded-stale reader split, <b>TimescaleDB + pgvector</b>{' '}
                  built in
                </li>
                <li>
                  <span>04</span> idle → 0 compute · connect → wakes sub-second · data durable on
                  the storage plane
                </li>
              </ul>
            </div>
            <pre className={styles.code}>
              <code>{`# one platform, two layers — declare the database inline
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: storefront
spec:
  image: registry/storefront@sha256:9f1c...
  scaling:
    minScale: 0            # the app scales to zero
  database:
    enabled: true          # scale-zero-pg provisions + wires it
    tier: small            # its own 0↔1 compute, wakes on connect
    # → injects DATABASE_URL (+ DATABASE_URL_RO) into the app`}</code>
            </pre>
          </div>
        </div>
      </section>

      <footer className={styles.footer}>
        <div className={styles.wrap}>
          <div>
            <span className={styles.pill}>v0.1 · alpha</span> &nbsp; the scale-to-zero Next.js
            adapter for Knative. Apache-2.0.
          </div>
          <div>
            <Link href="/docs/getting-started">getting started</Link> ·{' '}
            <Link href="/docs/operator">operator + CRD</Link> ·{' '}
            <Link href="/docs/compat-matrix">compat matrix</Link> ·{' '}
            <a href="https://github.com/getknext-dev/scale-zero-pg">scale-zero-pg</a> ·{' '}
            <a href="https://knext-platform.dev/">knext-platform.dev</a>
          </div>
        </div>
      </footer>
    </main>
  );
}
