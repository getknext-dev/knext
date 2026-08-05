/**
 * Pure, cluster-free half of the image-prewarm harness.
 *
 * It lives in its own module for one reason: everything here is a place the
 * harness could quietly produce a WRONG number rather than no number, and none
 * of it is testable while it sits inside a file whose first statement talks to a
 * cluster. `tests/image-prewarm-harness.test.ts` covers it offline.
 *
 * The four properties this file exists to hold:
 *
 *   1. An absent observation is a FAILED replicate, never a favourable default.
 *   2. A precondition that would damage the cluster (or the next run) aborts the
 *      RUN, not one replicate.
 *   3. Node-local image matching is ANCHORED to one repository, exactly — the
 *      eviction that follows it removes by image ID, which drops every reference
 *      to that content.
 *   4. Whatever the run changed on the CR, it puts back — and proves it did.
 */

/**
 * A condition under which continuing would corrupt the cluster, the run, or the
 * NEXT run. Distinguished from an ordinary replicate failure (which is recorded
 * and stepped over) precisely because the caller catches everything: without a
 * separate class, "ABORT: node disk at 86%" recorded one failed replicate and
 * then pulled another 370 MB onto that node.
 */
export class FatalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FatalError';
  }
}

/**
 * A digest-pinned image reference, and NOTHING that survives interpolation into
 * a root shell. `PW_IMAGE` reaches `crictl` inside an `nsenter -t 1` on every
 * node, as root, via `nodesh.sh` — so `.includes('@sha256:')` is not validation,
 * it is a substring test that `evil@sha256:…; reboot` passes.
 *
 * Deliberately narrower than the OCI grammar (no tag+digest form, lowercase
 * path components): this harness only ever names one digest-pinned image, and a
 * validator that accepts more than the caller needs is surface for nothing.
 */
const IMAGE_REF_RE =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?::\d+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}$/;

/** RFC-1123-ish node name: the value `nodesh.sh` puts into `nodeName:` and a Job name. */
const NODE_NAME_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

export function assertSafeImageRef(ref) {
  if (typeof ref !== 'string' || !IMAGE_REF_RE.test(ref)) {
    throw new FatalError(
      `PW_IMAGE ${JSON.stringify(ref)} is not a plain digest-pinned reference ` +
        '(registry[:port]/path@sha256:<64 hex>). It is interpolated into a root shell on every ' +
        'node, so anything else is rejected rather than escaped.',
    );
  }
  return ref;
}

export function assertSafeNodeName(node) {
  if (typeof node !== 'string' || !NODE_NAME_RE.test(node)) {
    throw new FatalError(`node name ${JSON.stringify(node)} is not a plain DNS-1123 name`);
  }
  return node;
}

/** The repository half of a digest-pinned reference (everything before `@`). */
export function imageRepo(ref) {
  return assertSafeImageRef(ref).split('@')[0];
}

/** POSIX single-quote quoting. Belt to the validators' braces. */
const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * The awk selector that turns a `crictl images --digests` table into image IDs
 * for EXACTLY ONE repository.
 *
 * This replaces `crictl images | grep ${REPO}`, which is an unanchored substring
 * match: with `REPO=…/pw` it also matched `…/pw-app` and `…/pwx`, and the caller
 * then `crictl rmi`s every id it returns — dropping every reference to content
 * the harness does not own, on a cluster the write-up itself says carries other
 * work's images. `$1` is the REPOSITORY column, and `==` is the whole fix.
 */
export function repoIdSelector(repo, prefix = '') {
  // Both values reach awk as -v ASSIGNMENTS, never as text spliced into the awk
  // program: the program is single-quoted for the shell, so an interpolated
  // literal would end the quoting.
  return `awk -v repo=${shq(repo)} -v pfx=${shq(prefix)} '$1 == repo { print pfx $4 }'`;
}

/**
 * Presence + id table + root-disk usage for one node.
 *
 * `crictl inspecti` rather than `crictl images -q <repo>`: the latter returns
 * NOTHING for a digest-only (untagged) image even when it is present, which
 * invalidated an entire run (its eviction loop found no ids and removed
 * nothing). The id table is for logging and for the eviction loop only.
 */
export function nodeProbeCmd(ref) {
  const image = assertSafeImageRef(ref);
  return (
    `crictl inspecti -q ${shq(image)} >/dev/null 2>&1 && echo PRESENT || echo ABSENT; ` +
    `crictl images --digests 2>/dev/null | ${repoIdSelector(imageRepo(image), 'ID=')}; ` +
    'df --output=pcent / | tail -1'
  );
}

