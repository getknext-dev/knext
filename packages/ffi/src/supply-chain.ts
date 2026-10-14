/**
 * Supply-chain gates for a zone's Rust library (ADR-0069 D16), run by
 * `knext ffi build` so every image build is gated:
 *
 * - **Pinned build tools.** zig is an exact version: a `zig` on PATH is used
 *   only if `zig version` equals the pin, otherwise none on PATH means knext
 *   downloads the pinned archive from ziglang.org and verifies its sha256 for
 *   this host (fail closed). The four cargo subcommands are pinned in
 *   {@link CARGO_TOOL_PINS}; a missing or different version is refused with
 *   the exact `cargo install --locked --version <pin> <crate>` command.
 * - **`cargo deny check`** before the build: bans, licenses and sources by its
 *   exit code under the crate's `deny.toml`; advisories through its JSON
 *   output, where every RustSec advisory (including one `deny.toml` ignores)
 *   must be covered by a dated, justified, unexpired entry in the crate's
 *   `advisory-allowlist.json`. Git sources are also checked here, from
 *   `Cargo.lock`: only `getknext-dev/knext`, whatever `deny.toml` says.
 * - **`cargo auditable`** wraps the cross-build, and the built library must
 *   carry the `.dep-v0` section it writes (the crate list Trivy and syft read).
 * - **A CycloneDX SBOM** (`cargo cyclonedx`) per target, staged as
 *   `native/ffi/<triple>/sbom.cdx.json` so it ships and is hashed into
 *   `native/.integrity.json` with everything else.
 *
 * Bumping a pin is a deliberate change to the tables below and their test.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import type { Runner, RunResult } from './build';
import { FfiUsageError } from './config';
import { CRATE_GIT } from './init';

// ---------------------------------------------------------------------------
// The pins
// ---------------------------------------------------------------------------

export interface CargoToolPin {
  /** The crates.io crate, and the `cargo-<sub>` binary it installs. */
  readonly crate: string;
  readonly version: string;
  /** What it does in the build, for the missing-tool message. */
  readonly purpose: string;
}

/**
 * The cargo subcommands `knext ffi build` runs, by exact version. Each is
 * installed with {@link cargoInstallCommand} (`--locked` makes `cargo install`
 * use the tool's own published Cargo.lock).
 */
export const CARGO_TOOL_PINS = {
  zigbuild: {
    crate: 'cargo-zigbuild',
    version: '0.23.4',
    purpose: 'it cross-compiles the library for the musl image',
  },
  deny: {
    crate: 'cargo-deny',
    version: '0.20.2',
    purpose: 'it checks advisories, licenses, bans and sources before the build',
  },
  auditable: {
    crate: 'cargo-auditable',
    version: '0.7.7',
    purpose: 'it embeds the crate list in the library for image scanners',
  },
  cyclonedx: {
    crate: 'cargo-cyclonedx',
    version: '0.5.9',
    purpose: 'it writes the CycloneDX SBOM that ships beside the library',
  },
} as const satisfies Record<string, CargoToolPin>;

export type CargoTool = keyof typeof CARGO_TOOL_PINS;

export interface ZigAsset {
  readonly file: string;
  /** sha256 of the archive, lowercase hex (ziglang.org's index, re-verified by download). */
  readonly sha256: string;
}

export interface ZigPin {
  readonly version: string;
  readonly baseUrl: string;
  /** Keyed by {@link zigHostKey}. */
  readonly assets: Readonly<Record<string, ZigAsset>>;
}

/** The zig cargo-zigbuild links with. */
export const ZIG_PIN: ZigPin = {
  version: '0.17.0',
  baseUrl: 'https://ziglang.org/download/0.17.0',
  assets: {
    'linux-x86_64': {
      file: 'zig-x86_64-linux-0.17.0.tar.xz',
      sha256: '1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026',
    },
    'linux-aarch64': {
      file: 'zig-aarch64-linux-0.17.0.tar.xz',
      sha256: '9e8d11661d4ae3bd57702a3832781e23ad151dde5798e16a5ccd503f65234ff8',
    },
    'macos-aarch64': {
      file: 'zig-aarch64-macos-0.17.0.tar.xz',
      sha256: 'b607e9b9234790a008116ae5bdb71c6243b84b9fb42a53a9e70fde41c06c536a',
    },
  },
};

/** The one command that installs a pinned cargo tool. */
export function cargoInstallCommand(tool: CargoTool): string {
  const pin = CARGO_TOOL_PINS[tool];
  return `cargo install --locked --version ${pin.version} ${pin.crate}`;
}

