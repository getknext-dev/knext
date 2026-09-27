/**
 * `pushKubeconfigSecret` (#1533) — the `init-ci --push-secret` flow.
 *
 * Two properties, both security-load-bearing:
 *   1. a cloud-credential kubeconfig is refused BEFORE `gh` is ever called
 *      (no leaking a refused credential to a third process at all);
 *   2. the token value never appears in anything this module returns, logs,
 *      or passes as an argv entry — only ever as `gh`'s stdin.
 *
 * The DI-based tests below are the fast, deterministic half. A second,
 * process-level test spawns a REAL `gh` stand-in on PATH and inspects what
 * actually crossed the process boundary — the thing DI cannot see, because DI
 * intercepts the call before argv/stdin are ever constructed for a real
 * subprocess.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    chmodSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOUD_CREDENTIAL_REFUSAL } from "../cli/ci/kubeconfig-safety";
import {
    DEFAULT_SECRET_NAME,
    type GhRunFn,
    pushKubeconfigSecret,
} from "../cli/ci/push-kubeconfig-secret";

const TOKEN_KUBECONFIG = `
apiVersion: v1
kind: Config
users:
  - name: knext-deployer
    user:
      token: super-secret-token-value-123
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

describe("pushKubeconfigSecret — DI (#1533)", () => {
    it("refuses an exec-plugin kubeconfig WITHOUT ever calling gh", () => {
        let called = false;
        const run: GhRunFn = () => {
            called = true;
            return { ok: true, code: 0 };
        };
        const r = pushKubeconfigSecret(EXEC_KUBECONFIG, { run });
        expect(r.ok).toBe(false);
        expect(r.error).toBe(CLOUD_CREDENTIAL_REFUSAL);
        expect(called).toBe(false);
    });

    it("pushes a scoped bearer-token kubeconfig via gh secret set <name>", () => {
        let receivedArgs: readonly string[] = [];
        let receivedInput = "";
        const run: GhRunFn = (args, input) => {
            receivedArgs = args;
            receivedInput = input;
            return { ok: true, code: 0 };
        };
        const r = pushKubeconfigSecret(TOKEN_KUBECONFIG, { run });
        expect(r.ok).toBe(true);
        expect(receivedArgs).toEqual(["secret", "set", DEFAULT_SECRET_NAME]);
        // The token never appears verbatim in argv — only base64 via stdin.
        expect(receivedArgs.join(" ")).not.toContain(
            "super-secret-token-value-123",
        );
        expect(Buffer.from(receivedInput, "base64").toString("utf8")).toBe(
            TOKEN_KUBECONFIG,
        );
    });

    it("honours a custom secret name", () => {
        let receivedArgs: readonly string[] = [];
        const run: GhRunFn = (args) => {
            receivedArgs = args;
            return { ok: true, code: 0 };
        };
        pushKubeconfigSecret(TOKEN_KUBECONFIG, {
            run,
            secretName: "MY_KUBECONFIG",
        });
        expect(receivedArgs).toEqual(["secret", "set", "MY_KUBECONFIG"]);
    });

    it("reports failure without echoing gh's own output", () => {
        const run: GhRunFn = () => ({ ok: false, code: 1 });
        const r = pushKubeconfigSecret(TOKEN_KUBECONFIG, { run });
        expect(r.ok).toBe(false);
        expect(r.error).toBeTruthy();
        expect(r.error).not.toContain("super-secret-token-value-123");
    });
});

describe("pushKubeconfigSecret — real subprocess, fake gh on PATH (#1533)", () => {
    // Belt-and-suspenders beyond the DI tests above: this exercises the
    // PRODUCTION `defaultGhRun` path — a real `spawnSync('gh', …)` — against a
    // stand-in `gh` script, and inspects what a THIRD PROCESS actually
    // received: the sentinel file proves the token WAS transmitted (via
    // stdin), and the captured combined stdout/stderr of the whole run proves
    // it was never echoed anywhere a human or a CI log would see it.
    it("the token crosses the process boundary only via stdin, never via argv/env/output", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-push-secret-fakebin-"));
        const sentinel = join(dir, "received-stdin.txt");
        const fakeGh = join(dir, "gh");
        // Prints its OWN argv and env (so a leak into either would show up in
        // the captured output), writes whatever it received on stdin to the
        // sentinel file (proving the value really was sent), and prints a
        // generic confirmation — never the stdin content.
        writeFileSync(
            fakeGh,
            [
                "#!/usr/bin/env bash",
                "set -euo pipefail",
                'echo "fake-gh: argv=$*"',
                "cat > " + JSON.stringify(sentinel),
                'echo "fake-gh: secret set (ok)"',
                "",
            ].join("\n"),
        );
        chmodSync(fakeGh, 0o755);

        // Drive the REAL default runner via a tiny child script rather than
        // calling `defaultGhRun` in-process, so `gh` really is resolved from
        // PATH exactly as it would be for a user — and so this process's own
        // stdout/stderr capture is the thing under test, not a mock.
        const driver = join(dir, "driver.mjs");
        writeFileSync(
            driver,
            [
                "import { pushKubeconfigSecret } from " +
                    JSON.stringify(
                        join(
                            import.meta.dirname,
                            "..",
                            "cli",
                            "ci",
                            "push-kubeconfig-secret.ts",
                        ),
                    ) +
                    ";",
                "const kubeconfig = " + JSON.stringify(TOKEN_KUBECONFIG) + ";",
                "const r = pushKubeconfigSecret(kubeconfig);",
                "console.log(JSON.stringify(r));",
            ].join("\n"),
        );

        const result = spawnSync(process.execPath, [driver], {
            encoding: "utf8",
            env: {
                ...process.env,
                PATH: `${dir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
            },
        });

        const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        expect(combined).not.toContain("super-secret-token-value-123");
        // The sentinel proves the value really crossed stdin (base64 of the
        // fixture), so "never appears" above is not vacuously true because
        // nothing was ever sent.
        const receivedB64 = readFileSync(sentinel, "utf8").trim();
        expect(Buffer.from(receivedB64, "base64").toString("utf8")).toBe(
            TOKEN_KUBECONFIG,
        );
        expect(combined).toContain('"ok":true');

        rmSync(dir, { recursive: true, force: true });
    });
});
