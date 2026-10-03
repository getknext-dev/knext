#!/usr/bin/env node
/**
 * `knext create`'s choices: runtime, builder, cache, storage provider and
 * React Compiler — asked interactively on a TTY, or given as flags.
 *
 * The rule that keeps this safe: the option layer ({@link applyCreateChoices})
 * is the IDENTITY at {@link DEFAULT_CREATE_CHOICES}. The defaults scaffold
 * exactly what the templates render, byte for byte, so `knext create` with no
 * answers (CI, no TTY, `--yes`) is unchanged. Every non-default answer is a
 * small, anchored edit of a rendered file, and an anchor that is missing or
 * appears twice THROWS — a template edit that moves an anchor fails the tests
 * instead of silently dropping the user's choice.
 *
 * Prompts are a minimal `node:readline/promises` loop, not a dependency: the
 * CLI is published, runs under plain Node, and must work offline.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { BuilderChoice } from "./create";
import { UsageError } from "./shared";

export type CreateRuntime = "bun" | "node";
export type CreateBuilder = "turbopack" | "webpack" | "vinext";
export type CreateCache = "none" | "redis";
export type CreateStorage = "none" | "gcs" | "s3" | "minio" | "azure";

export interface CreateChoices {
    runtime: CreateRuntime;
    builder: CreateBuilder;
    cache: CreateCache;
    storage: CreateStorage;
    reactCompiler: boolean;
}

/** Today's scaffold. Changing any of these changes every default app. */
export const DEFAULT_CREATE_CHOICES: Readonly<CreateChoices> = Object.freeze({
    runtime: "bun",
    builder: "turbopack",
    cache: "none",
    storage: "none",
    reactCompiler: false,
});

const RUNTIMES: readonly CreateRuntime[] = ["bun", "node"];
const BUILDERS: readonly CreateBuilder[] = ["turbopack", "webpack", "vinext"];
const CACHES: readonly CreateCache[] = ["none", "redis"];
const STORAGES: readonly CreateStorage[] = [
    "none",
    "gcs",
    "s3",
    "minio",
    "azure",
];

/** turbopack and webpack share the standalone template family. */
export function templateBuilderFor(builder: CreateBuilder): BuilderChoice {
    return builder === "vinext" ? "vinext" : "default";
}

// ─── flags ──────────────────────────────────────────────────────────────────

export interface ChoiceFlagValues {
    runtime?: string;
    builder?: string;
    cache?: string;
    storage?: string;
    "react-compiler"?: boolean;
}

function oneOf<T extends string>(
    flag: string,
    value: string | undefined,
    allowed: readonly T[],
    fallback: T,
): T {
    if (value === undefined) return fallback;
    if ((allowed as readonly string[]).includes(value)) return value as T;
    throw new UsageError(
        `unrecognised --${flag} '${value}' — expected one of: ${allowed.join(", ")}`,
    );
}

/**
 * Flags → choices. Unknown values are rejected, never mapped to a default: a
 * typo'd `--runtime nod` must not quietly scaffold a Bun app.
 */
export function parseChoiceFlags(values: ChoiceFlagValues): CreateChoices {
    const d = DEFAULT_CREATE_CHOICES;
    // `default` predates the turbopack/webpack split and stays accepted.
    const builderValue =
        values.builder === "default" ? "turbopack" : values.builder;
    const choices: CreateChoices = {
        runtime: oneOf("runtime", values.runtime, RUNTIMES, d.runtime),
        builder: oneOf("builder", builderValue, BUILDERS, d.builder),
        cache: oneOf("cache", values.cache, CACHES, d.cache),
        storage: oneOf("storage", values.storage, STORAGES, d.storage),
        reactCompiler: values["react-compiler"] ?? d.reactCompiler,
    };
    assertSupported(choices);
    return choices;
}

/** The flags that reproduce `c` without prompting (printed after the prompts). */
export function choicesToFlags(c: CreateChoices): string {
    return [
        `--runtime ${c.runtime}`,
        `--builder ${c.builder}`,
        `--cache ${c.cache}`,
        `--storage ${c.storage}`,
        ...(c.reactCompiler ? ["--react-compiler"] : []),
    ].join(" ");
}

