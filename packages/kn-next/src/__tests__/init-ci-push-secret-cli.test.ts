/**
 * `kn-next init-ci --push-secret <path>` (#1533) — the CLI wiring around
 * `pushKubeconfigSecret`. `push-kubeconfig-secret.test.ts` proves the
 * function itself is DI-safe and never leaks a token; this file proves the
 * VERB reads the right file, refuses the right shape, and — the exit
 * criterion #1533 names explicitly — that a full `initCiMain` run with a
 * fake `gh` on PATH never prints the token to stdout or stderr.
 *
 * The token-leak assertions run `initCiMain` in a REAL child process rather
 * than spying on `process.stdout.write` in-process. That distinction is
 * load-bearing, not style: `log.info`'s pino-pretty transport writes via a
 * worker thread straight to the fd (sonic-boom), which a JS-level spy on
 * `process.stdout.write` never sees — a mutation that made the success path
 * `log.info(raw)` the whole kubeconfig stayed GREEN under the spied version
 * (caught by this repo's mutation-proving discipline, not by inspection).
 * Only a genuine subprocess capture is sensitive to what pino actually wrote.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCiMain } from "../cli/ci/init-ci-cmd";
import { CLOUD_CREDENTIAL_REFUSAL } from "../cli/ci/kubeconfig-safety";
import {
    LEAK_SENTINEL_PREFIX,
    MALFORMED_TOKEN_KUBECONFIGS,
} from "./helpers/malformed-kubeconfigs";

let dir: string;
const savedCwd = process.cwd();
const savedPath = process.env.PATH;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-push-secret-cli-"));
    process.chdir(dir);
});

afterEach(() => {
    process.chdir(savedCwd);
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
});

async function runInitCi(argv: string[]) {
    const outSpy = spyOn(process.stdout, "write").mockImplementation(
        () => true,
    );
    const errSpy = spyOn(process.stderr, "write").mockImplementation(
        () => true,
    );
    try {
        const code = await initCiMain(argv);
        const stdout = outSpy.mock.calls.map((c) => String(c[0])).join("");
        const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("");
        return { code, stdout, stderr };
    } finally {
        outSpy.mockRestore();
        errSpy.mockRestore();
    }
}

/** A fake `gh` that swallows `secret set` and writes stdin to a sentinel. */
function installFakeGh(behavior: "succeed" | "fail"): {
    binDir: string;
    sentinel: string;
} {
    const binDir = join(dir, "fakebin");
    const sentinel = join(dir, "received.txt");
    const fake = join(binDir, "gh");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
        fake,
        [
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            "cat > " + JSON.stringify(sentinel),
            behavior === "succeed"
                ? 'echo "ok"; exit 0'
                : 'echo "boom" >&2; exit 1',
            "",
        ].join("\n"),
    );
    chmodSync(fake, 0o755);
    process.env.PATH = `${binDir}:${savedPath ?? ""}`;
    return { binDir, sentinel };
}

/**
 * Run `initCiMain` in a genuine CHILD process and capture its real,
 * fd-level combined stdout+stderr — see the header note on why this is not
 * equivalent to spying on `process.stdout.write` in-process.
 */
function runInitCiSubprocess(
    argv: string[],
    env: Record<string, string | undefined>,
): { status: number | null; combined: string } {
    const driver = join(dir, "driver.mjs");
    writeFileSync(
        driver,
        [
            `import { initCiMain } from ${JSON.stringify(
                join(import.meta.dirname, "..", "cli", "ci", "init-ci-cmd.ts"),
            )};`,
            `const code = await initCiMain(${JSON.stringify(argv)});`,
            "process.exit(code);",
        ].join("\n"),
    );
    const r = spawnSync(process.execPath, [driver], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, ...env },
    });
    return {
        status: r.status,
        combined: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    };
}

const TOKEN_KUBECONFIG = `
apiVersion: v1
kind: Config
users:
  - name: knext-deployer
    user:
      token: the-actual-token-bytes-xyz
contexts: []
`;

const EXEC_KUBECONFIG = `
apiVersion: v1
kind: Config
users:
  - name: admin
    user:
      exec:
        command: aws
contexts: []
`;

describe("init-ci --push-secret (#1533)", () => {
    it("missing --push-secret file is exit 1, no crash", async () => {
        const r = await runInitCi([
            "--namespace",
            "acme",
            "--push-secret",
            "does-not-exist.kubeconfig",
        ]);
        expect(r.code).toBe(1);
    });

    it("refuses an exec-plugin kubeconfig with the EXACT sentence, never calling gh", async () => {
        const kubeconfigPath = join(dir, "bad.kubeconfig");
        writeFileSync(kubeconfigPath, EXEC_KUBECONFIG);
        // No fake gh installed at all — if the code path reached gh it would
        // fail with "command not found", not the refusal text, so this also
        // proves gh was never invoked.
        const r = await runInitCi([
            "--namespace",
            "acme",
            "--push-secret",
            kubeconfigPath,
        ]);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain(CLOUD_CREDENTIAL_REFUSAL);
    });

    it("pushes a scoped kubeconfig and prints no token bytes anywhere — real child-process capture", () => {
        const { binDir, sentinel } = installFakeGh("succeed");
        const kubeconfigPath = join(dir, "good.kubeconfig");
        writeFileSync(kubeconfigPath, TOKEN_KUBECONFIG);

        const r = runInitCiSubprocess(
            ["--namespace", "acme", "--push-secret", kubeconfigPath],
            { PATH: `${binDir}:${savedPath ?? ""}` },
        );

        expect(r.status).toBe(0);
        expect(r.combined).not.toContain("the-actual-token-bytes-xyz");

        // And the value truly was sent — over stdin to the fake gh — so
        // "never appears" above is not vacuous.
        const received = readFileSync(sentinel, "utf8").trim();
        expect(Buffer.from(received, "base64").toString("utf8")).toBe(
            TOKEN_KUBECONFIG,
        );
    });

    it("surfaces a gh failure without printing the token — real child-process capture", () => {
        const { binDir } = installFakeGh("fail");
        const kubeconfigPath = join(dir, "good.kubeconfig");
        writeFileSync(kubeconfigPath, TOKEN_KUBECONFIG);

        const r = runInitCiSubprocess(
            ["--namespace", "acme", "--push-secret", kubeconfigPath],
            { PATH: `${binDir}:${savedPath ?? ""}` },
        );

        expect(r.status).toBe(1);
        expect(r.combined).not.toContain("the-actual-token-bytes-xyz");
    });

    // Round 2 of #1557: a parse error used to relay the YAML library's
    // message, which quotes the failing source line — the token line.
    for (const [name, text] of Object.entries(MALFORMED_TOKEN_KUBECONFIGS)) {
        it(`${name}: a malformed kubeconfig is refused with no token bytes on stdout/stderr — real child-process capture`, () => {
            const { binDir, sentinel } = installFakeGh("succeed");
            const kubeconfigPath = join(dir, `${name}.kubeconfig`);
            writeFileSync(kubeconfigPath, text);

            const r = runInitCiSubprocess(
                ["--namespace", "acme", "--push-secret", kubeconfigPath],
                { PATH: `${binDir}:${savedPath ?? ""}` },
            );

            expect(r.status).toBe(1);
            expect(r.combined).toContain(
                "could not parse this file as a kubeconfig",
            );
            expect(r.combined).not.toContain(LEAK_SENTINEL_PREFIX);
            // Refused before gh: nothing was pushed.
            expect(existsSync(sentinel)).toBe(false);
        });
    }
});
