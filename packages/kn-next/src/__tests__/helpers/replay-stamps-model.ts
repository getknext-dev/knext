/**
 * The JavaScript model of `REPLAY_STAMPS_SCRIPT` (use-cache-handler.js), the
 * compare-and-set Lua the `'use cache'` tag replay sends as one EVAL.
 *
 * The fake Redis the replay tests run against has no Lua engine, so those tests
 * answer the script with this model instead. That alone proves nothing about
 * the Lua: a mutated script would still be answered by this unchanged model.
 * `use-cache-replay-script-live-redis.test.ts` closes the gap by running the
 * exact script on a real Redis and requiring its results to equal this model's,
 * case by case, so the model the fake-backed tests trust is the script's.
 *
 * `h` is the stamp hash (mutated in place, as HSET would), `argv` the script's
 * ARGV pairs (field, ms), `now` the script's own `TIME` in epoch ms. Returns the
 * number of fields written, as the script does:
 *  - `s:<tag>` moves forward to now, never back;
 *  - `e:<tag>` wants now + ms, but an expiry already in effect (<= now) is never
 *    moved into the future (expire-now brings it up to now) and a pending one
 *    (> now) is never pushed later, only brought forward.
 */
export function replayStampsModel(
    h: Map<string, string>,
    argv: string[],
    now: number,
): number {
    let n = 0;
    for (let i = 0; i + 1 < argv.length; i += 2) {
        const field = argv[i] as string;
        const raw = h.get(field);
        const cur = raw === undefined ? undefined : Number(raw);
        let v: number | undefined;
        if (field.startsWith("s:")) {
            if (cur === undefined || cur < now) v = now;
        } else {
            const want = now + Number(argv[i + 1]);
            if (cur === undefined) v = want;
            else if (cur <= now) {
                if (want <= now) v = now;
            } else if (want < cur) v = want;
        }
        if (v !== undefined) {
            h.set(field, String(v));
            n += 1;
        }
    }
    return n;
}
