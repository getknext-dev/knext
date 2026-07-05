#!/usr/bin/env node

/**
 * kn-next db bind — one-command BYO Postgres binding (ADR-0019).
 *
 * Usage:
 *   kn-next db bind [<app>] --secret <name> [--key K]
 *                   [--ro-secret <name>] [--ro-key K]
 *                   [-n <namespace>] [--dry-run]
 *                   [--dsn <dsn>] [--secret-file <path>]
 *
 * ADR-0001 (operator = single source of truth):
 *   The CLI emits INTENT only. `db bind` issues exactly ONE cluster write — a
 *   `kubectl patch nextapp <name> --type merge -p <json>` that sets
 *   spec.database.secretRef (+ optional roSecretRef) — mirroring rollback.ts.
 *   It never writes the ksvc / Secret / anything else. `--dry-run` prints the
 *   patch YAML and performs zero cluster calls.
 *
 * ADR-0019 (spec.database secretRef, BYO mode):
 *   The admission matrix is validated CLIENT-SIDE here so the user gets the
 *   exact conflict at the keyboard instead of an apiserver rejection:
 *   DNS-1123 Secret names (rule 1), key defaults left to the server (rule 2),
 *   envMap DATABASE_URL/_RO collisions (rules 3/4), managed-vs-BYO mutual
 *   exclusion (rule 5), roSecretRef requires secretRef (rule 6), provisioning
 *   knobs are managed-mode-only (rule 7).
 *
 *   When a DSN is available (--dsn or a local Secret manifest via
 *   --secret-file), the command also surfaces the measured wake/pooling
 *   contract: pool idle < the gateway's 60s idle window, connect timeout ≥ 10s
 *   (a cold DB wakes in ~2.5s), and warns on sslmode=disable.
 */

import { existsSync, readFileSync, writeSync } from "node:fs";
import YAML from "yaml";
import type { KnativeNextConfig } from "../config";
import { createLogger } from "../utils/logger";
import { isEntrypoint, runCapture } from "./exec";
import { loadConfig } from "./shared";

const log = createLogger({ module: "db-bind" });

/** Env vars owned by spec.database (ADR-0019). */
const ENV_DATABASE_URL = "DATABASE_URL";
const ENV_DATABASE_URL_RO = "DATABASE_URL_RO";

/** Managed-mode-only provisioning knobs (ADR-0019 rule 7). */
const PROVISIONING_KNOBS = [
    "tier",
    "readReplicas",
    "quotas",
    "keepOnDelete",
] as const;

/** DNS-1123 subdomain (what Secret names must satisfy), max 253 chars. */
const DNS1123_SUBDOMAIN_RE =
    /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const DNS1123_MAX = 253;

export interface DbBindOptions {
    /** NextApp name; defaults to the local config's `name`. */
    app?: string;
    namespace: string;
    /** Secret carrying the DATABASE_URL DSN (required). */
    secret?: string;
    /** Key inside --secret; server defaults to DATABASE_URL when omitted. */
    key?: string;
    /** Optional Secret carrying a read-only DSN → DATABASE_URL_RO. */
    roSecret?: string;
    /** Key inside --ro-secret; server defaults to DATABASE_URL_RO. */
    roKey?: string;
    dryRun: boolean;
    /** Optional DSN for the local contract check (never sent anywhere). */
    dsn?: string;
    /** Optional local Secret manifest to resolve the DSN from. */
    secretFile?: string;
}

/** Parse `kn-next db bind` argv (after the `db bind` words). */
export function parseDbBindArgs(argv: readonly string[]): DbBindOptions {
    const out: DbBindOptions = { namespace: "default", dryRun: false };
    // A value-taking flag must actually have a value: a trailing `--secret` /
    // `-n`, or one followed by another flag, is a usage error — not a silent
    // `undefined` that detonates later as a TypeError inside kubectl argv.
    const need = (flag: string, i: number): string => {
        const v = argv[i];
        if (v === undefined || v.startsWith("-")) {
            throw new Error(
                `${flag} requires a value (see kn-next db bind --help)`,
            );
        }
        return v;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--secret") {
            out.secret = need(a, ++i);
        } else if (a === "--key") {
            out.key = need(a, ++i);
        } else if (a === "--ro-secret") {
            out.roSecret = need(a, ++i);
        } else if (a === "--ro-key") {
            out.roKey = need(a, ++i);
        } else if (a === "-n" || a === "--namespace") {
            out.namespace = need(a, ++i);
        } else if (a === "--dry-run") {
            out.dryRun = true;
        } else if (a === "--dsn") {
            out.dsn = need(a, ++i);
        } else if (a === "--secret-file") {
            out.secretFile = need(a, ++i);
        } else if (a.startsWith("-")) {
            // Unknown flags fail loudly — a typo like `--secert` must not
            // silently bind with defaults.
            throw new Error(`unknown flag "${a}" (see kn-next db bind --help)`);
        } else if (out.app === undefined) {
            out.app = a;
        } else {
            throw new Error(
                `unexpected positional "${a}" — only one <app> positional is accepted (see kn-next db bind --help)`,
            );
        }
    }
    return out;
}

