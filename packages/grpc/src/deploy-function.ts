/**
 * `knext deploy function` — build the function's `BackendService` CR and apply
 * it, the same way core applies a `NextApp` (ADR-0052 D3, amended).
 *
 *   1. build the CR from the flags and `knext.grpc.json` (pure, validated);
 *   2. write it to `.output/`;
 *   3. PREFLIGHT: a server-side `--dry-run=server --validate=strict` apply
 *      (core's `preflightCRSchema`), before the cluster is touched. Anything
 *      but an `ok` verdict stops here;
 *   4. APPLY: core runs `kubectl apply --validate=strict`, so the guarantee that
 *      an unknown field is rejected rather than silently pruned is knext's,
 *      not the user's kubectl default.
 *
 * Core owns the kubectl boundary (the argv, context binding, stdio, the
 * preflight itself) and hands this package a {@link DeployHost} with two
 * methods, `preflight` and `apply`. There is no way to run another program
 * through it. This package never imports core (ADR-0052 D8) and never spawns a
 * process itself.
 *
 * The deploy path never runs Knative's `func` or `kn` tools: `func` emits an
 * image only, and the operator is the single reconciler of cluster state
 * (`tests/cli-spawn-scan.test.ts` scans for it).
 *
 * It writes ONE kind, `BackendService`. It does not build or push the image
 * (`func build` produced it), and it does not touch the zone's `NextApp`: the
 * zone's consent is its own `spec.backends` entry.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildBackendServiceCR, renderBackendServiceCR } from './backend-service';
import { GrpcUsageError, loadConfig } from './config';
import type { Io } from './generate';

/** What core's server-side preflight tells us. A subset of its `PreflightOutcome`. */
export interface PreflightResult {
  readonly verdict: 'ok' | 'skew' | 'blocked';
  readonly reason: string;
  /** Fields the installed CRD does not know, when the apiserver named them. */
  readonly unknownFields: readonly string[];
  readonly stderr: string;
}

/** The cluster-facing seam, supplied by `@getknext/core`. */
export interface DeployHost {
  /** Server-side dry-run of the CR file under strict validation. Never throws. */
  preflight(args: {
    readonly crPath: string;
    readonly namespace: string;
    readonly context?: string;
  }): PreflightResult;
  /**
   * Apply the CR file. Core builds the argv (`kubectl apply --validate=strict`)
   * and runs it, so this package cannot run any other program through the seam.
   * Inherits stdio; throws on a non-zero exit.
   */
  apply(args: {
    readonly crPath: string;
    readonly namespace: string;
    readonly context?: string;
  }): void;
}

export const DEPLOY_USAGE =
  'Usage: knext deploy function <name> --zone <nextapp> --image <ref@sha256:digest>';

function firstLine(s: string): string {
  return (s.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 200);
}

const UPGRADE_ORDER =
  'Upgrade order is load-bearing: upgrade the operator (and its CRDs) first, then the CLI.';

/** The user-facing text for a preflight that did not return `ok`. */
export function formatPreflightFailure(outcome: PreflightResult): string {
  const tail = 'Nothing was applied — this ran before any change to the cluster.';
  if (outcome.reason === 'unknown-field') {
    const fields = outcome.unknownFields.length
      ? outcome.unknownFields.map((f) => `  - ${f}`).join('\n')
      : '  (the apiserver did not name the field)';
    return (
      'PREFLIGHT FAILED: the BackendService CRD installed on this cluster does not know ' +
      `field(s) this CLI emits, so the resource would be rejected (or silently pruned):\n${fields}\n` +
      `${UPGRADE_ORDER}\n${tail}\n` +
      '  kubectl get crd backendservices.apps.kn-next.dev\n  knext doctor'
    );
  }
  if (outcome.reason === 'invalid-file') {
    return (
      'PREFLIGHT FAILED: core refused the BackendService file before contacting the cluster:\n' +
      `${firstLine(outcome.stderr)}\n${tail}`
    );
  }
  if (outcome.reason === 'client-too-old') {
    return (
      'PREFLIGHT FAILED: your kubectl is older than v1.25, where `--validate=strict` does not ' +
      'exist, so knext cannot guarantee an unknown BackendService field is rejected rather than pruned. ' +
      `Upgrade kubectl to v1.25 or newer, then re-run.\n${tail}`
    );
  }
  if (outcome.reason === 'webhook-unavailable') {
    return (
      'PREFLIGHT FAILED: an admission webhook for the BackendService could not be reached. ' +
      'This is an availability problem, not CLI/operator skew.\n' +
      `kubectl said: ${firstLine(outcome.stderr)}\n${tail}\n  knext doctor`
    );
  }
  return (
    'PREFLIGHT FAILED: the server-side dry-run of the BackendService did not complete, so knext ' +
    'cannot say whether this cluster would store it intact. It needs the same permission as the ' +
    '`create`/`patch` on backendservices the apply needs. Is the BackendService CRD installed ' +
    '(operator Z8 or newer)?\n' +
    `kubectl said: ${firstLine(outcome.stderr)}\n${tail}\n  knext doctor`
  );
}

export interface DeployFunctionArgs {
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly io: Io;
  readonly host: DeployHost | undefined;
}

function intFlag(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^-?\d+(\.\d+)?$/.test(value.trim())) {
    throw new GrpcUsageError(`--${flag} must be a whole number, got "${value}"`);
  }
  return Number(value);
}

