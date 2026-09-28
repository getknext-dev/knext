/**
 * `init-ci --provider gitlab --push-secret` (#1534) — the GitLab counterpart
 * of `push-kubeconfig-secret.ts`. Same two refusals before `glab` is ever
 * invoked (unreadable file, handled by the caller; `classifyKubeconfigSafety`
 * refusing an exec/auth-provider shape, handled here) and the same rule for
 * the bytes afterward: base64-encoded, piped ONLY to `glab`'s stdin, never an
 * argv entry a co-resident process could read via `ps`.
 *
 * `glab variable set <key>` reads the value from stdin whenever `-v`/`--value`
 * is omitted (glab's own examples: `glab variable set FROM_FILE < secret.txt`).
 * glab has **no `--value-file` flag** — `internal/commands/variable/set/set.go`
 * (gitlab.com/gitlab-org/cli, current release) defines only `-v/--value`, `-t`,
 * `-s`, `-g`, `-m`/`--masked`, `--hidden`, `-r`/`--protected`, `-p`, `-d`; an
 * earlier revision of this file passed `--value-file -`, which is `Unknown
 * flag: --value-file` on every real `glab`. If `glab` is not on PATH, this
 * prints the manual steps instead of failing silently — there is no cluster
 * call to skip by failing here, only a secret push the user can do by hand.
 */
import { spawnSync } from "node:child_process";
import { classifyKubeconfigSafety } from "./kubeconfig-safety";

export interface GlabRunResult {
    ok: boolean;
    /** Exit code, or null if the process could not be spawned at all
     * (e.g. `glab` is not installed). */
    code: number | null;
}

/** Injected for tests — same contract as `GhRunFn`: no stdout/stderr field,
 * so a caller cannot accidentally log what `glab` echoed back. */
export type GlabRunFn = (
    args: readonly string[],
    input: string,
) => GlabRunResult;

export const defaultGlabRun: GlabRunFn = (args, input) => {
    const r = spawnSync("glab", args, {
        input,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
    });
    return { ok: r.status === 0, code: r.status };
};

export interface PushSecretGitlabResult {
    ok: boolean;
    /** Set iff `ok` is false. Never contains the kubeconfig's bytes. */
    error?: string;
    /** Set when `glab` was not run at all — the manual steps to print instead. */
    manualSteps?: string;
}

export const DEFAULT_SECRET_NAME = "KNEXT_KUBECONFIG";

/** True when `glab` resolves on PATH — checked before spawning it for real,
 * so a missing CLI is "print the manual steps" rather than an ENOENT crash. */
export type GlabAvailableFn = () => boolean;

export const defaultGlabAvailable: GlabAvailableFn = () => {
    const r = spawnSync("glab", ["--version"], {
        stdio: ["ignore", "ignore", "ignore"],
    });
    return r.error === undefined && r.status === 0;
};

function manualSteps(secretName: string): string {
    return [
        `glab is not installed, so this was NOT pushed automatically.`,
        "Push it yourself, in GitLab: Settings -> CI/CD -> Variables -> Add variable",
        `  Key:      ${secretName}`,
        "  Value:    (the base64-encoded kubeconfig — paste it, do not type it)",
        "  Type:     Variable",
        "  Flags:    Masked, Protected",
        "",
        "Or install glab (https://gitlab.com/gitlab-org/cli) and re-run this command.",
    ].join("\n");
}

/**
 * Classify, then push. Refuses a cloud-credential kubeconfig with the same
 * sentence `doctor --ci-kubeconfig`, the GitHub push-secret path and
 * `ci-preflight` use, and never calls `glab` at all in that case.
 */
export function pushKubeconfigSecretGitlab(
    kubeconfigYaml: string,
    opts: {
        secretName?: string;
        run?: GlabRunFn;
        available?: GlabAvailableFn;
    } = {},
): PushSecretGitlabResult {
    const verdict = classifyKubeconfigSafety(kubeconfigYaml);
    if (!verdict.ok) {
        return { ok: false, error: verdict.reason };
    }

    const secretName = opts.secretName ?? DEFAULT_SECRET_NAME;
    const available = opts.available ?? defaultGlabAvailable;

    if (!available()) {
        return { ok: true, manualSteps: manualSteps(secretName) };
    }

    const run = opts.run ?? defaultGlabRun;
    // Base64, matching the shape the generated `.gitlab-ci.yml` decodes
    // (`printf '%s' "$KNEXT_KUBECONFIG" | base64 -d`) — built once, here,
    // never re-derived downstream.
    const encoded = Buffer.from(kubeconfigYaml, "utf8").toString("base64");

    const result = run(
        ["variable", "set", secretName, "--masked", "--protected"],
        encoded,
    );
    if (!result.ok) {
        return {
            ok: false,
            error:
                `glab variable set ${secretName} exited ` +
                `${result.code ?? "without running"} — is glab installed and ` +
                "authenticated (`glab auth status`)?",
        };
    }
    return { ok: true };
}
