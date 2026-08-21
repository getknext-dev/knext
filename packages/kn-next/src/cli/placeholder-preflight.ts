/**
 * Fail-fast placeholder preflight (UX ledger row 4, finding 4b).
 *
 * The scaffold ships `registry: "ghcr.io/<your-user>"`, and row 4 measured
 * that value flowing SILENTLY into the build: the persona burns a full
 * multi-minute `next build` and fails at the image push — the most expensive
 * possible place to learn the config is unfinished. This module makes deploy
 * (and `kn-next validate`) say so up front, per field, in plain English.
 *
 * The scan is GENERIC over the config object — every string field, however
 * nested, wherever it lives (workflow rule: scan, don't enumerate). An
 * enumerated field list is how the second placeholder field gets missed; the
 * suite's adversarial-dodge cases (an unknown deeply-nested key, an array
 * element) exist to keep this generic.
 *
 * ONE type-level carve-out (architect gate, ADR-0046 Amendment 1): the root
 * `env` map is exempt — see the comment inside {@link findPlaceholders}.
 */

import type { KnativeNextConfig } from "../config";
import { DOCS_URL } from "./help";
import { UsageError } from "./shared";

/** One placeholder hit: where it is, and the value still sitting there. */
export interface PlaceholderFinding {
    /** Dot path into the config (`registry`, `storage.bucket`, `domains[1]`). */
    path: string;
    value: string;
}

/**
 * `<...>`-shaped: an angle-bracket pair with at least one character inside,
 * the shape every scaffold placeholder uses (`<your-user>`,
 * `<your-assets-bucket>`, `<your-db-secret>`). A lone `<` with no closing
 * bracket is someone's real value, not a placeholder.
 */
const PLACEHOLDER_RE = /<[^<>]+>/;

/**
 * Walk the config object generically and collect every string field that
 * still carries a `<...>` placeholder — except the root `env` free-text map
 * (see the carve-out comment below). Absent optional blocks (storage —
 * ADR-0047's valid image-served mode) simply are not visited: absence is
 * never a finding. Cycle-safe: a self-referencing config terminates.
 */
export function findPlaceholders(
    config: KnativeNextConfig,
): PlaceholderFinding[] {
    const findings: PlaceholderFinding[] = [];
    const seen = new WeakSet<object>();

    const visit = (value: unknown, path: string): void => {
        if (typeof value === "string") {
            if (PLACEHOLDER_RE.test(value)) {
                findings.push({ path, value });
            }
            return;
        }
        if (value === null || typeof value !== "object") {
            return;
        }
        if (seen.has(value)) {
            return;
        }
        seen.add(value);
        if (Array.isArray(value)) {
            value.forEach((item, i) => {
                visit(item, `${path}[${i}]`);
            });
            return;
        }
        for (const [key, child] of Object.entries(value)) {
            // Architect-gate carve-out: the ROOT `env` map (config.ts
            // `env?: Record<string, string>`) is exempt from the scan — SKIPPED,
            // not warn-tiered. It is the config's one free-text surface: arbitrary
            // user data where `<...>` is at least as likely to be real markup
            // (`ALLOWED_TAGS: "<b><i>"`, a template string) as a forgotten
            // placeholder — the scaffold never puts placeholders in env, so a hit
            // here has no scaffold provenance. A hard fail would make a
            // schema-valid config undeployable with no escape, and even a warning
            // would assert "this is the placeholder from the scaffold" about the
            // user's own data on every deploy — the gate's principle is that a
            // confidently wrong hint is worse than none, so the scan says nothing.
            // Exactly `path === ""` + key `env`: a nested block that happens to be
            // named env is not the contract's free-text map and stays scanned
            // (pinned by the dodge tests, so this cannot widen silently).
            if (path === "" && key === "env") {
                continue;
            }
            visit(child, path === "" ? key : `${path}.${key}`);
        }
    };

    visit(config, "");
    return findings;
}

/**
 * What each known field IS, for a reader with zero cloud/Kubernetes
 * background — one sentence of what, one of what to put there. Fields not
 * listed here still get flagged (the scan is generic); they fall back to
 * {@link GENERIC_GUIDANCE}.
 */
const FIELD_GUIDANCE: Record<string, string> = {
    registry:
        "The registry is where your app's container image gets pushed so the cluster can pull it.\n" +
        "    Put a registry you can push to — e.g. ghcr.io/YOUR_GITHUB_USERNAME after `docker login ghcr.io`.",
    "storage.bucket":
        "The bucket is the cloud storage location your app's static files (JS, CSS, images) are uploaded to.\n" +
        "    Put the name of a bucket you own — or delete the whole `storage` block to serve those files from the image instead.",
    "storage.publicUrl":
        "The public URL is the web address browsers use to fetch the static files in that bucket.\n" +
        "    Put your bucket's public base URL — or delete the whole `storage` block to serve those files from the image instead.",
    "database.secretRef.name":
        "This names the Kubernetes Secret holding your database connection string.\n" +
        "    Put the name of a Secret that exists in your cluster (see `kn-next db bind`), or remove the `database` block.",
};

const GENERIC_GUIDANCE =
    "This value is still the placeholder from the scaffold.\n" +
    "    Replace it with a real value before deploying.";

/**
 * Render the findings as the plain-English preflight message: per field —
 * what it is in one sentence, what to put there — and a docs link. No stack,
 * no serialized error, no Kubernetes vocabulary the reader has not met.
 */
export function formatPlaceholderFindings(
    findings: readonly PlaceholderFinding[],
): string {
    const lines: string[] = [
        "kn-next.config.ts still contains placeholder values:",
        "",
    ];
    for (const f of findings) {
        lines.push(`  ${f.path}: "${f.value}"`);
        lines.push(`    ${FIELD_GUIDANCE[f.path] ?? GENERIC_GUIDANCE}`);
        lines.push("");
    }
    lines.push(
        "Nothing was built or deployed. Fix the values above, then run",
        "`kn-next validate` to re-check without touching anything.",
        "",
        `Docs: ${DOCS_URL}`,
    );
    return `${lines.join("\n")}\n`;
}

/**
 * The UsageError FAMILY carrier for placeholder findings: it inherits the
 * `ERR_KN_USAGE` code, so every CLI entry's existing handleUsageError catch
 * renders it as a plain write-and-exit message — never `log.fatal`, never a
 * serialized Error with a stack and a dist chunk path (the presentation
 * contract of #810 / ADR-0046).
 */
export class PlaceholderConfigError extends UsageError {
    readonly findings: readonly PlaceholderFinding[];

    constructor(findings: readonly PlaceholderFinding[]) {
        super(formatPlaceholderFindings(findings));
        this.name = "PlaceholderConfigError";
        this.findings = findings;
    }
}

/**
 * The preflight itself: call with the EFFECTIVE config (after CLI flag
 * overrides — a `--registry` override legitimately rescues a placeholder
 * file, and a placeholder typed as the override must still be caught),
 * BEFORE any build step, upload, or cluster access.
 */
export function assertNoPlaceholders(config: KnativeNextConfig): void {
    const findings = findPlaceholders(config);
    if (findings.length > 0) {
        throw new PlaceholderConfigError(findings);
    }
}