export function nodeEvictCmd(ref) {
  const image = assertSafeImageRef(ref);
  return (
    `crictl rmi ${shq(image)} 2>&1 | tail -1; ` +
    `ids=$(crictl images --digests 2>/dev/null | ${repoIdSelector(imageRepo(image))}); ` +
    'for i in $ids; do crictl rmi "$i" 2>&1 | tail -1; done; ' +
    `crictl inspecti -q ${shq(image)} >/dev/null 2>&1 && echo "STILL-PRESENT" || echo "removed"`
  );
}

/**
 * Parse `nodeProbeCmd` output. Throws when presence is INDETERMINATE — a probe
 * that did not run must not resolve to either arm's expectation, in either
 * direction.
 */
export function parseNodeProbe(out) {
  const text = String(out ?? '');
  const present = /(^|\n)PRESENT(\r?\n|$)/.test(text);
  const absent = /(^|\n)ABSENT(\r?\n|$)/.test(text);
  if (present === absent) {
    throw new FatalError(
      `could not determine image presence on the node (no unambiguous PRESENT/ABSENT marker): ${text.slice(0, 400)}`,
    );
  }
  const pct = text.match(/(\d+)%/);
  return {
    present,
    ids: [...text.matchAll(/ID=([0-9a-f]{8,})/g)].map((m) => m[1]),
    diskPct: pct ? Number(pct[1]) : null,
  };
}

/**
 * The design constraint the harness header claims — "ONE application on both
 * arms, asserted by image DIGEST, not by inspection" — as code. Called BEFORE
 * any mutation: the sibling scale-to-zero harness aborts the same way (its D1
 * gate), and the reason it exists is that an A/B there once served two
 * different applications.
 */
export function assertSingleApplication({ pwImage, revisionImage, revision }) {
  assertSafeImageRef(pwImage);
  if (!revisionImage) {
    throw new FatalError(
      `could not read the running image of revision ${revision}: without it, "one application on ` +
        'both arms" is an assertion by the author rather than by the harness',
    );
  }
  if (revisionImage !== pwImage) {
    throw new FatalError(
      `ABORT: revision ${revision} runs ${revisionImage} but PW_IMAGE is ${pwImage}. ` +
        'Both arms must be the SAME application, asserted by digest.',
    );
  }
}

/**
 * What one measured pod contributes to a replicate.
 *
 * @typedef {object} PodFacts
 * @property {string} [pod]
 * @property {string} [node]
 * @property {boolean} [pulling]
 * @property {string} [eventsError]
 * @property {Array<{name?: string, image?: string}>} [containers]
 */

/**
 * An observation is complete or the replicate failed. Every branch here used to
 * degrade to `pulling: false` — which is the value the headline claim wants, so
 * a transient events-API failure on a no-prewarm replicate silently converted
 * 10/10 into 9/10 in the favourable direction.
 *
 * WHICH KIND OF FAILURE, and why the two are not the same:
 *
 *   - A MISSING observation (no pod in the window, a failed events query, no
 *     boolean `pulling`) fails THE REPLICATE. It is recorded as failed, never as
 *     the favourable value, and the loop steps over it. It is deliberately NOT a
 *     `FatalError`: nothing about a transient `kubectl get events` hiccup makes
 *     the next replicate wrong, and aborting discards a ~100 minute booking on a
 *     shared cluster. An earlier revision threw `FatalError` here while three
 *     doc sites said "fails the replicate" — the code and the prose taught
 *     different rules.
 *   - A WRONG IMAGE is fatal. It means the two arms are not one application, so
 *     every remaining replicate would measure a different program under the same
 *     label — the run itself is invalid, not one row of it.
 *
 * @param {PodFacts | null | undefined} facts
 * @param {{expectImage?: string}} [options]
 * @returns {PodFacts}
 */
