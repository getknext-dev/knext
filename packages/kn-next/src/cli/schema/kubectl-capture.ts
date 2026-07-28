/**
 * kubectl-capture.ts — the production `KubectlCapture` boundary.
 *
 * The preflight must READ kubectl's stderr (the apiserver names the rejected
 * field in it), so it cannot use `runInherit`, which streams stdio straight to
 * the terminal and leaves knext with nothing to classify. Same shape as
 * doctor's runner: spawnSync, `shell: false`, NEVER throws.
 */

import { spawnSync } from "node:child_process";
import type { KubectlCapture, KubectlResult } from "./preflight";

export const captureKubectl: KubectlCapture = (
    argv: readonly string[],
): KubectlResult => {
    // argv[0] is the literal "kubectl" (kept in the argv for test-stub clarity).
    const r = spawnSync("kubectl", argv.slice(1) as string[], {
        shell: false,
        encoding: "utf-8",
        maxBuffer: 32 * 1024 * 1024,
    });
    return {
        ok: r.status === 0,
        stdout: (r.stdout ?? "").toString(),
        stderr: (r.stderr ?? String(r.error?.message ?? "")).toString(),
    };
};
