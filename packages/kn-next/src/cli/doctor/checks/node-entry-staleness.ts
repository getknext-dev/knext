/**
 * vinext-on-node entry freshness (#1356) — LOCAL and read-only, so it runs
 * even when the cluster is unreachable (like storage-mode.ts).
 *
 * WHY THIS EXISTS: `knext-node-entry.mjs` is scaffolded ONCE by `kn-next
 * create` and never touched again — it is not re-rendered on `kn-next
 * build`/`deploy`. #1353 changed its runtime behavior (added the deployed
 * Cache-Control normalization, `response-cache-control.mjs`'s
 * `applyVinextDeployDefault` + `cacheControlMiddleware`), but an app
 * scaffolded BEFORE that change keeps running its OLD copy silently forever
 * — no error, no crash, just the wrong `s-maxage=…` on every response,
 * exactly the shape #1356 was filed to catch. A version marker
 * (`KNEXT_NODE_ENTRY_MARKER`, in the template's leading comment) is the
 * cheapest signal doctor can compare without parsing or diffing the file.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { templateRoot } from "../../create";
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

export function nodeEntryStalenessCheck(ctx: CheckContext): CheckResult[] {
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
                "no knext-node-entry.mjs in this directory — run doctor from the app directory, or this app does not use build: 'vinext' + runtime: 'node'",
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
            `knext-node-entry.mjs ${from}; the installed @getknext/core is at marker ${templateMarker} — this app may be missing a runtime fix (e.g. #1353's deployed Cache-Control normalization) that a newer scaffold ships`,
            `copy the current template over yours: kn-next create --force <scratch-dir> in a throwaway directory, then replace this app's knext-node-entry.mjs with the freshly scaffolded one (diff first if you made local edits)`,
        ),
    ];
}