export function assertPodFacts(facts, { expectImage } = {}) {
  if (!facts) {
    throw new Error(
      'no pod matched the request window: the cold start cannot be attributed, so the replicate ' +
        'is failed rather than recorded without its `Pulling` observation',
    );
  }
  if (facts.eventsError) {
    throw new Error(
      `the kubelet events query failed (${facts.eventsError}): "no Pulling event" would be an ` +
        'absent observation reported as the favourable one',
    );
  }
  if (typeof facts.pulling !== 'boolean') {
    throw new Error('pod facts carry no boolean `pulling` observation');
  }
  if (expectImage) {
    const images = (facts.containers ?? []).map((c) => c.image);
    if (!images.includes(expectImage)) {
      throw new FatalError(
        `the measured pod ran ${JSON.stringify(images)}, not the image under test ${expectImage}: ` +
          'the arms must be one application, asserted by digest',
      );
    }
  }
  return facts;
}

/** Why a row is not analysable, or `null` when it is. */
export function unusableReason(row) {
  if (row.failed) return `replicate failed: ${row.failed}`;
  if (typeof row.cold_ttfb_ms !== 'number') return 'no cold TTFB';
  if (typeof row.pulling !== 'boolean') {
    return 'no `pulling` observation — an absent observation is not "no Pulling event"';
  }
  if (typeof row.node !== 'string') return 'no node attribution';
  return null;
}

export function isUsableRow(row) {
  return unusableReason(row) === null;
}

/**
 * Run every replicate of every pair. An ordinary failure is RECORDED and
 * stepped over; a `FatalError` is recorded and then re-thrown, which is the
 * whole difference between "one bad replicate" and "keep pulling 370 MB onto a
 * node past the kubelet's image-GC threshold".
 *
 * @typedef {object} FailedRow
 * @property {string} ts
 * @property {number} pair
 * @property {number} idx
 * @property {string} mode
 * @property {string} failed
 * @property {boolean} fatal
 *
 * @param {object} options
 * @param {number} [options.first]
 * @param {number} options.pairs
 * @param {string[]} options.order
 * @param {(replicate: {pair: number, idx: number, mode: string}) => Promise<unknown>} options.run
 * @param {(row: FailedRow) => void} [options.record]
 * @param {(message: string) => void} [options.log]
 * @param {() => string} [options.now]
 * @returns {Promise<void>}
 */
export async function runReplicates({
  first = 1,
  pairs,
  order,
  run,
  // The unused parameters are load-bearing for callers type-checked under
  // `allowJs`: a `() => {}` default infers a ZERO-argument signature, which
  // makes every real 1-argument callback a type error at the call site.
  record = (_row) => {},
  log = (_message) => {},
  now = () => new Date().toISOString(),
}) {
  let idx = (first - 1) * order.length;
  for (let pair = first; pair <= first + pairs - 1; pair++) {
    for (const mode of order) {
      idx++;
      try {
        await run({ pair, idx, mode });
      } catch (error) {
        const fatal = error instanceof FatalError;
        log(`  REPLICATE ${fatal ? 'FATAL' : 'FAILED'}: ${error}`);
        record({ ts: now(), pair, idx, mode, failed: String(error), fatal });
        if (fatal) throw error;
      }
    }
  }
}

/** The exit code convention for a process killed by signal N: 128 + N. */
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 };

/**
 * The slice of `process` `withRestore` needs — declared structurally so a test
 * double is a first-class caller rather than something a cast has to smuggle in.
 *
 * @typedef {object} SignalHost
 * @property {(signal: string, handler: () => void) => unknown} on
 * @property {(signal: string, handler: () => void) => unknown} off
 * @property {(code: number) => unknown} exit
 */

/**
 * Run `body` and put back whatever `read()` reported before it — then read back
 * and PROVE the restore landed.
 *
 * Without this, every run of this harness exited with `imagePrewarm` set to
 * whatever its last replicate used (`ORDER` ends with `on`), leaving a prewarm
 * DaemonSet and a warm image on every node. The next benchmark on that cluster
 * inherits it and cannot tell — and this harness's own README says exactly that,
 * as a human checklist item. A checklist is not a restore.
 *
 * SIGNALS ARE PART OF THAT, not a footnote. A full run is ~100 minutes on a
 * shared cluster, so Ctrl-C is a LIKELY exit path, not an exotic one — and an
 * interrupted run that skipped the restore leaves exactly the state above:
 * `imagePrewarm=true` plus a warm image on every node. `SIGINT`/`SIGTERM` are
 * therefore handled and perform the same write + READ-BACK; only `SIGKILL`,
 * which no process can handle, remains uncovered.
 *
 * TYPES ARE DECLARED, not left to inference. The callers are TypeScript and are
 * checked by the root `typecheck` gate; with `proc` inferred from its
 * `= process` default, every test that injects a signal-host double became a
 * type error, and the casts that silenced it (`as never`) turned type-checking
 * OFF for the whole options object — on exactly the function whose contract was
 * being changed. A minimal structural `SignalHost` is what the code actually
 * needs, and `process` satisfies it.
 *
 * @template T
 * @param {object} options
 * @param {() => boolean} options.read
 * @param {(value: boolean) => void} options.write
 * @param {(before: boolean) => Promise<T>} options.body
 * @param {(message: string) => void} [options.log]
 * @param {SignalHost} [options.proc]
 * @param {string[]} [options.signals]
 * @returns {Promise<T>}
 */
