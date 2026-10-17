/**
 * Lazy dispatch of `knext generate` and `knext add function` to the optional
 * `@getknext/grpc` package (ADR-0052 D8).
 *
 * Zone-function orchestration — buf, codegen, function scaffolding — lives in
 * that package, never in core. Core's whole involvement is this file: when one
 * of the two verbs is typed, find the package (from the app first, then from
 * core's own location), check it is a compatible pair, and hand it the argv.
 * Core does not depend on the package, does not import it statically, and the
 * specifier is resolved at run time so no bundler can inline it into the bin
 * (`grpc-dispatch.test.ts` holds all three).
 *
 * Compatibility (ADR-0020 amendment): the package declares a peer range on
 * `@getknext/core`; a core outside it is refused with a message naming both
 * versions. `--help` is answered even then, and even when the package is not
 * installed, because help is never destructive.
 *
 * Every failure here is a plain message and an exit code; nothing throws.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { coreVersion } from "./core-version";
import { runInherit } from "./exec";
import { captureKubectl } from "./schema/kubectl-capture";
import {
    type KubectlCapture,
    type KubectlResult,
    preflightCRSchema,
} from "./schema/preflight";
import { withKubeContext } from "./shared";

/** The package that provides the verbs below. */
export const GRPC_PACKAGE = "@getknext/grpc";

/** Verbs owned by the package; core only routes them. */
export const GRPC_VERBS: ReadonlySet<string> = new Set(["generate", "add"]);

/** The module shape this core knows how to call. */
const SUPPORTED_PROTOCOL = 1;

/**
 * The cluster seam `knext deploy function` runs on. Core owns the kubectl
 * boundary; the package builds the `BackendService` and decides the order
 * (preflight, then a strict apply) but never spawns anything itself.
 * Structurally typed: core does not import the package's types.
 */
export interface DeployHost {
    preflight(args: {
        readonly crPath: string;
        readonly namespace: string;
        readonly context?: string;
    }): {
        readonly verdict: "ok" | "skew" | "blocked";
        readonly reason: string;
        readonly unknownFields: readonly string[];
        readonly stderr: string;
    };
    /**
     * Apply the CR file. Core builds the argv itself, so the package cannot
     * run any other program through the seam.
     */
    apply(args: {
        readonly crPath: string;
        readonly namespace: string;
        readonly context?: string;
    }): void;
}

/** What core calls on `@getknext/grpc/cli`. */
export interface GrpcCliModule {
    readonly DISPATCH_PROTOCOL: number;
    readonly GRPC_VERSION: string;
    readonly CORE_PEER_RANGE: string;
    helpText(verb: string): string;
    run(
        verb: string,
        argv: readonly string[],
        io?: {
            readonly host?: DeployHost;
            readonly stdout?: (text: string) => void;
            readonly stderr?: (text: string) => void;
        },
    ): Promise<number>;
}

/** The two kubectl processes core can run. Injectable so tests spawn nothing. */
export interface KubectlSeam {
    /** Capture stdout/stderr; never throws. */
    readonly capture: KubectlCapture;
    /** Inherit stdio; throws on a non-zero exit. */
    readonly run: (argv: readonly string[]) => void;
}

const defaultKubectl: KubectlSeam = {
    capture: captureKubectl,
    run: runInherit,
};

/**
 * The host handed to `knext deploy function`. The preflight is the same
 * server-side `--dry-run=server --validate=strict` apply `deploy` runs for a
 * NextApp (`preflightCRSchema`); every kubectl argv is bound to the target
 * context.
 */
export function buildDeployHost(
    kubectl: KubectlSeam = defaultKubectl,
): DeployHost {
    return {
        preflight: ({ crPath, namespace, context }) => {
            const outcome = preflightCRSchema(
                {
                    kubectl: (argv): KubectlResult =>
                        kubectl.capture(withKubeContext(argv, context)),
                },
                { crPath, namespace },
            );
            return {
                verdict: outcome.verdict,
                reason: outcome.reason,
                unknownFields: outcome.unknownFields,
                stderr: outcome.stderr,
            };
        },
        apply: ({ crPath, namespace, context }) =>
            kubectl.run(
                withKubeContext(
                    [
                        "kubectl",
                        "apply",
                        "--validate=strict",
                        "-f",
                        crPath,
                        "-n",
                        namespace,
                    ],
                    context,
                ),
            ),
    };
}

