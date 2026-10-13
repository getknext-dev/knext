/**
 * `knext add function <name> --lang go|rust`.
 *
 * Adds a zone function's CONTRACT to the app: the .proto file (one read RPC,
 * one write RPC, both under the function's name), the knext options contract
 * it imports, a `buf.yaml` if the app has none, and the function's entry in
 * `knext.grpc.json`. Writes files only; never touches a cluster.
 *
 * TODO(#2048, #2049): the function's own server project (Go and Rust
 * templates with the token-verifying interceptor, health RPC and image build)
 * is scaffolded by the language templates. Until they land, this command
 * records the language and writes the contract only, so it never produces a
 * server without its authentication check.
 *
 * Output is a pure function of the name and language, so the same command in
 * two apps writes identical bytes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function pascal(name: string): string {
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
  // retry it.
  rpc GetItem(GetItemRequest) returns (GetItemResponse) {
    option idempotency_level = NO_SIDE_EFFECTS;
  }

  // PutItem writes one item. A write is never retried and carries an
  // idempotency key.
  rpc PutItem(PutItemRequest) returns (PutItemResponse);
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

export interface AddFunctionOptions {
  readonly cwd: string;
  readonly name: string;
  readonly lang: string;
  readonly io: Io;
}

/** The `knext add function` verb. Returns the process exit code. */
export function addFunction({ cwd, name, lang, io }: AddFunctionOptions): number {
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

    const written: string[] = [];
    const write = (rel: string, content: string) => {
      const abs = join(cwd, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      written.push(rel);
    };
    if (!existsSync(join(cwd, 'buf.yaml'))) write('buf.yaml', BUF_YAML);
    const optionsRel = join(config.proto, 'knext', 'v1', 'options.proto');
    if (!existsSync(join(cwd, optionsRel))) write(optionsRel, packagedOptionsProto());
    write(protoRel, contractFor(name));
    write(
      CONFIG_FILE,
      serializeConfig({
        ...config,
        functions: { ...config.functions, [name]: { lang: lang as Language } },
      }),
    );

    io.stdout(
      `added the ${lang} function "${name}":\n` +
        written.map((w) => `  ${w}\n`).join('') +
        `\nThe zone reads its address from ${urlEnvFor(name)} at call time.\n` +
        'Next: edit the contract, then run `knext generate` to write the server-only client.\n',
    );
    return 0;
  } catch (err) {
    if (err instanceof GrpcUsageError) {
      io.stderr(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
