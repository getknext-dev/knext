#!/usr/bin/env node

/**
 * kn-next status — surface the NextApp CR's honest conditions.
 *
 * Usage:
 *   kn-next status [<app>] [-n <namespace>] [--json] [--watch]
 *
 * The operator reports rich truth on the CR — Ready (with reasons like
 * IngressNotProgrammed and the #208 guidance in the message), Degraded,
 * DatabaseReady (Provisioned|Bound), Reconciling, status.url and
 * status.databaseSecretName — but until now users had to kubectl-describe to
 * see it. This command renders that truth at the terminal.
 *
 * READ-ONLY by construction (ADR-0001): the ONLY cluster call is a
 * `kubectl get nextapp <app> -o json`. The CLI never mutates cluster state
 * here — the operator stays the single source of truth.
 *
 * Exit-code contract (CI-usable): exit 1 iff the Ready condition is present
 * with status False; a missing condition (operator predating the honest-Ready
 * work) renders as "not reported" and does NOT fail. --watch polls every 5s
 * until Ready=True, bounded (default 10m), and exits 1 on timeout.
 */

import { existsSync, writeSync } from "node:fs";
import type { KnativeNextConfig } from "../config";
import { createLogger } from "../utils/logger";
import { type KubectlFn, kubectlRunner } from "./doctor";
import { isEntrypoint } from "./exec";
import { loadConfig } from "./shared";

const log = createLogger({ module: "status" });

/** --watch poll interval. */
const WATCH_INTERVAL_MS = 5_000;
/** --watch default bound: 10 minutes. */
const WATCH_TIMEOUT_MS = 600_000;

export interface StatusOptions {
    /** NextApp name; defaults to the local config's `name`. */
    app?: string;
    namespace: string;
    json: boolean;
    watch: boolean;
    /** --watch bound; the poll gives up (exit 1) once this elapses. */
    timeoutMs: number;
}

/** Parse `kn-next status` argv (after the `status` word). */
export function parseStatusArgs(argv: readonly string[]): StatusOptions {
    const out: StatusOptions = {
        namespace: "default",
        json: false,
        watch: false,
        timeoutMs: WATCH_TIMEOUT_MS,
    };
    // Same discipline as db-bind: a value-taking flag must actually have a
    // value, and unknown flags fail loudly (a typo like `--wacth` must not
    // silently run a one-shot status a CI script then misreads).
    const need = (flag: string, i: number): string => {
        const v = argv[i];
        if (v === undefined || v.startsWith("-")) {
            throw new Error(
                `${flag} requires a value (see kn-next status --help)`,
            );
        }
        return v;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "-n" || a === "--namespace") {
            out.namespace = need(a, ++i);
        } else if (a === "--json") {
            out.json = true;
        } else if (a === "--watch") {
            out.watch = true;
        } else if (a.startsWith("-")) {
            throw new Error(`unknown flag "${a}" (see kn-next status --help)`);
        } else if (out.app === undefined) {
            out.app = a;
        } else {
            throw new Error(
                `unexpected positional "${a}" — only one <app> positional is accepted (see kn-next status --help)`,
            );
        }
    }
    return out;
}

/** One condition as the CLI surfaces it — the operator's words, verbatim. */
export interface ConditionView {
    status: "True" | "False" | "Unknown";
    reason?: string;
    message?: string;
    lastTransitionTime?: string;
}

export type DatabaseMode = "managed" | "bound" | "none";

/** The structured subset `--json` emits and the human renderer consumes. */
export interface StatusModel {
    name: string;
    namespace: string;
    url?: string;
    /** spec.image — digest-pinned by policy (the operator rejects :latest). */
    image?: string;
    ready?: ConditionView;
    degraded?: ConditionView;
    databaseReady?: ConditionView;
    reconciling?: ConditionView;
    database: { mode: DatabaseMode; secretName?: string };
}

interface RawCondition {
    type?: string;
    status?: string;
    reason?: string;
    message?: string;
    lastTransitionTime?: string;
}

interface RawNextApp {
    metadata?: { name?: string; namespace?: string };
    spec?: {
        image?: string;
        database?: { enabled?: boolean; secretRef?: { name?: string } };
    };
    status?: {
        url?: string;
        databaseSecretName?: string;
        conditions?: RawCondition[];
    };
}

function conditionView(c: RawCondition | undefined): ConditionView | undefined {
    if (!c) return undefined;
    const status =
        c.status === "True" || c.status === "False" ? c.status : "Unknown";
    return {
        status,
        reason: c.reason,
        message: c.message,
        lastTransitionTime: c.lastTransitionTime,
    };
}

