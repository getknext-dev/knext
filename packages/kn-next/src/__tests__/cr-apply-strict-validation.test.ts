/**
 * Every `kubectl apply` issued from `packages/kn-next/src/cli/*.ts` must ASSERT
 * strict field validation — it must not inherit it from whatever `kubectl`
 * happens to be on the user's PATH.
 *
 * Empirically (live cluster, server-side dry-run against the structural CRD):
 *   - `kubectl apply --validate=strict` (kubectl's own default since 1.25)
 *     REJECTS an unknown field:
 *       Error from server (BadRequest): ... strict decoding error:
 *       unknown field "spec.template.spec.thisFieldDoesNotExistAnywhere"
 *   - `kubectl apply --validate=ignore` ACCEPTS it and the apiserver PRUNES it
 *     silently. Concretely, for a field this CLI really emits: a pruned
 *     `spec.database.roSecretRef` means the operator never injects
 *     DATABASE_URL_RO, so `getDbRO()` falls back to the writer pool
 *     (packages/db/src/index.ts) and read traffic runs on the read-WRITE
 *     primary credential — a least-privilege downgrade on a CR that still
 *     reports Ready=True.
 *
 * So the protection exists, but it was an EXTERNAL BINARY'S DEFAULT. The
 * vectors that can actually take it away are narrower than they look: the CLI
 * spawns kubectl through `execFile` with `shell: false` (cli/exec.ts), so no
 * interactive shell alias is ever in the path, and kubectl exposes no
 * kubeconfig key or environment variable for `--validate`. What remains real:
 *   - a kubectl older than v1.25 on PATH (there the flag value did not exist);
 *   - a wrapper/shim binary NAMED `kubectl` on PATH (asdf/krew/kubie shims,
 *     corporate wrappers). That one is NOT closed by this flag: pflag takes the
 *     LAST occurrence of a string flag, so a shim appending `--validate=ignore`
 *     still wins.
 * Passing the flag explicitly makes the guarantee knext's for the argv knext
 * controls.
 *
 * The argv guard below is GENERALISED on purpose — instead of enumerating the
 * known call sites (precisely how the `preview deploy` apply was missed the
 * first time) it scans source. Its exact, non-recursive scope: the `*.ts` files
 * directly inside `packages/kn-next/src/cli/` (`readdirSync`, top level only) —
 * that is where every apply this CLI issues lives today, and nothing outside it
 * is checked. Within that scope the guard is per-SITE: every quoted `apply`
 * verb must correspond to an argv the scanner actually parsed and asserted, so
 * a later apply site — including a second one in an already-covered file, or
 * one written in a construct the scanner cannot read — fails this suite rather
 * than slipping through.
 *
 * Hermetic — every side-effecting seam of deploy.ts is module-mocked (same
 * pattern as deploy-orchestrator.test.ts); no cluster, no docker, no build.
 */

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
    mock,
} from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KnativeNextConfig } from "../config";

// bun types `mockResolvedValue`/`mockReturnValue` off the declared return
// type. A mock returning `unknown` is not Promise-shaped, so every
// `mockResolvedValue` call is rejected. Arguments stay `unknown[]` — that is
// where the strictness that matters lives.
// biome-ignore lint/suspicious/noExplicitAny: the return must be `any`; see above
type AnyFn = (...args: unknown[]) => any;

const runQuiet = mock<AnyFn>();
const runInherit = mock<AnyFn>();
const runCapture = mock<AnyFn>(() => "");
const isEntrypoint = mock<AnyFn>(() => false);

// `createRequire` and the REAL `node:fs` are resolved OUT HERE, not inside the
const __knextRealShared = { ...(await import("../cli/shared")) };

// `mock.module("node:fs", …)` factory below. An `await import(...)` in a mock
// factory deadlocks under bun: the mock is already registered when the factory
// runs, so the import re-enters resolution and waits on itself. The file does
// not fail — it HANGS with no output at all.
const { createRequire: __knextCreateRequire } = await import("node:module");
const __knextRealFs = __knextCreateRequire(import.meta.url)(
    "node:fs",
) as typeof import("node:fs");

