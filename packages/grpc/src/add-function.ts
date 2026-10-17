/**
 * `knext add function <name> --lang go|rust`.
 *
 * Adds a zone function's CONTRACT to the app: the .proto file (one read RPC,
 * one write RPC, both under the function's name), the knext options contract
 * it imports, a `buf.yaml` if the app has none, and the function's entry in
 * `knext.grpc.json`. Writes files only; never touches a cluster.
 *
 * For `--lang go` it also scaffolds the function's server project from
 * `templates/go` into `functions/<name>/` (see scaffold-go.ts). Rust is
 * contract-only until its template is scaffolded the same way.
 * TODO(#2489): `--lang rust` scaffolds from `templates/rust`.
 *
 * Output is a pure function of the name and language, so the same command in
 * two apps writes identical bytes.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_FILE,
  checkFunctionName,
  DEFAULT_CONFIG,
  type GrpcConfig,
  GrpcUsageError,
  LANGUAGES,
  type Language,
  loadConfig,
  serializeConfig,
  urlEnvFor,
} from './config';
import type { Io } from './generate';
import { checkModulePath, type StagedGoFunction, stageGoFunction } from './scaffold-go';

/** The options contract shipped in this package (`proto/` at the package root). */
export function packagedOptionsProto(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, '..', 'proto', 'knext', 'v1', 'options.proto'), 'utf8');
}

const BUF_YAML = `version: v2
modules:
  - path: proto
lint:
  use:
    - STANDARD
breaking:
  use:
    - FILE
`;

