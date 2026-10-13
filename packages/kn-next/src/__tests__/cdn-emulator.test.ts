import { afterEach, describe, expect, it } from "bun:test";
import {
    createServer,
    type IncomingMessage,
    request,
    type Server,
    type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The CDN cache emulator the kind e2e runs in front of the apps
 * (fixtures/cdn-emulator, ADR-0068 D13). The e2e's verdicts are only as good as
 * the emulator's model, so its properties are pinned here over real HTTP:
 * it keys on Host + URL + query and NOTHING else (not Vary, not the method),
 * follows Cloudflare's directive precedence, carries none of a CDN's own safety
 * nets, and its `store-all` mode stores everything (the negative control).
 */
const EMU: string = "./fixtures/cdn-emulator/cdn-emulator.mjs";
const ROWS: string = "../adapters/cdn-purge/rows.js";

type Reply = {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
};
type Emu = {
    cache: Server;
    admin: Server;
    store: Map<string, unknown>;
    mode: string;
};

const open: Server[] = [];
afterEach(async () => {
    await Promise.all(
        open.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))),
    );
});

function listen(server: Server): Promise<number> {
    open.push(server);
    return new Promise((resolve) =>
        server.listen(0, "127.0.0.1", () =>
            resolve((server.address() as AddressInfo).port),
        ),
    );
}

/** A fake origin whose answer per path is set by the test; it counts hits. */
async function origin(answer: (req: IncomingMessage) => Reply) {
    const hits: string[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        hits.push(`${req.method} ${req.url} host=${req.headers.host}`);
        const a = answer(req);
        res.writeHead(a.status ?? 200, a.headers ?? {});
        res.end(a.body ?? `body ${req.method} ${req.url} n=${hits.length}`);
    });
    const port = await listen(server);
    return { port, hits };
}

async function emulator(opts: {
    mode?: string;
    originPort: number;
    host?: string;
}) {
    const { createEmulator } = await import(EMU);
    // The token the real `emulator` provider row sends, from its one source.
    const { EMULATOR_DUMMY_TOKEN } = await import(ROWS);
    const host = opts.host ?? "app.ns.svc.cluster.local";
    const emu: Emu = createEmulator({
        mode: opts.mode,
        upstreamMap: `${host}=http://127.0.0.1:${opts.originPort}`,
        purgeToken: EMULATOR_DUMMY_TOKEN,
    });
    const port = await listen(emu.cache);
    const adminPort = await listen(emu.admin);
    return { emu, port, adminPort, host };
}

function send(
    port: number,
    opts: {
        method?: string;
        host: string;
        path: string;
        headers?: Record<string, string>;
        body?: string;
    },
): Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    text: string;
}> {
    return new Promise((resolve, reject) => {
        const req = request(
            {
                hostname: "127.0.0.1",
                port,
                method: opts.method ?? "GET",
                path: opts.path,
                headers: { host: opts.host, ...(opts.headers ?? {}) },
                agent: false,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c: Buffer) => chunks.push(c));
                res.on("end", () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        headers: res.headers,
                        text: Buffer.concat(chunks).toString(),
                    }),
                );
            },
        );
        req.on("error", reject);
        req.end(opts.body);
    });
}

describe("honouredTtl: Cloudflare's directive precedence", () => {
    it("reads only the first present header, in precedence order", async () => {
        const { honouredTtl } = await import(EMU);
        expect(
            honouredTtl({
                "cloudflare-cdn-cache-control": "max-age=30",
                "cache-control": "no-store",
            }),
        ).toBe(30);
        expect(
            honouredTtl({
                "cdn-cache-control": "max-age=40",
                "cache-control": "s-maxage=99",
            }),
        ).toBe(40);
        expect(
            honouredTtl({
                "cloudflare-cdn-cache-control": "no-store",
                "cdn-cache-control": "max-age=40",
            }),
        ).toBe(0);
        expect(
            honouredTtl({ "cache-control": "public, max-age=5, s-maxage=60" }),
        ).toBe(60);
        expect(
            honouredTtl({
                "cache-control": "public, max-age=0, must-revalidate",
            }),
        ).toBe(0);
        expect(honouredTtl({ "cache-control": "private, s-maxage=60" })).toBe(
            0,
        );
        expect(honouredTtl({ "cache-control": "no-cache, max-age=60" })).toBe(
            0,
        );
        expect(honouredTtl({})).toBe(0);
    });
});

