/**
 * Issue #92: rollback via Knative revision traffic split.
 *
 * ADR-0001 — the operator is the single authority for cluster state. The CLI
 * rollback affordance must emit INTENT, not mutate the cluster: `rollback.ts`
 * issues ONLY a `kubectl patch nextapp <name> --type merge -p <json>` that sets
 * (or clears) spec.traffic. It must NEVER write the ksvc / Knative Route / kn
 * directly — only the NextApp CR.
 */

import { describe, expect, it, vi } from "vitest";
import { parseRollbackArgs, runRollback } from "../cli/rollback";

describe("runRollback (#92 — CR-only traffic patch)", () => {
    it("pins to a revision: exactly ONE kubectl patch nextapp setting spec.traffic.revisionName", () => {
        const exec = vi.fn();
        runRollback("my-app", "default", "my-app-00002", undefined, exec);

        expect(exec).toHaveBeenCalledTimes(1);
        const argv = exec.mock.calls[0][0] as string[];
        expect(argv[0]).toBe("kubectl");
        expect(argv[1]).toBe("patch");
        expect(argv[2]).toBe("nextapp");
        expect(argv).toContain("my-app");
        expect(argv).toContain("--type");
        expect(argv).toContain("merge");

        const pIdx = argv.indexOf("-p");
        expect(pIdx).toBeGreaterThan(-1);
        const patch = JSON.parse(argv[pIdx + 1]);
        expect(patch.spec.traffic.revisionName).toBe("my-app-00002");
        expect(patch.spec.traffic.canaryPercent).toBeUndefined();
    });

    it("latest-ready (no --to): patches spec.traffic to null to clear any pin", () => {
        const exec = vi.fn();
        runRollback("my-app", "default", undefined, undefined, exec);

        expect(exec).toHaveBeenCalledTimes(1);
        const argv = exec.mock.calls[0][0] as string[];
        const patch = JSON.parse(argv[argv.indexOf("-p") + 1]);
        expect(patch).toEqual({ spec: { traffic: null } });
    });

    it("canary flows into the patch JSON alongside the pinned revision", () => {
        const exec = vi.fn();
        runRollback("my-app", "default", "my-app-00002", 20, exec);

        const argv = exec.mock.calls[0][0] as string[];
        const patch = JSON.parse(argv[argv.indexOf("-p") + 1]);
        expect(patch.spec.traffic.revisionName).toBe("my-app-00002");
        expect(patch.spec.traffic.canaryPercent).toBe(20);
    });

    it("passes -n <namespace> so the patch targets the right namespace", () => {
        const exec = vi.fn();
        runRollback("my-app", "preview", "my-app-00002", undefined, exec);
        const argv = exec.mock.calls[0][0] as string[];
        const nIdx = argv.indexOf("-n");
        expect(nIdx).toBeGreaterThan(-1);
        expect(argv[nIdx + 1]).toBe("preview");
    });

    it("the patch JSON is a single uninterpreted argv token (shell:false safe)", () => {
        const exec = vi.fn();
        runRollback("my-app", "default", "my-app-00002", undefined, exec);
        const argv = exec.mock.calls[0][0] as string[];
        const pIdx = argv.indexOf("-p");
        // Exactly one token follows -p, and it is valid JSON.
        expect(typeof argv[pIdx + 1]).toBe("string");
        expect(() => JSON.parse(argv[pIdx + 1])).not.toThrow();
    });

    it("NEGATIVE (ADR-0001): never targets ksvc / service / route / kn / knative — only nextapp", () => {
        const exec = vi.fn();
        runRollback("my-app", "default", "my-app-00002", 20, exec);
        const forbidden = [
            "ksvc",
            "service",
            "services",
            "route",
            "routes",
            "kn",
            "knative",
            "svc",
        ];
        for (const call of exec.mock.calls) {
            const argv = call[0] as string[];
            // The resource kind argument (argv[2]) must be exactly "nextapp".
            expect(argv[2]).toBe("nextapp");
            // No forbidden Knative kind appears as the binary or resource token.
            expect(forbidden).not.toContain(argv[0]);
            expect(forbidden).not.toContain(argv[2]);
        }
    });
});

describe("parseRollbackArgs hardening (PR #232 review — no silent opposite-intent mutations)", () => {
    it("dangling --to is a HARD ERROR, never a clear-the-pin", () => {
        // `kn-next rollback my-app --to` must not degrade to the bare-rollback
        // patch ({spec:{traffic:null}}) — that MUTATES traffic OPPOSITE to the
        // user's stated intent to pin.
        expect(() => parseRollbackArgs(["my-app", "--to"])).toThrow(
            /--to requires a value/,
        );
    });

    it("--to followed by another flag is dangling, not a revision named like a flag", () => {
        expect(() => parseRollbackArgs(["my-app", "--to", "-n"])).toThrow(
            /--to requires a value/,
        );
    });

    it("unknown flags are rejected (a typo'd --too must not silently clear the pin)", () => {
        expect(() => parseRollbackArgs(["my-app", "--too", "rev-1"])).toThrow(
            /unknown flag "--too"/,
        );
    });

    it("a second positional is rejected (only one <app> is accepted)", () => {
        expect(() => parseRollbackArgs(["my-app", "rev-1"])).toThrow(
            /only one <app>/,
        );
    });

    it("dangling -n / --canary are hard errors too", () => {
        expect(() => parseRollbackArgs(["my-app", "-n"])).toThrow(
            /-n requires a value/,
        );
        expect(() =>
            parseRollbackArgs(["my-app", "--to", "rev-1", "--canary"]),
        ).toThrow(/--canary requires a value/);
    });

    it("--canary enforces INTEGER 1–99 (matches the help text): 0, 100, 25.5, NaN rejected", () => {
        for (const bad of ["0", "100", "25.5", "abc"]) {
            expect(
                () =>
                    parseRollbackArgs([
                        "my-app",
                        "--to",
                        "rev-1",
                        "--canary",
                        bad,
                    ]),
                `--canary ${bad} must be rejected`,
            ).toThrow(/--canary must be an integer between 1 and 99/);
        }
        // A negative value reads as a dangling flag value ("-5" looks like a
        // flag) — still a HARD --canary error, just via the dangling-value path.
        {
            expect(() =>
                parseRollbackArgs([
                    "my-app",
                    "--to",
                    "rev-1",
                    "--canary",
                    "-5",
                ]),
            ).toThrow(/--canary requires a value/);
        }
    });

    it("--canary 25 with --to is accepted", () => {
        const args = parseRollbackArgs([
            "my-app",
            "--to",
            "rev-1",
            "--canary",
            "25",
        ]);
        expect(args.app).toBe("my-app");
        expect(args.toRevision).toBe("rev-1");
        expect(args.canaryPercent).toBe(25);
    });

    it("--canary without --to is rejected (it would be silently ignored otherwise)", () => {
        expect(() => parseRollbackArgs(["my-app", "--canary", "25"])).toThrow(
            /--canary requires --to/,
        );
    });

    it("the valid shapes still parse: pin, pin+namespace, bare clear", () => {
        expect(
            parseRollbackArgs(["my-app", "--to", "rev-1", "-n", "prod"]),
        ).toEqual({
            app: "my-app",
            namespace: "prod",
            toRevision: "rev-1",
        });
        expect(parseRollbackArgs(["my-app"])).toEqual({
            app: "my-app",
            namespace: "default",
        });
    });
});
