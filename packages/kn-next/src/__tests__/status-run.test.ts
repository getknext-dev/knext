/**
 * status.ts — runStatus (one-shot + --watch) and the fetchModel error surface
 * (#… honest status). Every cluster call goes through an injected KubectlFn and
 * the clock/sleep/writer are injected too, so the poll loop is hermetic:
 *  - one-shot: renders + exit code follows Ready (False → 1, True/absent → 0),
 *  - fetchModel: NotFound, unreachable, and unparseable-JSON error branches,
 *  - --watch: resolves on Ready=True, tolerates a transient-failure streak,
 *    throws past the streak cap, and times out (exit 1).
 */

import { describe, expect, it } from "bun:test";
import type { KubectlFn } from "../cli/doctor";
import {
    runStatus,
    type StatusDeps,
    type StatusOptions,
    statusMain,
} from "../cli/status";

function crJson(ready?: "True" | "False"): string {
    return JSON.stringify({
        metadata: { name: "my-app", namespace: "default" },
        spec: { image: "r/a@sha256:0" },
        status: {
            url: "https://my-app.example.com",
            conditions: ready
                ? [{ type: "Ready", status: ready, reason: "R" }]
                : [],
        },
    });
}

function ok(stdout: string) {
    return { ok: true, stdout, stderr: "" };
}
function fail(stderr: string) {
    return { ok: false, stdout: "", stderr };
}

function baseOpts(over: Partial<StatusOptions> = {}): StatusOptions {
    return {
        namespace: "default",
        json: false,
        watch: false,
        timeoutMs: 600_000,
        ...over,
    };
}

function deps(
    kubectl: KubectlFn,
    clock = { t: 0 },
): StatusDeps & {
    written: string[];
} {
    const written: string[] = [];
    return {
        written,
        kubectl,
        write: (t) => written.push(t),
        now: () => new Date(clock.t),
        sleep: async () => {},
    };
}

describe("runStatus — one-shot", () => {
    it("renders and returns 0 when Ready=True", async () => {
        const d = deps(() => ok(crJson("True")));
        expect(await runStatus("my-app", baseOpts(), d)).toBe(0);
        expect(d.written.join("")).toContain("my-app");
    });

    it("returns 1 when Ready=False (CI gate)", async () => {
        const d = deps(() => ok(crJson("False")));
        expect(await runStatus("my-app", baseOpts(), d)).toBe(1);
    });

    it("returns 0 when Ready is not reported", async () => {
        const d = deps(() => ok(crJson(undefined)));
        expect(await runStatus("my-app", baseOpts(), d)).toBe(0);
    });

    it("emits JSON in --json mode", async () => {
        const d = deps(() => ok(crJson("True")));
        await runStatus("my-app", baseOpts({ json: true }), d);
        expect(JSON.parse(d.written.join("")).name).toBe("my-app");
    });
});

describe("fetchModel — error surface", () => {
    it("throws a deploy-first hint on NotFound", async () => {
        const d = deps(() => fail("Error from server (NotFound): nope"));
        await expect(runStatus("my-app", baseOpts(), d)).rejects.toThrow(
            /not found in namespace/,
        );
    });

    it("throws an unreachable hint on other kubectl failures", async () => {
        const d = deps(() => fail("connection refused"));
        await expect(runStatus("my-app", baseOpts(), d)).rejects.toThrow(
            /cluster unreachable/,
        );
    });

    it("throws on unparseable JSON", async () => {
        const d = deps(() => ok("not json{{"));
        await expect(runStatus("my-app", baseOpts(), d)).rejects.toThrow(
            /unparseable JSON/,
        );
    });
});

describe("statusMain", () => {
    it("returns 0 for --help", async () => {
        expect(await statusMain(["--help"])).toBe(0);
    });
});

describe("runStatus — --watch", () => {
    it("returns 0 once Ready flips to True", async () => {
        let call = 0;
        const d = deps(() => ok(crJson(++call >= 2 ? "True" : "False")));
        expect(await runStatus("my-app", baseOpts({ watch: true }), d)).toBe(0);
        expect(call).toBe(2);
    });

    it("tolerates a transient-failure streak, then succeeds", async () => {
        let call = 0;
        const d = deps(() => {
            call++;
            if (call <= 2) return fail("i/o timeout"); // transient
            return ok(crJson("True"));
        });
        expect(await runStatus("my-app", baseOpts({ watch: true }), d)).toBe(0);
        expect(d.written.join("")).toMatch(/transient kubectl failure/);
    });

    it("throws once the transient streak exceeds the cap", async () => {
        const d = deps(() => fail("i/o timeout"));
        await expect(
            runStatus("my-app", baseOpts({ watch: true }), d),
        ).rejects.toThrow(/i\/o timeout/);
    });

    it("times out (exit 1) when Ready never becomes True", async () => {
        const clock = { t: 0 };
        const d = deps(() => ok(crJson("False")), clock);
        // Advance the clock past the bound on each sleep.
        d.sleep = async () => {
            clock.t += 200_000;
        };
        expect(
            await runStatus(
                "my-app",
                baseOpts({ watch: true, timeoutMs: 300_000 }),
                d,
            ),
        ).toBe(1);
        expect(d.written.join("")).toMatch(/watch timed out/);
    });
});