export async function withRestore({
  read,
  write,
  body,
  log = (_message) => {},
  // Injected so the signal path can be exercised rather than merely registered.
  proc = process,
  signals = ['SIGINT', 'SIGTERM'],
}) {
  const before = read();

  /**
   * Put it back and prove it. Idempotent: the signal and the normal path share it.
   *
   * The memo holds the OBSERVED OUTCOME, not `{ restored: true }`. It used to
   * hardcode success for the second caller, which meant a handler-path restore
   * that genuinely failed — state left dirty, `RESTORE FAILED` logged — was
   * reported to the normal path as a clean restore, and `withRestore` resolved
   * instead of raising its `FatalError`.
   *
   * Stated as measured, not as it reads: with `proc = process` that path is
   * NOT reachable. The handler calls `proc.exit()` and never returns, and a
   * signal delivered during the final synchronous `restore()` is dispatched
   * only after `unregister()` — the very next statement, same tick — has
   * removed the listener. So this fix is DEFENSIVE: it is the injected-`proc`
   * path (which the suite exercises) and any future caller that keeps running
   * after a handler that it makes honest. The ordering fix below earns its
   * place on a different mechanism — see the comment there — not on a race
   * with this memo.
   */
  let done = false;
  /** @type {{restored: boolean, after?: boolean, restoreError?: unknown}} */
  let outcome = { restored: false };
  const restore = () => {
    if (done) return outcome;
    done = true;
    let restoreError;
    let after;
    try {
      write(before);
      after = read();
    } catch (error) {
      restoreError = error;
    }
    const restored = restoreError === undefined && after === before;
    log(
      restored
        ? `restored pre-run state (imagePrewarm=${before}), verified by read-back`
        : `RESTORE FAILED: wanted imagePrewarm=${before}, read back ${after}${restoreError ? ` (${restoreError})` : ''}`,
    );
    outcome = { restored, after, restoreError };
    return outcome;
  };

  const handlers = signals.map((signal) => {
    const handler = () => {
      log(`${signal} received — restoring before exit`);
      const { restored } = restore();
      // A failed restore is not a clean interrupt: exit 1 so a wrapper script
      // cannot read "the operator just pressed Ctrl-C" and move on.
      proc.exit(restored ? (SIGNAL_EXIT[signal] ?? 1) : 1);
    };
    proc.on(signal, handler);
    return [signal, handler];
  });
  const unregister = () => {
    for (const [signal, handler] of handlers) proc.off(signal, handler);
  };

  let result;
  let bodyError;
  try {
    result = await body(before);
  } catch (error) {
    bodyError = error;
  }

  // The final restore runs WITH its signal protection still installed, and
  // `unregister()` comes after it. The other order — which is what shipped —
  // stripped the handlers one line before the single most important write in
  // the harness, and that write is a slow synchronous `execFileSync` kubectl
  // patch. A Ctrl-C landing in it (an operator waiting out the tail of a ~100
  // minute run: the LIKELIEST Ctrl-C moment there is) therefore met the default
  // disposition, killed the process mid-write, and left `imagePrewarm=true` —
  // precisely the state this function exists to prevent, with no handler log to
  // say it happened. `done` already makes `restore()` idempotent, so the
  // handler firing here is harmless; it re-reads the memoised outcome.
  const { restored, after, restoreError } = restore();
  unregister();

  if (bodyError) throw bodyError;
  if (!restored) {
    throw new FatalError(
      `RESTORE FAILED: the run could not put imagePrewarm back to ${before} (read back ${after}` +
        `${restoreError ? `, ${restoreError}` : ''}). The cluster is left in a state that changes ` +
        'every later measurement on it — fix it before running anything else there.',
    );
  }
  return result;
}