/** The files this module reads in the crate directory, and writes in `native/ffi/<triple>/`. */
export const DENY_FILE = 'deny.toml';
export const ADVISORY_ALLOWLIST_FILE = 'advisory-allowlist.json';
export const SBOM_FILE = 'sbom.cdx.json';

/** The only git repository a zone crate may depend on (D16): the knext-ffi crates' home. */
export const ALLOWED_GIT_SOURCE = CRATE_GIT;

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

type Env = Readonly<Record<string, string | undefined>>;

const notStarted = (r: RunResult) => r.error !== undefined;
const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The last `x.y.z` (with an optional pre-release) on the first line of `--version` output. */
export function versionOf(stdout: string): string | null {
  const line = stdout.split('\n')[0] ?? '';
  const all = [...line.matchAll(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/g)];
  return all.length > 0 ? (all[all.length - 1]?.[1] ?? null) : null;
}

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `name` on `PATH`, as an absolute path, or undefined. */
function onPath(name: string, env: Env): string | undefined {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && isExecutable(join(dir, name))) return join(dir, name);
  }
  return undefined;
}

/**
 * The binary `cargo <sub>` runs: cargo searches `$CARGO_HOME/bin` (default
 * `~/.cargo/bin`) before `PATH`, so the version checked is the version run.
 */
export function resolveCargoSubcommand(crate: string, env: Env): string | undefined {
  const cargoHome = env.CARGO_HOME || join(homedir(), '.cargo');
  const inHome = join(cargoHome, 'bin', crate);
  return isExecutable(inHome) ? inHome : onPath(crate, env);
}

// ---------------------------------------------------------------------------
// Cargo tool pins
// ---------------------------------------------------------------------------

/**
 * cargo-auditable has no version flag (measured on 0.7.7: `cargo auditable
 * --version` prints cargo's own version, `cargo-auditable --version` refuses
 * to run outside cargo). Its version is read from the record `cargo install`
 * keeps beside the bin directory it installed into (what `cargo install
 * --list` reads), for the entry that owns this binary.
 */
