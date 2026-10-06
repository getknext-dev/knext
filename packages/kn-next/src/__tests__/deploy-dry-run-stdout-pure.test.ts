/**
 * `knext deploy --dry-run` must keep stdout PURE: the rendered NextApp CR and
 * nothing else, so `knext deploy --dry-run | kubectl apply -f -` works.
 *
 * Two halves, both required:
 *  1. The logger honours KN_LOG_DESTINATION=stderr — proven end to end in a real
 *     subprocess, asserting the bytes on each stream (no ANSI on stdout, logs
 *     still visible on stderr), in both dev (pino-pretty) and production (JSON).
 *  2. deploy's `--dry-run` actually selects that destination — a hermetic
 *     in-process run, so the logger half is not decorative.
 */
import { afterAll, describe, expect, it, jest, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const tempRoots: string[] = [];
afterAll(() => {
    for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

const LOGGER_PATH = fileURLToPath(
    new URL("../utils/logger.ts", import.meta.url),
);
const CR =
    "apiVersion: apps.kn-next.dev/v1alpha1\nkind: NextApp\nmetadata:\n  name: demo\n";

function runLogger(env: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "knext-dry-run-pure-"));
    tempRoots.push(dir);
    const script = join(dir, "emit.ts");
    writeFileSync(
        script,
        `import { createLogger } from ${JSON.stringify(LOGGER_PATH)};
const log = createLogger({ module: "deploy" });
log.info("Dry run — NextApp CR (not applied):");
process.stdout.write(${JSON.stringify(CR)});
log.info("Dry run complete");
`,
    );
    const baseEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k !== "NO_COLOR" && k !== "LOG_LEVEL")
            baseEnv[k] = v;
    }
    const r = Bun.spawnSync([process.execPath, script], {
        env: { ...baseEnv, ...env },
    });
    return {
        stdout: r.stdout.toString(),
        stderr: r.stderr.toString(),
        code: r.exitCode,
    };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ANSI absence
const ANSI = /\u001b\[/;

describe("logger destination (KN_LOG_DESTINATION=stderr)", () => {
    for (const nodeEnv of ["development", "production"]) {
        it(`${nodeEnv}: stdout is only the CR, logs land on stderr`, () => {
            const r = runLogger({
                NODE_ENV: nodeEnv,
                KN_LOG_DESTINATION: "stderr",
            });
            expect(r.code).toBe(0);
            expect(r.stdout).not.toMatch(ANSI);
            expect(r.stdout).toBe(CR);
            expect(parse(r.stdout).kind).toBe("NextApp");
            expect(r.stderr).toContain("Dry run complete");
        });
    }

    it("default (no env) is unchanged: logs stay on stdout", () => {
        const r = runLogger({ NODE_ENV: "production" });
        expect(r.stdout).toContain("Dry run complete");
    });
});

// ---- deploy wiring (hermetic, mirrors deploy-image-flag.test.ts) ----
const { reconciledNextAppCapture } = await import(
    "./helpers/reconciled-nextapp"
);

mock.module("../cli/exec", () => ({
    runQuiet: mock(),
    runInherit: mock(),
    runCapture: mock(() => ""),
    runQuietAllowFail: mock(),
    isEntrypoint: () => false,
}));
const __realCr = { ...(await import("../cli/cr-builder")) };
mock.module("../cli/cr-builder", () => ({
    ...__realCr,
    renderNextAppCR: () => CR,
    resolveDigest: async () => "registry.example.com/my-app@sha256:deadbeef",
}));
mock.module("../cli/schema/kubectl-capture", () => ({
    captureKubectl: () => reconciledNextAppCapture(),
}));
mock.module("../utils/logger", () => ({
    createLogger: () => ({
        info: mock(),
        warn: mock(),
        error: mock(),
        debug: mock(),
        fatal: mock(),
        trace: mock(),
    }),
}));
const __realShared = { ...(await import("../cli/shared")) };
mock.module("../cli/shared", () => ({
    ...__realShared,
    loadConfig: async () => ({
        name: "my-app",
        registry: "registry.example.com",
        storage: { provider: "gcs", bucket: "b", publicUrl: "https://x/b" },
        cache: { provider: "redis", url: "redis://r:6379", keyPrefix: "k" },
        scaling: { minScale: 0, maxScale: 5 },
    }),
    excerpt: (s: string) => s,
}));

const DIGEST =
    "registry.example.com/my-app:v1@sha256:1111111111111111111111111111111111111111111111111111111111111111";

describe("deploy --dry-run selects the stderr log destination", () => {
    it("sets KN_LOG_DESTINATION=stderr under --dry-run", async () => {
        const savedArgv = process.argv;
        const savedEnv = { ...process.env };
        const write = jest
            .spyOn(process.stdout, "write")
            .mockImplementation(() => true);
        try {
            const { deploy } = (await import("../cli/deploy")) as {
                deploy: () => Promise<void>;
            };
            delete process.env.KN_LOG_DESTINATION;
            process.argv = [
                "node",
                "kn-next.js",
                "deploy",
                "--image",
                DIGEST,
                "--tag",
                "t",
                "--skip-upload",
                "--dry-run",
            ];
            await deploy();
            expect(process.env.KN_LOG_DESTINATION).toBe("stderr");
            expect(write).toHaveBeenCalledWith(CR);
        } finally {
            write.mockRestore();
            process.argv = savedArgv;
            process.env = savedEnv;
        }
    });
});
