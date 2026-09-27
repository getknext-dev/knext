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
 *
 * round-4: also covers `assertPrivateDir`'s OWN owner check (the 0700
 * per-uid subdir it enforces, distinct from `assertSafeBase`'s base check
 * above) for the same reason — a real, self-owned directory can never make
 * `st.uid !== uid` true.
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

const cleanupDirs: string[] = [];
const REAL_BASE_RAW = realFs.mkdtempSync(join(tmpdir(), "knext-1460-owner-"));
cleanupDirs.push(REAL_BASE_RAW);
// Resolved separately from the mkdtemp call itself (rather than nested as
// `realpathSync(mkdtempSync(...))`) so the repo static D9 scan in
// tests/temp-dirs-outside-the-repo.test.ts, which credits a mkdtemp creation
// only via a direct `rmSync(name)` or a `registry.push(name)` enrolment (an
// array-literal initializer like `[REAL_BASE]` is neither), can see
// REAL_BASE_RAW enrolled in cleanupDirs and drained by the afterAll below.
const REAL_BASE = realFs.realpathSync(REAL_BASE_RAW);
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

/** Non-null only while the per-uid-subdir probe below is running. */
let fakeSubdirUid: number | null = null;
// The extractor's own DIR_PREFIX is not exported (sharp-native-extract.mjs is
// dependency-free over node builtins on purpose); mirrored here as a literal
// since it never changes independently of the string this file already reads
// out of the thrown error message below.
const DIR_PREFIX = "knext-native-";

mock.module("node:fs", () => ({
    ...realFs,
    realpathSync: (p: string) =>
        p === REAL_BASE ? REAL_BASE : realFs.realpathSync(p),
    lstatSync: (p: string) => {
        if (p === REAL_BASE) {
            return fakeStat({ uid: fakeBaseUid, mode: fakeBaseMode });
        }
        if (
            fakeSubdirUid !== null &&
            typeof p === "string" &&
            p.startsWith(join(REAL_BASE, DIR_PREFIX))
        ) {
            // 0o700, never 0o777: this probe must trip ONLY assertPrivateDir's
            // owner check, not its world-writable-mode check — otherwise a
            // deleted owner check would still be masked by the mode branch.
            return fakeStat({ uid: fakeSubdirUid, mode: 0o700 });
        }
        return realFs.lstatSync(p);
    },
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

describe("assertPrivateDir owner check (mocked stat)", () => {
    it("refuses a pre-created per-uid subdir owned by some OTHER non-root uid, even under an otherwise-accepted root-owned 0777 base (proves assertPrivateDir's owner check is live, not decorative)", () => {
        // round-4 (#1460): the base-level mock tests above prove assertSafeBase's
        // owner branches; nothing before this proved assertPrivateDir's OWN owner
        // check (sharp-native-extract.mjs:86) is load-bearing rather than dead —
        // against a real, self-owned directory `st.uid !== uid` can never be true.
        fakeBaseMode = 0o777;
        fakeBaseUid = 0; // root-owned, world-writable, non-sticky base — accepted by assertSafeBase
        fakeSubdirUid = FOREIGN_UID;
        try {
            expect(() =>
                extractEmbeddedNative({ files: tree(), tmpRoot: REAL_BASE }),
            ).toThrow(
                new RegExp(
                    `belongs to uid ${FOREIGN_UID}, not to this process`,
                ),
            );
        } finally {
            fakeSubdirUid = null;
        }
    });
});
