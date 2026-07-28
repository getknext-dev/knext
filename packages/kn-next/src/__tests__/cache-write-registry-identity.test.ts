import { describe, expect, it, vi } from "vitest";

/**
 * ADR-0027 §3 anchoring, for the in-flight cache-write registry.
 *
 * The hazard: `cache-handler.js` is loaded by Next **by file path** through the
 * app's re-export shim, and Next duplicates modules across webpack layers in
 * the standalone bundle. So two module records of this source can coexist. If
 * the registry's state were a bare module-level `Set`, the writer would register
 * into one and the drain would read the other, empty — resolving instantly,
 * losing the writes, logging nothing. That is the #352 mechanism.
 *
 * (Not the source of the risk, checked rather than presumed: tsup hoists this
 * module into a shared chunk, so knext's own published artifacts hold a single
 * module record.)
 *
 * BE PRECISE ABOUT WHAT THIS PROVES. `vi.resetModules()` + re-import produces
 * two genuinely distinct module records in one process, which is the same
 * *shape* as the bundle duplication and is enough to red a bare module-level
 * Set. It does NOT reproduce a webpack-layer split in a shipped standalone
 * bundle — no test in this process can. The build-artifact guard is the only
 * real check of that, and none covers this module today (ADR-0027 §4 has the
 * analogue for `@getknext/lib`). Recorded rather than papered over.
 */
describe("cache-write registry state is anchored on globalThis (ADR-0027 §3)", () => {
    const REGISTRY: string = "../adapters/cache-write-registry.js";

    it("two distinct module records observe the SAME in-flight set", async () => {
        vi.resetModules();
        const first = await import(REGISTRY);

        // A fresh registry generation: re-importing after a reset re-evaluates
        // the module, yielding a second, independent module record.
        vi.resetModules();
        const second = await import(REGISTRY);

        // Guard the guard: if these were the same record, the assertion below
        // would hold trivially and prove nothing.
        expect(second).not.toBe(first);

        let release: (() => void) | undefined;
        const write = new Promise<void>((resolve) => {
            release = resolve;
        });

        // Registered through the FIRST copy…
        first.trackWrite(write);
        // …must be visible to, and awaited by, the SECOND.
        expect(second.inFlightCacheWriteCount()).toBe(1);

        let drained = false;
        const draining = second.drainCacheWrites(5000).then(() => {
            drained = true;
        });
        await new Promise((r) => setTimeout(r, 30));
        expect(drained).toBe(false);

        release?.();
        await draining;
        expect(drained).toBe(true);
        expect(first.inFlightCacheWriteCount()).toBe(0);
    });

    it("uses the namespaced Symbol.for key, not a bare module binding", async () => {
        vi.resetModules();
        const mod = await import(REGISTRY);

        const anchored = (
            globalThis as unknown as Record<symbol, Set<unknown> | undefined>
        )[Symbol.for("knext.core.cache.inflight")];

        const write = new Promise<void>(() => {});
        mod.trackWrite(write);

        // The state a second copy would find is the state this copy mutates.
        expect(anchored).toBeInstanceOf(Set);
        expect(anchored?.size).toBe(1);
        expect(mod.inFlightCacheWriteCount()).toBe(1);

        anchored?.clear();
    });
});