function assertDns1123(flag: string, value: string): void {
    if (value.length > DNS1123_MAX) {
        throw new Error(
            `${flag} '${value.slice(0, 32)}…' is ${value.length} chars — a Secret name is a DNS-1123 subdomain of at most 253 chars (ADR-0019).`,
        );
    }
    if (!DNS1123_SUBDOMAIN_RE.test(value)) {
        throw new Error(
            `${flag} '${value}' is not a valid Secret name (lowercase DNS-1123 subdomain: [a-z0-9-.], must start/end alphanumeric) (ADR-0019).`,
        );
    }
}

/**
 * Arg-level validation — ADR-0019 rules 1 (DNS-1123 names) and 6 (ro requires
 * primary). Throws with an actionable message.
 */
export function validateDbBindOptions(opts: DbBindOptions): void {
    if (!opts.secret) {
        throw new Error(
            "--secret <name> is required: the Secret carrying the DATABASE_URL DSN (kn-next db bind --secret <name>).",
        );
    }
    assertDns1123("--secret", opts.secret);
    if (opts.roSecret !== undefined) {
        assertDns1123("--ro-secret", opts.roSecret);
    }
    if (opts.roKey !== undefined && opts.roSecret === undefined) {
        throw new Error(
            "--ro-key requires --ro-secret (a read-only key without a read-only Secret binds nothing — ADR-0019 rule 6 shape).",
        );
    }
}

/**
 * Minimal shape of the parts of a NextApp spec (or its kn-next.config
 * equivalent) that ADR-0019's matrix cross-checks against.
 */
export interface BindTargetSpec {
    database?: Record<string, unknown>;
    secrets?: { envMap?: Record<string, unknown> };
}

/**
 * Cross-source validation — ADR-0019 rules 3/4 (envMap collisions), 5
 * (managed vs BYO) and 7 (provisioning knobs). `source` names where the
 * conflicting spec came from ("config" = local kn-next.config.ts,
 * "cluster" = the live NextApp CR) so the error points at the right file.
 */
export function validateBindAgainstSpec(
    opts: DbBindOptions,
    spec: BindTargetSpec,
    source: "config" | "cluster",
): void {
    const db = spec.database ?? {};

    // Rule 5 — one database mode per app.
    if (db.enabled === true) {
        throw new Error(
            `spec.database.enabled (managed mode) and spec.database.secretRef (BYO) are mutually exclusive — one database mode per app (ADR-0019). Found database.enabled: true on the ${source}.`,
        );
    }

    // Rule 7 — provisioning knobs are managed-mode-only.
    const knobs = PROVISIONING_KNOBS.filter((k) => db[k] !== undefined);
    if (knobs.length > 0) {
        throw new Error(
            `provisioning knobs (${knobs.join(", ")}) are managed-mode-only and cannot be combined with secretRef (ADR-0019); found them on the ${source} spec.database.`,
        );
    }

    // Rules 3/4 — spec.database owns DATABASE_URL / DATABASE_URL_RO.
    const envMap = spec.secrets?.envMap ?? {};
    const collide = (envName: string) => {
        throw new Error(
            `spec.database owns ${envName}: it is already defined in spec.secrets.envMap (${source}). Remove the envMap["${envName}"] entry — there is no silent precedence (ADR-0019).`,
        );
    };
    if (envMap[ENV_DATABASE_URL] !== undefined) {
        collide(ENV_DATABASE_URL);
    }
    if (
        opts.roSecret !== undefined &&
        envMap[ENV_DATABASE_URL_RO] !== undefined
    ) {
        collide(ENV_DATABASE_URL_RO);
    }
}

/**
 * Build the merge-patch object. Keys are emitted only when explicitly given —
 * the server defaults them to DATABASE_URL / DATABASE_URL_RO (ADR-0019 rule 2),
 * and repeating defaults in the CR is noise.
 */
export function buildDbBindPatch(opts: DbBindOptions): Record<string, unknown> {
    if (!opts.secret) {
        throw new Error("buildDbBindPatch: secret is required");
    }
    return {
        spec: {
            database: {
                secretRef: {
                    name: opts.secret,
                    ...(opts.key !== undefined ? { key: opts.key } : {}),
                },
                ...(opts.roSecret !== undefined
                    ? {
                          roSecretRef: {
                              name: opts.roSecret,
                              ...(opts.roKey !== undefined
                                  ? { key: opts.roKey }
                                  : {}),
                          },
                      }
                    : {}),
            },
        },
    };
}

