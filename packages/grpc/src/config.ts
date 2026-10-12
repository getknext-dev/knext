/**
 * `knext.grpc.json` — the zone's function settings, owned by this package
 * (not by `knext.config.ts`, which belongs to core).
 *
 * `knext add function` creates and updates it; `knext generate` reads it, so
 * a `--check` run uses exactly the settings the last generate used.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DEADLINE_MS, DEFAULT_GATEWAY_TIMEOUT_SECONDS } from './policy';

export const CONFIG_FILE = 'knext.grpc.json';

export const LANGUAGES = ['go', 'rust'] as const;
export type Language = (typeof LANGUAGES)[number];

export interface FunctionEntry {
  readonly lang: Language;
}

export interface GrpcConfig {
  /** Directory holding the .proto contracts (also the buf module path). */
  readonly proto: string;
  /** Directory the generated TypeScript is written to. */
  readonly out: string;
  /** Per-call deadline for every generated client. */
  readonly deadlineMs: number;
  /** The zone's gateway (request) timeout; the deadline must be shorter. */
  readonly gatewayTimeoutSeconds: number;
  readonly functions: Readonly<Record<string, FunctionEntry>>;
}

export const DEFAULT_CONFIG: GrpcConfig = {
  proto: 'proto',
  out: 'src/generated/grpc',
  deadlineMs: DEFAULT_DEADLINE_MS,
  gatewayTimeoutSeconds: DEFAULT_GATEWAY_TIMEOUT_SECONDS,
  functions: {},
};

/** A usage-class failure: printed as a plain message, exit 1. */
export class GrpcUsageError extends Error {
  override name = 'GrpcUsageError';
}

const KEYS = new Set(Object.keys(DEFAULT_CONFIG));

/**
 * A function name is a lowercase DNS label (it names a Kubernetes object and
 * the `<NAME>_SERVICE_URL` binding). Returns the problem, or `undefined`.
 */
export function checkFunctionName(name: string): string | undefined {
  if (!/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    return (
      `"${name}" is not a valid function name: use lowercase letters, digits and '-', ` +
      "starting with a letter and not ending with '-' (at most 63 characters)"
    );
  }
  return undefined;
}

/** `user-profile` -> `USER_PROFILE_SERVICE_URL`. */
export function urlEnvFor(functionName: string): string {
  return `${functionName.toUpperCase().replaceAll('-', '_')}_SERVICE_URL`;
}

function relativeDir(key: string, value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.startsWith('/') || value.includes('..')) {
    throw new GrpcUsageError(
      `${CONFIG_FILE}: "${key}" must be a relative directory inside the app`,
    );
  }
  return value;
}

/** Validate parsed JSON into a config, filling defaults. */
export function parseConfig(raw: unknown): GrpcConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new GrpcUsageError(`${CONFIG_FILE} must hold a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KEYS.has(key)) throw new GrpcUsageError(`${CONFIG_FILE}: unknown setting "${key}"`);
  }
  const functions: Record<string, FunctionEntry> = {};
  const rawFns = obj.functions ?? {};
  if (typeof rawFns !== 'object' || rawFns === null || Array.isArray(rawFns)) {
    throw new GrpcUsageError(`${CONFIG_FILE}: "functions" must be an object`);
  }
  for (const [name, entry] of Object.entries(rawFns as Record<string, unknown>)) {
    const problem = checkFunctionName(name);
    if (problem) throw new GrpcUsageError(`${CONFIG_FILE}: ${problem}`);
    const lang = (entry as { lang?: unknown } | null)?.lang;
    if (!LANGUAGES.includes(lang as Language)) {
      throw new GrpcUsageError(
        `${CONFIG_FILE}: function "${name}" needs "lang": one of ${LANGUAGES.join(', ')}`,
      );
    }
    functions[name] = { lang: lang as Language };
  }
  const num = (key: 'deadlineMs' | 'gatewayTimeoutSeconds'): number => {
    const v = obj[key] ?? DEFAULT_CONFIG[key];
    if (typeof v !== 'number')
      throw new GrpcUsageError(`${CONFIG_FILE}: "${key}" must be a number`);
    return v;
  };
  return {
    proto: relativeDir('proto', obj.proto ?? DEFAULT_CONFIG.proto),
    out: relativeDir('out', obj.out ?? DEFAULT_CONFIG.out),
    deadlineMs: num('deadlineMs'),
    gatewayTimeoutSeconds: num('gatewayTimeoutSeconds'),
    functions,
  };
}

/** Read `knext.grpc.json` from `cwd`. */
export function loadConfig(cwd: string): GrpcConfig {
  const path = join(cwd, CONFIG_FILE);
  if (!existsSync(path)) {
    throw new GrpcUsageError(
      `no ${CONFIG_FILE} in ${cwd}. Run \`knext add function <name> --lang go|rust\` first.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new GrpcUsageError(`${CONFIG_FILE} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}

/** Stable serialisation: fixed key order, functions sorted, trailing newline. */
export function serializeConfig(config: GrpcConfig): string {
  const functions = Object.fromEntries(
    Object.keys(config.functions)
      .sort()
      .map((name) => [name, { lang: config.functions[name]?.lang }]),
  );
  return `${JSON.stringify(
    {
      proto: config.proto,
      out: config.out,
      deadlineMs: config.deadlineMs,
      gatewayTimeoutSeconds: config.gatewayTimeoutSeconds,
      functions,
    },
    null,
    2,
  )}\n`;
}
