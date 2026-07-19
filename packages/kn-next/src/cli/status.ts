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
 * until Ready=True, bounded (default 10m), exits 1 on timeout, and tolerates a
 * short streak of transient kubectl failures so CI gates survive blips.
 *
 * Condition polarity matters: Ready/DatabaseReady alarm when False, but
 * Degraded/Reconciling alarm when True — the operator's reason + message
 * render verbatim whenever a condition is in its BAD state.
 */

import { existsSync, writeSync } from "node:fs";
import type { KnativeNextConfig } from "../config";
import { type KubectlFn, kubectlRunner } from "./doctor";
import { excerpt, loadConfig } from "./shared";

/** --watch poll interval. */
const WATCH_INTERVAL_MS = 5_000;
/** --watch default bound: 10 minutes. */
const WATCH_TIMEOUT_MS = 600_000;
/**
 * --watch tolerates this many CONSECUTIVE transient kubectl failures before
 * throwing — a `deploy && status --watch` CI gate must not die on one
 * apiserver blip mid-poll. The streak resets on any successful read.
 */
const WATCH_MAX_TRANSIENT_FAILURES = 3;

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
    if (out.json && out.watch) {
        // Rejected rather than silently concatenating JSON documents a parser
        // would choke on. If NDJSON streaming is ever wanted, it gets designed
        // deliberately — not implied by a flag combination.
        throw new Error(
            "--json cannot be combined with --watch (a 5s poll would emit concatenated JSON documents); poll `kn-next status --json` from your script instead (see kn-next status --help)",
        );
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

export type DatabaseMode = "bound" | "none";

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
        database?: { secretRef?: { name?: string } };
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
    // A malformed CR (conditions not an array) must degrade to "not reported",
    // never crash the renderer.
    const rawConditions = raw.status?.conditions;
    const conditions: RawCondition[] = Array.isArray(rawConditions)
        ? rawConditions
        : [];
    const byType = (t: string) =>
        conditionView(conditions.find((c) => c.type === t));

    const db = raw.spec?.database;
    const mode: DatabaseMode = db?.secretRef ? "bound" : "none";

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

/** Every label the human table can print — alignment uses the widest one. */
const LABELS = [
    "NextApp",
    "URL",
    "Ready",
    "Degraded",
    "Reconciling",
    "Database",
    "DatabaseReady",
    "Image",
] as const;
const LABEL_WIDTH = Math.max(...LABELS.map((l) => l.length));

/**
 * Condition polarity: the status value that means "something is wrong". Ready
 * and DatabaseReady alarm when False; Degraded and Reconciling (and any future
 * DatabaseOrphaned-style condition) alarm when True. The operator's reason +
 * message render VERBATIM whenever a condition is in its bad state — that
 * guidance is the whole point of honest status.
 */
type BadWhen = "True" | "False";

function conditionLine(
    label: (typeof LABELS)[number],
    c: ConditionView | undefined,
    now: Date,
    badWhen: BadWhen,
): string {
    if (!c) {
        return `${label.padEnd(LABEL_WIDTH)} ${NOT_REPORTED}`;
    }
    // Unknown is never the healthy state — surface its reason/message too.
    const bad = c.status === badWhen || c.status === "Unknown";
    const age = c.lastTransitionTime
        ? ` (${humanizeAge(c.lastTransitionTime, now)})`
        : "";
    let line = `${label.padEnd(LABEL_WIDTH)} ${c.status}${age}`;
    // Ready's reason is informative even when healthy; other conditions only
    // carry a meaningful reason in their bad state.
    if ((bad || label === "Ready") && c.reason) {
        line += `  ${c.reason}`;
    }
    if (bad && c.message) {
        line += `\n${"".padEnd(LABEL_WIDTH + 1)}${c.message}`;
    }
    return line;
}

function plainLine(label: (typeof LABELS)[number], value: string): string {
    return `${label.padEnd(LABEL_WIDTH)} ${value}`;
}

/** Render the human summary. */
export function renderStatusHuman(model: StatusModel, now: Date): string {
    const lines: string[] = [];
    lines.push(
        plainLine("NextApp", `${model.name} (namespace: ${model.namespace})`),
    );
    lines.push(plainLine("URL", model.url ?? "not reported"));
    lines.push(conditionLine("Ready", model.ready, now, "False"));
    lines.push(conditionLine("Degraded", model.degraded, now, "True"));
    lines.push(conditionLine("Reconciling", model.reconciling, now, "True"));
    const dbLabel =
        model.database.mode === "none"
            ? "none"
            : `${model.database.mode}${model.database.secretName ? ` (secret: ${model.database.secretName})` : ""}`;
    lines.push(plainLine("Database", dbLabel));
    if (model.database.mode !== "none") {
        lines.push(
            conditionLine("DatabaseReady", model.databaseReady, now, "False"),
        );
    }
    lines.push(plainLine("Image", model.image ?? "not reported"));
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
            `cluster unreachable (${excerpt(stderr) || "kubectl failed with no stderr"}) — check your kubeconfig/context; \`kn-next doctor\` diagnoses cluster prereqs.`,
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
    let consecutiveFailures = 0;
    for (;;) {
        // One blip must not kill a CI gate: tolerate a short streak of
        // transient kubectl failures; only a persistent outage throws.
        let model: StatusModel | undefined;
        try {
            model = fetchModel(appName, opts.namespace, deps);
            consecutiveFailures = 0;
        } catch (err) {
            consecutiveFailures++;
            if (consecutiveFailures > WATCH_MAX_TRANSIENT_FAILURES) {
                throw err;
            }
            deps.write(
                `transient kubectl failure (${consecutiveFailures}/${WATCH_MAX_TRANSIENT_FAILURES} tolerated), retrying in ${WATCH_INTERVAL_MS / 1000}s: ${(err as Error).message}\n`,
            );
        }
        if (model) {
            renderOnce(model, opts, deps);
            if (model.ready?.status === "True") {
                return 0;
            }
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
Degraded, Reconciling, Database (bound|none + bound Secret), image.
Conditions an older operator does not report render as "not reported".

Exit code: 1 iff Ready=False — usable as a CI gate after kn-next deploy.

Usage:
  kn-next status [<app>] [options]

Options:
  -n, --namespace <ns>  Kubernetes namespace (default: default)
  --json                Emit the structured status subset as JSON (one-shot
                        only — cannot be combined with --watch; poll --json
                        from your script instead)
  --watch               Poll every 5s until Ready=True (bounded: 10m, exit 1 on
                        timeout; tolerates up to 3 consecutive transient
                        kubectl failures)
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

// NO self-entry block here, DELIBERATELY — this module is reached ONLY via
// the kn-next bin's subcommand dispatch (see the hazard note atop deploy.ts's
// dispatcher: an isEntrypoint block in a bin-dispatched module re-arms the
// tsup-inlining hijack, #263).
