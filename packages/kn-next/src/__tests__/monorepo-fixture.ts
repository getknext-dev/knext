/**
 * Shared harness for the monorepo-root e2e suites: stage the real workspace
 * fixture into a throwaway dir, install it, and drive the SHIPPED `knext build`
 * against it. Not a test file (no `.test.` in the name).
 *
 * The caller owns the cleanup: every dir this makes is pushed onto the
 * `tempRoots` registry it is handed, and the suite drains that registry in its
 * `afterAll`.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** packages/kn-next (this file lives in src/__tests__). */
export const PKG_ROOT = resolve(__dirname, "..", "..");
export const MONOREPO_FIXTURE_SRC = join(
    __dirname,
    "fixtures",
    "monorepo-workspace",
);

export interface StagedMonorepo {
    /** The workspace root (the explicit tracing root). */
    root: string;
    /** `<root>/apps/web`, the app. */
    app: string;
}

function run(
    cmd: string,
    args: string[],
    opts: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {},
) {
    return spawnSync(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        encoding: "utf8",
        timeout: opts.timeout ?? 600_000,
    });
}

/** Copy the fixture into a fresh temp dir and `bun install` the workspace. */
export function stageMonorepo(
    tempRoots: string[],
    mutate?: (staged: StagedMonorepo) => void,
): StagedMonorepo {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "knext-monorepo-")));
    tempRoots.push(root);
    cpSync(MONOREPO_FIXTURE_SRC, root, { recursive: true });
    const staged = { root, app: join(root, "apps", "web") };
    mutate?.(staged);
    const install = run("bun", ["install"], { cwd: root, timeout: 300_000 });
    if (install.status !== 0) {
        throw new Error(
            `fixture bun install failed:\n${install.stdout}\n${install.stderr}`,
        );
    }
    return staged;
}

/** Run the shipped `knext build` (source entry) in `app`. */
export function knextBuild(app: string) {
    return run(
        "bun",
        ["run", join(PKG_ROOT, "src", "cli", "deploy.ts"), "build"],
        {
            cwd: app,
            timeout: 600_000,
        },
    );
}

/** Reserve N free TCP ports, holding every socket until all N are known. */
export async function freePorts(n: number): Promise<number[]> {
    const servers: ReturnType<typeof createServer>[] = [];
    const ports: number[] = [];
    for (let i = 0; i < n; i++) {
        const port = await new Promise<number>((res, rej) => {
            const srv = createServer();
            srv.once("error", rej);
            srv.listen(0, "127.0.0.1", () => {
                servers.push(srv);
                res((srv.address() as { port: number }).port);
            });
        });
        ports.push(port);
    }
    await Promise.all(
        servers.map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
    return ports;
}

export interface RunningServer {
    readonly child: ChildProcess;
    readonly port: number;
    /** Combined stdout + stderr so far, for failure messages. */
    output(): string;
}

/** Start a process and collect its output; the caller stops it with `stop`. */
export function startServer(
    command: string,
    args: string[],
    opts: { cwd: string; port: number; env?: Record<string, string> },
): RunningServer {
    const child = spawn(command, args, {
        cwd: opts.cwd,
        env: {
            ...process.env,
            PORT: String(opts.port),
            HOSTNAME: "127.0.0.1",
            NODE_ENV: "production",
            ...opts.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (d) => {
        output += String(d);
    });
    child.stderr?.on("data", (d) => {
        output += String(d);
    });
    return { child, port: opts.port, output: () => output };
}

/** GET until the server answers 200, or throw with the server's own output. */
export async function waitForOk(
    server: RunningServer,
    path: string,
    timeoutMs = 60_000,
): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (server.child.exitCode !== null) {
            throw new Error(
                `server exited (${server.child.exitCode}) before serving ${path}:\n${server.output()}`,
            );
        }
        try {
            const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
            if (res.status === 200) return await res.text();
        } catch {
            // not listening yet
        }
        if (Date.now() > deadline) {
            throw new Error(
                `server never served ${path} within ${timeoutMs}ms:\n${server.output()}`,
            );
        }
        await new Promise((r) => setTimeout(r, 250));
    }
}

/** Stop a server this suite started (by handle, never by name). */
export async function stopServer(server: RunningServer): Promise<void> {
    if (server.child.exitCode !== null) return;
    server.child.kill("SIGTERM");
    await new Promise<void>((resolveStop) => {
        const timer = setTimeout(() => {
            server.child.kill("SIGKILL");
            resolveStop();
        }, 10_000);
        server.child.once("exit", () => {
            clearTimeout(timer);
            resolveStop();
        });
    });
}
