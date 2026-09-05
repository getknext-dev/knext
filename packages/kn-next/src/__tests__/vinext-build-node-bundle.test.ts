/**
 * vinext-build-node-bundle.test.ts — #948
 *
 * `kn-next build` on the vinext target used to fail under the NODE-run CLI
 * before it ever reached Bun: `detectBunVersion`'s lazy
 * `require("node:child_process")` became `__require("child_process")` in the
 * tsup ESM bundle, which throws `Dynamic require of "child_process" is not
 * supported` at runtime — and the bare `catch {}` swallowed that and reported
 * *"needs \`bun\` on PATH … not found"* even with Bun 1.4.0 on PATH
 * (S3-V Finding B-1, docs/verification/sprint2-aggregate-2026-09-05.md).
 *
 * cli-node-runtime.test.ts deliberately covers dispatch/help/deploy parity,
 * NOT the compile step (ADR-0048 Amendment 3 sanctions Bun-on-PATH for the
 * compile). This suite extends the honest boundary to the seam that decision
 * left uncovered: the BUNDLED dist build path, run under Node, up to and
 * through the Bun detection.
 *
 * Three behavioral cases against `dist/cli/kn-next.js build` (the published
 * bin, spawned under Node — never the TS source) plus one static bundle guard:
 *
 *   1. Bun on PATH → the build proceeds PAST detection and completes.
 *   2. no Bun on PATH → the error says exactly that, with install guidance.
 *   3. a Bun that fails to report a version → the real failure surfaces;
 *      it is NOT mislabelled as "bun not found".
 *   4. static: no dist/cli bundle carries a `__require("…")` call — the
 *      esbuild shim that throws under ESM Node, i.e. this regression's shape.
 *
 * dist/ must exist: CI builds @getknext/core before the suite (ci.yml), the
 * same contract cli-node-runtime.test.ts relies on. Run
 * `pnpm --filter @getknext/core build` locally first.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_BIN, nodeDir } from "../../../../tests/helpers/runtime-binaries";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..", "..");
const distCliDir = join(pkgRoot, "dist", "cli");
const distBin = join(distCliDir, "kn-next.js");

/** How each fixture's fake `bun` behaves when the CLI shells out to it. */
type FakeBun =
    | "reports-1.4.0" // `bun --version` → 1.4.0; every other argv exits 0
    | "version-fails" // `bun --version` exits 1 (broken install, NOT missing)
    | "absent"; // no bun anywhere on the child's PATH

interface Fixture {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly cleanup: () => void;
}

/**
 * A minimal vinext app dir: a loadable config (default build = vinext, no
 * storage so nothing shells out to gsutil), a pre-made `.output` so
 * `--skip-next` has an artifact to point the compile at, and a PATH built
 * from scratch — node's own dir + /usr/bin:/bin for `sh`, plus (optionally)
 * a fake `bun`. The ambient PATH never leaks in: a real Bun on the machine
 * must not rescue the "absent" case, and a real Bun must not shadow the
 * fake in the others.
 */
function makeVinextApp(bun: FakeBun): Fixture {
    const dir = mkdtempSync(join(tmpdir(), "knext-948-"));
    writeFileSync(
        join(dir, "kn-next.config.ts"),
        [
            "const config = {",
            "  name: 'smoke-app',",
            "  registry: 'us-central1-docker.pkg.dev/demo/repo',",
            "};",
            "export default config;",
            "",
        ].join("\n"),
    );
    mkdirSync(join(dir, ".output", "server"), { recursive: true });
    writeFileSync(
        join(dir, ".output", "server", "index.mjs"),
        "export default {};\n",
    );

    const pathDirs = [nodeDir(), "/usr/bin", "/bin"];
    if (bun !== "absent") {
        const binDir = join(dir, "fake-bin");
        mkdirSync(binDir);
        const body =
            bun === "reports-1.4.0"
                ? [
                      "#!/bin/sh",
                      'if [ "$1" = "--version" ]; then echo "1.4.0"; exit 0; fi',
                      "exit 0",
                      "",
                  ]
                : [
                      "#!/bin/sh",
                      'echo "bun exploded before printing a version" >&2',
                      "exit 1",
                      "",
                  ];
        const shim = join(binDir, "bun");
        writeFileSync(shim, body.join("\n"));
        chmodSync(shim, 0o755);
        pathDirs.unshift(binDir);
    }

    return {
        cwd: dir,
        env: {
            ...process.env,
            PATH: pathDirs.join(":"),
            NODE_OPTIONS: "",
            NO_COLOR: "1",
        },
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
}

/** `node dist/cli/kn-next.js build --skip-next --skip-smoke` in the fixture. */
function runNodeBuild(fixture: Fixture) {
    const result = spawnSync(
        NODE_BIN,
        [distBin, "build", "--skip-next", "--skip-smoke"],
        {
            cwd: fixture.cwd,
            env: fixture.env,
            encoding: "utf8" as const,
            timeout: 60_000,
        },
    );
    return {
        ...result,
        output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
}

describe("bundled `kn-next build` (vinext) under plain Node — #948", () => {
    it("with Bun on PATH, the build gets past detection and succeeds", () => {
        const fixture = makeVinextApp("reports-1.4.0");
        try {
            const r = runNodeBuild(fixture);
            // The regression's exact signature, asserted by name so a return
            // of the bundled dynamic require reads as THIS bug, not a flake.
            expect(r.output).not.toContain("Dynamic require");
            expect(r.output).not.toContain("was not found");
            expect(r.status).toBe(0);
        } finally {
            fixture.cleanup();
        }
    });

    it("with NO bun on PATH, the error says bun is missing and how to install it", () => {
        const fixture = makeVinextApp("absent");
        try {
            const r = runNodeBuild(fixture);
            expect(r.status).not.toBe(0);
            expect(r.output).toContain("bun");
            expect(r.output).toContain("https://bun.sh");
            expect(r.output).toMatch(/not found/i);
            // A missing binary must never surface as the bundler shim's error.
            expect(r.output).not.toContain("Dynamic require");
        } finally {
            fixture.cleanup();
        }
    });

    it("a bun that fails to report a version is NOT mislabelled as missing", () => {
        const fixture = makeVinextApp("version-fails");
        try {
            const r = runNodeBuild(fixture);
            expect(r.status).not.toBe(0);
            // The honest half: the real failure is named…
            expect(r.output).toContain("bun --version");
            // …and the mislabel is gone: bun IS on PATH here.
            expect(r.output).not.toMatch(/not found/i);
        } finally {
            fixture.cleanup();
        }
    });
});

describe("dist/cli bundles carry no dynamic-require landmine (#948 static guard)", () => {
    it('no dist/cli/*.js calls __require("…") — the shim throws under ESM Node', () => {
        // Scanned, not enumerated: every published CLI bundle, so the next
        // lazily-required builtin in ANY cli module fails here instead of on a
        // user's machine. The esbuild shim only ever appears as a CALL with a
        // literal specifier at the site that will throw; its definition lives
        // in a shared chunk and is not matched by this pattern.
        const offenders: string[] = [];
        for (const file of readdirSync(distCliDir)) {
            if (!file.endsWith(".js")) continue;
            const content = readFileSync(join(distCliDir, file), "utf8");
            if (/__require\s*\(\s*["']/.test(content)) {
                offenders.push(`dist/cli/${file}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
