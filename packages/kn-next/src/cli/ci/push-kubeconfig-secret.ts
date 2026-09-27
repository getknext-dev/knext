/**
 * `init-ci --push-secret` (#1533) — push a minted kubeconfig to GitHub as the
 * KNEXT_KUBECONFIG repository secret, without the token ever touching a log
 * line, a console write, or an argv entry `ps` could see.
 *
 * Two refusals happen before `gh` is ever invoked:
 *   1. the file cannot be read (usage error, handled by the caller);
 *   2. `classifyKubeconfigSafety` refuses it (exec/auth-provider shape).
 *
 * After that, the ONLY place the secret's bytes travel is base64-encoded
 * into `gh`'s STDIN — never an argv entry, never a template string handed to
 * a logger. `gh secret set <name>` reads the value from stdin when no
 * `--body`/`--body-file` flag is given, the same convention
 * `docker login --password-stdin` uses in `kn-next-action/action.yml`.
 */
import { spawnSync } from "node:child_process";
import { classifyKubeconfigSafety } from "./kubeconfig-safety";

export interface GhRunResult {
    ok: boolean;
    /** Exit code, or null if the process could not be spawned at all. */
    code: number | null;
}

/**
 * Injected for tests. `args` are the `gh` argv (after the binary name);
 * `input` is what is written to its stdin. Implementations MUST NOT surface
 * `input` in any return value — {@link GhRunResult} deliberately carries no
 * stdout/stderr field, so a caller cannot accidentally log what `gh` echoed
 * back (some `gh` builds echo confirmation text that could, in principle,
 * quote part of what they were given).
 */
export type GhRunFn = (args: readonly string[], input: string) => GhRunResult;

/** Production runner: a real `gh`, secret piped via stdin, never via argv. */
export const defaultGhRun: GhRunFn = (args, input) => {
    const r = spawnSync("gh", args, {
        input,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
    });
    return { ok: r.status === 0, code: r.status };
};

export interface PushSecretResult {
    ok: boolean;
    /** Set iff `ok` is false. Never contains the kubeconfig's bytes. */
    error?: string;
}

export const DEFAULT_SECRET_NAME = "KNEXT_KUBECONFIG";

/**
 * Classify, then push. Refuses a cloud-credential kubeconfig with the same
 * sentence `doctor --ci-kubeconfig` and the action preflight use, and never
 * calls `gh` at all in that case — a refused credential should not even
 * reach the point of being base64-encoded.
 */
export function pushKubeconfigSecret(
    kubeconfigYaml: string,
    opts: { secretName?: string; run?: GhRunFn } = {},
): PushSecretResult {
    const verdict = classifyKubeconfigSafety(kubeconfigYaml);
    if (!verdict.ok) {
        return { ok: false, error: verdict.reason };
    }

    const secretName = opts.secretName ?? DEFAULT_SECRET_NAME;
    const run = opts.run ?? defaultGhRun;

    // Base64, matching the shape `kn-next-action`'s action.yml decodes
    // (`printf '%s' "$KNEXT_KUBECONFIG_B64" | base64 -d`) — the secret is
    // built once, here, and never re-derived downstream.
    const encoded = Buffer.from(kubeconfigYaml, "utf8").toString("base64");

    const result = run(["secret", "set", secretName], encoded);
    if (!result.ok) {
        return {
            ok: false,
            error:
                `gh secret set ${secretName} exited ` +
                `${result.code ?? "without running"} — is gh installed and ` +
                "authenticated (`gh auth status`)?",
        };
    }
    return { ok: true };
}