// The REAL cr-builder, captured before ANY mock registers.
//
// Placement is the whole point: after `mock.module("../cli/cr-builder", …)`
// the import returns the MOCK, and the spread comes back empty — which surfaces
// as `buildNextAppCRObject is not a function`, naming the module rather than the
// ordering. bun has no `vi.importActual`, so this is the replacement.
const __knextRealCrBuilder = {
    ...(await import("../cli/cr-builder")),
} as typeof import("../cli/cr-builder");

mock.module("../cli/exec", () => ({
    runQuiet: (...a: unknown[]) => runQuiet(...a),
    runInherit: (...a: unknown[]) => runInherit(...a),
    runCapture: (...a: unknown[]) => runCapture(...a),
    runQuietAllowFail: mock(),
    isEntrypoint: (...a: unknown[]) => isEntrypoint(...a),
}));

const uploadAssets = mock<AnyFn>(async () => {});
const getAssetPrefix = mock<AnyFn>(() => "https://cdn.example.com/_next");
const reclaimBuildPrefix = mock<AnyFn>();

const __knextReal1 = { ...(await import("../utils/asset-upload")) };
mock.module("../utils/asset-upload", async () => ({
    // keep the REAL hasStorage/notice exports (ADR-0047) — stub only the seams
    ...__knextReal1,
    uploadAssets: (...a: unknown[]) => uploadAssets(...a),
    getAssetPrefix: (...a: unknown[]) => getAssetPrefix(...a),
    reclaimBuildPrefix: (...a: unknown[]) => reclaimBuildPrefix(...a),
}));

const renderNextAppCR = mock<AnyFn>(() => "kind: NextApp\n");
const resolveDigest = mock<AnyFn>(
    async () => "registry.example.com/my-app@sha256:deadbeef",
);
const validateCRImageRef = mock<AnyFn>();

mock.module("../cli/cr-builder", () => ({
    renderNextAppCR: (...a: unknown[]) => renderNextAppCR(...a),
    resolveDigest: (...a: unknown[]) => resolveDigest(...a),
    validateCRImageRef: (...a: unknown[]) => validateCRImageRef(...a),
}));

// #314: deploy now runs a server-side dry-run preflight BEFORE any side effect.
// Stub the kubectl boundary it uses so this suite stays hermetic and keeps
// asserting the real APPLY argv; the preflight itself is covered by
// cr-prune-preflight.test.ts and deploy-preflight-ordering.test.ts.
mock.module("../cli/schema/kubectl-capture", () => ({
    captureKubectl: () => ({ ok: true, stdout: "", stderr: "" }),
}));

const runAssetGC = mock<AnyFn>(() => ({ pruned: true }));

mock.module("../cli/gc", () => ({
    runAssetGC: (...a: unknown[]) => runAssetGC(...a),
    gcMain: mock(),
}));

const baseConfig: KnativeNextConfig = {
    name: "my-app",
    registry: "registry.example.com",
    storage: {
        provider: "gcs",
        bucket: "my-bucket",
        publicUrl: "https://storage.googleapis.com/my-bucket",
    },
    cache: {
        provider: "redis",
        url: "redis://redis:6379",
        keyPrefix: "my-app",
    },
    scaling: { minScale: 0, maxScale: 5 },
};

const loadConfig = mock<AnyFn>(async () => baseConfig);
mock.module("../cli/shared", () => ({
    // bun replaces a mocked module WHOLESALE — no partial mock, no
    // automock — so a factory listing only what the test drives drops
    // every other export and the importer dies naming the CONSUMER, not
    // this factory. Spreading keeps it honest as `../cli/shared` grows.
    ...__knextRealShared,
    loadConfig: (...a: unknown[]) => loadConfig(...a),
    excerpt: (s: string) => s,
    // placeholder-preflight.ts (imported by deploy.ts) extends UsageError at
    // module-eval time, so the mock must define it (same as deploy-no-storage).
    UsageError: class MockUsageError extends Error {},
}));

const readFileSyncMock = mock<(...a: unknown[]) => string>(() => "");
const __knextReal2 = { ...(await import("node:fs")) };
mock.module("node:fs", async () => {
    const actual = __knextReal2;
    // #644: deploy now infers the docker build context from the real
    // filesystem (the lockfile walk in tracing-root.ts). Spreading
    // `importOriginal()` does NOT carry node-builtin named exports under
    // vitest, so every fs function the code touches must be listed here —
    // `existsSync` is passed through to the REAL one rather than stubbed, so
    // the walk still answers about the actual tree.
    const realFs = __knextRealFs;
    const overrides = {
        existsSync: realFs.existsSync,
        readFileSync: (...a: unknown[]) => readFileSyncMock(...(a as [string])),
        writeFileSync: mock(),
        mkdirSync: mock(),
        writeSync: mock(),
    };
    return {
        ...actual,
        ...overrides,
        default: { ...(actual as { default?: object }).default, ...overrides },
    };
});