function assertSupported(c: CreateChoices): void {
    if (c.reactCompiler && c.builder === "vinext") {
        throw new UsageError(
            "--react-compiler is not scaffolded for the vinext builder: vinext " +
                "reads it from its own Vite plugin options, not next.config.ts. " +
                "Scaffold without it and enable it in vite.config.ts by hand.",
        );
    }
}

// ─── when to prompt ─────────────────────────────────────────────────────────

/** `CI` counts when set to anything but empty, `0` or `false`. */
function isCI(env: Record<string, string | undefined>): boolean {
    const v = env.CI;
    return (
        v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false"
    );
}

/**
 * Prompt only when a person is clearly there: a TTY on stdin AND stdout, no
 * `CI`, and no flags at all (any flag, `--yes` included, means "I said what I
 * want"). Everything else takes the defaults — a pipe must never block.
 */
export function shouldPrompt(o: {
    flagsGiven: boolean;
    stdinIsTTY: boolean;
    stdoutIsTTY: boolean;
    env: Record<string, string | undefined>;
}): boolean {
    return !o.flagsGiven && o.stdinIsTTY && o.stdoutIsTTY && !isCI(o.env);
}

// ─── prompts ────────────────────────────────────────────────────────────────

export interface PromptIO {
    /** Ask one line; resolves with the raw answer. */
    ask(question: string): Promise<string>;
    /** Print text (the option list). */
    write(text: string): void;
}

interface Option<T> {
    value: T;
    label: string;
}

async function choose<T>(
    io: PromptIO,
    title: string,
    options: readonly Option<T>[],
    defaultIndex: number,
): Promise<T> {
    io.write(
        `\n${title}\n${options
            .map(
                (o, i) =>
                    `  ${i + 1}) ${o.label}${i === defaultIndex ? " (default)" : ""}\n`,
            )
            .join("")}`,
    );
    for (;;) {
        const raw = (await io.ask(`Choose [${defaultIndex + 1}]: `))
            .trim()
            .toLowerCase();
        if (raw === "") return options[defaultIndex].value;
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) {
            return options[n - 1].value;
        }
        const byName = options.find((o) => String(o.value) === raw);
        if (byName) return byName.value;
        io.write(
            `  '${raw}' is not one of the options — enter a number from 1 to ${options.length}, or press Enter for the default.\n`,
        );
    }
}

async function confirm(
    io: PromptIO,
    question: string,
    fallback: boolean,
): Promise<boolean> {
    for (;;) {
        const raw = (
            await io.ask(`\n${question} ${fallback ? "[Y/n]" : "[y/N]"}: `)
        )
            .trim()
            .toLowerCase();
        if (raw === "") return fallback;
        if (raw === "y" || raw === "yes") return true;
        if (raw === "n" || raw === "no") return false;
        io.write("  Please answer y or n.\n");
    }
}

/** Ask every question; Enter on each one gives {@link DEFAULT_CREATE_CHOICES}. */
export async function promptCreateChoices(
    io: PromptIO,
): Promise<CreateChoices> {
    const d = DEFAULT_CREATE_CHOICES;
    const runtime = await choose<CreateRuntime>(
        io,
        "Runtime — what runs your server in the container?",
        [
            { value: "bun", label: "bun — compiled Bun executable" },
            { value: "node", label: "node — Node.js" },
        ],
        RUNTIMES.indexOf(d.runtime),
    );
    const builder = await choose<CreateBuilder>(
        io,
        "Builder — what builds your app?",
        [
            { value: "turbopack", label: "turbopack — next build" },
            { value: "webpack", label: "webpack — next build --webpack" },
            { value: "vinext", label: "vinext — Vite-based build (Beta)" },
        ],
        BUILDERS.indexOf(d.builder),
    );
    const cache = await choose<CreateCache>(
        io,
        "ISR / data cache",
        [
            { value: "none", label: "none — in-memory, per pod" },
            {
                value: "redis",
                label: "redis — shared by every pod (set REDIS_URL at deploy time)",
            },
        ],
        CACHES.indexOf(d.cache),
    );
    const storage = await choose<CreateStorage>(
        io,
        "Object storage for static assets",
        [
            {
                value: "none",
                label: "none — serve them from the container image",
            },
            { value: "gcs", label: "gcs — Google Cloud Storage" },
            { value: "s3", label: "s3 — Amazon S3 or S3-compatible" },
            { value: "minio", label: "minio — self-hosted MinIO" },
            { value: "azure", label: "azure — Azure Blob Storage" },
        ],
        STORAGES.indexOf(d.storage),
    );
    // Not offered on vinext: it is configured in vite.config.ts there.
    const reactCompiler =
        builder === "vinext"
            ? false
            : await confirm(io, "Enable React Compiler?", d.reactCompiler);
    return { runtime, builder, cache, storage, reactCompiler };
}

