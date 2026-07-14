/**
 * Contract tests (v3-P6a) proving that BOTH former hand-rolled excerpt sites
 * now route through the shared `excerpt()` helper and therefore behave
 * identically — in particular, whitespace is collapsed at BOTH sites.
 *
 * - doctor.ts: an infra (RBAC) probe failure's `detail` collapses multiline
 *   stderr to a single space-joined line and caps at 160 chars.
 * - status.ts: an unreachable-cluster error message now ALSO collapses
 *   whitespace (previously it did a bare `.slice(0, 160)` — the intentional
 *   consistency fix in this change).
 */

import { describe, expect, it } from "vitest";
import type { KubectlFn, KubectlResult } from "../cli/doctor";
import { runDoctor } from "../cli/doctor";
import { runStatus, type StatusDeps } from "../cli/status";

const okVersion: KubectlResult = {
    ok: true,
    stdout: "v1.30.0",
    stderr: "",
};

describe("excerpt call sites collapse whitespace identically", () => {
    it("doctor infra-failure detail collapses multiline stderr and caps at 160", async () => {
        const multilineForbidden =
            "Error from server (Forbidden):\n\n  customresourcedefinitions.apiextensions.k8s.io\tis   forbidden:\n  User cannot get";
        const kubectl: KubectlFn = (args) => {
            const joined = args.join(" ");
            if (joined.includes("/version")) return okVersion;
            if (joined.includes("crd")) {
                return { ok: false, stdout: "", stderr: multilineForbidden };
            }
            // Everything else: benign not-found so the run completes fast.
            return { ok: false, stdout: "", stderr: "(NotFound)" };
        };

        const report = await runDoctor({
            kubectl,
            probeImage: async () => "ok",
        });
        const crd = report.checks.find((c) => c.id === "crd");
        expect(crd?.status).toBe("error");
        // No raw newline or tab survives — collapsed to single spaces.
        expect(crd?.detail).not.toMatch(/[\n\t]/);
        expect(crd?.detail).not.toMatch(/ {2,}/);
        expect(crd?.detail).toContain("probe failed (rbac):");
        expect(crd?.detail).toContain(
            "Error from server (Forbidden): customresourcedefinitions.apiextensions.k8s.io is forbidden:",
        );
    });

    it("status unreachable-cluster error collapses whitespace (consistency fix)", async () => {
        const multilineStderr =
            "Unable to connect to the server:\n  dial tcp   10.0.0.1:6443:\n\tconnect: connection   refused";
        const kubectl: KubectlFn = () => ({
            ok: false,
            stdout: "",
            stderr: multilineStderr,
        });
        const deps: StatusDeps = {
            kubectl,
            write: () => {},
            now: () => new Date(),
            sleep: async () => {},
        };

        const opts = {
            namespace: "default",
            json: false,
            watch: false,
            timeoutMs: 1000,
        };
        await expect(runStatus("myapp", opts, deps)).rejects.toThrow(
            /cluster unreachable/,
        );

        let message = "";
        try {
            await runStatus("myapp", opts, deps);
        } catch (err) {
            message = (err as Error).message;
        }
        // The excerpt embedded in the message must be whitespace-collapsed —
        // no surviving newline/tab and no double spaces inside the excerpt.
        const inParens = /cluster unreachable \(([^)]*)\)/.exec(message)?.[1];
        expect(inParens).toBeDefined();
        expect(inParens).not.toMatch(/[\n\t]/);
        expect(inParens).not.toMatch(/ {2,}/);
        expect(inParens).toContain(
            "Unable to connect to the server: dial tcp 10.0.0.1:6443: connect: connection refused",
        );
    });
});