function installedVersion(bin: string, crate: string): string | null {
  const record = join(dirname(dirname(bin)), '.crates2.json');
  let parsed: { installs?: Record<string, { bins?: unknown }> };
  try {
    parsed = JSON.parse(readFileSync(record, 'utf8'));
  } catch {
    return null;
  }
  for (const [key, entry] of Object.entries(parsed.installs ?? {})) {
    const m = /^(\S+) (\S+) \(/.exec(key);
    if (!m || m[1] !== crate) continue;
    if (Array.isArray(entry.bins) && entry.bins.includes(basename(bin))) return m[2] ?? null;
  }
  return null;
}

/** How each tool reports its version, by measurement against the pinned release. */
function readToolVersion(tool: CargoTool, bin: string, run: Runner, cwd: string): string | null {
  if (tool === 'auditable') return installedVersion(bin, CARGO_TOOL_PINS.auditable.crate);
  // `cargo-cyclonedx --version` is refused outside cargo's argv shape; the
  // subcommand form prints `cargo-cyclonedx-cyclonedx <version>`.
  // `cargo zigbuild --version` is refused by 0.23.4 itself; the binary answers.
  const args = tool === 'cyclonedx' ? ['cyclonedx', '--version'] : ['--version'];
  const r = run(bin, args, { cwd });
  if (notStarted(r) || r.status !== 0) return null;
  return versionOf(r.stdout);
}

/**
 * Every pinned cargo tool is present at exactly its pinned version, or a
 * usage error names the one install command. Returns the verified versions.
 */
export function checkCargoTools(
  run: Runner,
  cwd: string,
  env: Env,
  tools: readonly CargoTool[] = Object.keys(CARGO_TOOL_PINS) as CargoTool[],
): Record<string, string> {
  const versions: Record<string, string> = {};
  for (const tool of tools) {
    const pin = CARGO_TOOL_PINS[tool];
    const install = cargoInstallCommand(tool);
    const bin = resolveCargoSubcommand(pin.crate, env);
    if (bin === undefined) {
      throw new FfiUsageError(
        `${pin.crate} is not installed; ${pin.purpose}. Install the pinned version with: ${install}`,
      );
    }
    const got = readToolVersion(tool, bin, run, cwd);
    if (got === null) {
      throw new FfiUsageError(
        `could not read the version of ${pin.crate} at ${bin}, so it cannot be checked against the pinned ${pin.version}. Install the pinned version with: ${install}`,
      );
    }
    if (got !== pin.version) {
      throw new FfiUsageError(
        `${pin.crate} ${got} is installed (${bin}), but knext ffi build pins ${pin.version}. Install the pinned version with: ${install}`,
      );
    }
    versions[pin.crate] = got;
  }
  return versions;
}

// ---------------------------------------------------------------------------
// zig
// ---------------------------------------------------------------------------

export interface HostPlatform {
  readonly platform: string;
  readonly arch: string;
}

/** ziglang.org's name for this host's archive, or undefined when none is pinned. */
export function zigHostKey(host: HostPlatform): string | undefined {
  const arch = host.arch === 'x64' ? 'x86_64' : host.arch === 'arm64' ? 'aarch64' : undefined;
  if (arch === undefined) return undefined;
  if (host.platform === 'linux') return `linux-${arch}`;
  if (host.platform === 'darwin') return `macos-${arch}`;
  return undefined;
}

/** `$KNEXT_CACHE_DIR` → `$XDG_CACHE_HOME/knext` → `~/.cache/knext`, then `zig/<version>`. */
export function zigCacheDir(env: Env, home: string, version: string): string {
  const root = env.KNEXT_CACHE_DIR
    ? env.KNEXT_CACHE_DIR
    : env.XDG_CACHE_HOME
      ? join(env.XDG_CACHE_HOME, 'knext')
      : join(home, '.cache', 'knext');
  return join(root, 'zig', version);
}

type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface ZigDeps {
  readonly fetch?: FetchLike;
  readonly host?: HostPlatform;
  readonly cacheDir?: string;
  readonly pin?: ZigPin;
}

/** The verified zig, as recorded in provenance. */
export interface ResolvedZig {
  /** Absolute path; handed to cargo-zigbuild through {@link zigbuildEnv}. */
  readonly bin: string;
  readonly version: string;
  /** `path`: a `zig` already on PATH at the pinned version; `ziglang.org`: downloaded and verified. */
  readonly source: 'path' | 'ziglang.org';
  /** The verified archive's sha256 (download only). */
  readonly sha256: string | null;
}

function zigInstallHint(pin: ZigPin, host: HostPlatform): string {
  const key = zigHostKey(host);
  const asset = key ? pin.assets[key] : undefined;
  return asset
    ? `${pin.baseUrl}/${asset.file} (sha256 ${asset.sha256})`
    : `https://ziglang.org/download/#release-${pin.version}`;
}

function zigVersionAt(run: Runner, bin: string, cwd: string): string | null {
  const r = run(bin, ['version'], { cwd });
  if (notStarted(r) || r.status !== 0) return null;
  return r.stdout.trim() || null;
}

/**
 * The pinned zig: the one on PATH when its `zig version` equals the pin (a
 * different one is refused, never silently replaced), otherwise the pinned
 * archive for this host, downloaded from ziglang.org into knext's cache and
 * verified by sha256 on every build.
 */
export async function resolveZig(
  run: Runner,
  cwd: string,
  env: Env,
  deps: ZigDeps = {},
): Promise<ResolvedZig> {
  const pin = deps.pin ?? ZIG_PIN;
  const host = deps.host ?? { platform: process.platform, arch: process.arch };

  const onPathZig = onPath('zig', env);
  if (onPathZig !== undefined) {
    const got = zigVersionAt(run, onPathZig, cwd);
    if (got !== pin.version) {
      throw new FfiUsageError(
        `zig ${got ?? '(version unreadable)'} is on PATH (${onPathZig}), but knext ffi build pins zig ${pin.version}. ` +
          `Remove it from PATH (knext then downloads zig ${pin.version} from ziglang.org and verifies its sha256), ` +
          `or install exactly ${pin.version}: ${zigInstallHint(pin, host)}`,
      );
    }
    return { bin: onPathZig, version: got, source: 'path', sha256: null };
  }

  const key = zigHostKey(host);
  const asset = key ? pin.assets[key] : undefined;
  if (key === undefined || asset === undefined) {
    throw new FfiUsageError(
      `no zig is on PATH, and knext pins no zig ${pin.version} download for ${host.platform}-${host.arch} ` +
        `(pinned: ${Object.keys(pin.assets).join(', ')}). Install exactly zig ${pin.version} on PATH: ${zigInstallHint(pin, host)}`,
    );
  }

  const dir = deps.cacheDir ?? zigCacheDir(env, homedir(), pin.version);
  const archive = join(dir, asset.file);
  const stem = asset.file.replace(/\.tar\.xz$/, '');
  const tree = join(dir, stem);
  const url = `${pin.baseUrl}/${asset.file}`;

  let fresh = false;
  if (!(existsSync(archive) && sha256Hex(readFileSync(archive)) === asset.sha256)) {
    // A cached archive that no longer matches is never trusted: drop it, and
    // the tree extracted from it, and fetch again.
    rmSync(archive, { force: true });
    const fetchFn: FetchLike =
      deps.fetch ?? ((u: string) => globalThis.fetch(u) as ReturnType<FetchLike>);
    let bytes: Uint8Array;
    try {
      const res = await fetchFn(url);
      if (!res.ok) {
        throw new FfiUsageError(
          `downloading zig ${pin.version} failed: HTTP ${res.status} for ${url}. Nothing was installed.`,
        );
      }
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      if (err instanceof FfiUsageError) throw err;
      throw new FfiUsageError(
        `downloading zig ${pin.version} failed for ${url}: ${err instanceof Error ? err.message : String(err)}. Nothing was installed.`,
      );
    }
    const got = sha256Hex(bytes);
    if (got !== asset.sha256) {
      throw new FfiUsageError(
        `zig ${pin.version} failed verification: sha256 mismatch for ${url}\n` +
          `  expected ${asset.sha256} (pinned in @getknext/ffi)\n` +
          `  got      ${got}\n` +
          'The download was discarded and nothing was installed.',
      );
    }
    mkdirSync(dir, { recursive: true });
    const partial = join(dir, `.${asset.file}.${randomBytes(6).toString('hex')}.partial`);
    try {
      writeFileSync(partial, bytes);
      renameSync(partial, archive);
    } finally {
      rmSync(partial, { force: true });
    }
    fresh = true;
  }

  const bin = join(tree, 'zig');
  if (fresh || !existsSync(bin)) {
    rmSync(tree, { recursive: true, force: true });
    const scratch = join(dir, `.extract-${randomBytes(6).toString('hex')}`);
    mkdirSync(scratch, { recursive: true });
    try {
      const r = run('tar', ['-xJf', archive, '-C', scratch], { cwd });
      if (notStarted(r) || r.status !== 0 || !existsSync(join(scratch, stem, 'zig'))) {
        throw new FfiUsageError(
          `extracting ${archive} failed (tar exit ${r.status ?? 'not started'}); tar must support xz (-J).`,
        );
      }
      renameSync(join(scratch, stem), tree);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  const got = zigVersionAt(run, bin, cwd);
  if (got !== pin.version) {
    rmSync(tree, { recursive: true, force: true });
    throw new FfiUsageError(
      `the downloaded zig at ${bin} reports ${got ?? '(version unreadable)'}, not the pinned ${pin.version}; it was removed. Run the build again.`,
    );
  }
  return { bin, version: got, source: 'ziglang.org', sha256: asset.sha256 };
}

/**
 * The environment that makes cargo-zigbuild link with exactly this zig.
 * Without it, cargo-zigbuild 0.23.4 prefers `python3 -m ziglang` over the
 * `zig` on PATH (measured: with zig 0.15.2 on PATH and pip's ziglang 0.17.0
 * importable by `python3`, it linked with the pip one), so the pin would not
 * hold whenever a Python ziglang of another version is installed.
 */
export function zigbuildEnv(zig: ResolvedZig): Record<string, string> {
  return { CARGO_ZIGBUILD_ZIG_COMMAND: zig.bin, CARGO_ZIGBUILD_ZIG_COMMAND_ARGS: '' };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * Every git source in Cargo.lock is the knext-ffi repository. Checked here,
 * not only by `deny.toml`'s `[sources]`, so an edited (or missing) policy
 * file cannot widen it.
 */
export function assertGitSources(cargoLock: string, lockLabel: string): void {
  const allowed = new Set([ALLOWED_GIT_SOURCE, `${ALLOWED_GIT_SOURCE}.git`]);
  const refused = new Set<string>();
  for (const m of cargoLock.matchAll(/^source\s*=\s*"git\+([^"?#]*)[^"]*"/gm)) {
    const repo = m[1] as string;
    if (!allowed.has(repo)) refused.add(repo);
  }
  if (refused.size > 0) {
    throw new FfiUsageError(
      `${lockLabel} has git dependencies from ${[...refused].join(', ')}; a zone crate may depend on git sources from ${ALLOWED_GIT_SOURCE} only. ` +
        'Depend on a crates.io release instead.',
    );
  }
}

// ---------------------------------------------------------------------------
// Advisories
// ---------------------------------------------------------------------------

export interface AllowEntry {
  readonly id: string;
  readonly justification: string;
  readonly added: string;
  readonly expires?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (s: unknown): s is string =>
  typeof s === 'string' &&
  ISO_DATE.test(s) &&
  new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/**
 * The crate's dated, justified advisory allowlist (mirrors
 * `security/npm-audit-allowlist.json`): `{ "allow": [{ "id", "justification",
 * "added", "expires"? }] }`. No file means no accepted advisories. A malformed
 * file or entry fails the build: a gate that a typo can neuter is no gate.
 */
export function loadAdvisoryAllowlist(crateDir: string, crateLabel: string): AllowEntry[] {
  const path = join(crateDir, ADVISORY_ALLOWLIST_FILE);
  const label = `${crateLabel}/${ADVISORY_ALLOWLIST_FILE}`;
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new FfiUsageError(`could not parse ${label}: ${(err as Error).message}`);
  }
  const allow = (parsed as { allow?: unknown } | null)?.allow;
  if (!Array.isArray(allow)) {
    throw new FfiUsageError(`${label} must be an object with an "allow" array`);
  }
  return allow.map((raw, i) => {
    const e = (raw ?? {}) as Record<string, unknown>;
    const where = `${label} entry ${i + 1}`;
    if (typeof e.id !== 'string' || !/^RUSTSEC-\d{4}-\d{4}$/.test(e.id)) {
      throw new FfiUsageError(`${where} needs an "id" that is a RustSec id (RUSTSEC-YYYY-NNNN)`);
    }
    if (typeof e.justification !== 'string' || e.justification.trim() === '') {
      throw new FfiUsageError(
        `${where} (${e.id}) needs a non-empty "justification": why the risk is accepted`,
      );
    }
    if (!isIsoDate(e.added)) {
      throw new FfiUsageError(`${where} (${e.id}) needs an "added" date (YYYY-MM-DD)`);
    }
    if (e.expires !== undefined && !isIsoDate(e.expires)) {
      throw new FfiUsageError(`${where} (${e.id}) has an "expires" that is not a YYYY-MM-DD date`);
    }
    return {
      id: e.id,
      justification: e.justification,
      added: e.added,
      ...(e.expires !== undefined ? { expires: e.expires as string } : {}),
    };
  });
}

export interface AdvisoryFinding {
  readonly id: string;
  /** `name@version` of the affected crate, when cargo-deny names it. */
  readonly crate: string;
  readonly title: string;
  readonly severity: string;
}

export interface DenyReport {
  readonly advisories: readonly AdvisoryFinding[];
  /** Error diagnostics that are not advisories (e.g. a yanked crate). */
  readonly otherErrors: readonly string[];
}

/** cargo-deny's `--format json` stream (one JSON object per line, on stderr). */
export function parseDenyJson(stream: string): DenyReport {
  const advisories: AdvisoryFinding[] = [];
  const otherErrors: string[] = [];
  for (const line of stream.split('\n')) {
    if (!line.startsWith('{')) continue;
    let d: {
      type?: unknown;
      fields?: {
        severity?: unknown;
        code?: unknown;
        message?: unknown;
        advisory?: { id?: unknown; title?: unknown; package?: unknown } | null;
        graphs?: { Krate?: { name?: unknown; version?: unknown } }[];
      };
    };
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== 'diagnostic' || !d.fields) continue;
    const f = d.fields;
    const severity = typeof f.severity === 'string' ? f.severity : 'unknown';
    if (f.advisory && typeof f.advisory.id === 'string') {
      const k = f.graphs?.[0]?.Krate;
      const crate =
        typeof k?.name === 'string'
          ? `${k.name}@${typeof k.version === 'string' ? k.version : '?'}`
          : String(f.advisory.package ?? '?');
      advisories.push({
        id: f.advisory.id,
        crate,
        title: typeof f.advisory.title === 'string' ? f.advisory.title : '',
        severity,
      });
    } else if (severity === 'error') {
      otherErrors.push(`${String(f.code ?? 'error')}: ${String(f.message ?? '')}`);
    }
  }
  return { advisories, otherErrors };
}

export interface AdvisoryVerdict {
  readonly refused: readonly (AdvisoryFinding & { readonly reason: string })[];
  readonly accepted: readonly (AdvisoryFinding & { readonly entry: AllowEntry })[];
}

/**
 * Every advisory needs an unexpired allowlist entry. An entry past its
 * `expires` date stops covering it (the risk must be re-justified), and an
 * advisory `deny.toml` ignores is still refused without one: `deny.toml`'s
 * `ignore` carries no date.
 */
export function judgeAdvisories(
  findings: readonly AdvisoryFinding[],
  allow: readonly AllowEntry[],
  today: string,
): AdvisoryVerdict {
  const refused: (AdvisoryFinding & { reason: string })[] = [];
  const accepted: (AdvisoryFinding & { entry: AllowEntry })[] = [];
  for (const f of findings) {
    const entry = allow.find((e) => e.id === f.id);
    if (entry === undefined) {
      refused.push({ ...f, reason: `not in ${ADVISORY_ALLOWLIST_FILE}` });
    } else if (entry.expires !== undefined && entry.expires < today) {
      refused.push({
        ...f,
        reason: `its ${ADVISORY_ALLOWLIST_FILE} entry expired on ${entry.expires}`,
      });
    } else {
      accepted.push({ ...f, entry });
    }
  }
  return { refused, accepted };
}

export interface DenyOptions {
  readonly run: Runner;
  readonly crateDir: string;
  /** The crate directory as the user sees it (`rust`), for messages. */
  readonly crateLabel: string;
  readonly env: NodeJS.ProcessEnv;
  /** `YYYY-MM-DD`, for allowlist expiry. */
  readonly today: string;
  readonly note: (line: string) => void;
}

/**
 * `cargo deny check` before the build. Returns the advisories accepted by the
 * allowlist (recorded in provenance).
 */
export function runCargoDeny(opts: DenyOptions): string[] {
  const { run, crateDir, crateLabel, env } = opts;
  const policy = `${crateLabel}/${DENY_FILE}`;
  const policyHint = existsSync(join(crateDir, DENY_FILE))
    ? `The policy is ${policy}.`
    : `${policy} is missing, so cargo-deny ran with its defaults; \`knext ffi init\` writes the knext policy.`;
  const allow = loadAdvisoryAllowlist(crateDir, crateLabel);

  const policyRun = run('cargo', ['deny', '--locked', 'check', 'bans', 'licenses', 'sources'], {
    cwd: crateDir,
    env,
  });
  if (notStarted(policyRun) || policyRun.status !== 0) {
    throw new FfiUsageError(
      `cargo deny check bans licenses sources failed (exit ${policyRun.status ?? 'not started'}); see its errors above. ${policyHint}`,
    );
  }

  const adv = run(
    'cargo',
    ['deny', '--locked', '--format', 'json', '--log-level', 'info', 'check', 'advisories'],
    { cwd: crateDir, env, captureStderr: true },
  );
  if (notStarted(adv)) {
    throw new FfiUsageError('cargo deny check advisories could not be started.');
  }
  const report = parseDenyJson(adv.stderr ?? '');
  const verdict = judgeAdvisories(report.advisories, allow, opts.today);
  const problems = [
    ...verdict.refused.map((r) => `  ${r.id} in ${r.crate}: ${r.title} (${r.reason})`),
    ...report.otherErrors.map((e) => `  ${e}`),
  ];
  if (problems.length > 0) {
    throw new FfiUsageError(
      `cargo deny check advisories refused the build:\n${problems.join('\n')}\n` +
        `Upgrade the affected crate (cargo update -p <crate>), or accept a specific advisory with a dated, justified entry in ${crateLabel}/${ADVISORY_ALLOWLIST_FILE}: ` +
        '{ "allow": [{ "id": "RUSTSEC-…", "justification": "…", "added": "YYYY-MM-DD", "expires": "YYYY-MM-DD" }] }',
    );
  }
  // A non-zero exit every diagnostic of which the allowlist accepts is cargo-deny
  // not knowing the allowlist. A non-zero exit with no error diagnostic at all
  // (the database could not be fetched, the policy did not parse) is a failure.
  const sawError = verdict.accepted.some((a) => a.severity === 'error');
  if (adv.status !== 0 && !sawError) {
    throw new FfiUsageError(
      `cargo deny check advisories failed (exit ${adv.status}) without reporting an advisory. ${policyHint}`,
    );
  }
  for (const a of verdict.accepted) {
    opts.note(
      `accepted ${a.id} in ${a.crate} (${ADVISORY_ALLOWLIST_FILE}, added ${a.entry.added}${a.entry.expires ? `, expires ${a.entry.expires}` : ''})\n`,
    );
  }
  return [...new Set(verdict.accepted.map((a) => a.id))].sort();
}

// ---------------------------------------------------------------------------
// cargo auditable
// ---------------------------------------------------------------------------

/** The section cargo-auditable writes: zlib-compressed JSON (`{"packages":[…]}`). */
export const AUDIT_SECTION = '.dep-v0';

export interface AuditPackage {
  readonly name: string;
  readonly version: string;
  readonly root?: boolean;
}

/** The crate list cargo-auditable embedded in an ELF64 little-endian library, or null when absent. */
export function readAuditData(bytes: Uint8Array): AuditPackage[] | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 64 || bytes[4] !== 2 || bytes[5] !== 1) return null;
  const shoff = Number(view.getBigUint64(40, true));
  const shentsize = view.getUint16(58, true);
  const shnum = view.getUint16(60, true);
  const shstrndx = view.getUint16(62, true);
  if (shoff === 0 || shentsize < 64 || shstrndx >= shnum) return null;
  if (shoff + shentsize * shnum > bytes.byteLength) return null;
  const header = (i: number) => {
    const at = shoff + i * shentsize;
    return {
      name: view.getUint32(at, true),
      offset: Number(view.getBigUint64(at + 24, true)),
      size: Number(view.getBigUint64(at + 32, true)),
    };
  };
  const strtab = header(shstrndx);
  if (strtab.offset + strtab.size > bytes.byteLength) return null;
  const decoder = new TextDecoder();
  const nameAt = (off: number) => {
    let end = strtab.offset + off;
    while (end < strtab.offset + strtab.size && bytes[end] !== 0) end++;
    return decoder.decode(bytes.subarray(strtab.offset + off, end));
  };
  for (let i = 0; i < shnum; i++) {
    const s = header(i);
    if (nameAt(s.name) !== AUDIT_SECTION) continue;
    if (s.offset + s.size > bytes.byteLength) return null;
    try {
      const json = JSON.parse(inflateSync(bytes.subarray(s.offset, s.offset + s.size)).toString());
      return Array.isArray(json.packages) ? (json.packages as AuditPackage[]) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The built library carries cargo-auditable's crate list, rooted at this crate
 * (so image scanners see the Rust dependencies the npm SBOM cannot).
 */
export function assertAuditable(bytes: Uint8Array, crateName: string | null, label: string): void {
  const packages = readAuditData(bytes);
  if (packages === null) {
    throw new FfiUsageError(
      `${label} carries no cargo-auditable data (no readable ${AUDIT_SECTION} section), so image scanners cannot see its crates. It must be built through \`cargo auditable\`.`,
    );
  }
  if (crateName !== null && !packages.some((p) => p.root === true && p.name === crateName)) {
    throw new FfiUsageError(
      `${label}'s cargo-auditable data does not list ${crateName} as its root crate.`,
    );
  }
}

// ---------------------------------------------------------------------------
// CycloneDX SBOM
// ---------------------------------------------------------------------------

/**
 * `cargo cyclonedx` for one target: the SBOM bytes, validated. The tool writes
 * beside Cargo.toml; the file is read and removed, and staged by the caller.
 */
export function buildSbom(opts: {
  run: Runner;
  crateDir: string;
  triple: string;
  crateName: string | null;
  env: NodeJS.ProcessEnv;
}): Buffer {
  const name = `knext-ffi-sbom-${opts.triple}`;
  const out = join(opts.crateDir, `${name}.json`);
  rmSync(out, { force: true });
  try {
    const r = opts.run(
      'cargo',
      [
        'cyclonedx',
        '--format',
        'json',
        '--spec-version',
        '1.5',
        '--target',
        opts.triple,
        '--override-filename',
        name,
      ],
      { cwd: opts.crateDir, env: opts.env },
    );
    if (notStarted(r) || r.status !== 0 || !existsSync(out)) {
      throw new FfiUsageError(
        `cargo cyclonedx failed for ${opts.triple} (exit ${r.status ?? 'not started'}); see its errors above.`,
      );
    }
    const bytes = readFileSync(out);
    assertCycloneDx(bytes, opts.triple, opts.crateName);
    return bytes;
  } finally {
    rmSync(out, { force: true });
  }
}

/** A CycloneDX JSON BOM describing this crate, for this target. */
export function assertCycloneDx(bytes: Uint8Array, triple: string, crateName: string | null): void {
  let bom: {
    bomFormat?: unknown;
    specVersion?: unknown;
    components?: unknown;
    metadata?: {
      component?: { name?: unknown };
      properties?: { name?: unknown; value?: unknown }[];
    };
  };
  try {
    bom = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new FfiUsageError(`the SBOM for ${triple} is not JSON`);
  }
  const bad = (why: string) => new FfiUsageError(`the SBOM for ${triple} is not valid: ${why}`);
  if (bom.bomFormat !== 'CycloneDX') throw bad('bomFormat is not "CycloneDX"');
  if (typeof bom.specVersion !== 'string' || !/^1\.\d+$/.test(bom.specVersion)) {
    throw bad('specVersion is not 1.x');
  }
  if (!Array.isArray(bom.components)) throw bad('it has no components array');
  if (crateName !== null && bom.metadata?.component?.name !== crateName) {
    throw bad(`it describes ${String(bom.metadata?.component?.name)}, not ${crateName}`);
  }
  const target = bom.metadata?.properties?.find((p) => p.name === 'cdx:rustc:sbom:target:triple');
  if (target !== undefined && target.value !== triple) {
    throw bad(`it was generated for ${String(target.value)}`);
  }
}

/** `YYYY-MM-DD` in UTC. */
export const todayUtc = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// The one entry point `knext ffi build` calls
// ---------------------------------------------------------------------------

export interface SupplyChainOptions {
  readonly run: Runner;
  readonly crateDir: string;
  /** The crate directory as the user sees it (`rust`), for messages. */
  readonly crateLabel: string;
  readonly cargoLock: string;
  /** `[package] name`, when Cargo.toml states it. */
  readonly crateName: string | null;
  readonly env: NodeJS.ProcessEnv;
  readonly note: (line: string) => void;
  readonly zig?: ZigDeps;
  readonly today?: string;
}

/** What the gates hand back to the build. */
export interface SupplyChain {
  /** The arguments before `--release`: the build runs as `cargo auditable zigbuild …`. */
  readonly cargoPrefix: readonly string[];
  /** Merged into the build's environment: cargo-zigbuild links with the verified zig. */
  readonly env: Readonly<Record<string, string>>;
  /** `cargo-zigbuild <version>`, as provenance has always recorded it. */
  readonly zigbuildVersion: string;
  /** Recorded in each target's provenance.json. */
  readonly provenance: {
    readonly tools: Record<string, unknown>;
    readonly advisoriesAccepted: readonly string[];
  };
  /** The built library carries cargo-auditable's crate list. */
  verifyLibrary(bytes: Uint8Array, label: string): void;
  /** The validated CycloneDX SBOM bytes for one target. */
  sbom(triple: string, env: NodeJS.ProcessEnv): Buffer;
}

/**
 * Every gate that runs before the cross-build, in order: the git-source rule,
 * the four pinned cargo tools, the pinned zig, and `cargo deny check`. Throws
 * {@link FfiUsageError} on the first failure; nothing has been built then.
 */
export async function prepareSupplyChain(opts: SupplyChainOptions): Promise<SupplyChain> {
  const { run, crateDir, crateLabel, env } = opts;
  assertGitSources(opts.cargoLock, `${crateLabel}/Cargo.lock`);
  const versions = checkCargoTools(run, crateDir, env);
  const zig = await resolveZig(run, crateDir, env, opts.zig);
  const accepted = runCargoDeny({
    run,
    crateDir,
    crateLabel,
    env,
    today: opts.today ?? todayUtc(),
    note: opts.note,
  });
  return {
    cargoPrefix: ['auditable', 'zigbuild'],
    env: zigbuildEnv(zig),
    zigbuildVersion: `${CARGO_TOOL_PINS.zigbuild.crate} ${versions[CARGO_TOOL_PINS.zigbuild.crate]}`,
    provenance: {
      tools: {
        zig: { version: zig.version, source: zig.source, sha256: zig.sha256 },
        ...versions,
      },
      advisoriesAccepted: accepted,
    },
    verifyLibrary: (bytes, label) => assertAuditable(bytes, opts.crateName, label),
    sbom: (triple, buildEnv) =>
      buildSbom({ run, crateDir, triple, crateName: opts.crateName, env: buildEnv }),
  };
}