export function pascal(name: string): string {
  return name
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/** The scaffolded contract for a function. */
export function contractFor(name: string): string {
  const pkg = name.replaceAll('-', '_');
  const svc = `${pascal(name)}Service`;
  return `// The contract of the \`${name}\` function. Raise contract_version with every
// change, and roll out the function before the zone that calls it.
syntax = "proto3";

package ${pkg}.v1;

import "knext/v1/options.proto";

option (knext.v1.function) = "${name}";
option (knext.v1.contract_version) = "1.0.0";

// ${svc} is served by the \`${name}\` function of this zone.
service ${svc} {
  // GetItem reads one item. NO_SIDE_EFFECTS makes it a read: the zone may
  // retry it, and caches it per signed-in user. AUTH_USER: authorize() must
  // return a verified user first.
  rpc GetItem(GetItemRequest) returns (GetItemResponse) {
    option idempotency_level = NO_SIDE_EFFECTS;
    option (knext.v1.auth) = AUTH_USER;
  }

  // PutItem writes one item. A write is never retried, carries an
  // idempotency key, and always needs a user (AUTH_USER).
  rpc PutItem(PutItemRequest) returns (PutItemResponse) {
    option (knext.v1.auth) = AUTH_USER;
  }
}

// GetItemRequest names the item to read.
message GetItemRequest {
  string id = 1;
}

// GetItemResponse is one item.
message GetItemResponse {
  string id = 1;
  string value = 2;
}

// PutItemRequest is the item to write.
message PutItemRequest {
  string id = 1;
  string value = 2;
}

// PutItemResponse confirms the write.
message PutItemResponse {}
`;
}

/** Where `knext add function` puts the authorize() hook when the app has none. */
export const DEFAULT_AUTHORIZE = 'src/knext/authorize.ts';

/** The scaffolded authorize() hook: it refuses every call until it is written. */
export const AUTHORIZE_STUB = `import type { AuthorizeContext, Principal } from '@getknext/grpc/runtime';

/**
 * Who is calling? Every generated query, action and stream for an AUTH_USER
 * RPC calls this first, outside any cache. Return the signed-in user's stable
 * id from your own session (a cookie, a header) as { sub }, or throw (a
 * redirect to sign-in, an error) to refuse the call.
 *
 * For an anonymous write (sign-up, a contact form), run your own check first
 * (CAPTCHA, rate limit, CSRF), and only then return an anonymous principal.
 *
 * Until you write it, every call is refused.
 */
export async function authorize(ctx: AuthorizeContext): Promise<Principal> {
  throw new Error(\`authorize() is not written yet: refusing \${ctx.service}.\${ctx.method}\`);
}
`;

export interface AddFunctionOptions {
  readonly cwd: string;
  readonly name: string;
  readonly lang: string;
  /** Go module path for `--lang go` (default `example.com/<name>`). */
  readonly module?: string;
  readonly io: Io;
  /** Test seam: the Go template to scaffold from (default: the resolved one). */
  readonly templateDir?: string;
  /** Test seam: replaces `buf generate` over the staged Go project. */
  readonly generate?: (stageDir: string) => void;
  /** Test seam: false writes the contract only, as `--lang rust` does (default true). */
  readonly serverProject?: boolean;
  /** Test seam: called before each step; a throw there simulates that step failing. */
  readonly onStep?: (step: string) => void;
}

/** The `knext add function` verb. Returns the process exit code. */
export function addFunction({
  cwd,
  name,
  lang,
  module,
  io,
  templateDir,
  generate,
  serverProject = true,
  onStep,
}: AddFunctionOptions): number {
  // Every write is undone if a later one fails, so a rerun starts from the same
  // tree. `undo` runs newest-first.
  const undo: Array<() => void> = [];
  let staged: StagedGoFunction | undefined;
  try {
    const nameProblem = checkFunctionName(name);
    if (nameProblem) throw new GrpcUsageError(nameProblem);
    if (!LANGUAGES.includes(lang as Language)) {
      throw new GrpcUsageError(`--lang must be one of: ${LANGUAGES.join(', ')} (got "${lang}")`);
    }

    const config: GrpcConfig = existsSync(join(cwd, CONFIG_FILE))
      ? loadConfig(cwd)
      : DEFAULT_CONFIG;
    const pkg = name.replaceAll('-', '_');
    const protoRel = join(config.proto, pkg, 'v1', `${pkg}.proto`);
    if (config.functions[name] || existsSync(join(cwd, protoRel))) {
      throw new GrpcUsageError(
        `function "${name}" already exists (${protoRel}); nothing was changed`,
      );
    }

    const fnDirRel = join('functions', name);
    const goModule = module ?? `example.com/${name}`;
    if (lang === 'go') {
      const moduleProblem = checkModulePath(goModule);
      if (moduleProblem) throw new GrpcUsageError(moduleProblem);
      if (existsSync(join(cwd, fnDirRel))) {
        throw new GrpcUsageError(
          `function "${name}" already exists (${fnDirRel}); nothing was changed`,
        );
      }
    } else if (module !== undefined) {
      throw new GrpcUsageError('--module applies to --lang go only');
    }

    const written: string[] = [];
    const step = (label: string) => onStep?.(label);
    const write = (rel: string, content: string) => {
      step(rel);
      const abs = join(cwd, rel);
      const prior = existsSync(abs) ? readFileSync(abs) : undefined;
      const firstCreated = mkdirSync(dirname(abs), { recursive: true });
      undo.push(() => {
        if (prior !== undefined) writeFileSync(abs, prior);
        else rmSync(abs, { force: true });
        if (firstCreated) rmSync(firstCreated, { recursive: true, force: true });
      });
      writeFileSync(abs, content);
      written.push(rel);
    };
    if (lang === 'go' && serverProject) {
      // Staged first (a failed code generation writes nothing), installed last.
      step('stage');
      staged = stageGoFunction(
        {
          name,
          pkg,
          service: `${pascal(name)}Service`,
          module: goModule,
          contract: contractFor(name),
          options: packagedOptionsProto(),
        },
        templateDir,
        generate,
      );
    }
    if (!existsSync(join(cwd, 'buf.yaml'))) write('buf.yaml', BUF_YAML);
    const optionsRel = join(config.proto, 'knext', 'v1', 'options.proto');
    if (!existsSync(join(cwd, optionsRel))) write(optionsRel, packagedOptionsProto());
    write(protoRel, contractFor(name));
    const authorize = config.authorize ?? DEFAULT_AUTHORIZE;
    if (!existsSync(join(cwd, authorize))) write(authorize, AUTHORIZE_STUB);
    write(
      CONFIG_FILE,
      serializeConfig({
        ...config,
        authorize,
        functions: { ...config.functions, [name]: { lang: lang as Language } },
      }),
    );
    if (staged) {
      step('install');
      const target = join(cwd, fnDirRel);
      const functionsDir = join(cwd, 'functions');
      const removeOnFailure = existsSync(functionsDir) ? target : functionsDir;
      undo.push(() => rmSync(removeOnFailure, { recursive: true, force: true }));
      staged.install(target);
      for (const f of staged.files) written.push(join(fnDirRel, f));
    }

    io.stdout(
      `added the ${lang} function "${name}":\n` +
        written.map((w) => `  ${w}\n`).join('') +
        `\nThe zone reads its address from ${urlEnvFor(name)} at call time.\n` +
        `Next: write authorize() in ${authorize} (until then every call is refused), edit the\n` +
        'contract, then run `knext generate` to write the server-only client and glue.\n',
    );
    return 0;
  } catch (err) {
    for (const u of undo.reverse()) {
      try {
        u();
      } catch {
        // Best effort: the original error is the one to report.
      }
    }
    if (err instanceof GrpcUsageError) {
      io.stderr(`${err.message}\n`);
      return 1;
    }
    throw err;
  } finally {
    staged?.dispose();
  }
}