/** Render the merge-patch as reviewable YAML (the --dry-run output). */
export function renderDbBindPatchYaml(opts: DbBindOptions): string {
    return YAML.stringify(buildDbBindPatch(opts));
}

/**
 * Resolve a DSN from a local Kubernetes Secret manifest (stringData wins,
 * base64 `data` decoded otherwise). Returns undefined when the key is absent.
 * Local file only — the DSN never leaves the machine.
 */
export function extractDsnFromSecretManifest(
    manifestYaml: string,
    key: string,
): string | undefined {
    const doc = YAML.parse(manifestYaml) as {
        stringData?: Record<string, string>;
        data?: Record<string, string>;
    } | null;
    if (!doc) return undefined;
    const plain = doc.stringData?.[key];
    if (typeof plain === "string") return plain;
    const encoded = doc.data?.[key];
    if (typeof encoded === "string") {
        try {
            return Buffer.from(encoded, "base64").toString("utf-8");
        } catch {
            return undefined;
        }
    }
    return undefined;
}

/**
 * The measured wake/pooling contract (ADR-0019 / docs/guides/postgres-binding.md):
 * warnings (sslmode) + the two client-side pool rules the platform cannot set.
 */
export function analyzeDsn(
    dsn: string,
    envName: string,
): { warnings: string[]; contract: string[] } {
    const warnings: string[] = [];
    if (/[?&]sslmode=disable(&|$)/.test(dsn)) {
        warnings.push(
            `${envName} DSN uses sslmode=disable — traffic to the database is unencrypted. Acceptable only for in-cluster gateways (e.g. pggw); never for a database reached over a network boundary.`,
        );
    }
    const contract = [
        "Pool idle timeout must be < the gateway's 60s idle window (keep ~10s, and min idle connections at 0 so an idle pool doesn't keep the database awake).",
        "Connect timeout must be ≥ 10s: a cold database wakes in ~2.5s and default 2–5s timeouts can give up right before the wake completes.",
    ];
    return { warnings, contract };
}

/**
 * Exec boundary: injectable capture-runner so tests can assert the EXACT argv
 * issued (and that --dry-run issues none) without shelling out. Production
 * passes {@link runCapture} (execFileSync, shell:false — CLI-58).
 */
export type DbBindExec = (argv: readonly string[]) => string;

export interface DbBindDeps {
    exec: DbBindExec;
    /** stdout writer (writeSync(1, …) in production; a spy in tests). */
    write: (text: string) => void;
}

/** Print the DSN warnings + pool contract when a DSN is locally resolvable. */
function printDsnContract(opts: DbBindOptions, deps: DbBindDeps): void {
    let dsn = opts.dsn;
    if (!dsn && opts.secretFile) {
        const key = opts.key ?? ENV_DATABASE_URL;
        try {
            dsn = extractDsnFromSecretManifest(
                readFileSync(opts.secretFile, "utf-8"),
                key,
            );
        } catch {
            deps.write(
                `note: could not read --secret-file ${opts.secretFile}; skipping the DSN contract check\n`,
            );
            return;
        }
        if (!dsn) {
            deps.write(
                `note: key "${key}" not found in ${opts.secretFile}; skipping the DSN contract check\n`,
            );
            return;
        }
    }
    if (!dsn) return;

    const { warnings, contract } = analyzeDsn(dsn, ENV_DATABASE_URL);
    for (const w of warnings) {
        deps.write(`WARN  ${w}\n`);
    }
    deps.write("Connection contract (client-side pool settings):\n");
    for (const c of contract) {
        deps.write(`  - ${c}\n`);
    }
}

/**
 * Run the bind. Validation order: args → local config (when provided) → the
 * live CR — then exactly ONE cluster write (the merge-patch), or a printed
 * patch on --dry-run (zero cluster calls).
 */
