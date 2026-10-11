#!/usr/bin/env node
/**
 * Mutation proof for the tracing-off deep-health gauge and the idle drop.
 *
 * WHAT IS CLAIMED. On a default install (tracing off) the deep-health alerts can
 * fire because a dependency-free module serves `knext_deep_health_state`; that
 * module never wakes an idle scale-to-zero database; and an idle app serves NO
 * series (rather than a stale `waking`/`down`) on BOTH paths, lite and
 * prom-client.
 *
 * Every one of those is a property that fails silently: a probe that dials an
 * idle database looks like a healthy gauge, and a series that outlives its
 * activity looks like an alert doing its job. So each guard is proved by removing
 * the behaviour it protects and requiring the guard to go red.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): verdicts branch on the runner's EXIT
 * CODE and never on output; the baseline must be green and a canary must go red
 * first; each anchor must occur EXACTLY ONCE (preflight aborts otherwise); the
 * tree is checked clean between mutations; a partial run is a failure. No perl.
 *
 * Mutations are grouped by the spec that must kill them; one prover per spec.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const T = 'packages/kn-next/src/__tests__/';

const HBS = { commentPrefix: '//' };

/** @type {Array<{spec: string, mutations: object[]}>} */
const GROUPS = [
  {
    spec: `${T}deep-health-lite.test.ts`,
    mutations: [
      {
        id: 'L1',
        expect: 'red',
        claim:
          'the activity gate is removed — every scrape dials Postgres and wakes an idle scale-to-zero DB',
        subject: 'lite',
        anchor: '            if (!gateOpen()) {',
        replacement: '            if (!gateOpen() && false) {',
      },
      {
        id: 'L2',
        expect: 'red',
        claim: 'a throwing activity read FAILS OPEN — "not sure" dials the database',
        subject: 'lite',
        anchor:
          '        } catch {\n            return false;\n        }\n    };\n\n    const probe',
        replacement:
          '        } catch {\n            return true;\n        }\n    };\n\n    const probe',
      },
      {
        id: 'L3',
        expect: 'red',
        claim:
          'the health module is loaded EAGERLY at creation — the cold-start cost lite exists to avoid',
        subject: 'lite',
        anchor: '    let health: Promise<HealthModule> | undefined;',
        replacement: '    let health: Promise<HealthModule> | undefined = loadHealth();',
      },
      {
        id: 'L4',
        expect: 'red',
        claim: 'the 10 s TTL is removed — every scrape is a fresh database probe (amplification)',
        subject: 'lite',
        anchor: '            if (now() - lastFinishedAt >= DEEP_HEALTH_LITE_TTL_MS) {',
        replacement: '            if (true as boolean) {',
      },
      {
        id: 'L5',
        expect: 'red',
        claim: 'single-flight is removed — N concurrent scrapes become N probes',
        subject: 'lite',
        anchor: '            if (inFlight) {\n                await inFlight;',
        replacement: '            if (false as boolean) {\n                await inFlight;',
      },
      {
        id: 'L6',
        expect: 'red',
        claim: 'a failed probe keeps the PREVIOUS reading — a stale claim served as fresh',
        subject: 'lite',
        anchor:
          '            // Fail-open for the scrape, stale-free for the claim: a failed probe says nothing.\n            current = undefined;',
        replacement:
          '            // Fail-open for the scrape, stale-free for the claim: a failed probe says nothing.',
      },
      {
        id: 'L7',
        expect: 'red',
        claim:
          'idle no longer DROPS the cached reading (#2209 on the lite path) — a stale waking/down persists',
        subject: 'lite',
        anchor: '                return "";\n            }\n            if (now() - lastFinishedAt',
        replacement:
          '                return current ? render(app, current) : "";\n            }\n            if (now() - lastFinishedAt',
      },
      {
        id: 'L8',
        expect: 'red',
        claim:
          'idle forgets to clear the TTL — the first probe after traffic resumes is suppressed',
        subject: 'lite',
        anchor:
          '                lastFinishedAt = Number.NEGATIVE_INFINITY;\n                return "";',
        replacement: '                return "";',
      },
      {
        id: 'L9',
        expect: 'red',
        claim:
          'the server binds every interface — the gauge becomes reachable from outside the pod',
        subject: 'lite',
        anchor: '"127.0.0.1");',
        replacement: '"0.0.0.0");',
      },
      {
        id: 'L10',
        expect: 'red',
        claim:
          'a bind error is re-thrown — EADDRINUSE (the tracing-on path owns the port) crashes boot',
        subject: 'lite',
        anchor: '    server.on("error", () => {});',
        replacement: '    server.on("error", (e) => {\n        throw e;\n    });',
      },
      {
        id: 'L11',
        expect: 'red',
        claim: 'a scrape that throws becomes a 5xx instead of an empty 200',
        subject: 'lite',
        anchor: '        } catch {\n            body = "";\n        }',
        replacement: '        } catch (e) {\n            throw e;\n        }',
      },
      {
        id: 'L12',
        expect: 'red',
        claim:
          'the exposition drifts from the prom-client path — the HELP text diverges by one character',
        subject: 'lite',
        anchor: "Alert on overall state='waking' sustained past the wake budget.",
        replacement: "Alert on overall state='waking' sustained past the wake budget!",
      },
    ],
  },
  {
    spec: `${T}deep-health-lite-guards.test.ts`,
    mutations: [
      {
        id: 'L13',
        expect: 'red',
        claim:
          'the lite activity key diverges from the lib key — the gate never opens and no series is ever served',
        subject: 'lite',
        anchor: 'Symbol.for("knext.lib.clients.lastDbActivityAt")',
        replacement: 'Symbol.for("knext.lib.clients.lastDbActivityAtX")',
      },
      {
        id: 'G1',
        expect: 'red',
        claim:
          'lite gains a static prom-client import — the ~0.9 s class of cold-start cost returns',
        subject: 'lite',
        anchor: 'import { createServer, type Server } from "node:http";',
        replacement:
          'import { createServer, type Server } from "node:http";\nimport { Registry as _R } from "prom-client";',
      },
      {
        id: 'G2',
        expect: 'red',
        claim:
          'the lazy health import is pointed at lib/clients — the pool/cerbos/minio graph loads on the first scrape',
        subject: 'lite',
        anchor: '(() => import("@getknext/lib/health") as Promise<HealthModule>);',
        replacement: '(() => import("@getknext/lib/clients") as unknown as Promise<HealthModule>);',
      },
      {
        id: 'G3',
        expect: 'red',
        claim: 'the server is no longer unref’d — a draining pod is held open by the gauge',
        subject: 'lite',
        anchor: '    server.unref();',
        replacement: '    void server;',
      },
      {
        id: 'G4',
        expect: 'red',
        claim: 'lite gains module-level mutable state — the #352 duplicated-module class',
        subject: 'lite',
        anchor: 'const DEFAULT_DB_ACTIVITY_BUDGET_MS = 45_000;',
        replacement: 'const DEFAULT_DB_ACTIVITY_BUDGET_MS = 45_000;\nlet moduleLevelState = 0;',
      },
      {
        id: 'G5',
        expect: 'red',
        claim:
          'the LIB renames the activity key — lite reads a slot nothing writes, silently, forever',
        subject: 'libClients',
        anchor: "const DB_ACTIVITY_KEY = Symbol.for('knext.lib.clients.lastDbActivityAt');",
        replacement: "const DB_ACTIVITY_KEY = Symbol.for('knext.lib.clients.lastDbActivityAtV2');",
      },
      {
        id: 'G6',
        expect: 'red',
        claim:
          'the CLI template starts lite when tracing is ON as well — two servers race for the loopback port',
        subject: 'cliTemplate',
        options: HBS,
        anchor: '      .catch(() => {});\n    return;\n  }',
        replacement: '      .catch(() => {});\n  }',
      },
      {
        id: 'G7',
        expect: 'red',
        claim:
          'the CLI template awaits the lite start with no catch — a failing import breaks boot',
        subject: 'cliTemplate',
        options: HBS,
        anchor: '      .catch(() => {});\n    return;',
        replacement: '      ;\n    return;',
      },
    ],
  },
  {
    spec: `${T}deep-health-activity-gate.test.ts`,
    mutations: [
      {
        id: 'M1',
        expect: 'red',
        claim:
          'idle no longer drops the series on the prom-client path (#2209) — a stale waking/down keeps alerting',
        subject: 'metrics',
        anchor: '            metrics.deepHealthState.reset();',
        replacement: '            void metrics;',
      },
      {
        id: 'M2',
        expect: 'red',
        claim:
          'idle forgets to clear the TTL on the prom-client path — the series stays absent for up to 10 s after traffic resumes',
        subject: 'metrics',
        anchor:
          '            lastFinishedAt = Number.NEGATIVE_INFINITY;\n            return Promise.resolve();',
        replacement: '            return Promise.resolve();',
      },
    ],
  },
  {
    spec: `${T}adapter-edge-ignore-plugin.test.ts`,
    mutations: [
      {
        id: 'A1',
        expect: 'red',
        claim:
          'the edge fence stops covering the lite module — `next build` pulls pg/ioredis into the edge bundle',
        subject: 'adapter',
        anchor: '/(instrumentation-node|deep-health-lite)(\\.[cm]?[jt]s)?$/,',
        replacement: '/(instrumentation-node)(\\.[cm]?[jt]s)?$/,',
      },
    ],
  },
  {
    spec: `${T}instrumentation-lazy-tracing.test.ts`,
    mutations: [
      {
        id: 'I1',
        expect: 'red',
        claim:
          'the template never starts the lite gauge — a default install has no deep-health series',
        subject: 'cliTemplate',
        options: HBS,
        anchor: '      .then(({ startDeepHealthLite }) => startDeepHealthLite())',
        replacement: '      .then(() => undefined)',
      },
      {
        id: 'I2',
        expect: 'red',
        claim:
          'tracing OFF falls through to the full instrumentation — the cold-start cost the gate exists to avoid',
        subject: 'cliTemplate',
        options: HBS,
        anchor: '      .catch(() => {});\n    return;\n  }',
        replacement: '      .catch(() => {});\n  }',
      },
    ],
  },
  {
    spec: 'tests/deep-health-tracing-off-e2e-wiring.test.ts',
    mutations: [
      {
        id: 'E1',
        expect: 'red',
        claim:
          'the e2e fixture calls registerNode() directly — the tracing-off arm becomes a copy of the tracing-on arm',
        subject: 'fixtureTs',
        anchor: "import { register } from '../src/instrumentation';",
        replacement:
          "import { registerNode as register } from '../src/instrumentation-node';\nregisterNode();",
      },
      {
        id: 'E2',
        expect: 'red',
        claim: 'the e2e stops asserting the series is gone at idle',
        subject: 'assertAlert',
        anchor: 'return { ok: r.length === 0, detail: `${r.length} series still present` };',
        replacement: 'return { ok: r.length >= 0, detail: `${r.length} series still present` };',
      },
      {
        id: 'E3',
        expect: 'red',
        claim: 'the e2e hardcodes the loopback port instead of reading the pod spec',
        subject: 'assertAlert',
        anchor: '`http://127.0.0.1:${process.env.KN_CHILD_METRICS_PORT}/metrics`',
        replacement: '`http://127.0.0.1:9092/metrics`',
      },
    ],
  },
];