function argvOf(call: unknown[]): string[] {
    return (call[0] as string[]) ?? [];
}

/** The single mutating call: `kubectl apply …` of the NextApp CR. */
function applyArgv(): string[] | undefined {
    const call = runInherit.mock.calls.find(
        (c) => argvOf(c)[0] === "kubectl" && argvOf(c)[1] === "apply",
    );
    return call ? argvOf(call) : undefined;
}

async function importDeploy(): Promise<() => Promise<void>> {
    const mod = (await import("../cli/deploy")) as {
        deploy: () => Promise<void>;
    };
    return mod.deploy;
}

function setArgv(flags: string[]): void {
    process.argv = ["node", "/path/to/kn-next.js", ...flags];
}

const savedArgv = process.argv;
const savedEnv = { ...process.env };

beforeEach(() => {
    // No `resetModules()`: everything this file varies goes through the mocks
    // cleared on the next line and the fixtures set below. bun has no registry
    // reset, and the deploy path holds no module state of its own — it reads
    // config and calls injected collaborators.
    jest.clearAllMocks();
    runCapture.mockReturnValue("");
    resolveDigest.mockResolvedValue(
        "registry.example.com/my-app@sha256:deadbeef",
    );
    renderNextAppCR.mockReturnValue("kind: NextApp\n");
    runAssetGC.mockReturnValue({ pruned: true });
    loadConfig.mockResolvedValue(baseConfig);
    readFileSyncMock.mockReturnValue("deploytag");
});

afterEach(() => {
    process.argv = savedArgv;
    process.env = { ...savedEnv };
});

/* ------------------------------------------------------------------ *
 * Generalised guard: every `kubectl apply` argv literal under src/cli/  *
 * ------------------------------------------------------------------ */

// The real fs — this file module-mocks node:fs for the deploy tests, and the
// source-scanning guards below must read from disk regardless.
const realFs = createRequire(import.meta.url)(
    "node:fs",
) as typeof import("node:fs");

const TEST_FILE = fileURLToPath(import.meta.url);
const CLI_DIR = join(dirname(TEST_FILE), "..", "cli");

/** Blank out comments while preserving line numbers (so failures point home). */
function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Index of the string terminator starting at `start` (quote char at start). */
function skipString(s: string, start: number): number {
    const quote = s[start];
    for (let i = start + 1; i < s.length; i++) {
        if (s[i] === "\\") {
            i++;
            continue;
        }
        if (s[i] === quote) return i;
    }
    return s.length;
}

/** Index of the `]` matching the `[` at `start`, or -1. */
function matchBracket(s: string, start: number): number {
    let depth = 0;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (c === '"' || c === "'" || c === "`") {
            i = skipString(s, i);
            continue;
        }
        if (c === "[") depth++;
        else if (c === "]" && --depth === 0) return i;
    }
    return -1;
}

interface ApplySite {
    file: string;
    line: number;
    args: string[];
}

/**
 * Find every flat argv array literal that spawns `kubectl apply`, in both
 * shapes the CLI uses: `run*(["kubectl", "apply", …])` and
 * `execFileSync("kubectl", ["apply", …])`. Non-literal argv entries (paths,
 * namespaces) are simply absent from `args` — we only assert over the flags,
 * which are always literals.
 */
