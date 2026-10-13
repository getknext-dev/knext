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

export const VERBS = ['generate', 'add'] as const;

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

Usage: knext add function <name> --lang go|rust

Writes proto/<name>/v1/<name>.proto (one read and one write RPC to start
from), the knext options contract it imports, a buf.yaml if there is none, and
the function's entry in knext.grpc.json. Writes files only; nothing is
deployed. The name is a lowercase DNS label; the zone reaches the function
through <NAME>_SERVICE_URL.

Options:
  --lang <go|rust>  the language the function is written in
  -h, --help        show this help

Exit code: 0 on success; 1 if the function already exists or on a usage error.`;

const ADD_USAGE = 'Usage: knext add function <name> --lang go|rust';

export function helpText(verb: string): string {
  return verb === 'add' ? ADD_HELP : GENERATE_HELP;
}

export interface RunIo extends Io {
  readonly cwd?: string;
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

  if (verb !== 'generate' && verb !== 'add') {
    out.stderr(`@getknext/grpc does not provide the "${verb}" command\n`);
    return 1;
  }
  if (wantsHelp(argv)) {
    out.stdout(`${helpText(verb)}\n`);
    return 0;
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

  let parsed: { values: { lang?: string }; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { lang: { type: 'string' } },
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
  return addFunction({ cwd, name, lang: parsed.values.lang, io: out });
}