/**
 * A {@link PromptIO} on the real terminal. If the input closes (Ctrl-D) or is
 * interrupted (Ctrl-C) mid-question, the pending answer REJECTS rather than
 * waiting forever.
 */
export function terminalPromptIO(): PromptIO & { close(): void } {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    let closed = false;
    const onClose: Array<() => void> = [];
    rl.on("close", () => {
        closed = true;
        for (const f of onClose.splice(0)) f();
    });
    return {
        write: (text) => void process.stdout.write(text),
        ask: (question) =>
            new Promise<string>((res, rej) => {
                const aborted = () =>
                    rej(
                        new UsageError(
                            "knext create: cancelled, nothing was written",
                        ),
                    );
                if (closed) return aborted();
                onClose.push(aborted);
                rl.question(question).then(
                    (answer) => {
                        onClose.splice(onClose.indexOf(aborted), 1);
                        res(answer);
                    },
                    () => aborted(),
                );
            }),
        close: () => rl.close(),
    };
}

// ─── applying the choices to the rendered scaffold ──────────────────────────

/** Replace `anchor` (which must occur exactly once) in `rel`. */
function editOnce(
    files: Map<string, string>,
    rel: string,
    anchor: string | RegExp,
    replace: (match: string) => string,
): void {
    const src = files.get(rel);
    if (src === undefined) {
        throw new Error(`knext create: expected a ${rel} in the scaffold`);
    }
    const re =
        typeof anchor === "string"
            ? new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
            : new RegExp(
                  anchor.source,
                  anchor.flags.includes("g")
                      ? anchor.flags
                      : `${anchor.flags}g`,
              );
    const hits = src.match(re)?.length ?? 0;
    if (hits !== 1) {
        throw new Error(
            `knext create: the ${rel} template has ${hits} copies of the anchor for ` +
                `this option (expected exactly 1): ${String(anchor)}`,
        );
    }
    files.set(
        rel,
        src.replace(re, (m) => replace(m)),
    );
}

function editPackageJson(
    files: Map<string, string>,
    edit: (pkg: {
        scripts: Record<string, string>;
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
    }) => void,
): void {
    const pkg = JSON.parse(files.get("package.json") ?? "");
    edit(pkg);
    files.set("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
}

const REGISTRY_ANCHOR = '  registry: "ghcr.io/<your-user>",\n';
const SCALING_ANCHOR = "  // Knative autoscaling.";
const STORAGE_PARAGRAPH =
    /^ {2}\/\/ Object storage for static assets[\s\S]*?^ {2}\/\/ \},\n/m;
const BUILD_PARAGRAPH =
    /^ {2}\/\/ This scaffold builds with plain `next build`[\s\S]*?\(`build: 'vinext'`\)\.\n/m;

const STORAGE_BLOCKS: Record<Exclude<CreateStorage, "none">, string> = {
    gcs: [
        '    provider: "gcs",',
        '    bucket: "<your-assets-bucket>",',
        '    publicUrl: "https://storage.googleapis.com/<your-assets-bucket>",',
    ].join("\n"),
    s3: [
        '    provider: "s3",',
        '    bucket: "<your-assets-bucket>",',
        '    region: "<your-region>",',
        "    // S3-compatible stores: also set endpoint.",
        '    publicUrl: "https://<your-assets-bucket>.s3.<your-region>.amazonaws.com",',
    ].join("\n"),
    minio: [
        '    provider: "minio",',
        '    bucket: "<your-assets-bucket>",',
        '    endpoint: "<your-minio-endpoint>", // e.g. http://minio.minio.svc.cluster.local:9000',
        '    publicUrl: "<your-public-assets-url>",',
    ].join("\n"),
    azure: [
        '    provider: "azure",',
        '    bucket: "<your-blob-container>", // the blob container name',
        '    publicUrl: "https://<your-storage-account>.blob.core.windows.net/<your-blob-container>",',
    ].join("\n"),
};