const ALL = GROUPS.flatMap((g) => g.mutations);

console.log('=== mutation proof: tracing-off deep-health gauge + idle drop ===');
declareMutations(ALL.length);

// One driver per spec. The subject map is written INLINE so the PR-time liveness
// audit (tests/mutation-prover-lane.test.ts) can resolve every anchor to a file.
const provers = GROUPS.map((group) => ({
  group,
  prover: createGuardProver({
    repoRoot: REPO_ROOT,
    spec: group.spec,
    subjects: {
      lite: 'packages/kn-next/src/adapters/deep-health-lite.ts',
      metrics: 'packages/kn-next/src/adapters/metrics.ts',
      adapter: 'packages/kn-next/src/adapters/next-adapter.ts',
      libClients: 'packages/lib/src/clients.ts',
      cliTemplate: 'packages/kn-next/templates/app/src/instrumentation.ts.hbs',
      fixtureTs: 'apps/file-manager/e2e-support/deep-health-alert-fixture.ts',
      assertAlert: 'scripts/deep-health-alert-e2e/assert-alert.mjs',
    },
  }),
}));

// Preflight EVERY anchor before running anything expensive (exactly once each).
provers[0].prover.preflight(ALL);

let first = true;
for (const { group, prover } of provers) {
  console.log(`\n=== ${group.spec} ===`);
  prover.baseline();
  if (first) {
    // The canary: if the harness cannot see red here, nothing below is worth reading.
    prover.proveCanSeeRed({
      subject: 'lite',
      anchor: '            if (!gateOpen()) {',
      replacement: '            if (!gateOpen() && false) {',
    });
    first = false;
  }
  for (const m of group.mutations) {
    prover.run(m);
    recordMutation();
  }
  prover.finish(group.mutations.length);
}
console.log(
  `\n${ALL.length} mutation(s) across ${GROUPS.length} spec(s): all KILLED, tree restored clean.`,
);