function scanApplySites(file: string, rawSource: string): ApplySite[] {
    const src = stripComments(rawSource);
    const sites: ApplySite[] = [];
    for (let i = 0; i < src.length; i++) {
        if (src[i] !== "[") continue;
        const end = matchBracket(src, i);
        if (end < 0) continue;
        const region = src.slice(i + 1, end);
        if (region.includes("[")) continue; // not a flat argv literal
        const args = [...region.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)].map(
            (m) => m[2] as string,
        );
        const isApplyArgv =
            (args[0] === "kubectl" && args[1] === "apply") ||
            (args[0] === "apply" &&
                /["'`]kubectl["'`]\s*,\s*$/.test(src.slice(0, i)));
        if (!isApplyArgv) continue;
        sites.push({
            file,
            line: src.slice(0, i).split("\n").length,
            args,
        });
    }
    return sites;
}

/**
 * Every occurrence of the bare verb literal `apply` — in ANY quote form
 * (`'apply'`, `"apply"`, `` `apply` ``) — in comment-stripped source.
 *
 * This is the counting half of the anti-vacuity guard: `scanApplySites` only
 * understands ONE construct (a flat argv array literal), so anything else that
 * spawns an apply — `argv.push("apply", …)`, `execFileSync(BIN, ["apply", …])`
 * with a non-literal binary, an argv containing a nested `[` — is invisible to
 * it. Counting the verb makes those constructs FAIL LOUDLY (literal present,
 * no parsed site) instead of passing silently, which is the whole point.
 */
function applyVerbLines(src: string): number[] {
    const out: number[] = [];
    for (const m of src.matchAll(/(['"`])apply\1/g)) {
        out.push(src.slice(0, m.index).split("\n").length);
    }
    return out;
}

describe("kubectl apply — asserted strict field validation at EVERY call site", () => {
    /**
     * Every `*.ts` under `src/cli/`, RECURSIVELY.
     *
     * It used to be top-level only, on the reasoning that "that is where all
     * three applies live today". #314 added a fourth — the prune preflight's
     * server-side dry-run apply in `cli/schema/preflight.ts` — one directory
     * down, i.e. in exactly the blind spot that reasoning created. Scope by
     * construction, not by where the current call sites happen to sit.
     */
    function readCliSources(): Map<string, string> {
        const out = new Map<string, string>();
        const walk = (dir: string, prefix: string): void => {
            for (const entry of realFs.readdirSync(dir, {
                withFileTypes: true,
            })) {
                const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
                if (entry.isDirectory()) {
                    walk(join(dir, entry.name), rel);
                    continue;
                }
                if (!entry.name.endsWith(".ts")) continue;
                out.set(
                    rel,
                    realFs.readFileSync(join(dir, entry.name), "utf-8"),
                );
            }
        };
        walk(CLI_DIR, "");
        return out;
    }

    it("no `kubectl apply` argv in src/cli/ omits or weakens --validate=strict", () => {
        const sources = readCliSources();
        const sites = [...sources].flatMap(([name, src]) =>
            scanApplySites(name, src),
        );
        // Non-vacuity: the CLI has at least three apply sites today (deploy's
        // NextApp CR, preview's NextApp CR, loadtest's k6 Job). If the scanner
        // ever stops finding them this must fail, not silently pass.
        expect(
            sites.length,
            "the argv scanner found no kubectl apply sites — the guard has gone vacuous",
        ).toBeGreaterThanOrEqual(3);

        for (const site of sites) {
            const where = `${site.file}:${site.line} (${site.args.join(" ")})`;
            expect(site.args, `${where} — missing --validate=strict`).toContain(
                "--validate=strict",
            );
            expect(
                site.args.filter((a) => a.startsWith("--validate")),
                `${where} — exactly one --validate flag (pflag takes the last)`,
            ).toHaveLength(1);
        }
    });

    it("every `apply` verb literal in src/cli/*.ts is a site the scanner parsed (an unparsed construct fails, it does not slip through)", () => {
        const sources = readCliSources();
        // Per-SITE, not per-file: a SECOND apply in an already-covered file
        // used to be satisfied by the first one. The verb count must match the
        // parsed-site count in EVERY file, so an apply the parser cannot see
        // (`.push("apply", …)`, `execFileSync(BIN, ["apply", …])`, a nested
        // `[` in the argv, a backticked verb) fails here instead of hiding.
        for (const [name, raw] of sources) {
            const verbLines = applyVerbLines(stripComments(raw));
            const sites = scanApplySites(name, raw);
            expect(
                verbLines.length,
                `${name}: ${verbLines.length} \`apply\` verb literal(s) (line(s) ${verbLines.join(", ") || "-"}) but only ${sites.length} argv the scanner could parse (line(s) ${sites.map((s) => s.line).join(", ") || "-"}). Either the argv is not a flat literal array the scanner understands — rewrite it as one — or it is not a kubectl apply at all. It is NOT allowed to be unverifiable.`,
            ).toBe(sites.length);
        }
        // Non-vacuity of the counter itself: it must be finding verbs at all.
        const total = [...sources.values()].reduce(
            (n, raw) => n + applyVerbLines(stripComments(raw)).length,
            0,
        );
        expect(
            total,
            "no `apply` verb literal found anywhere in src/cli/ — the counting guard has gone vacuous",
        ).toBeGreaterThanOrEqual(3);
    });
});

describe("NextApp CR apply — asserted strict field validation", () => {
    it("passes --validate=strict explicitly on the kubectl apply argv", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();

        const argv = applyArgv();
        expect(argv, "the mutating kubectl apply must have run").toBeDefined();
        // THE regression guard: one word, trivially lost in a refactor.
        expect(argv).toContain("--validate=strict");
    });

    it("never weakens validation (no --validate=ignore/warn/false in the apply argv)", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const deploy = await importDeploy();
        await deploy();

        const argv = applyArgv() ?? [];
        for (const weak of [
            "--validate=ignore",
            "--validate=warn",
            "--validate=false",
        ]) {
            expect(argv).not.toContain(weak);
        }
        // Exactly one --validate flag — a second one would silently win.
        expect(argv.filter((a) => a.startsWith("--validate")).length).toBe(1);
    });

    it("still applies the right file into the right namespace (the flag is additive)", async () => {
        setArgv(["deploy", "--tag", "deploytag", "--namespace", "prod"]);
        const deploy = await importDeploy();
        await deploy();

        const argv = applyArgv() ?? [];
        expect(argv[0]).toBe("kubectl");
        expect(argv[1]).toBe("apply");
        expect(argv).toContain("-f");
        expect(argv[argv.indexOf("-f") + 1]).toMatch(/nextapp-cr\.yaml$/);
        expect(argv[argv.indexOf("-n") + 1]).toBe("prod");
    });
});

describe("NextApp CR apply — a rejected apply is never swallowed", () => {
    /** Make ONLY the `kubectl apply` leg fail, like a real strict rejection. */
    function failApplyWith(message: string): Error {
        const err = new Error(message);
        runInherit.mockImplementation((...a: unknown[]) => {
            const argv = a[0] as string[];
            if (argv?.[0] === "kubectl" && argv?.[1] === "apply") throw err;
        });
        return err;
    }

    // Sibling at "names no single cause …" asserts the SHAPE of the differential
    // (headline blames nothing, CRD skew appears only as a conditional). This one
    // asserts the harder guarantee: the rejection PROPAGATES — deploy() rejects
    // rather than resolving — and the thrown message is actionable.
    it("rejects rather than resolving, with an actionable message the user can act on", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        failApplyWith(
            'Command failed: kubectl apply -f nextapp-cr.yaml\nError from server (BadRequest): ... strict decoding error: unknown field "spec.security.networkPolicy"',
        );
        const deploy = await importDeploy();

        await expect(deploy()).rejects.toThrow(
            /unknown field|strict decoding/i,
        );
        await expect(deploy()).rejects.toThrow(/older than this CLI/i);
        // Actionable: tells the user how to check the installed CRD.
        await expect(deploy()).rejects.toThrow(
            /kubectl get crd nextapps\.apps\.kn-next\.dev/,
        );
    });

    it("preserves the original kubectl error as `cause` (nothing is swallowed)", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const original = failApplyWith("Command failed: kubectl apply ...");
        const deploy = await importDeploy();

        const caught = await deploy().then(
            () => undefined,
            (e: unknown) => e as Error,
        );
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error & { cause?: unknown }).cause).toBe(original);
    });

    it("does not reach the post-apply status read when the apply is rejected", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        failApplyWith("Command failed: kubectl apply ...");
        const deploy = await importDeploy();

        await expect(deploy()).rejects.toThrow();
        expect(
            runCapture.mock.calls.some(
                (c) => argvOf(c)[0] === "kubectl" && argvOf(c)[1] === "get",
            ),
        ).toBe(false);
    });
});

