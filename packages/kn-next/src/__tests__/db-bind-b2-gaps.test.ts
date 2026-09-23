/**
 * #1233 (coverage batch B2) — db-bind.ts honest-uncovered gaps.
 *
 * Targets: `--context` flag parsing, `buildDbBindPatch`'s own required-secret
 * guard (defense-in-depth — every real caller validates first, but the
 * function is exported and must refuse to build a patch with no secret),
 * `extractDsnFromSecretManifest`'s base64-decode-throws fallback (defensive:
 * `Buffer.from(x, "base64")` does not normally throw, so this is only
 * reachable by making it), the `dbMain` local-config load branch
 * (`existsSync("kn-next.config.ts")` true), and `dbMain`'s own post-bind
 * "Patched NextApp" log line on the non-dry-run leg (every existing dbMain
 * test uses `--dry-run`).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// biome-ignore lint/suspicious/noExplicitAny: matches the repo-wide AnyFn pattern for bun mocks
type AnyFn = (...args: unknown[]) => any;

const runCapture = mock<AnyFn>();
mock.module("../cli/exec", () => ({
    runCapture: (...a: unknown[]) => runCapture(...a),
}));

const runDbMigrate = mock<AnyFn>(async () => {});
mock.module("../cli/db-migrate", () => ({ runDbMigrate }));

const logInfo = mock<AnyFn>();
mock.module("../utils/logger", () => ({
    createLogger: () => ({
        info: (...a: unknown[]) => logInfo(...a),
        warn: mock(),
        error: mock(),
        debug: mock(),
        fatal: mock(),
        trace: mock(),
    }),
}));

const {
    buildDbBindPatch,
    dbMain,
    extractDsnFromSecretManifest,
    parseDbBindArgs,
} = await import("../cli/db-bind");

describe("parseDbBindArgs — --context", () => {
    it("carries --context into the parsed options", () => {
        const opts = parseDbBindArgs([
            "my-app",
            "--secret",
            "shop-db",
            "--context",
            "kind-dev",
        ]);
        expect(opts.context).toBe("kind-dev");
    });
});

describe("buildDbBindPatch — required-secret guard", () => {
    it("throws when opts.secret is absent (defense-in-depth over the validated callers)", () => {
        expect(() =>
            buildDbBindPatch({ namespace: "default" } as never),
        ).toThrow(/secret is required/);
    });
});

describe("extractDsnFromSecretManifest — base64 decode failure fallback", () => {
    it("returns undefined when Buffer.from(..., 'base64') throws", () => {
        const manifest = ["data:", "  DATABASE_URL: c29tZS12YWx1ZQ=="].join(
            "\n",
        );
        const realFrom = Buffer.from;
        // biome-ignore lint/suspicious/noExplicitAny: monkeypatching Buffer.from to force the catch branch
        (Buffer as any).from = (...a: unknown[]) => {
            if (a[1] === "base64") throw new Error("forced decode failure");
            return realFrom(...(a as [string]));
        };
        try {
            expect(
                extractDsnFromSecretManifest(manifest, "DATABASE_URL"),
            ).toBeUndefined();
        } finally {
            Buffer.from = realFrom;
        }
    });
});

describe("dbMain — local kn-next.config.ts is loaded when present", () => {
    let dir: string;
    const savedCwd = process.cwd();

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "knext-dbmain-cfg-"));
        process.chdir(dir);
    });

    afterEach(() => {
        process.chdir(savedCwd);
        rmSync(dir, { recursive: true, force: true });
    });

    it("resolves the app name from kn-next.config.ts's name when no positional is given", async () => {
        writeFileSync(
            join(dir, "kn-next.config.ts"),
            [
                "export default {",
                '  name: "from-config",',
                '  registry: "registry.example.com",',
                "};",
            ].join("\n"),
        );
        await expect(
            dbMain(["bind", "--secret", "shop-db", "--dry-run"]),
        ).resolves.toBeUndefined();
    });
});

describe("dbMain — non-dry-run: patches the live CR and logs the confirmation", () => {
    let dir: string;
    const savedCwd = process.cwd();

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "knext-dbmain-live-"));
        process.chdir(dir);
        runCapture.mockReset();
        logInfo.mockClear();
    });

    afterEach(() => {
        process.chdir(savedCwd);
        rmSync(dir, { recursive: true, force: true });
    });

    it("reads the live CR, patches it, and logs 'Patched NextApp' (not the dry-run leg)", async () => {
        runCapture.mockImplementation((argv: unknown) => {
            const a = argv as string[];
            if (a.includes("get")) {
                // First GET (pre-patch validation) and the post-patch verify
                // GET both hit this branch — return the ALREADY-BOUND shape
                // for both, since this test's target is the confirmation log,
                // not the silent-prune guard (that is covered elsewhere).
                return JSON.stringify({
                    spec: { database: { secretRef: { name: "shop-db" } } },
                });
            }
            return "";
        });

        await expect(
            dbMain(["bind", "my-app", "--secret", "shop-db"]),
        ).resolves.toBeUndefined();

        // The two reads (kubectl get, pre + post-patch verify) and the write
        // (kubectl patch) all happened.
        expect(runCapture).toHaveBeenCalledTimes(3);
        const patchCall = runCapture.mock.calls.find((c) =>
            (c[0] as string[]).includes("patch"),
        );
        expect(patchCall).toBeDefined();

        // dbMain's own post-runDbBind confirmation log — only reachable on
        // the !dryRun leg.
        const loggedPatched = logInfo.mock.calls.some(
            (c) => typeof c[1] === "string" && c[1].includes("Patched NextApp"),
        );
        expect(loggedPatched).toBe(true);
    });
});
