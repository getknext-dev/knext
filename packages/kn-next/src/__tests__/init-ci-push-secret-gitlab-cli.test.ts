/**
 * `kn-next init-ci --provider gitlab --push-secret <path>` (#1534) — the CLI
 * wiring around `pushKubeconfigSecretGitlab`, mirroring
 * `init-ci-push-secret-cli.test.ts`'s real-child-process discipline: the
 * token-leak assertions run `initCiMain` in a genuine subprocess, because a
 * JS-level spy on `process.stdout.write` cannot see what a logging transport
 * writes straight to the fd (the exact mutation class that file's header
 * documents).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOUD_CREDENTIAL_REFUSAL } from "../cli/ci/kubeconfig-safety";

let dir: string;
const savedCwd = process.cwd();
const savedPath = process.env.PATH;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-push-secret-gitlab-cli-"));
    process.chdir(dir);
});

afterEach(() => {
    process.chdir(savedCwd);
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
});

/** A fake `glab` that answers --version, swallows `variable set`, and writes
 * whatever it received on stdin (never argv) to a sentinel file. */
function installFakeGlab(behavior: "succeed" | "fail"): {
    binDir: string;
    sentinel: string;
    argvLog: string;
} {
    const binDir = join(dir, "fakebin");
    const sentinel = join(dir, "received.txt");
    const argvLog = join(dir, "argv.txt");
    const fake = join(binDir, "glab");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
        fake,
        [
            "#!/usr/bin/env bash",
            "set -euo pipefail",
            'if [ "$1" = "--version" ]; then echo "fake-glab 1.0.0"; exit 0; fi',
            `printf '%s\\n' "$*" > ${JSON.stringify(argvLog)}`,
            `cat > ${JSON.stringify(sentinel)}`,
            behavior === "succeed"
                ? 'echo "ok"; exit 0'
                : 'echo "boom" >&2; exit 1',
            "",
        ].join("\n"),
    );
    chmodSync(fake, 0o755);
    return { binDir, sentinel, argvLog };
}

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

describe("init-ci --provider gitlab --push-secret (#1534)", () => {
    it("refuses an exec-plugin kubeconfig with the EXACT sentence, never calling glab", () => {
        const kubeconfigPath = join(dir, "bad.kubeconfig");
        writeFileSync(kubeconfigPath, EXEC_KUBECONFIG);
        // No fake glab installed at all — if the code path reached glab it
        // would fail with "command not found", not the refusal text.
        const r = runInitCiSubprocess(
            [
                "--namespace",
                "acme",
                "--provider",
                "gitlab",
                "--push-secret",
                kubeconfigPath,
            ],
            {},
        );
        expect(r.status).toBe(1);
        expect(r.combined).toContain(CLOUD_CREDENTIAL_REFUSAL);
    });

    it("pushes a scoped kubeconfig via stdin only — never argv — and prints no token bytes anywhere", () => {
        const { binDir, sentinel, argvLog } = installFakeGlab("succeed");
        const kubeconfigPath = join(dir, "good.kubeconfig");
        writeFileSync(kubeconfigPath, TOKEN_KUBECONFIG);

        const r = runInitCiSubprocess(
            [
                "--namespace",
                "acme",
                "--provider",
                "gitlab",
                "--push-secret",
                kubeconfigPath,
            ],
            { PATH: `${binDir}:${savedPath ?? ""}` },
        );

        expect(r.status).toBe(0);
        expect(r.combined).not.toContain("the-actual-token-bytes-xyz");

        // The mutation this pins: the token moved from stdin to argv. The
        // fake glab logs its OWN argv to a separate file from the stdin
        // sentinel, so this asserts the two never merge.
        const argv = readFileSync(argvLog, "utf8");
        expect(argv).not.toContain("the-actual-token-bytes-xyz");
        expect(argv).not.toContain(
            Buffer.from(TOKEN_KUBECONFIG, "utf8").toString("base64"),
        );

        const received = readFileSync(sentinel, "utf8").trim();
        expect(Buffer.from(received, "base64").toString("utf8")).toBe(
            TOKEN_KUBECONFIG,
        );
    });

    it("surfaces a glab failure without printing the token", () => {
        const { binDir } = installFakeGlab("fail");
        const kubeconfigPath = join(dir, "good.kubeconfig");
        writeFileSync(kubeconfigPath, TOKEN_KUBECONFIG);

        const r = runInitCiSubprocess(
            [
                "--namespace",
                "acme",
                "--provider",
                "gitlab",
                "--push-secret",
                kubeconfigPath,
            ],
            { PATH: `${binDir}:${savedPath ?? ""}` },
        );

        expect(r.status).toBe(1);
        expect(r.combined).not.toContain("the-actual-token-bytes-xyz");
    });

    it("with no glab on PATH, prints manual steps (exit 0) rather than crashing", () => {
        const kubeconfigPath = join(dir, "good.kubeconfig");
        writeFileSync(kubeconfigPath, TOKEN_KUBECONFIG);

        const r = runInitCiSubprocess(
            [
                "--namespace",
                "acme",
                "--provider",
                "gitlab",
                "--push-secret",
                kubeconfigPath,
            ],
            { PATH: dir },
        );

        expect(r.status).toBe(0);
        expect(r.combined).toContain("KNEXT_KUBECONFIG");
        expect(r.combined).not.toContain("the-actual-token-bytes-xyz");
    });
});