/**
 * The dependency ranges @getknext/core itself declares (read from its own
 * package.json under `packageRoot`) — so the Redis client an app pins and the
 * one the Node runtime image installs come from one source.
 */
export function coreDependencyRanges(
    packageRoot: string,
): Record<string, string> {
    const manifest = JSON.parse(
        readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    return manifest.dependencies ?? {};
}

/**
 * Apply `choices` to a rendered scaffold. Returns a new map; the identity at
 * {@link DEFAULT_CREATE_CHOICES}. `coreDependencies` is
 * {@link coreDependencyRanges}.
 */
export function applyCreateChoices(
    rendered: Map<string, string>,
    choices: CreateChoices,
    coreDependencies: Record<string, string>,
): Map<string, string> {
    assertSupported(choices);
    const files = new Map(rendered);
    const cfg = "knext.config.ts";

    if (choices.runtime === "node") {
        // `m` ends in a newline and the template's blank line follows it.
        editOnce(files, cfg, REGISTRY_ANCHOR, (m) =>
            [
                m,
                "  // Runtime: Node.js. Without this line knext runs your server on Bun",
                "  // (a compiled executable).",
                '  runtime: "node",',
                "",
            ].join("\n"),
        );
        if (choices.builder === "vinext") {
            // vite.config.ts picks nitro's node preset from `runtime`; run that
            // output with node too.
            editPackageJson(files, (pkg) => {
                pkg.scripts.start = "node .output/server/index.mjs";
            });
        }
    }

    if (choices.builder === "webpack") {
        editOnce(files, cfg, BUILD_PARAGRAPH, () =>
            [
                "  // This scaffold builds with webpack (`next build --webpack` — see",
                "  // package.json's `build` script). It emits the same standalone output",
                "  // and runtime image as the default Turbopack build.",
                '  build: "webpack",',
                "",
            ].join("\n"),
        );
        editPackageJson(files, (pkg) => {
            pkg.scripts.build = "next build --webpack";
        });
    }

    if (choices.cache === "redis") {
        editOnce(files, cfg, SCALING_ANCHOR, (m) =>
            [
                "  // ISR / data cache in Redis, shared by every pod and kept across",
                "  // scale-to-zero. Set REDIS_URL when you run `knext deploy` (keep the",
                "  // value in a Kubernetes Secret or your CI secrets, never in this file).",
                "  // `knext deploy` refuses to run while it is empty.",
                "  cache: {",
                '    provider: "redis",',
                '    url: process.env.REDIS_URL ?? "",',
                "  },",
                "",
                m,
            ].join("\n"),
        );
        if (choices.runtime === "node") {
            // Node loads the Redis client from the app's own dependencies;
            // Bun has one built in, so a Bun app needs nothing extra.
            const range = coreDependencies.ioredis;
            if (!range) {
                throw new Error(
                    "knext create: @getknext/core declares no ioredis dependency to pin the Node Redis client to",
                );
            }
            editPackageJson(files, (pkg) => {
                pkg.dependencies.ioredis = range;
            });
        }
    }

    if (choices.storage !== "none") {
        const block = STORAGE_BLOCKS[choices.storage];
        editOnce(files, cfg, STORAGE_PARAGRAPH, () =>
            [
                "  // Object storage for static assets: `knext deploy` uploads them here and",
                "  // serves them from `publicUrl`. Replace every <placeholder> — `knext",
                "  // deploy` names any that are left.",
                "  storage: {",
                block,
                "  },",
                "",
            ].join("\n"),
        );
    }

    if (choices.reactCompiler) {
        editOnce(files, "next.config.ts", '    output: "standalone",\n', (m) =>
            [
                m.trimEnd(),
                "    // React Compiler: memoizes components at build time (client rendering",
                "    // only). Needs babel-plugin-react-compiler, which is in devDependencies.",
                "    reactCompiler: true,",
                "",
            ].join("\n"),
        );
        editPackageJson(files, (pkg) => {
            pkg.devDependencies["babel-plugin-react-compiler"] = "^1.0.0";
        });
    }

    return files;
}