describe("NextApp CR apply — the failure is attributed to the right side", () => {
    function failApply(): Error {
        const err = new Error("Command failed: kubectl apply ...");
        runInherit.mockImplementation((...a: unknown[]) => {
            const argv = a[0] as string[];
            if (argv?.[0] === "kubectl" && argv?.[1] === "apply") throw err;
        });
        return err;
    }

    /** Answer the post-failure `kubectl version --client` probe. */
    function clientVersion(gitVersion: string): void {
        runCapture.mockImplementation((...a: unknown[]) => {
            const argv = a[0] as string[];
            if (argv?.[1] === "version")
                return JSON.stringify({ clientVersion: { gitVersion } });
            return "";
        });
    }

    it("blames the CLIENT, not the CRD, when the local kubectl predates --validate=strict", async () => {
        // The ONE failure this PR introduces: on kubectl <= 1.24 `--validate`
        // is a bool, so `--validate=strict` dies at flag parse and the apply
        // never reaches the apiserver. Saying "the CRD is older than the CLI"
        // there is exactly backwards.
        setArgv(["deploy", "--tag", "deploytag"]);
        failApply();
        clientVersion("v1.24.17");
        const deploy = await importDeploy();

        const caught = await deploy().then(
            () => undefined,
            (e: unknown) => e as Error,
        );
        expect(caught?.message).toMatch(/v1\.24\.17/);
        expect(caught?.message).toMatch(/older than v1\.25/i);
        expect(caught?.message).toMatch(
            /never reached|before it contacts|flag pars/i,
        );
        // It must NOT tell this user to go looking at the CRD.
        expect(caught?.message).not.toMatch(/CRD/);
    });

    it("names no single cause when it cannot know one (offers a differential)", async () => {
        // Cluster unreachable / RBAC / bad namespace all land here with stdio
        // inherited, so knext has no stderr to classify.
        setArgv(["deploy", "--tag", "deploytag"]);
        const original = failApply();
        clientVersion("v1.31.0");
        const deploy = await importDeploy();

        const caught = await deploy().then(
            () => undefined,
            (e: unknown) => e as Error,
        );
        // The headline states the FACT (the apply failed); it must not lead
        // with a cause knext cannot see.
        const headline = (caught?.message ?? "").split("\n")[0] as string;
        expect(headline).not.toMatch(/CRD/);
        // The CRD-skew cause appears ONLY as one conditional candidate.
        expect(caught?.message).toMatch(
            /If it reads[\s\S]*NextApp CRD is older than this CLI/,
        );
        // Still actionable: the candidate causes and how to check each.
        expect(caught?.message).toMatch(/strict decoding error/);
        expect(caught?.message).toMatch(
            /kubectl get crd nextapps\.apps\.kn-next\.dev/,
        );
        expect(caught?.message).toMatch(/kn-next doctor/);
        expect((caught as Error & { cause?: unknown }).cause).toBe(original);
    });

    it("survives a kubectl version probe that itself fails (no diagnosis crash)", async () => {
        setArgv(["deploy", "--tag", "deploytag"]);
        const original = failApply();
        runCapture.mockImplementation(() => {
            throw new Error("kubectl: command not found");
        });
        const deploy = await importDeploy();

        const caught = await deploy().then(
            () => undefined,
            (e: unknown) => e as Error,
        );
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error & { cause?: unknown }).cause).toBe(original);
    });
});

