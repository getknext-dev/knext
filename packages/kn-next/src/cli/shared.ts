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
import { basename, dirname, resolve } from "node:path";
import type { KnativeNextConfig } from "../config";
import { DOCS_URL } from "./help";
import { validateConfig } from "./validate";

export const CONFIG_FILE = "knext.config.ts";

/**
 * The pre-rename filename (#1559: `kn-next.config.ts` -> `knext.config.ts`).
 * knext no longer reads it -- NO dual-read (founder decision) -- but its
 * presence, when `knext.config.ts` is absent, is common enough (an app that
 * has not migrated the file yet) to deserve one specific, actionable error
 * instead of the generic "no config found here" guidance.
 */
export const LEGACY_CONFIG_FILE = "kn-next.config.ts";

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
 * Discriminator carried by the "there is no knext.config.ts here" error.
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
 * Discriminator carried by the "you still have the pre-rename config file"
 * error (#1559). Distinct from {@link CONFIG_NOT_FOUND_CODE}: this fires when
 * `knext.config.ts` is absent but `kn-next.config.ts` IS present -- the user
 * has an app, just under the old filename -- so the guidance is "rename it",
 * never a silent fallback (no dual-read, founder decision).
 */
export const LEGACY_CONFIG_FILE_CODE = "ERR_KN_LEGACY_CONFIG_FILE";

/** The error {@link loadConfig} throws when only the pre-rename filename exists. */
export class LegacyConfigFileError extends Error {
    readonly code = LEGACY_CONFIG_FILE_CODE;
    readonly legacyPath: string;

    constructor(legacyPath: string) {
        super(`Legacy config file found: ${legacyPath}`);
        this.name = "LegacyConfigFileError";
        this.legacyPath = legacyPath;
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
 * Render the plain-English guidance for the pre-rename config file (#1559).
 * ONE actionable line — rename the file — never a warning-and-continue: the
 * founder decision recorded on the issue is NO dual-read.
 */
export function formatLegacyConfigFile(legacyPath: string): string {
    const dir = dirname(legacyPath);
    return `${[
        `Found ${LEGACY_CONFIG_FILE} in ${dir}, but knext now reads ${CONFIG_FILE}.`,
        "",
        "Rename the file, then run this command again:",
        `  mv ${LEGACY_CONFIG_FILE} ${CONFIG_FILE}`,
        "",
        `  Docs: ${DOCS_URL}`,
    ].join("\n")}\n`;
}

/**
 * If `err` is a config-resolution error — missing entirely, or present only
 * under the pre-rename filename (#1559) — print the matching guidance and
 * report that it was handled; otherwise report false and write nothing,
 * leaving genuine failures to the caller's existing fatal path.
 *
 * Every runnable CLI entry routes its catch through this (scanned, not
 * enumerated, by cli-config-not-found.test.ts).
 */
export function handleConfigNotFound(
    err: unknown,
    write: (text: string) => void = (text) => writeSync(2, text),
): boolean {
    if (typeof err !== "object" || err === null) {
        return false;
    }
    const code = (err as { code?: unknown }).code;
    if (code === LEGACY_CONFIG_FILE_CODE) {
        const legacyPath =
            typeof (err as { legacyPath?: unknown }).legacyPath === "string"
                ? (err as { legacyPath: string }).legacyPath
                : resolve(process.cwd(), LEGACY_CONFIG_FILE);
        write(formatLegacyConfigFile(legacyPath));
        return true;
    }
    if (code !== CONFIG_NOT_FOUND_CODE) {
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
 * Loads knext.config.ts from the current working directory.
 * Runs validation after loading — fails fast with clear error messages.
 *
 * No dual-read (#1559, founder decision): `knext.config.ts` wins when
 * present. When it is ABSENT, a `kn-next.config.ts` in the same directory is
 * not read as a fallback — it throws {@link LegacyConfigFileError} instead,
 * so the caller can print one actionable "rename the file" error rather than
 * silently continuing on the old name.
 */
export async function loadConfig(
    options: { phase?: "build" | "deploy" } = {},
): Promise<KnativeNextConfig> {
    const cwd = process.cwd();
    const configPath = resolve(cwd, CONFIG_FILE);

    if (!existsSync(configPath)) {
        const legacyPath = resolve(cwd, LEGACY_CONFIG_FILE);
        if (existsSync(legacyPath)) {
            throw new LegacyConfigFileError(legacyPath);
        }
        throw new ConfigNotFoundError(configPath, cwd);
    }

    const module = await import(configPath);
    let config: KnativeNextConfig = module.default;

    // KN_REDIS_URL is a documented deploy-time override of a redis
    // `cache.url`. It must land BEFORE validation: the scaffold's config
    // reads `REDIS_URL ?? ""`, so a user supplying only KN_REDIS_URL would
    // otherwise be refused for a URL they did provide.
    if (process.env.KN_REDIS_URL && config?.cache?.provider === "redis") {
        config = {
            ...config,
            cache: { ...config.cache, url: process.env.KN_REDIS_URL },
        };
    }

    validateConfig(config, undefined, options);

    return config;
}

/**
 * `kn-next` → `knext` rename (#1369, rev-1380 round). `package.json` declares
 * BOTH `bin.knext` and `bin.kn-next` pointing at the SAME dist file
 * (`dist/cli/kn-next.js`) — a second file (even a thin runtime proxy) broke
 * `npx @getknext/core` for every consumer: npm's default-bin picker only
 * auto-resolves when every declared bin targets ONE file, proven against
 * real npm 11.12.1. Since there is only one file, `deploy.ts` cannot tell
 * `knext` and `kn-next` apart from ITS OWN `import.meta.url` (always the
 * same) or from an env marker set by a proxy (there is no proxy). It CAN
 * tell them apart from `process.argv[1]`: npm creates two differently-named
 * symlinks (`node_modules/.bin/knext`, `node_modules/.bin/kn-next`) to this
 * one file, and when Node is invoked through a symlink, `process.argv[1]` is
 * the symlink path AS INVOKED — the literal name the user (or their
 * `package.json` script) typed — NOT the realpath-resolved target (see
 * `isEntrypoint` in exec.ts, which relies on the same fact for the opposite
 * comparison). `basename(argv1)` is therefore checked BEFORE any realpath
 * resolution.
 *
 * `npx @getknext/core <verb>` with no bin name given IS observable, but not
 * as "neither alias" — rev-1380's round-2 review measured it against real
 * npm 11.9.0 and found the opposite of what an earlier round assumed: npm's
 * arborist creates BOTH `node_modules/.bin/kn-next` and `.../.bin/knext`
 * (alphabetical), and since the package's own unscoped name ("core") matches
 * NEITHER bin, npm's default-bin picker falls back to the first one
 * alphabetically — `kn-next`. So `argv[1]`'s basename for that invocation IS
 * `"kn-next"`, indistinguishable from a real deprecated-alias use by
 * `isDeprecatedAliasInvocation` alone. That made EVERY `npx @getknext/core`
 * user — the documented front door (cli.mdx) — see a false "you're using
 * the deprecated command" warning for a command they never typed.
 *
 * `isDeprecatedAliasInvocation` itself stays a PURE basename check (its
 * whole contract, unit-tested directly) — the npx-ambiguity carve-out lives
 * in {@link printDeprecatedKnNextNoticeIfNeeded} instead, via
 * {@link isAmbiguousNpxBinDispatch}.
 */
export function isDeprecatedAliasInvocation(
    argv1: string | undefined = process.argv[1],
): boolean {
    return argv1 !== undefined && basename(argv1) === "kn-next";
}

/**
 * Whether the current process was dispatched by `npx`/`npm exec` — the
 * ambiguous-bin-pick case {@link isDeprecatedAliasInvocation}'s docblock
 * describes. Measured against real npm 11.9.0 (`npx <pkg>`, `npm exec
 * <pkg>`, and explicit `npx <bin-name>` all set `npm_command=exec`; a
 * project's own `npm run <script>` that shells out to a bin directly sets
 * `npm_command=run`; running `node_modules/.bin/<name>` straight from a
 * shell sets neither — no npm process is involved at all). `npm_command` is
 * the more directly-documented of the two env vars npm sets for this
 * (`npm_lifecycle_event=npx` is the other, equally reliable in the same
 * measurement — `npm_command` was picked for being the more literal name).
 *
 * Accepted trade, not a full disambiguation: this ALSO suppresses the notice
 * for a user who types `npx kn-next` EXPLICITLY (naming the deprecated alias
 * on purpose) — npm sets the identical env vars for that case, and nothing
 * observable from inside the spawned process tells the two apart. That is a
 * strictly smaller, more forgivable loss than the false-positive on every
 * `npx @getknext/core` user this replaces.
 */
export function isAmbiguousNpxBinDispatch(
    env: Record<string, string | undefined> = process.env,
): boolean {
    return env.npm_command === "exec";
}

const DEPRECATED_KN_NEXT_NOTICE =
    "`kn-next` is deprecated and will be removed in a future minor release — use `knext` instead (same command, same flags).\n";

/**
 * Print the one-line deprecation notice to stderr when invoked as `kn-next`
 * (see {@link isDeprecatedAliasInvocation}) — UNLESS the dispatch is the
 * ambiguous `npx`/`npm exec` bin-pick case (see
 * {@link isAmbiguousNpxBinDispatch}), where `argv[1]`'s basename cannot be
 * trusted as a statement of user intent.
 *
 * Caveat this does NOT cover (doc-only, no code fix possible): pnpm's
 * `pnpm dlx`/`exec` and Windows `.cmd`/`.ps1` shims do not set these npm-only
 * env vars at all, so the notice never fires there either way — "always
 * warns on `kn-next`" is an npm/POSIX-shim claim, not a universal one.
 */
export function printDeprecatedKnNextNoticeIfNeeded(
    argv1: string | undefined = process.argv[1],
    env: Record<string, string | undefined> = process.env,
    write: (text: string) => void = (text) => writeSync(2, text),
): void {
    if (isDeprecatedAliasInvocation(argv1) && !isAmbiguousNpxBinDispatch(env)) {
        write(DEPRECATED_KN_NEXT_NOTICE);
    }
}