export interface DispatchDeps {
    /** Load the package; defaults to resolving it from the app, then from core. */
    readonly load?: () => Promise<GrpcCliModule>;
    readonly stdout?: (text: string) => void;
    readonly stderr?: (text: string) => void;
    /** The kubectl processes `deploy function` runs; defaults to the real ones. */
    readonly kubectl?: KubectlSeam;
}

// ---------------------------------------------------------------------------
// A deliberately small semver range check: space-separated comparators
// (`>=`, `>`, `<=`, `<`, `=` or bare) and `^X.Y.Z`. Anything else is
// `undefined`, which the dispatcher treats as incompatible (fail closed).
// Plain precedence, without npm's prerelease-tuple rule.
// ---------------------------------------------------------------------------

type Parsed = [number, number, number, (string | number)[]];

function parse(v: string): Parsed | undefined {
    const m =
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
            v,
        );
    if (!m) return undefined;
    const pre = (m[4] ?? "")
        .split(".")
        .filter((s) => s !== "")
        .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
    return [Number(m[1]), Number(m[2]), Number(m[3]), pre];
}

function compare(a: Parsed, b: Parsed): number {
    for (let i = 0; i < 3; i++) {
        const d = (a[i] as number) - (b[i] as number);
        if (d !== 0) return Math.sign(d);
    }
    const [pa, pb] = [a[3], b[3]];
    if (pa.length === 0 || pb.length === 0)
        return Math.sign(pb.length - pa.length);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i];
        const y = pb[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        if (x === y) continue;
        if (typeof x === "number" && typeof y === "number")
            return Math.sign(x - y);
        if (typeof x === "number") return -1;
        if (typeof y === "number") return 1;
        return x < y ? -1 : 1;
    }
    return 0;
}