describe("cache emulator (honour mode)", () => {
    it("stores a response with an edge directive and serves it as a HIT without asking the origin", async () => {
        const o = await origin(() => ({
            headers: {
                "cloudflare-cdn-cache-control": "max-age=30",
                "cache-tag": "kn-a,kn-a-t1",
            },
        }));
        const { port, host } = await emulator({ originPort: o.port });
        const r1 = await send(port, { host, path: "/p?x=1" });
        const r2 = await send(port, { host, path: "/p?x=1" });
        expect(r1.headers["x-emu-cache"]).toBe("MISS");
        expect(r1.headers["x-emu-stored"]).toBe("30");
        expect(r2.headers["x-emu-cache"]).toBe("HIT");
        expect(r2.text).toBe(r1.text);
        expect(o.hits).toHaveLength(1);
    });

    it("keys on the query string: another query is another entry", async () => {
        const o = await origin(() => ({
            headers: { "cloudflare-cdn-cache-control": "max-age=30" },
        }));
        const { port, host } = await emulator({ originPort: o.port });
        await send(port, { host, path: "/p?x=1" });
        const r = await send(port, { host, path: "/p?x=2" });
        expect(r.headers["x-emu-cache"]).toBe("MISS");
        expect(o.hits).toHaveLength(2);
    });

    it("IGNORES Vary and request headers: an RSC response is served to a plain request (Cloudflare's model)", async () => {
        const o = await origin((req) => ({
            headers: {
                "cloudflare-cdn-cache-control": "max-age=30",
                vary: "rsc, cookie, authorization",
                "content-type":
                    req.headers.rsc === "1" ? "text/x-component" : "text/html",
            },
        }));
        const { port, host } = await emulator({ originPort: o.port });
        await send(port, {
            host,
            path: "/page",
            headers: { rsc: "1", cookie: "s=1", authorization: "Bearer x" },
        });
        const plain = await send(port, { host, path: "/page" });
        expect(plain.headers["x-emu-cache"]).toBe("HIT");
        expect(plain.headers["content-type"]).toBe("text/x-component");
    });

    it("keeps the Host in the key: two apps never share an entry", async () => {
        const o = await origin(() => ({
            headers: { "cloudflare-cdn-cache-control": "max-age=30" },
        }));
        const { createEmulator } = await import(EMU);
        const emu: Emu = createEmulator({
            upstreamMap: `a.ns.svc.cluster.local=http://127.0.0.1:${o.port},b.ns.svc.cluster.local=http://127.0.0.1:${o.port}`,
        });
        const port = await listen(emu.cache);
        await send(port, { host: "a.ns.svc.cluster.local", path: "/p" });
        const b = await send(port, {
            host: "b.ns.svc.cluster.local",
            path: "/p",
        });
        expect(b.headers["x-emu-cache"]).toBe("MISS");
    });

    it("has no safety nets of its own: Set-Cookie, a 3xx and a POST are stored when the origin allows it", async () => {
        const o = await origin((req) => ({
            status: req.url?.startsWith("/r") ? 307 : 200,
            headers: {
                "cloudflare-cdn-cache-control": "max-age=30",
                "set-cookie": "a=b",
                location: "/x",
            },
        }));
        const { port, host } = await emulator({ originPort: o.port });
        expect(
            (await send(port, { host, path: "/c" })).headers["x-emu-stored"],
        ).toBe("30");
        expect(
            (await send(port, { host, path: "/r" })).headers["x-emu-stored"],
        ).toBe("30");
        await send(port, { method: "POST", host, path: "/post", body: "x" });
        const get = await send(port, { host, path: "/post" });
        expect(get.headers["x-emu-cache"]).toBe("HIT");
        expect(get.text).toContain("body POST /post");
    });

    it("never answers a POST from cache", async () => {
        const o = await origin(() => ({
            headers: { "cloudflare-cdn-cache-control": "max-age=30" },
        }));
        const { port, host } = await emulator({ originPort: o.port });
        await send(port, { host, path: "/p" });
        const post = await send(port, {
            method: "POST",
            host,
            path: "/p",
            body: "x",
        });
        expect(post.headers["x-emu-cache"]).toBe("MISS");
        expect(o.hits).toHaveLength(2);
    });

    it("does not store without a positive directive", async () => {
        const o = await origin(() => ({
            headers: { "cache-control": "public, max-age=0, must-revalidate" },
        }));
        const { port, host } = await emulator({ originPort: o.port });
        const r = await send(port, { host, path: "/p" });
        expect(r.headers["x-emu-stored"]).toBeUndefined();
        expect(
            (await send(port, { host, path: "/p" })).headers["x-emu-cache"],
        ).toBe("MISS");
    });

    it("x-emu-bypass forwards with no lookup and no store, and is not sent upstream", async () => {
        let sawBypass = false;
        const o = await origin((req) => {
            if (req.headers["x-emu-bypass"] !== undefined) sawBypass = true;
            return {
                headers: { "cloudflare-cdn-cache-control": "max-age=30" },
            };
        });
        const { port, host, emu } = await emulator({ originPort: o.port });
        const r = await send(port, {
            host,
            path: "/p",
            headers: { "x-emu-bypass": "1" },
        });
        expect(r.headers["x-emu-cache"]).toBe("BYPASS");
        expect(emu.store.size).toBe(0);
        expect(sawBypass).toBe(false);
    });

    it("refuses a Host outside the cluster-local suffix (it cannot be pointed at an arbitrary host)", async () => {
        const { createEmulator } = await import(EMU);
        const emu: Emu = createEmulator({});
        const port = await listen(emu.cache);
        const r = await send(port, { host: "example.com", path: "/" });
        expect(r.status).toBe(400);
    });

    it("lists entries with their tags on the admin port, and resets", async () => {
        const o = await origin(() => ({
            headers: {
                "cloudflare-cdn-cache-control": "max-age=30",
                "cache-tag": "kn-a, kn-a-t1",
            },
        }));
        const { port, adminPort, host } = await emulator({
            originPort: o.port,
        });
        await send(port, { host, path: "/p?q=1" });
        const list = JSON.parse(
            (await send(adminPort, { host: "admin", path: "/__emu/entries" }))
                .text,
        );
        expect(list.mode).toBe("honour");
        expect(list.entries).toEqual([
            expect.objectContaining({
                key: `${host}/p?q=1`,
                host,
                url: "/p?q=1",
                method: "GET",
                status: 200,
                tags: ["kn-a", "kn-a-t1"],
            }),
        ]);
        await send(adminPort, {
            method: "POST",
            host: "admin",
            path: "/__emu/reset",
        });
        const after = JSON.parse(
            (await send(adminPort, { host: "admin", path: "/__emu/entries" }))
                .text,
        );
        expect(after.entries).toEqual([]);
    });
});