describe("preview deploy — the OTHER NextApp CR apply (same CR, same skew)", () => {
    const digestImage = `registry.example.com/my-app-pr-42:t@sha256:${"a".repeat(64)}`;

    async function runPreview(): Promise<string[]> {
        const { runPreviewDeploy } = await import("../cli/preview");
        const apply = mock<(argv: readonly string[]) => void>();
        await runPreviewDeploy(
            baseConfig,
            { prId: "42", branch: "feat/x", namespace: "previews" },
            {
                apply,
                capture: () => "https://my-app-pr-42.example.com",
                buildAndPush: async () => digestImage,
                // Hermetic: the #314 prune preflight is a real cluster call
                // (server-side dry run) and is covered by
                // cr-prune-preflight.test.ts. Here it is stubbed so this suite
                // keeps asserting the APPLY argv and nothing else.
                preflight: () => {},
            },
        );
        return (apply.mock.calls[0]?.[0] ?? []) as string[];
    }

    it("passes --validate=strict explicitly (it renders the SAME CR as deploy)", async () => {
        const argv = await runPreview();
        expect(argv).toContain("--validate=strict");
    });

    it("never weakens validation and applies the preview CR into the right namespace", async () => {
        const argv = await runPreview();
        expect(argv[0]).toBe("kubectl");
        expect(argv[1]).toBe("apply");
        for (const weak of [
            "--validate=ignore",
            "--validate=warn",
            "--validate=false",
        ]) {
            expect(argv).not.toContain(weak);
        }
        expect(argv.filter((a) => a.startsWith("--validate"))).toHaveLength(1);
        expect(argv[argv.indexOf("-f") + 1]).toMatch(
            /nextapp-preview-cr\.yaml$/,
        );
        expect(argv[argv.indexOf("-n") + 1]).toBe("previews");
    });
});

