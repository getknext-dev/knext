/**
 * `knext.ffi.json` — the zone's in-process Rust settings (ADR-0069 D11), owned
 * by this package. Its existence opts the app in; core only checks that the
 * file exists and never parses it.
 *
 * ```json
 * { "version": 1, "crate": "rust", "out": "src/generated/ffi" }
 * ```
 *
 * The build target triples are deliberately not configured here: they follow
 * the image arch `knext build` is building (D14).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

export const CONFIG_FILE = 'knext.ffi.json';

export interface FfiConfig {
  readonly version: 1;
  /** The Rust crate directory, relative to the app root. */
  readonly crate: string;
  /** The generated-module directory, relative to the app root. */
  readonly out: string;
}

export const DEFAULT_CONFIG: FfiConfig = { version: 1, crate: 'rust', out: 'src/generated/ffi' };

/** A usage-class failure: printed as a plain message, exit 1. */
export class FfiUsageError extends Error {
  override name = 'FfiUsageError';
}

const KEYS = new Set(Object.keys(DEFAULT_CONFIG));

/**
 * A real subdirectory of the app: not the app root itself (`.`, `./`,
 * `src/..`), nothing outside it, nothing in or under `node_modules` (in any
 * case: on a case-insensitive file system `NODE_MODULES` IS node_modules).
 * The same rule `knext.grpc.json` applies to its `out`.
 */
function subdir(key: string, value: unknown): string {
  const problem = `${CONFIG_FILE}: "${key}" must be a subdirectory of the app, outside node_modules`;
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\\')) {
    throw new FfiUsageError(problem);
  }
  if (posix.isAbsolute(value)) throw new FfiUsageError(problem);
  const norm = posix.normalize(value).replace(/\/+$/, '');
  if (norm === '' || norm === '.' || norm === '..' || norm.startsWith('../')) {
    throw new FfiUsageError(problem);
  }
  if (norm.split('/').some((s) => s.toLowerCase() === 'node_modules')) {
    throw new FfiUsageError(problem);
  }
  return norm;
}

/** Validate parsed JSON into a config, filling defaults for `crate` and `out`. */
export function parseConfig(raw: unknown): FfiConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new FfiUsageError(`${CONFIG_FILE} must hold a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KEYS.has(key)) throw new FfiUsageError(`${CONFIG_FILE}: unknown setting "${key}"`);
  }
  if (obj.version !== 1) {
    throw new FfiUsageError(
      `${CONFIG_FILE}: "version" must be 1 (the only version this @getknext/ffi reads)`,
    );
  }
  return {
    version: 1,
    crate: subdir('crate', obj.crate ?? DEFAULT_CONFIG.crate),
    out: subdir('out', obj.out ?? DEFAULT_CONFIG.out),
  };
}

/** Read `knext.ffi.json` from `cwd`. */
export function loadConfig(cwd: string): FfiConfig {
  const path = join(cwd, CONFIG_FILE);
  if (!existsSync(path)) {
    throw new FfiUsageError(`no ${CONFIG_FILE} in ${cwd}. Run \`knext ffi init\` first.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new FfiUsageError(`${CONFIG_FILE} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}

/** Stable serialisation: fixed key order, trailing newline. */
export function serializeConfig(config: FfiConfig): string {
  return `${JSON.stringify({ version: config.version, crate: config.crate, out: config.out }, null, 2)}\n`;
}