describe("cache emulator (store-all negative control)", () => {
    it("stores every response whatever it says", async () => {
        const o = await origin(() => ({
            status: 307,
            headers: {
                "cache-control": "private, no-store",
                "set-cookie": "a=b",
            },
        }));
        const { port, host } = await emulator({
            mode: "store-all",
            originPort: o.port,
        });
        const r1 = await send(port, { host, path: "/p" });
        const r2 = await send(port, { host, path: "/p" });
        expect(r1.headers["x-emu-stored"]).toBeDefined();
        expect(r2.headers["x-emu-cache"]).toBe("HIT");
        expect(r2.status).toBe(307);
    });

    it("rejects an unknown mode", async () => {
        const { createEmulator } = await import(EMU);
        expect(() => createEmulator({ mode: "honor-vary" })).toThrow(
            /unknown EMU_MODE/,
        );
    });
});

/**
 * Tag purge (CDN-3b): the emulator speaks the purge API the knext `emulator`
 * provider row calls (cdn-purge/rows.js: Cloudflare-shaped, with a fixed dummy
 * token). Driven here by the REAL purger, routed to the emulator's admin port.
 */
describe("cache emulator: tag purge through the knext emulator provider", () => {
    const PURGE: string = "../adapters/cdn-purge/index.js";
    const prefix = "abcdef012345";
    const env = {
        KNEXT_CDN_PROVIDER: "emulator",
        KNEXT_CDN_TAG_PREFIX: prefix,
        KNEXT_CDN_PURGE_TARGET: "e2e-zone",
        KNEXT_CDN_EMULATOR_ENDPOINT:
            "http://cdn-emulator.cdn-e2e.svc.cluster.local:8081",
    };
    const routed = (adminPort: number) =>
        ((input: unknown, init?: RequestInit) => {
            const u = new URL(String(input));
            return fetch(
                `http://127.0.0.1:${adminPort}${u.pathname}${u.search}`,
                init,
            );
        }) as typeof fetch;

    async function taggedOrigin() {
        const { nextTag, appTag } = await import(PURGE);
        // /a and /b carry Next tag "t-a" / "t-b"; every entry carries the app tag.
        return origin((req) => {
            const t = req.url?.startsWith("/a") ? "t-a" : "t-b";
            return {
                headers: {
                    "cloudflare-cdn-cache-control": "max-age=3600",
                    "cache-tag": `${appTag(prefix)},${nextTag(prefix, t)}`,
                },
            };
        });
    }

    it("a revalidateTag purge from the real purger evicts exactly the entries carrying that tag", async () => {
        const { createCdnPurger } = await import(PURGE);
        const o = await taggedOrigin();
        const { port, adminPort, host } = await emulator({
            originPort: o.port,
        });
        await send(port, { host, path: "/a?1" });
        await send(port, { host, path: "/a?2" });
        await send(port, { host, path: "/b" });
        const purger = createCdnPurger({
            env,
            fetch: routed(adminPort),
            log: { info() {}, warn() {}, error() {} },
        });
        expect(purger.enqueue(["t-a"])).toEqual({ queued: 1 });
        await purger.flush();
        expect(
            (await send(port, { host, path: "/a?1" })).headers["x-emu-cache"],
        ).toBe("MISS");
        expect(
            (await send(port, { host, path: "/a?2" })).headers["x-emu-cache"],
        ).toBe("MISS");
        expect(
            (await send(port, { host, path: "/b" })).headers["x-emu-cache"],
        ).toBe("HIT");
        const log = JSON.parse(
            (await send(adminPort, { host: "admin", path: "/__emu/purges" }))
                .text,
        );
        expect(log.purges).toEqual([
            expect.objectContaining({
                zone: "e2e-zone",
                status: 200,
                authorized: true,
                evicted: 2,
            }),
        ]);
        expect(log.purges[0].tags).toHaveLength(1);
    });

    it("the first-ready purge of the app tag evicts every entry of the app", async () => {
        const { createCdnPurger, appTag } = await import(PURGE);
        const o = await taggedOrigin();
        const { port, adminPort, host } = await emulator({
            originPort: o.port,
        });
        await send(port, { host, path: "/a" });
        await send(port, { host, path: "/b" });
        const purger = createCdnPurger({
            env,
            fetch: routed(adminPort),
            log: { info() {}, warn() {}, error() {} },
        });
        const strings = new Map<string, string>();
        const redis = {
            send: async (_name: string, args: string[]) => {
                if (strings.has(args[0])) return null;
                strings.set(args[0], args[1]);
                return "OK";
            },
        };
        expect(await purger.firstReady("build-1", redis)).toEqual(
            expect.objectContaining({ purged: true }),
        );
        await purger.flush();
        const log = JSON.parse(
            (await send(adminPort, { host: "admin", path: "/__emu/purges" }))
                .text,
        );
        expect(log.purges.at(-1).tags).toEqual([appTag(prefix)]);
        expect(
            (await send(port, { host, path: "/a" })).headers["x-emu-cache"],
        ).toBe("MISS");
        expect(
            (await send(port, { host, path: "/b" })).headers["x-emu-cache"],
        ).toBe("MISS");
    });

    it("refuses a purge without the emulator row's token, Cloudflare-shaped, and evicts nothing", async () => {
        const o = await taggedOrigin();
        const { port, adminPort, host } = await emulator({
            originPort: o.port,
        });
        await send(port, { host, path: "/a" });
        const r = await send(adminPort, {
            method: "POST",
            host: "admin",
            path: "/client/v4/zones/e2e-zone/purge_cache",
            headers: {
                "content-type": "application/json",
                authorization: "Bearer someone-elses-token",
            },
            body: JSON.stringify({ tags: [`kn-${prefix}`] }),
        });
        expect(r.status).toBe(403);
        expect(JSON.parse(r.text)).toEqual(
            expect.objectContaining({ success: false }),
        );
        expect(
            (await send(port, { host, path: "/a" })).headers["x-emu-cache"],
        ).toBe("HIT");
    });

    it("rejects a body that is not a tag purge (files / prefixes / everything are not modelled)", async () => {
        const o = await taggedOrigin();
        const { adminPort } = await emulator({ originPort: o.port });
        for (const body of [
            '{"purge_everything":true}',
            '{"files":["/a"]}',
            "not json",
            '{"tags":[]}',
        ]) {
            const r = await send(adminPort, {
                method: "POST",
                host: "admin",
                path: "/client/v4/zones/e2e-zone/purge_cache",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${(await import(ROWS)).EMULATOR_DUMMY_TOKEN}`,
                },
                body,
            });
            expect({ body, status: r.status }).toEqual({ body, status: 400 });
        }
    });

    it("can answer the next purge with ONE 429 (Retry-After), and the purger recovers on its retry", async () => {
        const { createCdnPurger } = await import(PURGE);
        const o = await taggedOrigin();
        const { port, adminPort, host } = await emulator({
            originPort: o.port,
        });
        await send(port, { host, path: "/a" });
        await send(adminPort, {
            method: "POST",
            host: "admin",
            path: "/__emu/fail-next?status=429&retryAfter=1",
        });
        const waits: number[] = [];
        const purger = createCdnPurger({
            env,
            fetch: routed(adminPort),
            sleep: async (ms: number) => {
                waits.push(ms);
            },
            log: { info() {}, warn() {}, error() {} },
        });
        purger.enqueue(["t-a"]);
        await purger.flush();
        const log = JSON.parse(
            (await send(adminPort, { host: "admin", path: "/__emu/purges" }))
                .text,
        );
        expect(log.purges.map((p: { status: number }) => p.status)).toEqual([
            429, 200,
        ]);
        expect(waits).toContain(1000);
        expect(
            (await send(port, { host, path: "/a" })).headers["x-emu-cache"],
        ).toBe("MISS");
    });
});

describe("cache emulator: started as a program", () => {
    it("starts when run through a symlink, as a ConfigMap mount presents the file", async () => {
        const { mkdtempSync, rmSync, symlinkSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join, resolve } = await import("node:path");
        const { spawn } = await import("node:child_process");
        // A ConfigMap volume mounts `<key>` as a symlink into `..data/`: Node
        // resolves the symlink for import.meta.url but not for argv[1].
        const dir = mkdtempSync(join(tmpdir(), "cdn-emu-link-"));
        const link = join(dir, "cdn-emulator.mjs");
        symlinkSync(resolve(import.meta.dir, EMU), link);
        const child = spawn("node", [link], {
            env: { ...process.env, EMU_PORT: "0", EMU_ADMIN_PORT: "0" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        try {
            const started = await new Promise<string>((resolveLine, reject) => {
                let out = "";
                const timer = setTimeout(
                    () => reject(new Error(`no startup line; output: ${out}`)),
                    10_000,
                );
                child.stdout?.on("data", (d: Buffer) => {
                    out += d.toString();
                    if (out.includes("cdn-emulator: mode=")) {
                        clearTimeout(timer);
                        resolveLine(out);
                    }
                });
                child.on("exit", (code) => {
                    clearTimeout(timer);
                    reject(
                        new Error(
                            `exited ${code} before listening; output: ${out}`,
                        ),
                    );
                });
            });
            expect(started).toContain("cdn-emulator: mode=honour");
        } finally {
            child.kill();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
