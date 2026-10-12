/**
 * `protoc-gen-knext` — the code generator for a zone's server-only function
 * clients. For every .proto file that declares a service it writes
 * `<file>_knext.ts` next to protoc-gen-es's `<file>_pb.ts`: one
 * `defineFunctionClient(...)` per service, carrying the client policy
 * (see `policy.ts`) as data the runtime enforces.
 *
 * The output is a pure function of the contract and two parameters
 * (`deadline_ms`, `gateway_timeout_ms`): no clock, no paths, no package
 * version. The header names a FORMAT version (`v1`) rather than this
 * package's version, so releasing the package does not churn every app's
 * generated files; the format version changes only when the output does.
 *
 * Mapping RPCs onto Next.js shapes (cached reads, Server Actions, streaming
 * handlers) is a separate generator built on top of these clients.
 */

import { type DescExtension, type DescFile, getOption } from '@bufbuild/protobuf';
import { createEcmaScriptPlugin, type Schema } from '@bufbuild/protoplugin';
import { checkFunctionName, urlEnvFor } from './config';
import { checkBudget, methodKind, READ_MAX_ATTEMPTS } from './policy';
import { parseVersion } from './semver';

export const PLUGIN_NAME = 'protoc-gen-knext';
/** The generated-output format version (not the package version). */
export const FORMAT_VERSION = 'v1';

/** Module the generated clients import their runtime from. */
export const RUNTIME_MODULE = '@getknext/grpc/runtime';

export interface KnextPluginOptions {
  readonly deadlineMs: number;
  readonly gatewayTimeoutMs: number;
}

function parseOptions(raw: { key: string; value: string }[]): KnextPluginOptions {
  let deadlineMs: number | undefined;
  let gatewayTimeoutMs: number | undefined;
  for (const { key, value } of raw) {
    if (key === 'deadline_ms') deadlineMs = Number(value);
    else if (key === 'gateway_timeout_ms') gatewayTimeoutMs = Number(value);
    else throw new Error(`${PLUGIN_NAME}: unknown option "${key}"`);
  }
  if (deadlineMs === undefined || gatewayTimeoutMs === undefined) {
    throw new Error(`${PLUGIN_NAME}: deadline_ms and gateway_timeout_ms are required`);
  }
  const problem = checkBudget(deadlineMs, gatewayTimeoutMs);
  if (problem) throw new Error(problem);
  return { deadlineMs, gatewayTimeoutMs };
}

function findExtension(
  schema: Schema<KnextPluginOptions>,
  typeName: string,
): DescExtension | undefined {
  for (const file of schema.allFiles) {
    const ext = file.extensions.find((e) => e.typeName === typeName);
    if (ext) return ext;
  }
  return undefined;
}

function stringOption(file: DescFile, ext: DescExtension | undefined): string | undefined {
  if (!ext) return undefined;
  const value = getOption(file, ext as DescExtension & { fieldKind: 'scalar' });
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function generateTs(schema: Schema<KnextPluginOptions>): void {
  const functionExt = findExtension(schema, 'knext.v1.function');
  const versionExt = findExtension(schema, 'knext.v1.contract_version');
  const { deadlineMs, gatewayTimeoutMs } = schema.options;

  for (const file of schema.files) {
    if (file.services.length === 0) continue;
    const fn = stringOption(file, functionExt);
    const version = stringOption(file, versionExt);
    if (!fn) {
      throw new Error(
        `${file.name}: a file with services must name its function with ` +
          '`option (knext.v1.function) = "<name>";` (import "knext/v1/options.proto")',
      );
    }
    const nameProblem = checkFunctionName(fn);
    if (nameProblem) throw new Error(`${file.name}: ${nameProblem}`);
    if (!version || !parseVersion(version)) {
      throw new Error(
        `${file.name}: a file with services must state its contract version as ` +
          '`option (knext.v1.contract_version) = "MAJOR.MINOR.PATCH";`',
      );
    }

    const f = schema.generateFile(`${file.name}_knext.ts`);
    f.preamble(file);
    const define = f.import('defineFunctionClient', RUNTIME_MODULE);
    f.print('import "server-only";');
    f.print();
    for (const service of file.services) {
      f.print(
        f.jsDoc(
          [
            `Server-only client for ${service.typeName}, served by the \`${fn}\` function.`,
            '',
            `Every call has a ${deadlineMs} ms deadline, inside the zone's ${gatewayTimeoutMs} ms`,
            'gateway timeout. Only side-effect-free reads are retried; writes are never',
            'retried and need an idempotency key. The endpoint is read from',
            `${urlEnvFor(fn)} at call time. The function must serve contract ${version}`,
            'or newer: roll out the function first, then the zone.',
          ].join('\n'),
        ),
      );
      f.print('export const ', lowerFirst(service.name), 'Client = ', define, '({');
      f.print('  service: ', f.importSchema(service), ',');
      f.print('  function: ', f.string(fn), ',');
      f.print('  urlEnv: ', f.string(urlEnvFor(fn)), ',');
      f.print('  contractVersion: ', f.string(version), ',');
      f.print('  deadlineMs: ', String(deadlineMs), ',');
      f.print('  gatewayTimeoutMs: ', String(gatewayTimeoutMs), ',');
      f.print('  methods: {');
      for (const method of service.methods) {
        const kind = methodKind(method);
        const policy =
          kind === 'read'
            ? `{ kind: "read", retry: { maxAttempts: ${READ_MAX_ATTEMPTS} } }`
            : kind === 'mutation'
              ? '{ kind: "mutation", idempotencyKey: "required" }'
              : '{ kind: "stream" }';
        f.print('    ', method.localName, ': ', policy, ',');
      }
      f.print('  },');
      f.print('});');
      f.print();
    }
  }
}

export const knextClientPlugin = createEcmaScriptPlugin<KnextPluginOptions>({
  name: PLUGIN_NAME,
  version: FORMAT_VERSION,
  parseOptions,
  generateTs,
});
