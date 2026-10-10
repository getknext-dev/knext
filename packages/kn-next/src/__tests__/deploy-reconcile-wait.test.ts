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
    heldChangeMessage,
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
    it("returns reconciled=true as soon as status.conditions carries a condition at the CR's own generation", async () => {
        let calls = 0;
        const result = await waitForOperatorReconcile(
            () => {
                calls += 1;
                return {
                    ok: true,
                    stdout: JSON.stringify({
                        metadata: { generation: 1 },
                        status: {
                            conditions: [
                                {
                                    type: "Ready",
                                    status: "True",
                                    observedGeneration: 1,
                                },
                            ],
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

    it("polls until a condition at the current generation appears, then stops", async () => {
        let calls = 0;
        const clock = fakeClock();
        const result = await waitForOperatorReconcile(
            () => {
                calls += 1;
                const reconciled = calls >= 3;
                return {
                    ok: true,
                    stdout: JSON.stringify({
                        metadata: { generation: 1 },
                        status: {
                            conditions: reconciled
                                ? [
                                      {
                                          type: "Ready",
                                          status: "True",
                                          observedGeneration: 1,
                                      },
                                  ]
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

    it("round 2 (#1535 B1) — REDEPLOY: conditions from the PREVIOUS generation are never treated as reconciled, even though they are non-empty", async () => {
        const clock = fakeClock();
        // metadata.generation: 7 (this is at least the CLI's 2nd apply of
        // this CR), but every condition the operator ever wrote still
        // carries observedGeneration: 6 — i.e. a dead/CrashLooping operator
        // that stopped reconciling one generation ago. The pre-fix code
        // read `conditions.length > 0` alone and returned reconciled=true on
        // the very first poll here.
        const result = await waitForOperatorReconcile(
            () => ({
                ok: true,
                stdout: JSON.stringify({
                    metadata: { generation: 7 },
                    status: {
                        conditions: [
                            {
                                type: "Ready",
                                status: "True",
                                observedGeneration: 6,
                            },
                        ],
                        url: "https://stale.example.com",
                    },
                }),
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
        // lastUrl is still tracked from the stale read — waitForOperatorReconcile
        // never claims it has none, only that it isn't reconciled YET.
        expect(result.url).toBe("https://stale.example.com");
        expect(clock.now()).toBeGreaterThanOrEqual(3_000);
    });

    it("round 2 (#1535 B1) — REDEPLOY: a condition at (or after) the current generation IS reconciled", async () => {
        let calls = 0;
        const result = await waitForOperatorReconcile(
            () => {
                calls += 1;
                return {
                    ok: true,
                    stdout: JSON.stringify({
                        metadata: { generation: 7 },
                        status: {
                            conditions: [
                                {
                                    type: "Ready",
                                    status: "True",
                                    observedGeneration: 7,
                                },
                            ],
                            url: "https://fresh.example.com",
                        },
                    }),
                    stderr: "",
                };
            },
            { waitMs: 15_000, pollIntervalMs: 1_000, sleep: async () => {} },
        );
        expect(result).toEqual({
            reconciled: true,
            url: "https://fresh.example.com",
        });
        expect(calls).toBe(1);
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
                        metadata: { generation: 1 },
                        status: {
                            conditions: [
                                { type: "Ready", observedGeneration: 1 },
                            ],
                        },
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

describe("held app change (Ready=False, EffectiveSpecInvalid)", () => {
    const heldMsg =
        "the change at generation 2 is NOT applied: the platform's defaults make this app's effective spec invalid (spec.scaling): maxScale 50 exceeds the budget. The previous Knative Service keeps serving unchanged";
    const nextApp = (ready: Record<string, unknown>, gen: number, obs = 2) =>
        JSON.stringify({
            metadata: { generation: gen },
            status: {
                conditions: [
                    {
                        type: "PlatformDefaultsApplied",
                        status: "False",
                        observedGeneration: obs,
                    },
                    { type: "Ready", observedGeneration: obs, ...ready },
                ],
            },
        });
    const heldReady = {
        status: "False",
        reason: "EffectiveSpecInvalid",
        message: heldMsg,
    };

    it("reports held with the operator message, not success", async () => {
        const r = await waitForOperatorReconcile(
            () => ({ ok: true, stdout: nextApp(heldReady, 2), stderr: "" }),
            fakeClock(),
        );
        expect(r.held?.message).toBe(heldMsg);
    });

    it("heldChangeMessage names the field and the remedy", () => {
        const m = heldChangeMessage(heldMsg);
        expect(m).toContain("spec.scaling");
        expect(m).toContain("Raise the platform budget");
        expect(m).toContain("maxScale / poolMax");
    });

    it("a normal Ready=True deploy is unchanged", async () => {
        const r = await waitForOperatorReconcile(
            () => ({
                ok: true,
                stdout: nextApp({ status: "True", reason: "Ready" }, 2),
                stderr: "",
            }),
            fakeClock(),
        );
        expect(r.reconciled).toBe(true);
        expect(r.held).toBeUndefined();
    });

    it("a hold observed at an older generation keeps waiting, then times out", async () => {
        const r = await waitForOperatorReconcile(
            () => ({ ok: true, stdout: nextApp(heldReady, 3, 2), stderr: "" }),
            { ...fakeClock(), waitMs: 3000 },
        );
        expect(r.reconciled).toBe(false);
        expect(r.held).toBeUndefined();
    });

    const only = (cond: Record<string, unknown>) =>
        JSON.stringify({
            metadata: { generation: 2 },
            status: { conditions: [{ observedGeneration: 2, ...cond }] },
        });

    it("Ready=False with a different reason is reconciled, not held", async () => {
        const r = await waitForOperatorReconcile(
            () => ({
                ok: true,
                stdout: only({
                    type: "Ready",
                    status: "False",
                    reason: "RevisionFailed",
                    message: "revision failed",
                }),
                stderr: "",
            }),
            fakeClock(),
        );
        expect(r.held).toBeUndefined();
        expect(r.reconciled).toBe(true);
    });

    it("a non-Ready condition with the held reason is not held", async () => {
        const r = await waitForOperatorReconcile(
            () => ({
                ok: true,
                stdout: only({
                    type: "Degraded",
                    status: "False",
                    reason: "EffectiveSpecInvalid",
                    message: "x",
                }),
                stderr: "",
            }),
            fakeClock(),
        );
        expect(r.held).toBeUndefined();
        expect(r.reconciled).toBe(true);
    });

    it("Ready=True with the held reason is not held", async () => {
        const r = await waitForOperatorReconcile(
            () => ({
                ok: true,
                stdout: only({
                    type: "Ready",
                    status: "True",
                    reason: "EffectiveSpecInvalid",
                    message: "x",
                }),
                stderr: "",
            }),
            fakeClock(),
        );
        expect(r.held).toBeUndefined();
        expect(r.reconciled).toBe(true);
    });
});
