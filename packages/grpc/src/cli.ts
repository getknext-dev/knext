/**
 * The verbs `@getknext/grpc` adds to the `knext` CLI: `knext generate` and
 * `knext add function`.
 *
 * Core (`@getknext/core`) owns the `knext` bin and only lazily loads this
 * module when one of these verbs is typed; core never imports it eagerly and
 * does not depend on it. Before calling {@link run}, core checks
 * {@link DISPATCH_PROTOCOL} and that its own version is inside
 * {@link CORE_PEER_RANGE}, and names both versions if not.
 */

import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { addFunction } from './add-function';
import { DEPLOY_USAGE, type DeployHost, deployFunction } from './deploy-function';
import { type Io, runGenerate } from './generate';

/** The shape of this module as core calls it. Bumped only on a breaking change to it. */
export const DISPATCH_PROTOCOL = 1;

const manifest = createRequire(import.meta.url)('../package.json') as {
  version: string;
  peerDependencies: Record<string, string>;
};

export const GRPC_VERSION: string = manifest.version;
/** The `@getknext/core` versions this package works with (its peer range). */
export const CORE_PEER_RANGE: string = manifest.peerDependencies['@getknext/core'] as string;

export const VERBS = ['generate', 'add', 'deploy'] as const;

const GENERATE_HELP = `knext generate — write the server-only clients for this zone's functions (Beta)

Usage: knext generate [--check] [--against <baseline>]

Reads knext.grpc.json and the .proto contracts of the buf workspace in the
current directory, runs buf lint, and writes TypeScript to the configured
output directory. Every generated client has a call deadline shorter than the
gateway timeout, retries only side-effect-free reads, and requires an
idempotency key on every write.

Options:
  --check               compare instead of writing; fail if the generated code is out of date
  --against <baseline>  also run buf breaking against a baseline: a directory, an image file,
                        or a git reference such as ".git#branch=main,subdir=proto"
  -h, --help            show this help

Exit code: 0 on success; 1 on a lint failure, a breaking change, out-of-date
generated code (with --check), or a usage error.`;

const ADD_HELP = `knext add function — add a function's contract to this zone (Beta)

Usage: knext add function <name> --lang go|rust [--module <go-module-path>]

For --lang go it also copies the Go function template to functions/<name>/ (the
token-verifying server, health check and Dockerfile), renamed to the function
and with its Go code generated; this needs the Go toolchain on PATH.

Writes proto/<name>/v1/<name>.proto (one read and one write RPC to start
from), the knext options contract it imports, a buf.yaml if there is none, and
the function's entry in knext.grpc.json. Writes files only; nothing is
deployed. The name is a lowercase DNS label; the zone reaches the function
through <NAME>_SERVICE_URL.

Options:
  --lang <go|rust>  the language the function is written in
  --module <path>   the Go module path of the server (--lang go; default example.com/<name>)
  -h, --help        show this help

Exit code: 0 on success; 1 if the function already exists or on a usage error.`;

const DEPLOY_HELP = `knext deploy function — apply a function's BackendService to the cluster (Beta)

Usage: knext deploy function <name> --zone <nextapp> --image <ref@sha256:digest> [options]

Builds the function's BackendService resource and applies it. The image must
already be built and pushed, pinned by digest (a tag-only reference and :latest
are refused). The function's language comes from knext.grpc.json. Nothing here
builds an image or runs Knative's own tools; the operator reconciles the rest.

Before anything changes, a server-side dry-run checks the resource under strict
validation. If the cluster's CRD does not know a field this CLI emits, the run
stops and names the field (upgrade the operator first). The apply itself then
carries --validate=strict.

The zone's consent is its own: the NextApp lists this function in spec.backends
(service: <name>) or the operator renders nothing for it.

Options:
  --zone <nextapp>             the NextApp in this namespace that owns the function (required)
  --image <ref@sha256:digest>  the function's image, pinned by digest (required)
  --namespace <ns>             namespace (default: $KN_NAMESPACE, else "default")
  --context <ctx>              kubectl context (default: $KN_CONTEXT, else the current one)
  --port <n>                   the h2c port the function serves (operator default 8080)
  --proto-version <x.y.z>      the contract version this image serves
  --no-wake-ahead              do not wake this function when the zone starts
  --min-scale <n>              warm floor (default 0, scale to zero)
  --max-scale <n>              fan-out cap (0 = the Knative default)
  --container-concurrency <n>  concurrent requests per pod (0 = unlimited)
  --dry-run                    print the resource and apply nothing
  -h, --help                   show this help

Exit code: 0 on success; 1 on a usage error, a failed preflight, or a failed apply.`;

const ADD_USAGE = 'Usage: knext add function <name> --lang go|rust';

export function helpText(verb: string): string {
  if (verb === 'add') return ADD_HELP;
  return verb === 'deploy' ? DEPLOY_HELP : GENERATE_HELP;
}

export interface RunIo extends Io {
  readonly cwd?: string;
  /** The cluster seam `knext deploy function` needs; core supplies it. */
  readonly host?: DeployHost;
}

const defaultIo: Io = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

/** Run a verb. Returns the process exit code; never calls `process.exit`. */
export async function run(
  verb: string,
  argv: readonly string[],
  io: Partial<RunIo> = {},
): Promise<number> {
  const out: Io = { stdout: io.stdout ?? defaultIo.stdout, stderr: io.stderr ?? defaultIo.stderr };
  const cwd = io.cwd ?? process.cwd();

  if (verb !== 'generate' && verb !== 'add' && verb !== 'deploy') {
    out.stderr(`@getknext/grpc does not provide the "${verb}" command\n`);
    return 1;
  }
  if (wantsHelp(argv)) {
    out.stdout(`${helpText(verb)}\n`);
    return 0;
  }

  if (verb === 'deploy') {
    if (argv[0] !== 'function') {
      out.stderr(`${DEPLOY_USAGE}\nRun \`knext deploy function --help\` for usage.\n`);
      return 1;
    }
    return deployFunction({ cwd, argv, io: out, host: io.host });
  }

  if (verb === 'generate') {
    let values: { check?: boolean; against?: string };
    try {
      ({ values } = parseArgs({
        args: [...argv],
        options: { check: { type: 'boolean' }, against: { type: 'string' } },
        allowPositionals: false,
        strict: true,
      }));
    } catch (err) {
      const msg = (err as Error).message.replace(/^Unexpected argument/, 'unexpected argument');
      out.stderr(`knext generate: ${msg}\nRun \`knext generate --help\` for usage.\n`);
      return 1;
    }
    return runGenerate({ cwd, check: values.check, against: values.against, io: out });
  }

  let parsed: { values: { lang?: string; module?: string }; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { lang: { type: 'string' }, module: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    out.stderr(`knext add: ${(err as Error).message}\nRun \`knext add --help\` for usage.\n`);
    return 1;
  }
  const [noun, name, ...extra] = parsed.positionals;
  if (noun !== 'function' || !name || extra.length > 0 || !parsed.values.lang) {
    out.stderr(`${ADD_USAGE}\nRun \`knext add --help\` for usage.\n`);
    return 1;
  }
  return addFunction({
    cwd,
    name,
    lang: parsed.values.lang,
    module: parsed.values.module,
    io: out,
  });
}
