/**
 * #1460 round 3 — `assertSafeBase()`'s ownership branches in
 * `sharp-native-extract.mjs`.
 *
 * Two of the three ownership cases cannot be produced with real files by an
 * unprivileged test runner: nothing here can `chown` a directory to root, or
 * to some OTHER non-root uid, without actually running as multiple users.
 * Those two branches are exactly the ones round 2's review flagged as
 * decorative — a check nothing ever proves would go red if deleted. This
 * file fakes ownership via `mock.module("node:fs", …)` instead of real
 * `chown`, kept in its own file (not the main `sharp-native-extract.test.ts`)
 * because `mock.module` replaces `node:fs` for every import in the process,
 * including the ones this module's own real-fs helpers need — this file
 * grabs the REAL `node:fs` via `createRequire` first, the same pattern
 * `create-packageroot-fallback.test.ts` uses.
 */
import { afterAll, describe, expect, it, mock } from "bun:test";

const { createRequire } = await import("node:module");
const realFs = createRequire(import.meta.url)(
    "node:fs",
) as typeof import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

/** A fake `Stats`-like object, just the fields `assertSafeBase`/`assertPrivateDir` read. */
function fakeStat({ uid, mode }: { uid: number; mode: number }) {
    return {
        isDirectory: () => true,
        isSymbolicLink: () => false,
        uid,
        mode,
    };
}

const REAL_BASE = realFs.realpathSync(
    realFs.mkdtempSync(join(tmpdir(), "knext-1460-owner-")),
);
const cleanupDirs: string[] = [REAL_BASE];
afterAll(() => {
    for (const d of cleanupDirs) {
        try {
            realFs.rmSync(d, { recursive: true, force: true });
        } catch {}
    }
});

/** The uid this test process actually runs as — used to prove "another, non-root, non-self uid" is a genuinely different value. */
const SELF_UID = typeof process.getuid === "function" ? process.getuid() : 0;
const FOREIGN_UID = SELF_UID === 4242 ? 4243 : 4242; // anything that is neither 0 nor SELF_UID

let fakeBaseMode = 0o777;
let fakeBaseUid = 0;

mock.module("node:fs", () => ({
    ...realFs,
    realpathSync: (p: string) =>
        p === REAL_BASE ? REAL_BASE : realFs.realpathSync(p),
    lstatSync: (p: string) =>
        p === REAL_BASE
            ? fakeStat({ uid: fakeBaseUid, mode: fakeBaseMode })
            : realFs.lstatSync(p),
}));

const { extractEmbeddedNative } = await import(
    "../adapters/sharp-native-extract.mjs"
);

const LAYOUT = { "a/x.node": "X" };
function tree() {
    const src = realFs.mkdtempSync(join(tmpdir(), "knext-1460-owner-src-"));
    cleanupDirs.push(src);
    return Object.entries(LAYOUT).map(([rel, body]) => {
        const path = join(src, rel);
        realFs.mkdirSync(join(path, ".."), { recursive: true });
        realFs.writeFileSync(path, body);
        return { rel, path };
    });
}

describe("assertSafeBase ownership branches (mocked stat)", () => {
    it("accepts a world-writable, non-sticky base when it is ROOT-owned — the kubelet emptyDir default (#1460 round 3, was BLOCKING)", () => {
        fakeBaseMode = 0o777;
        fakeBaseUid = 0;
        const out = extractEmbeddedNative({
            files: tree(),
            tmpRoot: REAL_BASE,
        });
        cleanupDirs.push(out.root);
        // Content-addressed: this test and the sibling below (root-owned,
        // non-world-writable) unpack the SAME tree, so whichever runs second
        // legitimately reuses rather than re-extracts — either counts as proof
        // the base was accepted.
        expect(out.extracted + out.reused).toBe(1);
    });

    it("refuses a world-writable, non-sticky base owned by some OTHER non-root uid — not root, not this process", () => {
        fakeBaseMode = 0o777;
        fakeBaseUid = FOREIGN_UID;
        expect(() =>
            extractEmbeddedNative({ files: tree(), tmpRoot: REAL_BASE }),
        ).toThrow(/world-writable.*without the sticky bit.*not root/s);
    });

    it("refuses a NON-world-writable base owned by some OTHER non-root uid (proves the owner check is live, not decorative)", () => {
        // Round-2 review: with a self-owned real directory this branch's
        // `st.uid !== uid` side is always false, so nothing ever proves it
        // would go red if the check were deleted. Faking a genuinely foreign
        // uid on a non-world-writable, non-sticky directory exercises it.
        fakeBaseMode = 0o700;
        fakeBaseUid = FOREIGN_UID;
        expect(() =>
            extractEmbeddedNative({ files: tree(), tmpRoot: REAL_BASE }),
        ).toThrow(new RegExp(`owned by uid ${FOREIGN_UID}, not this process`));
    });

    it("accepts a NON-world-writable base owned by root even when this process is not root", () => {
        fakeBaseMode = 0o700;
        fakeBaseUid = 0;
        const out = extractEmbeddedNative({
            files: tree(),
            tmpRoot: REAL_BASE,
        });
        cleanupDirs.push(out.root);
        expect(out.extracted + out.reused).toBe(1);
    });
});
