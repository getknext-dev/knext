/**
 * vinext-on-node entry freshness (#1356) — LOCAL and read-only, so it runs
 * even when the cluster is unreachable (like storage-mode.ts).
 *
 * WHY THIS EXISTS: `knext-node-entry.mjs` is scaffolded ONCE by `knext
 * create` and never touched again — it is not re-rendered on `knext
 * build`/`deploy`. It changed runtime behavior once already (the deployed
 * Cache-Control normalization, `response-cache-control.mjs`'s
 * `applyVinextDeployDefault` + `cacheControlMiddleware`), but an app
 * scaffolded BEFORE that change keeps running its OLD copy silently forever
 * — no error, no crash, just the wrong `s-maxage=…` on every response,
 * exactly the shape this check was filed to catch. A version marker
 * (`KNEXT_NODE_ENTRY_MARKER`, in the template's leading comment) is the
 * cheapest signal doctor can compare without parsing or diffing the file.
 *
 * SCOPE: `knext-node-entry.mjs` is only ever RUN by an app on
 * `build: 'vinext'` + `runtime: 'node'` (`vite.config.ts.hbs` is what wires
 * nitro's `entry` to it under that combination). `knext create` scaffolds
 * the file into every app regardless of which build/runtime it will end up
 * selecting — a default-standalone or vinext×bun app carries an inert copy
 * it never executes. Comparing that inert copy's marker against the
 * packaged template is a false positive: the WARN names a runtime fix
 * (e.g. the Cache-Control normalization above) the app can never be
 * missing, because it never runs this file at all. So this check first
 * reads the app's OWN `kn-next.config.ts` (same pattern as
 * `storage-mode.ts`) and SKIPs unless it resolves to vinext-on-node —
 * `runtime` defaults to `"bun"` (ADR-0058/#1183), so an absent `runtime` is
 * NOT node.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RUNTIME_ID } from "../../../adapters/artifact-contract";
import type { KnativeNextConfig } from "../../../config";
import { templateRoot } from "../../create";
import { loadConfig } from "../../shared";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";

export const NODE_ENTRY_FILENAME = "knext-node-entry.mjs";
const TEMPLATE_FILENAME = "knext-node-entry.mjs.hbs";
const MARKER_RE = /KNEXT_NODE_ENTRY_MARKER:\s*(\d+)/;

/** Extract the marker number from a node-entry file's leading comment, or undefined if absent/unparseable. */
export function extractNodeEntryMarker(text: string): number | undefined {
    const m = MARKER_RE.exec(text);
    if (!m?.[1]) return undefined;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : undefined;
}

/** Real default: read `<cwd>/knext-node-entry.mjs`, or undefined if it is not there. */
function defaultReadAppEntry(): string | undefined {
    const path = join(process.cwd(), NODE_ENTRY_FILENAME);
    if (!existsSync(path)) return undefined;
    try {
        return readFileSync(path, "utf8");
    } catch {
        return undefined;
    }
}

/** Real default: read the PACKAGED template — the "current" marker to compare against. */
function defaultReadTemplateEntry(): string | undefined {
    try {
        return readFileSync(join(templateRoot(), TEMPLATE_FILENAME), "utf8");
    } catch {
        return undefined;
    }
}

/**
 * Default loadAppConfig: the real cwd loader. ANY failure — no config in this
 * directory, a config that does not validate — yields undefined: doctor
 * diagnoses, it must never crash on the state it is diagnosing. Mirrors
 * `storage-mode.ts`'s `loadAppConfigOrUndefined` (not shared — each check
 * module stays independently importable, per the #1055 decomposition).
 */
async function defaultLoadAppConfig(): Promise<KnativeNextConfig | undefined> {
    try {
        return await loadConfig();
    } catch {
        return undefined;
    }
}

/**
 * True iff `config` resolves to the ONLY cell that runs
 * `knext-node-entry.mjs`: `build: 'vinext'` + `runtime: 'node'`. `runtime`
 * defaults to `"bun"` (ADR-0058/#1183) — an absent `runtime` under
 * `build: 'vinext'` is the bun entry (`knext-bun-entry.mjs`), never this one.
 */
export function isVinextOnNode(config: KnativeNextConfig | undefined): boolean {
    if (!config) return false;
    return (
        config.build === "vinext" &&
        (config.runtime ?? DEFAULT_RUNTIME_ID) === "node"
    );
}

export async function nodeEntryStalenessCheck(
    ctx: CheckContext,
): Promise<CheckResult[]> {
    const loadAppConfig = ctx.deps.loadAppConfig ?? defaultLoadAppConfig;
    const config = await loadAppConfig();
    if (!isVinextOnNode(config)) {
        return [
            mk(
                "node-entry-staleness",
                "vinext-on-node entry freshness",
                "skip",
                "this app does not build with build: 'vinext' + runtime: 'node' " +
                    "(or no kn-next.config.ts was found) — knext-node-entry.mjs, " +
                    "if scaffolded, is never run",
            ),
        ];
    }

    const readAppEntry = ctx.deps.readNodeEntryFile ?? defaultReadAppEntry;
    const readTemplateEntry =
        ctx.deps.readNodeEntryTemplate ?? defaultReadTemplateEntry;

    const appEntry = readAppEntry();
    if (appEntry === undefined) {
        return [
            mk(
                "node-entry-staleness",
                "vinext-on-node entry freshness",
                "skip",
                "kn-next.config.ts selects build: 'vinext' + runtime: 'node', but no knext-node-entry.mjs was found in this directory — run doctor from the app directory",
            ),
        ];
    }

    const templateEntry = readTemplateEntry();
    const templateMarker =
        templateEntry === undefined
            ? undefined
            : extractNodeEntryMarker(templateEntry);
    if (templateMarker === undefined) {
        // Defensive: should never happen once the marker ships with the
        // package. An unreadable/unparseable template degrades the CHECK,
        // never the underlying question — skip rather than guess.
        return [
            mk(
                "node-entry-staleness",
                "vinext-on-node entry freshness",
                "skip",
                "could not read a KNEXT_NODE_ENTRY_MARKER from the packaged knext-node-entry.mjs.hbs template — the installed @getknext/core package may be incomplete or predates this check",
            ),
        ];
    }

    const appMarker = extractNodeEntryMarker(appEntry);
    if (appMarker === templateMarker) {
        return [
            mk(
                "node-entry-staleness",
                "vinext-on-node entry freshness",
                "pass",
                `knext-node-entry.mjs is current (marker ${templateMarker})`,
            ),
        ];
    }

    const from =
        appMarker === undefined
            ? "carries no marker at all — scaffolded before this check existed"
            : `is at marker ${appMarker}`;
    return [
        mk(
            "node-entry-staleness",
            "vinext-on-node entry freshness",
            "warn",
            `knext-node-entry.mjs ${from}; the installed @getknext/core is at marker ${templateMarker} — this app may be missing a runtime fix (e.g. a deployed Cache-Control normalization) that a newer scaffold ships`,
            `copy the current template over yours: knext create --force <scratch-dir> in a throwaway directory, then replace this app's knext-node-entry.mjs with the freshly scaffolded one (diff first if you made local edits)`,
        ),
    ];
}
