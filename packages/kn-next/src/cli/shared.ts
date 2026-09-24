/**
 * Shared CLI utilities for knext build and deploy commands.
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
 * Discriminator carried by a USAGE mistake — an unknown flag, a stray
 * positional, an unknown subcommand. Same string-`code` reasoning as
 * {@link CONFIG_NOT_FOUND_CODE}: bundling makes `instanceof` unreliable.
 */
export const USAGE_ERROR_CODE = "ERR_KN_USAGE";

/**
 * The user mis-typed the command line. That is an expected state, so it must
 * render as a message — never as `log.fatal({ err })`, which serialises the
 * Error with its stack and an absolute dist chunk path. A reviewer caught
 * exactly that on the strict-flag rejections: `knext celanup` (a typo) got a
 * clean one-liner while `knext cleanup -v` (also a typo) got a stack dump.
 *
 * Every CLI module raises usage mistakes through this class; a scan in
 * cli-dispatch-contract.test.ts fails the build if one goes back to `Error`.
 */
export class UsageError extends Error {
    readonly code = USAGE_ERROR_CODE;

    constructor(message: string) {
        super(message);
        this.name = "UsageError";
    }
}

/**
 * If `err` is a usage mistake, print its message (plus a help pointer when the
 * message does not already carry one) and report that it was handled.
 * Anything else is left to the caller's fatal path.
 */
export function handleUsageError(
    err: unknown,
    write: (text: string) => void = (text) => writeSync(2, text),
): boolean {
    if (
        typeof err !== "object" ||
        err === null ||
        (err as { code?: unknown }).code !== USAGE_ERROR_CODE
    ) {
        return false;
    }
    const message = String((err as { message?: unknown }).message ?? "");
    // Most of these messages already end in "(see knext <verb> --help)"; only
    // add the generic pointer when the user was given none.
    const pointer = message.includes("--help")
        ? ""
        : "\n\nRun `knext --help` to see the available commands.";
    write(`${message}${pointer}\n`);
    return true;
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
 * Thread an explicit `--context <ctx>` into a kubectl argv (#978).
 *
 * Every cluster-writing verb (deploy, cleanup, gc, rollback, db bind, preview)
 * must target the cluster the user NAMED, not whatever `kubectl` happens to have
 * as its ambient current-context — otherwise `knext cleanup --context staging`
 * silently deletes on production. This is the single place that shape is built,
 * so a verb honours `--context` by resolving it once (see {@link
 * resolveKubeContext}) and wrapping every kubectl argv it issues.
 *
 * The flag is inserted immediately after the `kubectl` binary token. kubectl
 * treats `--context` as a global flag, so position is not load-bearing, but
 * keeping it first makes the argv guard's scan unambiguous. When no context was
 * resolved the argv is returned UNCHANGED (a fresh copy) — the ambient
 * current-context is the documented default, exactly as before this change.
 *
 * @param argv - a kubectl argv whose first element is the `kubectl` binary
 * @param context - the resolved --context value, or undefined for "ambient"
 */
export function withKubeContext(
    argv: readonly string[],
    context?: string,
): string[] {
    if (!context) {
        return [...argv];
    }
    const [cmd, ...rest] = argv;
    if (cmd === undefined) {
        // Defensive: an empty argv is a programmer error, but never fabricate a
        // bare `kubectl --context <ctx>` out of nothing.
        return [];
    }
    return [cmd, "--context", context, ...rest];
}

/**
 * Resolve the kubectl context a verb should target: the explicit `--context`
 * flag wins, else the `KN_CONTEXT` env var (parity with `KN_NAMESPACE`), else
 * undefined ⇒ the ambient current-context. Returned undefined rather than a
 * sentinel so {@link withKubeContext} is a no-op in the default case.
 */
export function resolveKubeContext(flag?: string): string | undefined {
    return flag || process.env.KN_CONTEXT || undefined;
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

/**
 * `kn-next` → `knext` rename (#1369). `deploy.ts`'s dispatcher (the ONLY
 * sanctioned self-entry — see its SELF-ENTRY HAZARD note) is still built as
 * a SINGLE tsup entry, `dist/cli/kn-next.js`
 * — a second tsup entry pointing at the same source shares a chunk with it,
 * which breaks `isEntrypoint` for BOTH (measured live in this round: the
 * dispatcher silently never fired for either bin). `dist/cli/knext.js` is
 * therefore a separate, tiny RUNTIME proxy (src/cli/knext.ts) that re-execs
 * `kn-next.js` in-process, so from `deploy.ts`'s own perspective it is
 * ALWAYS "running as kn-next.js" — this env var is how the proxy tells it
 * "but don't call it that": set before the proxy's dynamic import, so it is
 * in scope before `deploy.ts`'s top level runs.
 */
export const KNEXT_CANONICAL_BIN_ENV = "KNEXT_CANONICAL_BIN";

const DEPRECATED_KN_NEXT_NOTICE =
    "`kn-next` is deprecated and will be removed in a future minor release — use `knext` instead (same command, same flags).\n";

/**
 * Print the one-line deprecation notice to stderr, UNLESS the canonical
 * `knext` proxy marked this invocation via {@link KNEXT_CANONICAL_BIN_ENV}.
 * Reads `process.env` by default; the parameter exists so this stays a pure,
 * directly-testable function rather than one more thing a test has to mutate
 * global `process.env` to exercise.
 */
export function printDeprecatedKnNextNoticeIfNeeded(
    env: NodeJS.ProcessEnv = process.env,
): void {
    if (env[KNEXT_CANONICAL_BIN_ENV] === "1") {
        return;
    }
    writeSync(2, DEPRECATED_KN_NEXT_NOTICE);
}
