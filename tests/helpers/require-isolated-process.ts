/**
 * Fail LOUD when two of the known mock-polluting specs share one `bun test`
 * process (#965).
 *
 * ## Why this exists
 *
 * bun registers `mock.module` for the whole RUN and cannot unregister it —
 * `mock.restore()` restores spies, not module mocks (measured, bun 1.4.0), and
 * a consumer imported once is cached bound to whichever mock was live first. So
 * `build-run.test.ts` and `gc-build-no-storage.test.ts` install process-global
 * fakes of the shared CLI modules (`../cli/exec`, `../cli/shared`,
 * `../cli/vinext-build`, `../cli/postcompile-smoke`, `../utils/asset-upload`,
 * `../utils/logger`), and any sibling that imports the REAL versions in the same
 * process gets the fake instead — a phantom failure that looks real to a
 * reviewer, a newcomer, or an IDE test runner.
 *
 * The suite of record — `scripts/bun-test.mjs` — sidesteps this by running one
 * PROCESS per file, so the pollution never crosses. This guard makes the footgun
 * that everything ELSE hits fail with a NAMED message pointing at that runner,
 * instead of a confusing assertion deep inside an innocent spec.
 *
 * True cross-file isolation is not available here: restoring the real modules
 * would mean importing the heavy, side-effectful CLI modules first, i.e. exactly
 * the "rewrite every mocking file to avoid each other" trap the runner's own
 * docstring rejects. Detecting the collision and pointing at the runner is the
 * honest fix.
 *
 * ## Contract
 *
 * Each known-conflicting spec calls `requireIsolatedProcess(<name>)` at module
 * top. Under the per-file runner exactly one such call happens per process, so
 * this is a no-op. The moment a SECOND one runs in the same process it prints the
 * banner and exits non-zero, aborting the batch loudly.
 */

const REGISTRY_KEY = Symbol.for('knext.test.isolated-process-registry');

const RUNNER = 'scripts/bun-test.mjs';

interface Registry {
  names: string[];
}

function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  let reg = g[REGISTRY_KEY];
  if (reg === undefined) {
    reg = { names: [] };
    g[REGISTRY_KEY] = reg;
  }
  return reg;
}

/**
 * Assert this spec has the `bun test` process to itself.
 *
 * @param name a short, human identifier for the spec (used in the banner).
 */
export function requireIsolatedProcess(name: string): void {
  const reg = registry();
  reg.names.push(name);
  if (reg.names.length < 2) return;

  const banner = [
    '',
    '========================================================================',
    '  CROSS-FILE MOCK POLLUTION: these specs must each run in their OWN process.',
    '',
    `  In this process together: ${reg.names.join(', ')}`,
    '',
    '  They install process-global `mock.module` fakes of shared CLI modules that',
    '  bun cannot unregister, so batching them into ONE `bun test` invocation',
    '  produces PHANTOM failures that look real. Each spec passes on its own.',
    '',
    '  Run the suite of record instead — it isolates one process per file:',
    '',
    `      node ${RUNNER} <path...>`,
    '',
    '  See issue #965 / this guard: tests/helpers/require-isolated-process.ts',
    '========================================================================',
    '',
  ].join('\n');

  console.error(banner);
  process.exit(1);
}
