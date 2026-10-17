import { describe, expect, it } from "bun:test";
import { fakeClock, MAX_FAKE_SLEEPS } from "./helpers/cdn-purge-fixtures";

/**
 * The CDN purge specs inject `fakeClock().sleep` so retry and rate-limit waits are
 * asserted instead of waited for. That makes `sleep` instant, so a loop that keeps
 * sleeping spins at full speed and a bad value can poison the clock.
 *
 * The incident this pins: the mutation prover's row M03 (MAX_ATTEMPTS 3 -> 4) made
 * the purger ask the back-off table for a fourth entry that does not exist, hand
 * `sleep(NaN)` to the clock, and turn every later timestamp into NaN; the rate
 * limiter's `tokens >= 1` was then never true and it called `sleep` forever,
 * pushing to the recording array. On a 16 GB CI runner that took the whole VM
 * down (twice, in the same leg of the mutation-prover lane). The fake clock must
 * turn that mistake into a failing test.
 */
describe("fakeClock refuses what would run away", () => {
    it("records and advances for an ordinary wait", async () => {
        const clock = fakeClock(1000);
        await clock.sleep(250);
        expect(clock.sleeps).toEqual([250]);
        expect(clock.now()).toBe(1250);
    });

    it("rejects a NaN wait instead of poisoning every later timestamp", async () => {
        const clock = fakeClock(1000);
        await expect(clock.sleep(Number.NaN)).rejects.toThrow(
            /not a finite, non-negative wait/,
        );
        expect(clock.now()).toBe(1000);
        expect(clock.sleeps).toEqual([]);
    });

    it("rejects an infinite or negative wait", async () => {
        const clock = fakeClock();
        await expect(clock.sleep(Number.POSITIVE_INFINITY)).rejects.toThrow(
            /finite/,
        );
        await expect(clock.sleep(-1)).rejects.toThrow(/non-negative/);
    });

    it("fails a runaway sleep loop at a bounded count instead of growing forever", async () => {
        const clock = fakeClock();
        for (let i = 0; i < MAX_FAKE_SLEEPS; i++) await clock.sleep(1);
        await expect(clock.sleep(1)).rejects.toThrow(/runaway sleep loop/);
        expect(clock.sleeps.length).toBe(MAX_FAKE_SLEEPS);
    });
});
