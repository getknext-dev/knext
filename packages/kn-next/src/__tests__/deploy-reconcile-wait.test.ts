/**
 * #1535 — `deploy`'s post-apply reconcile wait.
 *
 * Before this, `deploy()` read `status.url` ONCE, immediately after the
 * apply, and logged whatever came back (including empty, when the operator
 * hadn't reconciled at all). This suite pins the replacement: poll
 * `status.conditions` for up to `waitMs`, and produce the exact one-sentence
 * warning when nothing reconciled in time — hermetically, with an injected
 * `getNextApp` and a fake `sleep` so the suite costs no real wall-clock time.
 */

import { describe, expect, it } from "bun:test";
import {
    noReconcileMessage,
    operatorPodCheckCommand,
    RECONCILE_WAIT_MS_DEFAULT,
    waitForOperatorReconcile,
} from "../cli/deploy-reconcile-wait";

/** A fake sleep that just advances a shared clock — no real delay. */
function fakeClock() {
    let now = 0;
    return {
        now: () => now,
        sleep: async (ms: number) => {
            now += ms;
        },
    };
}

describe("noReconcileMessage (#1535)", () => {
    it("is the exact sentence, naming the operator-pod command", () => {
        expect(noReconcileMessage(15_000)).toBe(
            "NextApp applied; no operator reconciled it in 15s. Check the operator pod: kubectl get pods -n kn-next-operator-system.",
        );
    });

    it("renders a different wait bound correctly", () => {
        expect(noReconcileMessage(30_000)).toContain("in 30s");
    });

    it("operatorPodCheckCommand names the operator namespace", () => {
        expect(operatorPodCheckCommand()).toBe(
            "kubectl get pods -n kn-next-operator-system",
        );
    });
});

describe("waitForOperatorReconcile (#1535)", () => {
    it("returns reconciled=true as soon as status.conditions is non-empty", async () => {
        let calls = 0;
        const result = await waitForOperatorReconcile(
            () => {
                calls += 1;
                return {
                    ok: true,
                    stdout: JSON.stringify({
                        status: {
                            conditions: [{ type: "Ready", status: "True" }],
                            url: "https://shop.example.com",
                        },
                    }),
                    stderr: "",
                };
            },
            { waitMs: 15_000, pollIntervalMs: 1_000, sleep: async () => {} },
        );
        expect(result).toEqual({
            reconciled: true,
            url: "https://shop.example.com",
        });
        expect(calls).toBe(1);
    });

    it("polls until conditions appear, then stops", async () => {
        let calls = 0;
        const clock = fakeClock();
        const result = await waitForOperatorReconcile(
            () => {
                calls += 1;
                const reconciled = calls >= 3;
                return {
                    ok: true,
                    stdout: JSON.stringify({
                        status: {
                            conditions: reconciled
                                ? [{ type: "Ready", status: "True" }]
                                : [],
                            url: reconciled ? "https://shop.example.com" : "",
                        },
                    }),
                    stderr: "",
                };
            },
            {
                waitMs: 15_000,
                pollIntervalMs: 1_000,
                sleep: clock.sleep,
                now: clock.now,
            },
        );
        expect(calls).toBe(3);
        expect(result.reconciled).toBe(true);
    });

    it("gives up at the deadline: reconciled=false, never throws", async () => {
        const clock = fakeClock();
        const result = await waitForOperatorReconcile(
            () => ({
                ok: true,
                stdout: JSON.stringify({ status: { conditions: [] } }),
                stderr: "",
            }),
            {
                waitMs: 3_000,
                pollIntervalMs: 1_000,
                sleep: clock.sleep,
                now: clock.now,
            },
        );
        expect(result.reconciled).toBe(false);
        expect(clock.now()).toBeGreaterThanOrEqual(3_000);
    });

    it("a transient kubectl failure mid-poll does not throw or abort early", async () => {
        let calls = 0;
        const result = await waitForOperatorReconcile(
            () => {
                calls += 1;
                if (calls === 1) {
                    return { ok: false, stdout: "", stderr: "i/o timeout" };
                }
                return {
                    ok: true,
                    stdout: JSON.stringify({
                        status: { conditions: [{ type: "Ready" }] },
                    }),
                    stderr: "",
                };
            },
            { waitMs: 15_000, pollIntervalMs: 1_000, sleep: async () => {} },
        );
        expect(result.reconciled).toBe(true);
        expect(calls).toBe(2);
    });

    it("unparseable stdout is treated as 'not reconciled yet', not a crash", async () => {
        const clock = fakeClock();
        const result = await waitForOperatorReconcile(
            () => ({ ok: true, stdout: "not json", stderr: "" }),
            {
                waitMs: 2_000,
                pollIntervalMs: 1_000,
                sleep: clock.sleep,
                now: clock.now,
            },
        );
        expect(result.reconciled).toBe(false);
    });

    it("defaults to RECONCILE_WAIT_MS_DEFAULT when waitMs is omitted", async () => {
        const clock = fakeClock();
        await waitForOperatorReconcile(
            () => ({
                ok: true,
                stdout: JSON.stringify({ status: { conditions: [] } }),
                stderr: "",
            }),
            { pollIntervalMs: 1_000, sleep: clock.sleep, now: clock.now },
        );
        expect(clock.now()).toBeGreaterThanOrEqual(RECONCILE_WAIT_MS_DEFAULT);
    });
});