export async function runDbBind(
    appName: string,
    opts: DbBindOptions,
    deps: DbBindDeps,
    localConfig?: unknown,
): Promise<void> {
    validateDbBindOptions(opts);

    // Local config cross-check (managed-mode `database.enabled` may live in
    // kn-next.config.ts before it ever reaches a CR).
    if (localConfig && typeof localConfig === "object") {
        const cfg = localConfig as {
            database?: Record<string, unknown>;
            secrets?: { envMap?: Record<string, unknown> };
        };
        validateBindAgainstSpec(
            opts,
            { database: cfg.database, secrets: cfg.secrets },
            "config",
        );
    }

    if (opts.dryRun) {
        deps.write(renderDbBindPatchYaml(opts));
        printDsnContract(opts, deps);
        return;
    }

    // Read the live CR (read-only) and validate ADR-0019's matrix against it
    // BEFORE emitting the single write.
    let liveRaw: string;
    try {
        liveRaw = deps.exec([
            "kubectl",
            "get",
            "nextapp",
            appName,
            "-n",
            opts.namespace,
            "-o",
            "json",
        ]);
    } catch (err) {
        throw new Error(
            `NextApp "${appName}" not found in namespace "${opts.namespace}" — run \`kn-next deploy\` first, or use --dry-run to preview the patch. (${(err as Error).message})`,
        );
    }
    const live = JSON.parse(liveRaw) as { spec?: BindTargetSpec };
    validateBindAgainstSpec(opts, live.spec ?? {}, "cluster");

    const patch = buildDbBindPatch(opts);
    deps.exec([
        "kubectl",
        "patch",
        "nextapp",
        appName,
        "-n",
        opts.namespace,
        "--type",
        "merge",
        "-p",
        JSON.stringify(patch),
    ]);

    // Silent-prune guard: on a cluster whose operator predates the
    // spec.database.secretRef schema (pre-#222 CRD), structural-schema pruning
    // drops the field — `kubectl patch` still exits 0 and NOTHING binds.
    // Re-read the CR and fail loudly instead of logging a false success.
    const verifyRaw = deps.exec([
        "kubectl",
        "get",
        "nextapp",
        appName,
        "-n",
        opts.namespace,
        "-o",
        "json",
    ]);
    const verified = JSON.parse(verifyRaw) as {
        spec?: { database?: { secretRef?: unknown } };
    };
    if (verified.spec?.database?.secretRef === undefined) {
        throw new Error(
            "operator predates spec.database.secretRef — upgrade the operator bundle (kubectl apply the latest install.yaml), then re-run",
        );
    }

    printDsnContract(opts, deps);
}

const DB_BIND_HELP = `kn-next db bind — bind an existing Postgres Secret to the NextApp CR (ADR-0019)

Usage:
  kn-next db bind [<app>] --secret <name> [options]

Options:
  --secret <name>       Secret carrying the DATABASE_URL DSN (required)
  --key <key>           Key inside --secret (server default: DATABASE_URL)
  --ro-secret <name>    Secret carrying a read-only DSN -> DATABASE_URL_RO
  --ro-key <key>        Key inside --ro-secret (server default: DATABASE_URL_RO)
  -n, --namespace <ns>  Kubernetes namespace (default: default)
  --dry-run             Print the CR merge-patch YAML without applying it
  --dsn <dsn>           Local-only DSN to run the connection-contract check on
  --secret-file <path>  Local Secret manifest to resolve the DSN from
  -h, --help            Show this help
`;

/** Entry for the `kn-next db …` subcommand family. */
export async function dbMain(argv: readonly string[]): Promise<void> {
    const [sub, ...rest] = argv;
    if (sub === undefined || sub === "-h" || sub === "--help") {
        writeSync(1, DB_BIND_HELP);
        return;
    }
    if (sub !== "bind") {
        throw new Error(
            `unknown db subcommand "${sub}" — available: bind (kn-next db bind --help)`,
        );
    }
    if (rest.includes("-h") || rest.includes("--help")) {
        writeSync(1, DB_BIND_HELP);
        return;
    }

    const opts = parseDbBindArgs(rest);

    // Resolve the app name: positional wins, else the local config's name.
    // The config (when present) also feeds the managed-mode conflict check.
    let localConfig: KnativeNextConfig | undefined;
    if (existsSync("kn-next.config.ts")) {
        localConfig = await loadConfig();
    }
    const appName = opts.app ?? localConfig?.name;
    if (!appName) {
        throw new Error(
            "app name required: pass it as a positional (kn-next db bind <app> …) or run from a directory with kn-next.config.ts",
        );
    }

    log.info(
        { app: appName, namespace: opts.namespace, dryRun: opts.dryRun },
        "kn-next db bind (CR merge-patch only — the operator reconciles the env wiring)",
    );

    await runDbBind(
        appName,
        opts,
        { exec: (a) => runCapture(a), write: (t) => writeSync(1, t) },
        localConfig,
    );

    if (!opts.dryRun) {
        log.info(
            { app: appName, secret: opts.secret },
            "Patched NextApp spec.database — the operator injects DATABASE_URL via the envMap machinery",
        );
    }
}

// Run only when invoked directly as the entry (not when imported by tests or
// the kn-next bin dispatcher).
if (isEntrypoint(import.meta.url)) {
    try {
        await dbMain(process.argv.slice(2));
    } catch (err) {
        log.fatal({ err }, "db bind failed");
        process.exit(1);
    }
}
