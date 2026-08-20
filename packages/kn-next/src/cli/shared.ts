/**
 * Shared CLI utilities for kn-next build and deploy commands.
 * Single source of truth for config loading.
 *
 * NOTE: copyAdapters and getNitroPreset were removed as part of the
 * vinext → official Next.js Adapter migration. The CLI now runs plain
 * `npm run build` which invokes `next build` with output:'standalone'.
 * Adapters are no longer copied to a Nitro .output/ directory.
 */

import { existsSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import type { KnativeNextConfig } from "../config";
import { DOCS_URL } from "./help";
import { validateConfig } from "./validate";

const CONFIG_FILE = "kn-next.config.ts";

/** Default cap for {@link excerpt} — keeps a hint line to one terminal row-ish. */
const DEFAULT_EXCERPT_MAX = 160;

/**
 * Build a bounded, whitespace-collapsed one-line excerpt of raw text (typically
 * kubectl stderr) for embedding in an error/hint message.
 *
 * Single source of truth for what `doctor.ts` and `status.ts` previously
 * hand-rolled (inconsistently — status did a bare `.slice` and did NOT collapse
 * whitespace). Steps: trim → collapse every run of whitespace (newlines, tabs,
 * spaces) to a single space → slice to `max`.
 *
 * The slice is by CODE POINT (`Array.from`), not UTF-16 unit, so a multi-byte
 * character (emoji, etc.) is never split into a lone surrogate at the cap.
 *
 * @param raw - the source text (may contain newlines / control-adjacent bytes)
 * @param max - maximum length in code points (default {@link DEFAULT_EXCERPT_MAX})
 */
export function excerpt(raw: string, max = DEFAULT_EXCERPT_MAX): string {
    const collapsed = raw.trim().replace(/\s+/g, " ");
    return Array.from(collapsed).slice(0, max).join("");
}

/**
 * Discriminator carried by the "there is no kn-next.config.ts here" error.
 *
 * A `code` string rather than an `instanceof` check on purpose: the CLI ships
 * as a tsup bundle whose subcommands are dynamic-imported chunks, so two copies
 * of a class can exist in one process and `instanceof` would silently stop
 * matching. A string on the error object survives any bundling.
 */
export const CONFIG_NOT_FOUND_CODE = "ERR_KN_CONFIG_NOT_FOUND";

/** The error {@link loadConfig} throws when the config file is simply absent. */
export class ConfigNotFoundError extends Error {
    readonly code = CONFIG_NOT_FOUND_CODE;
    readonly searchedDir: string;

    constructor(configPath: string, searchedDir: string) {
        super(`Config file not found: ${configPath}`);
        this.name = "ConfigNotFoundError";
        this.searchedDir = searchedDir;
    }
}

/**
 * Render the plain-English guidance for a missing config.
 *
 * This is an EXPECTED state — running the CLI in the wrong directory, or in an
 * app that has not been wired up yet — so the user gets directions, not an
 * exception dump. Deliberately free of Kubernetes vocabulary: the reader is a
 * Next.js developer who may never have heard of a cluster.
 */
export function formatConfigNotFound(searchedDir: string): string {
    return `${[
        `No ${CONFIG_FILE} found in ${searchedDir}`,
        "",
        `${CONFIG_FILE} is the file that tells knext about your app — its name,`,
        "where to push its container image, and where its static files go.",
        "",
        "Starting a new app?",
        "  npx @getknext/core create my-app",
        "",
        "Adding knext to an app you already have?",
        `  Add ${CONFIG_FILE} to the project root (next to package.json),`,
        "  then run this command again from that directory.",
        "",
        `  Docs: ${DOCS_URL}`,
    ].join("\n")}\n`;
}

/**
 * If `err` is the missing-config state, print the guidance and report that it
 * was handled; otherwise report false and write nothing, leaving genuine
 * failures to the caller's existing fatal path.
 *
 * Every runnable CLI entry routes its catch through this (scanned, not
 * enumerated, by cli-config-not-found.test.ts).
 */
export function handleConfigNotFound(
    err: unknown,
    write: (text: string) => void = (text) => writeSync(2, text),
): boolean {
    if (
        typeof err !== "object" ||
        err === null ||
        (err as { code?: unknown }).code !== CONFIG_NOT_FOUND_CODE
    ) {
        return false;
    }
    const dir =
        typeof (err as { searchedDir?: unknown }).searchedDir === "string"
            ? (err as { searchedDir: string }).searchedDir
            : process.cwd();
    write(formatConfigNotFound(dir));
    return true;
}

/**
 * Loads kn-next.config.ts from the current working directory.
 * Runs validation after loading — fails fast with clear error messages.
 */
export async function loadConfig(): Promise<KnativeNextConfig> {
    const cwd = process.cwd();
    const configPath = resolve(cwd, CONFIG_FILE);

    if (!existsSync(configPath)) {
        throw new ConfigNotFoundError(configPath, cwd);
    }

    const module = await import(configPath);
    const config: KnativeNextConfig = module.default;

    validateConfig(config);

    return config;
}
