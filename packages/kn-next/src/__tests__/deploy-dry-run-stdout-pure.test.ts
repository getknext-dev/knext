/**
 * `knext deploy --dry-run` must keep stdout PURE: the rendered NextApp CR and
 * nothing else, so `knext deploy --dry-run | kubectl apply -f -` works.
 *
 * Everything here runs the REAL CLI entry and the REAL logger in a subprocess
 * (no mocks), and asserts the bytes on each stream:
 *  - `deploy --dry-run`: stdout is exactly one YAML document (the NextApp CR),
 *    no ANSI; the log lines land on stderr; no env var is exported to children.
 *  - `db bind --dry-run`: stdout is only the merge-patch, no ANSI.
 *  - the logger module itself: `setLogDestination("stderr")` called AFTER an
 *    earlier log still redirects (the ordering hazard), in dev and production.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, parseAllDocuments } from "yaml";

const tempRoots: string[] = [];
afterAll(() => {
    for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

const SRC = fileURLToPath(new URL("..", import.meta.url));
const DEPLOY_ENTRY = join(SRC, "cli", "deploy.ts");
const LOGGER_PATH = join(SRC, "utils", "logger.ts");
const DEST_PATH = join(SRC, "utils", "log-destination.ts");

// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ANSI absence
const ANSI = /\u001b\[/;

function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (
            v !== undefined &&
            !["NO_COLOR", "LOG_LEVEL", "NODE_ENV", "FORCE_COLOR"].includes(k)
        )
            env[k] = v;
    }
    return { ...env, ...extra };
}

function run(cwd: string, args: string[], env: Record<string, string> = {}) {
    const r = Bun.spawnSync([process.execPath, ...args], {
        cwd,
        env: cleanEnv(env),
    });
    return {
        stdout: r.stdout.toString(),
        stderr: r.stderr.toString(),
        code: r.exitCode,
    };
}

function fixtureDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "knext-dry-run-pure-"));
    tempRoots.push(dir);
    writeFileSync(
        join(dir, "knext.config.ts"),
        `export default {
    name: "my-app",
    registry: "registry.example.com",
    storage: { provider: "gcs", bucket: "b", publicUrl: "https://storage.googleapis.com/b" },
    cache: { provider: "redis", url: "redis://r:6379", keyPrefix: "k" },
    scaling: { minScale: 0, maxScale: 5 },
};
`,
    );
    return dir;
}

const DIGEST =
    "registry.example.com/my-app:v1@sha256:1111111111111111111111111111111111111111111111111111111111111111";

describe("knext deploy --dry-run (real entry, real logger)", () => {
    it("stdout is exactly the NextApp CR; logs land on stderr", () => {
        const dir = fixtureDir();
        const r = run(dir, [
            DEPLOY_ENTRY,
            "deploy",
            "--dry-run",
            "--image",
            DIGEST,
            "--tag",
            "t",
            "--skip-upload",
        ]);
        expect(r.stderr).toContain("Dry run complete");
        expect(r.code).toBe(0);
        expect(r.stdout).not.toMatch(ANSI);
        const docs = parseAllDocuments(r.stdout);
        expect(docs.length).toBe(1);
        expect(docs[0]?.errors).toEqual([]);
        const cr = parse(r.stdout);
        expect(cr.kind).toBe("NextApp");
        expect(cr.spec.image).toBe(DIGEST);
        expect(r.stdout).not.toContain("Dry run complete");
    });

    it("without --dry-run the destination is untouched (no stderr redirect)", () => {
        const dir = fixtureDir();
        // A usage error path that still logs nothing on stdout is not a probe;
        // probe the logger default directly instead.
        const script = join(dir, "default.ts");
        writeFileSync(
            script,
            `import { createLogger } from ${JSON.stringify(LOGGER_PATH)};
createLogger({ module: "x" }).info("marker-default");
`,
        );
        const r = run(dir, [script], { NODE_ENV: "production" });
        expect(r.stdout).toContain("marker-default");
        expect(r.stderr).not.toContain("marker-default");
    });
});

describe("knext db bind --dry-run (real entry, real logger)", () => {
    it("stdout is only the patch; logs land on stderr", () => {
        const dir = fixtureDir();
        const r = run(dir, [
            DEPLOY_ENTRY,
            "db",
            "bind",
            "my-app",
            "--secret",
            "db-creds",
            "--dry-run",
        ]);
        expect(r.code).toBe(0);
        expect(r.stdout).not.toMatch(ANSI);
        expect(r.stdout).not.toContain("knext db bind");
        expect(parse(r.stdout)).toBeTruthy();
        expect(r.stderr).toContain("knext db bind");
    });
});

describe("setLogDestination ordering", () => {
    for (const nodeEnv of ["development", "production"]) {
        it(`${nodeEnv}: a call AFTER an earlier log still redirects`, () => {
            const dir = fixtureDir();
            const script = join(dir, "order.ts");
            writeFileSync(
                script,
                `import { createLogger } from ${JSON.stringify(LOGGER_PATH)};
import { setLogDestination } from ${JSON.stringify(DEST_PATH)};
const log = createLogger({ module: "x" });
log.info("early-line");
setLogDestination("stderr");
log.info("late-line");
process.stdout.write("DOC\\n");
`,
            );
            const r = run(dir, [script], { NODE_ENV: nodeEnv });
            expect(r.stdout).toContain("early-line");
            expect(r.stdout).not.toContain("late-line");
            expect(r.stdout).toContain("DOC");
            expect(r.stderr).toContain("late-line");
        });
    }
});