/**
 * CR json → structured model. Degrades gracefully on operators predating the
 * newer conditions: an absent condition is simply `undefined` ("not
 * reported"), never a crash.
 */
export function extractStatus(cr: unknown): StatusModel {
    const raw = (cr ?? {}) as RawNextApp;
    const conditions = raw.status?.conditions ?? [];
    const byType = (t: string) =>
        conditionView(conditions.find((c) => c.type === t));

    const db = raw.spec?.database;
    const mode: DatabaseMode = db?.enabled
        ? "managed"
        : db?.secretRef
          ? "bound"
          : "none";

    return {
        name: raw.metadata?.name ?? "<unknown>",
        namespace: raw.metadata?.namespace ?? "default",
        url: raw.status?.url,
        image: raw.spec?.image,
        ready: byType("Ready"),
        degraded: byType("Degraded"),
        databaseReady: byType("DatabaseReady"),
        reconciling: byType("Reconciling"),
        database: {
            mode,
            secretName:
                mode === "none"
                    ? undefined
                    : (raw.status?.databaseSecretName ??
                      db?.secretRef?.name ??
                      undefined),
        },
    };
}

/** ISO timestamp → "3m ago" style age. "unknown" on garbage, never a crash. */
export function humanizeAge(iso: string, now: Date): string {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "unknown";
    const s = Math.max(0, Math.floor((now.getTime() - t) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}

const NOT_REPORTED = "not reported (operator predates this condition)";

function conditionLine(
    label: string,
    c: ConditionView | undefined,
    now: Date,
): string {
    if (!c) {
        return `${label.padEnd(10)} ${NOT_REPORTED}`;
    }
    const age = c.lastTransitionTime
        ? ` (${humanizeAge(c.lastTransitionTime, now)})`
        : "";
    let line = `${label.padEnd(10)} ${c.status}${age}`;
    // Ready=False (or any non-True truth) carries the operator's reason and
    // guidance VERBATIM — that message is the whole point of honest status.
    if (c.status !== "True" || label === "Ready") {
        if (c.reason) line += `  ${c.reason}`;
    }
    if (c.status !== "True" && c.message) {
        line += `\n${"".padEnd(11)}${c.message}`;
    }
    return line;
}

/** Render the human summary. */
export function renderStatusHuman(model: StatusModel, now: Date): string {
    const lines: string[] = [];
    lines.push(`NextApp    ${model.name} (namespace: ${model.namespace})`);
    lines.push(`URL        ${model.url ?? "not reported"}`);
    lines.push(conditionLine("Ready", model.ready, now));
    lines.push(conditionLine("Degraded", model.degraded, now));
    lines.push(conditionLine("Reconciling", model.reconciling, now));
    const dbLabel =
        model.database.mode === "none"
            ? "none"
            : `${model.database.mode}${model.database.secretName ? ` (secret: ${model.database.secretName})` : ""}`;
    lines.push(`Database   ${dbLabel}`);
    if (model.database.mode !== "none") {
        lines.push(conditionLine("DatabaseReady", model.databaseReady, now));
    }
    lines.push(`Image      ${model.image ?? "not reported"}`);
    return `${lines.join("\n")}\n`;
}

/** The --json contract: absent conditions are explicit nulls, not omissions. */
export function statusModelToJson(model: StatusModel): string {
    return `${JSON.stringify(
        {
            name: model.name,
            namespace: model.namespace,
            url: model.url ?? null,
            image: model.image ?? null,
            ready: model.ready ?? null,
            degraded: model.degraded ?? null,
            databaseReady: model.databaseReady ?? null,
            reconciling: model.reconciling ?? null,
            database: {
                mode: model.database.mode,
                ...(model.database.secretName !== undefined
                    ? { secretName: model.database.secretName }
                    : {}),
            },
        },
        null,
        2,
    )}\n`;
}

/**
 * Injectable deps: doctor's kubectl runner shape plus a writer and a clock, so
 * every test (including --watch's poll loop) is hermetic.
 */
export interface StatusDeps {
    kubectl: KubectlFn;
    /** stdout writer (writeSync(1, …) in production; a spy in tests). */
    write: (text: string) => void;
    now: () => Date;
    sleep: (ms: number) => Promise<void>;
}

/** Fetch + parse the CR, or throw a clean, hint-bearing error. */
function fetchModel(
    appName: string,
    namespace: string,
    deps: StatusDeps,
): StatusModel {
    const r = deps.kubectl([
        "kubectl",
        "get",
        "nextapp",
        appName,
        "-n",
        namespace,
        "-o",
        "json",
    ]);
    if (!r.ok) {
        const stderr = r.stderr.trim();
        if (/notfound|not found/i.test(stderr)) {
            throw new Error(
                `NextApp "${appName}" not found in namespace "${namespace}" — deploy it first (\`kn-next deploy\`); \`kn-next doctor\` checks the cluster prereqs (CRD installed, operator Ready).`,
            );
        }
        throw new Error(
            `cluster unreachable (${stderr.slice(0, 160) || "kubectl failed with no stderr"}) — check your kubeconfig/context; \`kn-next doctor\` diagnoses cluster prereqs.`,
        );
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(r.stdout);
    } catch {
        throw new Error(
            "kubectl returned unparseable JSON for the NextApp — re-run with -v or `kn-next doctor` to check the cluster.",
        );
    }
    return extractStatus(parsed);
}

/** Exit 1 iff Ready is PRESENT and False — absent = "not reported", not a failure. */
function exitCodeFor(model: StatusModel): 0 | 1 {
    return model.ready?.status === "False" ? 1 : 0;
}

function renderOnce(
    model: StatusModel,
    opts: StatusOptions,
    deps: StatusDeps,
): void {
    deps.write(
        opts.json
            ? statusModelToJson(model)
            : renderStatusHuman(model, deps.now()),
    );
}

/**
 * Run the status command. One-shot by default; --watch polls every 5s until
 * Ready=True (exit 0) or the bound elapses (exit 1). Returns the exit code.
 */
export async function runStatus(
    appName: string,
    opts: StatusOptions,
    deps: StatusDeps,
): Promise<number> {
    if (!opts.watch) {
        const model = fetchModel(appName, opts.namespace, deps);
        renderOnce(model, opts, deps);
        return exitCodeFor(model);
    }

    const start = deps.now().getTime();
    for (;;) {
        const model = fetchModel(appName, opts.namespace, deps);
        renderOnce(model, opts, deps);
        if (model.ready?.status === "True") {
            return 0;
        }
        if (deps.now().getTime() - start >= opts.timeoutMs) {
            deps.write(
                `watch timed out after ${Math.round(opts.timeoutMs / 60000)}m without Ready=True — the CR above is the operator's last honest word; \`kn-next doctor\` checks the cluster prereqs.\n`,
            );
            return 1;
        }
        await deps.sleep(WATCH_INTERVAL_MS);
    }
}

const STATUS_HELP = `kn-next status — show the NextApp's honest conditions (read-only)

Renders the operator-reported truth from the NextApp CR: URL, Ready (with the
operator's reason + guidance verbatim when False, e.g. IngressNotProgrammed),
Degraded, Reconciling, Database (managed|bound|none + bound Secret), image.
Conditions an older operator does not report render as "not reported".

Exit code: 1 iff Ready=False — usable as a CI gate after kn-next deploy.

Usage:
  kn-next status [<app>] [options]

Options:
  -n, --namespace <ns>  Kubernetes namespace (default: default)
  --json                Emit the structured status subset as JSON
  --watch               Poll every 5s until Ready=True (bounded: 10m, exit 1 on timeout)
  -h, --help            Show this help
`;

/** Entry for `kn-next status`. Returns the process exit code. */
export async function statusMain(argv: readonly string[]): Promise<number> {
    if (argv.includes("-h") || argv.includes("--help")) {
        writeSync(1, STATUS_HELP);
        return 0;
    }
    const opts = parseStatusArgs(argv);

    // Resolve the app name: positional wins, else the local config's name —
    // the same resolution `kn-next db bind` uses.
    let localConfig: KnativeNextConfig | undefined;
    if (opts.app === undefined && existsSync("kn-next.config.ts")) {
        localConfig = await loadConfig();
    }
    const appName = opts.app ?? localConfig?.name;
    if (!appName) {
        throw new Error(
            "app name required: pass it as a positional (kn-next status <app>) or run from a directory with kn-next.config.ts",
        );
    }

    return runStatus(appName, opts, {
        kubectl: kubectlRunner,
        write: (t) => writeSync(1, t),
        now: () => new Date(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
}

// Run only when invoked directly as the entry (not when imported by tests or
// the kn-next bin dispatcher).
if (isEntrypoint(import.meta.url)) {
    try {
        process.exit(await statusMain(process.argv.slice(2)));
    } catch (err) {
        log.fatal({ err }, "status failed");
        process.exit(1);
    }
}