/** Run `knext deploy function`. Returns the exit code; never calls `process.exit`. */
export async function deployFunction(args: DeployFunctionArgs): Promise<number> {
  const { cwd, io, host } = args;
  try {
    const parsed = parseArgs({
      args: [...args.argv],
      options: {
        zone: { type: 'string' },
        image: { type: 'string' },
        namespace: { type: 'string' },
        context: { type: 'string' },
        port: { type: 'string' },
        'proto-version': { type: 'string' },
        'min-scale': { type: 'string' },
        'max-scale': { type: 'string' },
        'container-concurrency': { type: 'string' },
        'no-wake-ahead': { type: 'boolean' },
        'dry-run': { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
    });
    const [noun, name, ...extra] = parsed.positionals;
    const v = parsed.values;
    if (noun !== 'function' || !name || extra.length > 0 || !v.zone || !v.image) {
      io.stderr(`${DEPLOY_USAGE}\nRun \`knext deploy function --help\` for usage.\n`);
      return 1;
    }

    const config = loadConfig(cwd);
    const entry = config.functions[name];
    if (!entry) {
      throw new GrpcUsageError(
        `no function "${name}" in knext.grpc.json. Run \`knext add function ${name} --lang go|rust\` first.`,
      );
    }

    const namespace = v.namespace || process.env.KN_NAMESPACE || 'default';
    const context = v.context || process.env.KN_CONTEXT || undefined;
    const minScale = intFlag('min-scale', v['min-scale']);
    const maxScale = intFlag('max-scale', v['max-scale']);
    const containerConcurrency = intFlag('container-concurrency', v['container-concurrency']);
    const cr = buildBackendServiceCR({
      name,
      namespace,
      zone: v.zone,
      image: v.image,
      language: entry.lang,
      port: intFlag('port', v.port),
      protoVersion: v['proto-version'],
      ...(v['no-wake-ahead'] ? { wakeAhead: false } : {}),
      ...(minScale === undefined && maxScale === undefined && containerConcurrency === undefined
        ? {}
        : {
            scaling: {
              ...(minScale === undefined ? {} : { minScale }),
              ...(maxScale === undefined ? {} : { maxScale }),
              ...(containerConcurrency === undefined ? {} : { containerConcurrency }),
            },
          }),
    });
    const text = renderBackendServiceCR(cr);

    // Like `knext deploy --dry-run`: stdout carries only the resource, so it
    // pipes into `kubectl apply -f -`. No cluster, no file.
    if (v['dry-run']) {
      io.stdout(text);
      return 0;
    }
    if (!host) {
      io.stderr(
        'knext deploy function must be run through @getknext/core, which supplies the cluster ' +
          'access. Run it as `knext deploy function ...` with @getknext/core installed.\n',
      );
      return 1;
    }

    const outDir = join(cwd, '.output');
    mkdirSync(outDir, { recursive: true });
    const crPath = join(outDir, `backendservice-${name}.json`);
    writeFileSync(crPath, text, 'utf-8');

    // 1. Preflight, before the cluster is touched.
    const outcome = host.preflight({ crPath, namespace, context });
    if (outcome.verdict !== 'ok') {
      io.stderr(`${formatPreflightFailure(outcome)}\n`);
      return 1;
    }

    // 2. Apply. Core builds the argv, with `--validate=strict` passed
    // explicitly rather than inherited from whatever kubectl is on PATH.
    try {
      host.apply({ crPath, namespace, context });
    } catch (err) {
      io.stderr(
        `kubectl apply of the BackendService FAILED (kubectl's own error, if it ran, is printed above): ` +
          `${(err as Error).message}\n` +
          'The preflight passed, so this is not field skew; check permissions and that the ' +
          'zone exists in the namespace.\n',
      );
      return 1;
    }
    // The zone's half of the binding. Its optional `image` pins the digest of
    // the image just applied (digest only: the registry path may move, the
    // content may not), so a later swap of spec.image by anyone with `update`
    // on backendservices is refused instead of inheriting the zone's database
    // Secret. Core's schema, the CRD and the operator agree on this shape.
    const pin = `@${v.image.slice(v.image.lastIndexOf('@') + 1)}`;
    io.stdout(
      `BackendService ${namespace}/${name} applied. The function runs once the zone lists it. ` +
        'Add this entry to `backends` in knext.config.ts and run `knext deploy`, ' +
        'then the operator reconciles both halves:\n' +
        `  { name: '${name}', image: '${pin}' }\n` +
        'The `image` field pins the image the zone binds: if the BackendService image ever ' +
        'changes without the zone changing the pin too, the function is refused and nothing is ' +
        'mounted into it. Leave `image` out to keep the name-only binding. After you deploy a new ' +
        'function image, update the pin in the same step.\n',
    );
    return 0;
  } catch (err) {
    if (err instanceof GrpcUsageError) {
      io.stderr(`knext deploy function: ${err.message}\n`);
      return 1;
    }
    const e = err as Error & { code?: string };
    if (e.code?.startsWith('ERR_PARSE_ARGS')) {
      io.stderr(
        `knext deploy function: ${e.message}\nRun \`knext deploy function --help\` for usage.\n`,
      );
      return 1;
    }
    throw err;
  }
}