/** Whether `version` is inside `range`; `undefined` if either cannot be read. */
export function satisfiesRange(
    version: string,
    range: string,
): boolean | undefined {
    const v = parse(version);
    const parts = range
        .trim()
        .split(/\s+/)
        .filter((p) => p !== "");
    if (!v || parts.length === 0) return undefined;
    for (const part of parts) {
        const caret = /^\^(.+)$/.exec(part);
        if (caret) {
            const lo = parse(caret[1] as string);
            if (!lo) return undefined;
            const hi: Parsed =
                lo[0] > 0 ? [lo[0] + 1, 0, 0, [0]] : [0, lo[1] + 1, 0, [0]];
            if (compare(v, lo) < 0 || compare(v, hi) >= 0) return false;
            continue;
        }
        const m = /^(>=|<=|>|<|=)?(.+)$/.exec(part);
        const bound = m ? parse(m[2] as string) : undefined;
        if (!m || !bound) return undefined;
        const c = compare(v, bound);
        const ok =
            m[1] === ">="
                ? c >= 0
                : m[1] === "<="
                  ? c <= 0
                  : m[1] === ">"
                    ? c > 0
                    : m[1] === "<"
                      ? c < 0
                      : c === 0;
        if (!ok) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------

class NotInstalled {}

function isNotFound(err: unknown): boolean {
    const code = (err as { code?: unknown } | null)?.code;
    return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
}

/** Resolve `@getknext/grpc/cli` from the app first, then from core itself. */
async function defaultLoad(): Promise<GrpcCliModule> {
    const specifier = `${GRPC_PACKAGE}/cli`;
    for (const base of [join(process.cwd(), "package.json"), import.meta.url]) {
        let resolved: string;
        try {
            resolved = createRequire(base).resolve(specifier);
        } catch (err) {
            if (isNotFound(err)) continue;
            throw err;
        }
        return (await import(pathToFileURL(resolved).href)) as GrpcCliModule;
    }
    throw new NotInstalled();
}

function displayVerb(verb: string): string {
    if (verb === "add") return "knext add function";
    return verb === "deploy" ? "knext deploy function" : `knext ${verb}`;
}

function installHelp(verb: string): string {
    return `${displayVerb(verb)} — provided by the optional ${GRPC_PACKAGE} package (Beta)

\`knext generate\`, \`knext add function\` and \`knext deploy function\` come from
${GRPC_PACKAGE}, which is
not installed in this app. Install it next to @getknext/core:

  npm install --save-dev ${GRPC_PACKAGE}

then run \`${displayVerb(verb)} --help\` again for the full usage.

Exit code: 0 for --help; 1 for anything else while the package is missing.
`;
}

/**
 * Route `verb` (`generate` or `add`) to the package. Returns the exit code.
 * `coreVersion` is this CLI's own version, checked against the package's
 * peer range.
 */
export async function dispatchGrpcVerb(
    verb: string,
    argv: readonly string[],
    coreVersion: string,
    deps: DispatchDeps = {},
): Promise<number> {
    const stdout = deps.stdout ?? ((s: string) => process.stdout.write(s));
    const stderr = deps.stderr ?? ((s: string) => process.stderr.write(s));
    const help = argv.includes("--help") || argv.includes("-h");
    const typed = ["knext", verb, ...argv].join(" ");

    let mod: GrpcCliModule;
    try {
        mod = await (deps.load ?? defaultLoad)();
    } catch (err) {
        if (err instanceof NotInstalled || isNotFound(err)) {
            if (help) {
                stdout(installHelp(verb));
                return 0;
            }
            stderr(
                `\`${typed}\`: this command comes from the optional ${GRPC_PACKAGE} package ` +
                    "(Beta), which is not installed here.\n" +
                    `Install it next to @getknext/core: npm install --save-dev ${GRPC_PACKAGE}\n`,
            );
            return 1;
        }
        stderr(
            `could not load ${GRPC_PACKAGE}: ${(err as Error)?.message ?? String(err)}\n`,
        );
        return 1;
    }

    if (help) {
        stdout(`${mod.helpText(verb)}\n`);
        return 0;
    }
    const pair = `${GRPC_PACKAGE} ${mod.GRPC_VERSION} and @getknext/core ${coreVersion}`;
    if (mod.DISPATCH_PROTOCOL !== SUPPORTED_PROTOCOL) {
        stderr(
            `${pair} do not work together (dispatch protocol ${mod.DISPATCH_PROTOCOL}, ` +
                `expected ${SUPPORTED_PROTOCOL}). Install a matching pair.\n`,
        );
        return 1;
    }
    const ok = satisfiesRange(coreVersion, mod.CORE_PEER_RANGE);
    if (ok !== true) {
        stderr(
            `${GRPC_PACKAGE} ${mod.GRPC_VERSION} works with @getknext/core ` +
                `${mod.CORE_PEER_RANGE}, but this is @getknext/core ${coreVersion}. ` +
                "Install a matching pair.\n",
        );
        return 1;
    }
    try {
        // Only `deploy function` writes to the cluster, so only it is handed
        // the kubectl seam.
        return await (verb === "deploy"
            ? mod.run(verb, argv, {
                  host: buildDeployHost(deps.kubectl),
                  stdout,
                  stderr,
              })
            : mod.run(verb, argv));
    } catch (err) {
        stderr(`${typed} failed: ${(err as Error)?.message ?? String(err)}\n`);
        return 1;
    }
}

/** `knext generate` — bin entry. */
export function generateMain(argv: readonly string[]): Promise<number> {
    return dispatchGrpcVerb("generate", argv, coreVersion());
}

/** `knext add` — bin entry. Answers `--help` itself when the package is missing. */
export function addMain(argv: readonly string[]): Promise<number> {
    return dispatchGrpcVerb("add", argv, coreVersion());
}

/** `knext deploy function` — bin entry. Applies the function's BackendService. */
export function deployFunctionMain(argv: readonly string[]): Promise<number> {
    return dispatchGrpcVerb("deploy", ["function", ...argv], coreVersion());
}
