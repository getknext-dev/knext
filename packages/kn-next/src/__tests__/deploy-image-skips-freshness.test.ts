/**
 * #2355 — `deploy --image <pre-built ref>` must not run the LOCAL compiled-exec
 * freshness check.
 *
 * `--image` forces skipBuild, and the `--skip-build` leg fails closed on a
 * stale local exec (`assertCompiledArtifactFresh`). But `--image` ships
 * nothing from the local tree — no docker build, no COPY of the exec — so a
 * leftover exec from an older build in the checkout is irrelevant and must not
 * refuse the deploy. Plain `--skip-build` builds the image from this tree, so
 * it keeps refusing.
 *
 * The REAL `assertCompiledArtifactFresh` runs here (build-artifact.ts is not
 * mocked) against a real stale exec on disk. Every deploy() is a dry run.
 */

import {
    afterAll,
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    mock,
} from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// biome-ignore lint/suspicious/noExplicitAny: spies return whatever the seam does
type AnyFn = (...args: unknown[]) => any;

const loadConfig = mock<AnyFn>();
const runProjectBuild = mock<AnyFn>();

const realShared = { ...(await import("../cli/shared")) };
mock.module("../cli/shared", () => ({
    ...realShared,
    loadConfig: (...a: unknown[]) => loadConfig(...a),
}));
const realProjectBuild = { ...(await import("../cli/project-build")) };
mock.module("../cli/project-build", () => ({
    ...realProjectBuild,
    runProjectBuild: (...a: unknown[]) => runProjectBuild(...a),
}));

const { deploy } = await import("../cli/deploy");
const { compiledExecPathFor, buildStampPathFor } = await import(
    "../cli/build-artifact"
);
const { HARFBUZZ_NOTICE_FILE } = await import("../adapters/og-harfbuzz.mjs");

const VINEXT_BUN = {
    name: "zone",
    registry: "ghcr.io/acme",
    build: "vinext",
    runtime: "bun",
} as const;
const PREBUILT = `reg.example.com/app@sha256:${"a".repeat(64)}`;
const STALE = /is STALE/;

const roots: string[] = [];
const savedCwd = process.cwd();
const savedArgv = process.argv;
afterAll(() => {
    process.chdir(savedCwd);
    for (const r of roots) rmSync(r, { recursive: true, force: true });
});
beforeEach(() => {
    loadConfig.mockReset();
    runProjectBuild.mockReset();
    loadConfig.mockResolvedValue(VINEXT_BUN);
});
afterEach(() => {
    process.argv = savedArgv;
    process.chdir(savedCwd);
});

/** An app dir holding a compiled exec whose stamp does not match its source. */
function enterAppWithStaleExec(): string {
    const root = mkdtempSync(join(tmpdir(), "knext-image-freshness-"));
    roots.push(root);
    const dir = realpathSync(root);
    writeFileSync(
        join(dir, "package-lock.json"),
        '{ "lockfileVersion": 3, "packages": {} }\n',
    );
    // biome-ignore lint/suspicious/noExplicitAny: config literal is a partial KnativeNextConfig
    const target = compiledExecPathFor(VINEXT_BUN as any, dir);
    if (!target) throw new Error("vinext × bun must have a compiled exec");
    mkdirSync(dirname(target.sourcePath), { recursive: true });
    writeFileSync(target.sourcePath, "export default 'current source';\n");
    writeFileSync(target.execPath, "binary from an older build");
    writeFileSync(
        join(dirname(target.execPath), HARFBUZZ_NOTICE_FILE),
        "notice",
    );
    writeFileSync(buildStampPathFor(target.execPath), "stale-hash\n");
    process.chdir(dir);
    return dir;
}

/** The ONLY way this spec runs deploy(): always a dry run. */
async function runDeploy(...flags: string[]): Promise<Error | undefined> {
    process.argv = ["node", "/path/to/kn-next.js", "--dry-run", ...flags];
    return deploy().then(
        () => undefined,
        (e: Error) => e,
    );
}

describe("deploy with a stale local compiled exec", () => {
    it("--image <digest ref> is not refused: nothing local ships", async () => {
        enterAppWithStaleExec();
        const err = await runDeploy("--image", PREBUILT);
        expect(err?.message ?? "").not.toMatch(STALE);
        expect(err).toBeUndefined();
        expect(runProjectBuild).not.toHaveBeenCalled();
    });

    it("plain --skip-build is still refused for the stale exec", async () => {
        enterAppWithStaleExec();
        const err = await runDeploy("--skip-build");
        expect(err?.message).toMatch(STALE);
        expect(err?.message).toContain("--skip-build");
        expect(runProjectBuild).not.toHaveBeenCalled();
    });
});
