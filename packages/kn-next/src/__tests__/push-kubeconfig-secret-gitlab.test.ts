/**
 * `pushKubeconfigSecretGitlab` (#1534) — the GitLab counterpart of
 * `push-kubeconfig-secret.test.ts`. Same two load-bearing properties:
 *
 *   1. a cloud-credential kubeconfig is refused BEFORE `glab` is ever called;
 *   2. the token value never appears in anything this module returns, logs,
 *      or passes as an argv entry — only ever via `glab`'s stdin.
 *
 * Plus the GitLab-specific escape hatch: when `glab` is not on PATH, this
 * prints manual steps instead of failing — proved with a `available` DI that
 * reports "not installed" and a real subprocess check that `glab` is never
 * invoked in that case either.
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
    type GlabRunFn,
    pushKubeconfigSecretGitlab,
} from "../cli/ci/push-kubeconfig-secret-gitlab";

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

describe("pushKubeconfigSecretGitlab — DI (#1534)", () => {
    it("refuses an exec-plugin kubeconfig WITHOUT ever calling glab or checking availability", () => {
        let ranAvailable = false;
        let ranPush = false;
        const r = pushKubeconfigSecretGitlab(EXEC_KUBECONFIG, {
            available: () => {
                ranAvailable = true;
                return true;
            },
            run: () => {
                ranPush = true;
                return { ok: true, code: 0 };
            },
        });
        expect(r.ok).toBe(false);
        expect(r.error).toBe(CLOUD_CREDENTIAL_REFUSAL);
        expect(ranAvailable).toBe(false);
        expect(ranPush).toBe(false);
    });

    it("pushes a scoped bearer-token kubeconfig via glab variable set --masked --protected, value on stdin", () => {
        let receivedArgs: readonly string[] = [];
        let receivedInput = "";
        const run: GlabRunFn = (args, input) => {
            receivedArgs = args;
            receivedInput = input;
            return { ok: true, code: 0 };
        };
        const r = pushKubeconfigSecretGitlab(TOKEN_KUBECONFIG, {
            run,
            available: () => true,
        });
        expect(r.ok).toBe(true);
        expect(receivedArgs).toEqual([
            "variable",
            "set",
            DEFAULT_SECRET_NAME,
            "--masked",
            "--protected",
        ]);
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
        const run: GlabRunFn = (args) => {
            receivedArgs = args;
            return { ok: true, code: 0 };
        };
        pushKubeconfigSecretGitlab(TOKEN_KUBECONFIG, {
            run,
            available: () => true,
            secretName: "MY_KUBECONFIG",
        });
        expect(receivedArgs[2]).toBe("MY_KUBECONFIG");
    });

    it("reports failure without echoing glab's own output", () => {
        const run: GlabRunFn = () => ({ ok: false, code: 1 });
        const r = pushKubeconfigSecretGitlab(TOKEN_KUBECONFIG, {
            run,
            available: () => true,
        });
        expect(r.ok).toBe(false);
        expect(r.error).toBeTruthy();
        expect(r.error).not.toContain("super-secret-token-value-123");
    });

    it("prints manual steps instead of pushing when glab is not available, and never calls run", () => {
        let ranPush = false;
        const r = pushKubeconfigSecretGitlab(TOKEN_KUBECONFIG, {
            available: () => false,
            run: () => {
                ranPush = true;
                return { ok: true, code: 0 };
            },
        });
        expect(r.ok).toBe(true);
        expect(ranPush).toBe(false);
        expect(r.manualSteps).toContain(DEFAULT_SECRET_NAME);
        expect(r.manualSteps).toContain("Masked");
        expect(r.manualSteps).toContain("Protected");
        // Never echoes the secret's own bytes.
        expect(r.manualSteps).not.toContain("super-secret-token-value-123");
    });
});

describe("pushKubeconfigSecretGitlab — real subprocess, fake glab on PATH (#1534)", () => {
    it("the token crosses the process boundary only via stdin, never via argv/env/output", () => {
        const dir = mkdtempSync(
            join(tmpdir(), "knext-push-secret-glab-fakebin-"),
        );
        const sentinel = join(dir, "received-stdin.txt");
        const fakeGlab = join(dir, "glab");
        // Mirrors glab's real `variable set` flag set
        // (`internal/commands/variable/set/set.go`, gitlab.com/gitlab-org/cli):
        // only -v/--value, -t/--type, -s/--scope, -g/--group, -m/--masked,
        // --hidden, -r/--protected, -p/--project, -d/--description are known.
        // Any other flag (e.g. the old `--value-file`) is rejected, exactly
        // like the real binary, so this class of drift cannot recur silently.
        writeFileSync(
            fakeGlab,
            [
                "#!/usr/bin/env bash",
                "set -euo pipefail",
                'if [ "$1" = "--version" ]; then echo "fake-glab 1.0.0"; exit 0; fi',
                'if [ "$1" != "variable" ] || [ "$2" != "set" ]; then',
                '  echo "fake-glab: unsupported invocation: $*" >&2',
                "  exit 1",
                "fi",
                "shift 2",
                'for arg in "$@"; do',
                '  case "$arg" in',
                "    -v|--value|-t|--type|-s|--scope|-g|--group|-m|--masked|--hidden|-r|--protected|-p|--project|-d|--description)",
                "      ;;",
                "    -*)",
                '      echo "ERROR Unknown flag: $arg" >&2',
                "      exit 1",
                "      ;;",
                "  esac",
                "done",
                'echo "fake-glab: argv=$*"',
                "cat > " + JSON.stringify(sentinel),
                'echo "fake-glab: variable set (ok)"',
                "",
            ].join("\n"),
        );
        chmodSync(fakeGlab, 0o755);

        const driver = join(dir, "driver.mjs");
        writeFileSync(
            driver,
            [
                "import { pushKubeconfigSecretGitlab } from " +
                    JSON.stringify(
                        join(
                            import.meta.dirname,
                            "..",
                            "cli",
                            "ci",
                            "push-kubeconfig-secret-gitlab.ts",
                        ),
                    ) +
                    ";",
                "const kubeconfig = " + JSON.stringify(TOKEN_KUBECONFIG) + ";",
                "const r = pushKubeconfigSecretGitlab(kubeconfig);",
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
        const receivedB64 = readFileSync(sentinel, "utf8").trim();
        expect(Buffer.from(receivedB64, "base64").toString("utf8")).toBe(
            TOKEN_KUBECONFIG,
        );
        expect(combined).toContain('"ok":true');

        rmSync(dir, { recursive: true, force: true });
    });

    it("with no glab on PATH at all, prints manual steps and never spawns anything named glab", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-push-secret-noglab-"));
        const driver = join(dir, "driver.mjs");
        writeFileSync(
            driver,
            [
                "import { pushKubeconfigSecretGitlab } from " +
                    JSON.stringify(
                        join(
                            import.meta.dirname,
                            "..",
                            "cli",
                            "ci",
                            "push-kubeconfig-secret-gitlab.ts",
                        ),
                    ) +
                    ";",
                "const kubeconfig = " + JSON.stringify(TOKEN_KUBECONFIG) + ";",
                "const r = pushKubeconfigSecretGitlab(kubeconfig);",
                "console.log(JSON.stringify(r));",
            ].join("\n"),
        );

        const result = spawnSync(process.execPath, [driver], {
            encoding: "utf8",
            env: {
                ...process.env,
                // An empty-but-present PATH: no `glab` reachable anywhere.
                PATH: dir,
            },
        });
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout);
        expect(parsed.ok).toBe(true);
        expect(parsed.manualSteps).toContain(DEFAULT_SECRET_NAME);

        rmSync(dir, { recursive: true, force: true });
    });
});
