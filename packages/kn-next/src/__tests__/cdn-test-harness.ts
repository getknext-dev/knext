/**
 * Shared harness for the CDN preload tests: start the stand-in Next server
 * (`fixtures/cdn-http-server.cjs`) under Node or Bun with the header preload
 * loaded, and talk to it with RAW BYTES over a socket, so no HTTP client can
 * normalise the request-target before the preload sees it.
 */
import { Buffer } from "node:buffer";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_SERVER = join(HERE, "fixtures", "cdn-http-server.cjs");
export const PRELOAD = join(
    HERE,
    "..",
    "adapters",
    "cache-control-normalize.cjs",
);
export const FROZEN_PRE_CDN_PRELOAD = join(
    HERE,
    "fixtures",
    "cache-control-normalize.pre-cdn.cjs",
);

export type Runtime = "node" | "bun";

export function runtimeBinary(runtime: Runtime): string {
    return runtime === "bun" ? process.execPath : "node";
}

/** `{ "version": 1, … }` as the adapter writes it. */
export function artifact(
    over: Partial<{
        basePath: string;
        i18n: { locales: string[] } | null;
        middleware: "none" | Array<Record<string, unknown>>;
        conditional: "unknown" | Array<Record<string, unknown>>;
    }> = {},
): string {
    return JSON.stringify({
        version: 1,
        basePath: "",
        i18n: null,
        middleware: "none",
        conditional: [],
        ...over,
    });
}

export interface ServerOptions {
    runtime: Runtime;
    env?: Record<string, string>;
    /** Text of `.next/knext-cdn-routing.json`; `undefined` writes none. */
    artifact?: string;
    /** Text of `.next/BUILD_ID`; `null` writes none. */
    buildId?: string | null;
    preload?: string;
}

export interface Running {
    port: number;
    dir: string;
    /** Everything the server process has written to stdout/stderr so far. */
    output(): string;
    stop(): void;
}

export const CDN_ENV: Record<string, string> = {
    KNEXT_CDN_PROVIDER: "cloudflare",
    KNEXT_CDN_TAG_PREFIX: "abcdef012345",
    KNEXT_CDN_HTML_TTL_SECONDS: "30",
    KNEXT_CDN_SWR_SECONDS: "0",
};

export async function startServer(opts: ServerOptions): Promise<Running> {
    const dir = mkdtempSync(join(tmpdir(), "knext-cdn-http-"));
    mkdirSync(join(dir, ".next"), { recursive: true });
    if (opts.artifact !== undefined) {
        writeFileSync(
            join(dir, ".next", "knext-cdn-routing.json"),
            opts.artifact,
        );
    }
    if (opts.buildId !== null) {
        writeFileSync(
            join(dir, ".next", "BUILD_ID"),
            opts.buildId ?? "build-xyz",
        );
    }
    const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        CDN_FIXTURE_PRELOAD: opts.preload ?? PRELOAD,
        KNEXT_REQUEST_BODY_CAP_NO_AUTOINSTALL: "1",
        ...opts.env,
    };
    const child: ChildProcess = spawn(
        runtimeBinary(opts.runtime),
        [FIXTURE_SERVER],
        {
            cwd: dir,
            env: env as NodeJS.ProcessEnv,
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    let all = "";
    child.stdout?.on("data", (d: Buffer) => {
        all += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
        all += d.toString();
    });
    const port = await new Promise<number>((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(
            () => reject(new Error(`server did not start: ${buf}`)),
            20_000,
        );
        child.stdout?.on("data", (d: Buffer) => {
            buf += d.toString();
            const m = /PORT (\d+)/.exec(buf);
            if (m) {
                clearTimeout(timer);
                resolve(Number(m[1]));
            }
        });
        child.stderr?.on("data", (d: Buffer) => {
            buf += d.toString();
        });
        child.on("exit", (code: number | null) => {
            clearTimeout(timer);
            reject(new Error(`server exited ${code}: ${buf}`));
        });
    });
    return {
        port,
        dir,
        output: () => all,
        stop() {
            child.kill("SIGKILL");
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

export interface RawResponse {
    status: number;
    /** Header lines in wire order, lowercased names. */
    headers: Array<[string, string]>;
    head: string;
    body: string;
    header(name: string): string | undefined;
}

/** Send exact bytes (the request line included) and read until the server closes. */
export function rawRequest(port: number, bytes: string): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const socket = connect(port, "127.0.0.1");
        const chunks: Buffer[] = [];
        socket.on("data", (d: Buffer) => chunks.push(Buffer.from(d)));
        socket.on("error", reject);
        socket.on("close", () => {
            const text = Buffer.concat(chunks).toString("latin1");
            const split = text.indexOf("\r\n\r\n");
            const head = split === -1 ? text : text.slice(0, split);
            const body = split === -1 ? "" : text.slice(split + 4);
            const lines = head.split("\r\n");
            const status = Number(
                /^HTTP\/1\.\d (\d{3})/.exec(lines[0] ?? "")?.[1] ?? 0,
            );
            const headers: Array<[string, string]> = lines
                .slice(1)
                .map((l: string) => {
                    const i = l.indexOf(":");
                    return [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()];
                });
            resolve({
                status,
                headers,
                head,
                body,
                header: (name) => headers.find(([n]) => n === name)?.[1],
            });
        });
        socket.write(bytes); // never half-close: Node aborts a pending response on FIN
    });
}

export interface Spec {
    cc?: string;
    ct?: string;
    tags?: Array<{ kind: string; tags: string[] }>;
    setCookie?: boolean;
    mode?:
        | "write"
        | "end"
        | "writehead"
        | "writehead-pairs"
        | "writehead-flat"
        | "append"
        | "stream"
        | "flush";
    status?: number;
    rewriteUrl?: string;
    hop?: boolean;
    extra?: Record<string, string>;
}

export const OWN_TAGS = [{ kind: "page", tags: ["_N_T_/blog", "posts"] }];
export const ISR_CC = "s-maxage=60, stale-while-revalidate=31535940";

/** A GET for `target` answered per `spec`, with extra request headers. */
export function get(
    port: number,
    target: string,
    spec: Spec,
    headers: Record<string, string> = {},
    kase?: string,
): Promise<RawResponse> {
    const lines = [
        `GET ${target} HTTP/1.1`,
        "Host: example.test",
        "Connection: close",
        `x-spec: ${JSON.stringify(spec)}`,
        ...(kase ? [`x-case: ${kase}`] : []),
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ];
    return rawRequest(port, `${lines.join("\r\n")}\r\n\r\n`);
}