/* ------------------------------------------------------------------ *
 * The cited pruning example must be a field the CLI actually EMITS.    *
 * A fabricated concrete example in a security note is worse than none: *
 * it invites verification and loses the reader's trust in the rest.    *
 * ------------------------------------------------------------------ */

/**
 * Every BACKTICKED `spec.…` path in the strict-validation prose is a claim that
 * the CLI emits that field. There is deliberately NO allowlist: the one path
 * that names a field nothing emits (`spec.template.spec.thisFieldDoesNotExist…`,
 * quoted from a real kubectl rejection) is written inside double quotes, as part
 * of the quoted error text, so it is not a claim and is not matched here. An
 * allowlist would be a pre-authorised hole — backticking an unemitted path later
 * would silently become legal.
 */
function citedSpecPaths(text: string): string[] {
    return [...text.matchAll(/`(spec\.[A-Za-z][A-Za-z0-9_.]*)`/g)].map(
        (m) => m[1] as string,
    );
}

function hasPath(root: unknown, path: string): boolean {
    let node: unknown = root;
    for (const key of path.split(".")) {
        if (typeof node !== "object" || node === null) return false;
        if (!(key in (node as Record<string, unknown>))) return false;
        node = (node as Record<string, unknown>)[key];
    }
    return node !== undefined;
}

describe("strict-validation prose — every cited spec field is one the CLI emits", () => {
    /** A config exercising the optional blocks the CR builder can emit. */
    const maximalConfig: KnativeNextConfig = {
        ...baseConfig,
        database: {
            secretRef: { name: "app-db" },
            roSecretRef: { name: "app-db", key: "DATABASE_URL_RO" },
        },
    };

    async function builtCR(): Promise<Record<string, unknown>> {
        // The real module, captured ONCE at module scope below — not
        // `vi.importActual`, which bun has no equivalent of.
        //
        // It must be captured before `mock.module("../cli/cr-builder", …)`
        // registers: importing inside the mocked window returns the mock, and
        // importing inside a factory deadlocks outright.
        const actual = __knextRealCrBuilder;
        return actual.buildNextAppCRObject(
            maximalConfig,
            `registry.example.com/my-app@sha256:${"b".repeat(64)}`,
            "prod",
            "build-1",
        );
    }

    function proseSources(): Map<string, string> {
        const root = join(dirname(TEST_FILE), "..", "..", "..", "..");
        const files = [
            join(CLI_DIR, "deploy.ts"),
            join(CLI_DIR, "doctor.ts"),
            join(dirname(TEST_FILE), "doctor.test.ts"),
            TEST_FILE,
        ];
        const out = new Map<string, string>();
        for (const f of files) out.set(f, realFs.readFileSync(f, "utf-8"));
        // Only §2.1 of the roadmap — the section that makes this claim.
        const roadmap = realFs.readFileSync(
            join(root, "docs", "V1_ROADMAP.md"),
            "utf-8",
        );
        const start = roadmap.indexOf("### 2.1");
        const end = roadmap.indexOf("### 2.2", start);
        out.set("docs/V1_ROADMAP.md#2.1", roadmap.slice(start, end));
        return out;
    }

    it("cites at least one concrete field (the prose is worth checking)", () => {
        const sources = proseSources();
        const cited = [...sources.values()].flatMap(citedSpecPaths);
        expect(cited.length).toBeGreaterThan(0);
    });

    it("every cited `spec.…` example is emitted by buildNextAppCRObject", async () => {
        const cr = await builtCR();
        const sources = proseSources();
        for (const [file, text] of sources) {
            for (const path of new Set(citedSpecPaths(text))) {
                expect(
                    hasPath(cr, path),
                    `${file} cites \`${path}\` as a field this CLI emits, but buildNextAppCRObject never produces it`,
                ).toBe(true);
            }
        }
    });
});
