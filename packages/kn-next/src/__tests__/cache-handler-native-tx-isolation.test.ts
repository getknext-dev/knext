/**
 * A plain command must never be swallowed by an in-flight MULTI (#886).
 *
 * ## The measured failure
 *
 * With the idle-reaper and stale-while-revalidate defects fixed, the ISR fixture
 * STILL missed intermittently under a real Redis:
 *
 *   [Cache] STALE app:…:/knext-smoke/isr:html (redis)
 *   [vinext] ISR: STALE (HTML) /knext-smoke/isr      ← background regen starts
 *   [Cache] MISS  app:…:/knext-smoke/isr:html (redis) ← the key is right there
 *   [Cache] SET   app:…:/knext-smoke/isr:rsc  (redis)
 *   [vinext] ISR: regen complete
 *
 * On Bun's native client a transaction lives on the CONNECTION, not on a command
 * object — the handler's own header already says so for two concurrent writers.
 * The same is true of a READER: a `GET` issued between the regeneration's
 * `MULTI` and its `EXEC` is QUEUED INTO that transaction and answered `+QUEUED`,
 * so the read returns a value that is not the entry, the request records a MISS,
 * and the page re-renders. Serializing transactions against each other — which
 * is all `nativeTxQueue` did — does not close this: the interleaving command is
 * not a transaction.
 *
 * ## What this asserts
 *
 * That no plain command lands inside the MULTI…EXEC window. The assertion is on
 * the ORDER OF COMMANDS the client actually received, because that is the only
 * place the defect is visible; asserting the returned value would pass on a
 * client whose fake happens to answer correctly.
 */
import { describe, expect, it } from "bun:test";

async function freshModule() {
    return (await import(
        `../adapters/cache-handler.js?tx=${Math.random()}`
    )) as {
        __budgetNativeClient: <T extends object>(c: T) => T;
        __execAtomic: (c: unknown, cmds: string[][]) => Promise<unknown>;
    };
}

/** A native-shaped client (no `.on`, no `.multi`) that records command order. */
function recordingClient(log: string[], holdOn?: string) {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
        release = r;
    });
    return {
        release,
        client: {
            async send(command: string) {
                log.push(command);
                if (holdOn && command === holdOn) await held;
                return "OK";
            },
            async get(key: string) {
                log.push(`GET ${key}`);
                return null;
            },
        },
    };
}

describe("native Redis: transaction isolation", () => {
    it("does not let a concurrent read land between MULTI and EXEC", async () => {
        const { __budgetNativeClient, __execAtomic } = await freshModule();
        const log: string[] = [];
        // Hold the transaction open at its first queued command, which is exactly
        // the window a concurrent request's read used to fall into.
        const { client: raw, release } = recordingClient(log, "SET");
        const client = __budgetNativeClient(raw);

        const tx = __execAtomic(client, [["SET", "k", "v"]]);
        // Give the transaction a turn to reach MULTI + SET before reading.
        await Bun.sleep(10);
        const read = client.get("k");
        await Bun.sleep(10);
        release();
        await Promise.all([tx, read]);

        const multiAt = log.indexOf("MULTI");
        const execAt = log.indexOf("EXEC");
        const getAt = log.findIndex((entry) => entry.startsWith("GET "));
        expect(multiAt, "the transaction must have opened").toBeGreaterThan(-1);
        expect(execAt, "the transaction must have committed").toBeGreaterThan(
            multiAt,
        );
        expect(getAt, "the read must have been issued").toBeGreaterThan(-1);
        expect(
            getAt > multiAt && getAt < execAt,
            `a read inside MULTI…EXEC is answered +QUEUED — order was ${log.join(", ")}`,
        ).toBe(false);
    });
});
