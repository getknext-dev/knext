import { afterEach, describe, expect, it } from "bun:test";
import {
    captureLog,
    cloudflareEnv,
    emulatorEnv,
    type FakeCdn,
    fakeClock,
    PREFIX,
    routeFetch,
    sha256hex,
    startFakeCdn,
} from "./helpers/cdn-purge-fixtures";

/**
 * CDN purge module (ADR-0068 D6, D10) — behaviour over REAL HTTP against an
 * in-process fake Cloudflare listener on an OS-assigned port. Time is the
 * injected clock, so retry/Retry-After/rate-limit waits are asserted by the
 * values handed to `sleep` rather than by waiting.
 */
const PURGE: string = "../adapters/cdn-purge/index.js";

const servers: FakeCdn[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function nextTag(tag: string): Promise<string> {
    return `kn-${PREFIX}-t${(await sha256hex(tag)).slice(0, 16)}`;
}

// biome-ignore lint/suspicious/noExplicitAny: the module is untyped plain JS
type Any = any;

async function harness(
    env: Record<string, string | undefined>,
    extra: Record<string, unknown> = {},
) {
    const cdn = await startFakeCdn();
    servers.push(cdn);
    const clock = fakeClock();
    const logs = captureLog();
    const fetchShim = routeFetch(cdn.port);
    const mod: Any = await import(PURGE);
    const metrics = mod.createMetricsRegistry();
    const purger = mod.createCdnPurger({
        env,
        fetch: fetchShim,
        now: clock.now,
        sleep: clock.sleep,
        log: logs.log,
        metrics,
        flushIntervalMs: 60_000,
        ...extra,
    });
    const count = (provider: string, result: string): number =>
        metrics.get("knext_cdn_purge_total", { provider, result });
    return { cdn, clock, logs, fetchShim, metrics, purger, count, mod };
}

const tagsOf = (cdn: FakeCdn, i: number): string[] =>
    (cdn.requests[i]?.json as { tags: string[] }).tags;

describe("request shape", () => {
    it("cloudflare: POST the hardcoded purge_cache URL, Bearer token, JSON {tags} of hashed tags", async () => {
        const { env, token } = cloudflareEnv();
        const h = await harness(env);
        h.purger.enqueue(["posts", "_N_T_/blog"]);
        await h.purger.flush();

        expect(h.fetchShim.seen).toEqual([
            `https://api.cloudflare.com/client/v4/zones/${env.KNEXT_CDN_PURGE_TARGET}/purge_cache`,
        ]);
        const req = h.cdn.requests[0];
        expect(req?.method).toBe("POST");
        expect(req?.headers.authorization).toBe(`Bearer ${token}`);
        expect(req?.headers["content-type"]).toContain("application/json");
        expect(req?.json).toEqual({
            tags: [await nextTag("posts"), await nextTag("_N_T_/blog")],
        });
        expect(h.count("cloudflare", "ok")).toBe(1);
    });

    it("duplicate tags in one window are sent once", async () => {
        const { env } = cloudflareEnv();
        const h = await harness(env);
        h.purger.enqueue(["a", "b", "a"]);
        h.purger.enqueue(["b", "a"]);
        await h.purger.flush();
        expect(h.cdn.requests.length).toBe(1);
        expect(tagsOf(h.cdn, 0).length).toBe(2);
    });

    it("a trailing newline on the mounted token is trimmed, not sent", async () => {
        const { env, token } = cloudflareEnv();
        env.KNEXT_CDN_PURGE_TOKEN = `${token}\n`;
        const h = await harness(env);
        h.purger.enqueue(["a"]);
        await h.purger.flush();
        expect(h.cdn.requests[0]?.headers.authorization).toBe(
            `Bearer ${token}`,
        );
    });

    it("emulator: same Cloudflare shape at the cluster-local endpoint, with a FIXED dummy token, never the env token", async () => {
        const { env, token } = emulatorEnv();
        const h = await harness(env);
        h.purger.enqueue(["a"]);
        await h.purger.flush();
        expect(h.fetchShim.seen).toEqual([
            "http://cdn-emulator.e2e.svc.cluster.local:8080/client/v4/zones/zone-1/purge_cache",
        ]);
        const auth = String(h.cdn.requests[0]?.headers.authorization);
        expect(auth).toMatch(/^Bearer \S+$/);
        expect(auth).not.toContain(token);
        // Fixed: identical across independent purgers (not derived from the env).
        const { env: env2 } = emulatorEnv();
        const h2 = await harness(env2);
        h2.purger.enqueue(["a"]);
        await h2.purger.flush();
        expect(h2.cdn.requests[0]?.headers.authorization).toBe(auth);
        expect(h.count("emulator", "ok")).toBe(1);
    });

    it("emulator works with no purge token configured at all", async () => {
        const { env } = emulatorEnv({ KNEXT_CDN_PURGE_TOKEN: undefined });
        const h = await harness(env);
        h.purger.enqueue(["a"]);
        await h.purger.flush();
        expect(h.cdn.requests.length).toBe(1);
        expect(h.count("emulator", "skipped_no_credential")).toBe(0);
    });
});

describe("batching (ADR-0068 D6.4: at most 100 tags per request)", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

    it("100 tags -> one request of 100", async () => {
        const h = await harness(cloudflareEnv().env);
        h.purger.enqueue(many(100));
        await h.purger.flush();
        expect(h.cdn.requests.map((r) => (r.json as Any).tags.length)).toEqual([
            100,
        ]);
    });

    it("101 tags -> 100 + 1", async () => {
        const h = await harness(cloudflareEnv().env);
        h.purger.enqueue(many(101));
        await h.purger.flush();
        expect(h.cdn.requests.map((r) => (r.json as Any).tags.length)).toEqual([
            100, 1,
        ]);
    });

    it("250 tags -> 100, 100, 50, and no tag is lost or repeated", async () => {
        const h = await harness(cloudflareEnv().env);
        h.purger.enqueue(many(250));
        await h.purger.flush();
        const sizes = h.cdn.requests.map((r) => (r.json as Any).tags.length);
        expect(sizes).toEqual([100, 100, 50]);
        const all = h.cdn.requests.flatMap(
            (r) => (r.json as Any).tags as string[],
        );
        expect(new Set(all).size).toBe(250);
        expect(h.count("cloudflare", "ok")).toBe(3);
    });

    it("exactly 1000 pending tags do NOT collapse", async () => {
        const h = await harness(cloudflareEnv().env);
        h.purger.enqueue(many(1000));
        await h.purger.flush();
        expect(h.cdn.requests.length).toBe(10);
    });
});

describe("overflow collapses to ONE app-tag purge (ADR-0068 D6.4)", () => {
    it("1001 pending tags -> a single request purging kn-<prefix>", async () => {
        const h = await harness(cloudflareEnv().env);
        h.purger.enqueue(Array.from({ length: 1001 }, (_, i) => `t${i}`));
        await h.purger.flush();
        expect(h.cdn.requests.length).toBe(1);
        expect(tagsOf(h.cdn, 0)).toEqual([`kn-${PREFIX}`]);
        expect(h.count("cloudflare", "ok")).toBe(1);
    });

    it("the backlog built across several calls collapses too, and later tags are covered by it", async () => {
        const h = await harness(cloudflareEnv().env);
        h.purger.enqueue(Array.from({ length: 600 }, (_, i) => `a${i}`));
        h.purger.enqueue(Array.from({ length: 600 }, (_, i) => `b${i}`));
        h.purger.enqueue(["late"]);
        await h.purger.flush();
        expect(h.cdn.requests.length).toBe(1);
        expect(tagsOf(h.cdn, 0)).toEqual([`kn-${PREFIX}`]);
    });

    it("after the collapse is flushed, normal per-tag purging resumes", async () => {
        const h = await harness(cloudflareEnv().env);
        h.purger.enqueue(Array.from({ length: 1500 }, (_, i) => `t${i}`));
        await h.purger.flush();
        h.purger.enqueue(["after"]);
        await h.purger.flush();
        expect(h.cdn.requests.length).toBe(2);
        expect(tagsOf(h.cdn, 1)).toEqual([await nextTag("after")]);
    });
});

describe("retries are bounded (ADR-0068 D6.4: at most 3 attempts per batch)", () => {
    it("a provider that always answers 500 gets exactly 3 attempts, backed off 1 s then 2 s", async () => {
        const h = await harness(cloudflareEnv().env);
        h.cdn.reply(() => ({ status: 500 }));
        h.purger.enqueue(["a"]);
        await h.purger.flush();
        expect(h.cdn.requests.length).toBe(3);
        expect(h.clock.sleeps).toEqual([1000, 2000]);
        expect(h.count("cloudflare", "failed")).toBe(1);
        expect(h.count("cloudflare", "ok")).toBe(0);
    });

    it("a 5xx then success recovers after one 1 s backoff", async () => {
        const h = await harness(cloudflareEnv().env);
        h.cdn.reply((_r, i) => ({ status: i === 0 ? 503 : 200 }));
        h.purger.enqueue(["a"]);
        await h.purger.flush();
        expect(h.cdn.requests.length).toBe(2);
        expect(h.clock.sleeps).toEqual([1000]);
        expect(h.count("cloudflare", "ok")).toBe(1);
        expect(h.count("cloudflare", "failed")).toBe(0);
    });

    it("a network error is retried and eventually counted failed", async () => {
        const h = await harness(cloudflareEnv().env);
        h.cdn.reply(() => ({ destroy: true }));
        h.purger.enqueue(["a"]);
        await h.purger.flush();
        expect(h.cdn.requests.length).toBe(3);
        expect(h.count("cloudflare", "failed")).toBe(1);
    });

    it("a non-429 4xx (bad token / zone) is not retried", async () => {
        const h = await harness(cloudflareEnv().env);
        h.cdn.reply(() => ({ status: 403 }));
        h.purger.enqueue(["a"]);
        await h.purger.flush();
        expect(h.cdn.requests.length).toBe(1);
        expect(h.clock.sleeps).toEqual([]);
        expect(h.count("cloudflare", "failed")).toBe(1);
    });
});

describe("429 / Retry-After (ADR-0068 D6.4)", () => {
    it("honours Retry-After seconds, then recovers", async () => {
        const h = await harness(cloudflareEnv().env);
        h.cdn.reply((_r, i) =>
            i === 0
                ? { status: 429, headers: { "retry-after": "7" } }
                : { status: 200 },
        );
        h.purger.enqueue(["a"]);
        await h.purger.flush();
        expect(h.cdn.requests.length).toBe(2);
        expect(h.clock.sleeps).toEqual([7000]);
        expect(h.count("cloudflare", "ok")).toBe(1);
    });

    it("caps an enormous Retry-After at 60 s", async () => {
        const h = await harness(cloudflareEnv().env);
        h.cdn.reply((_r, i) =>
            i === 0
                ? { status: 429, headers: { "retry-after": "86400" } }
                : { status: 200 },
        );
        h.purger.enqueue(["a"]);
        await h.purger.flush();
        expect(h.clock.sleeps).toEqual([60_000]);
    });

    it("honours an HTTP-date Retry-After relative to the injected clock", async () => {
        const h = await harness(cloudflareEnv().env);
        const when = new Date(h.clock.now() + 9_000).toUTCString();
        h.cdn.reply((_r, i) =>
            i === 0
                ? { status: 429, headers: { "retry-after": when } }
                : { status: 200 },
        );
        h.purger.enqueue(["a"]);
        await h.purger.flush();
        const [wait] = h.clock.sleeps;
        expect(wait).toBeGreaterThan(7_000);
        expect(wait).toBeLessThanOrEqual(9_000);
    });

    it("an unparseable Retry-After falls back to the 1 s / 2 s backoff", async () => {
        const h = await harness(cloudflareEnv().env);
        h.cdn.reply(() => ({
            status: 429,
            headers: { "retry-after": "soon" },
        }));
        h.purger.enqueue(["a"]);
        await h.purger.flush();
        expect(h.clock.sleeps).toEqual([1000, 2000]);
    });

    it("429 forever: 3 attempts, then given up and counted ratelimited (not failed)", async () => {
        const h = await harness(cloudflareEnv().env);
        h.cdn.reply(() => ({ status: 429, headers: { "retry-after": "1" } }));
        h.purger.enqueue(["a"]);
        await h.purger.flush();
        expect(h.cdn.requests.length).toBe(3);
        expect(h.count("cloudflare", "ratelimited")).toBe(1);
        expect(h.count("cloudflare", "failed")).toBe(0);
    });
});

describe("token bucket (ADR-0068 D6.4: Cloudflare default 5/min, bucket 25)", () => {
    it("requests 1..25 go out at once; each later one waits 12 s for a token", async () => {
        const h = await harness(cloudflareEnv().env);
        for (let i = 0; i < 30; i++) {
            h.purger.enqueue([`t${i}`]);
            await h.purger.flush();
        }
        expect(h.cdn.requests.length).toBe(30);
        expect(h.clock.sleeps).toEqual([
            12_000, 12_000, 12_000, 12_000, 12_000,
        ]);
    });

    it("KNEXT_CDN_PURGE_RPM overrides the rate (60/min -> 1 s per token)", async () => {
        const h = await harness(
            cloudflareEnv({ KNEXT_CDN_PURGE_RPM: "60" }).env,
        );
        for (let i = 0; i < 26; i++) {
            h.purger.enqueue([`t${i}`]);
            await h.purger.flush();
        }
        expect(h.clock.sleeps).toEqual([1000]);
    });

    it("a nonsense RPM falls back to the row default", async () => {
        for (const bad of ["0", "-3", "abc", "1.5e9"]) {
            const h = await harness(
                cloudflareEnv({ KNEXT_CDN_PURGE_RPM: bad }).env,
            );
            for (let i = 0; i < 26; i++) {
                h.purger.enqueue([`t${i}`]);
                await h.purger.flush();
            }
            expect(h.clock.sleeps).toEqual([12_000]);
        }
    });
});

describe("missing credential is fail-closed and invisible to the request path (ADR-0068 D10)", () => {
    for (const [label, value] of [
        ["unset", undefined],
        ["empty", ""],
        ["whitespace", "   \n"],
        ["control characters", "ab\ncd"],
    ] as const) {
        it(`token ${label}: no request, no throw, counted, logged exactly once`, async () => {
            const { env } = cloudflareEnv({ KNEXT_CDN_PURGE_TOKEN: value });
            const h = await harness(env);
            let out: Any;
            expect(() => {
                for (let i = 0; i < 5; i++) out = h.purger.enqueue([`t${i}`]);
            }).not.toThrow();
            await h.purger.flush();
            expect(h.cdn.requests.length).toBe(0);
            expect(h.fetchShim.seen).toEqual([]);
            expect(h.count("cloudflare", "skipped_no_credential")).toBe(5);
            expect(out.queued).toBe(0);
            expect(
                h.logs.lines.filter((l) => /credential/i.test(l)).length,
            ).toBe(1);
        });
    }

    it("enqueue is synchronous and never returns a promise (the request path cannot await it)", async () => {
        const h = await harness(cloudflareEnv().env);
        const out = h.purger.enqueue(["a"]);
        expect(typeof (out as Any)?.then).toBe("undefined");
        await h.purger.flush();
    });

    it("garbage input never throws", async () => {
        const h = await harness(cloudflareEnv().env);
        expect(() => {
            h.purger.enqueue(undefined);
            h.purger.enqueue(null);
            h.purger.enqueue([]);
            h.purger.enqueue("single");
            h.purger.enqueue(["ok", 5, null, {}, ""]);
        }).not.toThrow();
        await h.purger.flush();
        // "single" (the string form Next may pass) and "ok" are real tags; the
        // empty string and the non-strings (5, null, {}) are not.
        const sent = h.cdn.requests.flatMap(
            (r) => (r.json as Any).tags as string[],
        );
        expect(sent).toContain(await nextTag("single"));
        expect(sent).toContain(await nextTag("ok"));
        expect(sent.length).toBe(2);
    });

    it("a fetch that throws synchronously cannot escape enqueue or flush", async () => {
        const { env } = cloudflareEnv();
        const h = await harness(env, {
            fetch: () => {
                throw new Error("sync boom");
            },
        });
        expect(() => h.purger.enqueue(["a"])).not.toThrow();
        await expect(h.purger.flush()).resolves.toBeUndefined();
        expect(h.count("cloudflare", "failed")).toBe(1);
    });

    it("a logger that throws cannot reach the request path", async () => {
        const boom = () => {
            throw new Error("log sink down");
        };
        const { env } = cloudflareEnv({ KNEXT_CDN_PURGE_TOKEN: undefined });
        const h = await harness(env, {
            log: { info: boom, warn: boom, error: boom },
        });
        // The skip is still reported as what it was ("error" would mean the
        // logger's failure escaped the logging helper and was caught upstream).
        expect(h.purger.enqueue(["a"]).skipped).toBe("no_credential");
        await expect(h.purger.flush()).resolves.toBeUndefined();
        expect(h.count("cloudflare", "skipped_no_credential")).toBe(1);
    });

    it("a metrics sink that throws cannot reach the request path or stop the purge", async () => {
        const { env } = cloudflareEnv();
        const h = await harness(env, {
            metrics: {
                inc: () => {
                    throw new Error("registry down");
                },
            },
        });
        expect(() => h.purger.enqueue(["a"])).not.toThrow();
        await expect(h.purger.flush()).resolves.toBeUndefined();
        expect(h.cdn.requests.length).toBe(1);

        // And on the synchronous skip path, which counts before it returns.
        const { env: noToken } = cloudflareEnv({
            KNEXT_CDN_PURGE_TOKEN: undefined,
        });
        const skipped = await harness(noToken, {
            metrics: {
                inc: () => {
                    throw new Error("registry down");
                },
            },
        });
        expect(skipped.purger.enqueue(["a"]).skipped).toBe("no_credential");
        expect(skipped.logs.lines.some((l) => /credential/i.test(l))).toBe(
            true,
        );
    });

    it("a provider that accepts the connection and never answers is cut off at the request timeout", async () => {
        const { env } = cloudflareEnv();
        const h = await harness(env, { requestTimeoutMs: 50 });
        h.cdn.reply(() => ({ hang: true }));
        h.purger.enqueue(["a"]);
        await h.purger.flush();
        expect(h.cdn.requests.length).toBe(3);
        expect(h.count("cloudflare", "failed")).toBe(1);
    });
});

describe("deferred rows, bad targets and inert mode", () => {
    for (const provider of [
        "google-cloud-cdn",
        "cloudfront",
        "azure-front-door",
    ]) {
        it(`${provider}: accepted config, NO call, skipped_unsupported, one log line`, async () => {
            const { env } = cloudflareEnv({ KNEXT_CDN_PROVIDER: provider });
            const h = await harness(env);
            h.purger.enqueue(["a"]);
            h.purger.enqueue(["b"]);
            await h.purger.flush();
            expect(h.cdn.requests.length).toBe(0);
            expect(h.count(provider, "skipped_unsupported")).toBe(2);
            expect(h.logs.lines.length).toBe(1);
        });
    }

    it("cloudflare with a malformed zone id: no call, skipped_invalid_target", async () => {
        for (const bad of [
            "",
            "zone-1",
            "../../x",
            "g".repeat(32),
            `${"a".repeat(32)}/evil`,
        ]) {
            const h = await harness(
                cloudflareEnv({ KNEXT_CDN_PURGE_TARGET: bad }).env,
            );
            h.purger.enqueue(["a"]);
            await h.purger.flush();
            expect(h.fetchShim.seen).toEqual([]);
            expect(h.count("cloudflare", "skipped_invalid_target")).toBe(1);
        }
    });

    it("a missing or malformed tag prefix is also skipped_invalid_target (operator too old to render it)", async () => {
        for (const bad of [
            undefined,
            "",
            "UPPERCASE123",
            "short",
            "abcdef0123456789zz",
        ]) {
            const h = await harness(
                cloudflareEnv({ KNEXT_CDN_TAG_PREFIX: bad }).env,
            );
            h.purger.enqueue(["a"]);
            await h.purger.flush();
            expect(h.fetchShim.seen).toEqual([]);
            expect(h.count("cloudflare", "skipped_invalid_target")).toBe(1);
        }
    });

    it("no KNEXT_CDN_PROVIDER: completely inert (no call, no metric, no log)", async () => {
        const h = await harness({});
        const out = h.purger.enqueue(["a"]);
        await h.purger.flush();
        expect(out.queued).toBe(0);
        expect(h.fetchShim.seen).toEqual([]);
        expect(h.logs.lines).toEqual([]);
        expect(h.metrics.render()).not.toMatch(/\{provider=/);
    });

    it("an unknown provider name is inert and logged once, not a crash", async () => {
        const h = await harness(
            cloudflareEnv({ KNEXT_CDN_PROVIDER: "akamai" }).env,
        );
        h.purger.enqueue(["a"]);
        h.purger.enqueue(["b"]);
        await h.purger.flush();
        expect(h.fetchShim.seen).toEqual([]);
        expect(h.logs.lines.length).toBe(1);
    });
});

describe("SSRF guard (ADR-0068 D10)", () => {
    it("only the emulator row takes an endpoint, and only a *.svc.cluster.local one", async () => {
        const refused = [
            "http://evil.example.com",
            "https://api.cloudflare.com",
            "http://127.0.0.1:8080",
            "http://localhost:8080",
            "http://169.254.169.254",
            "http://[::1]:8080",
            "http://a.svc.cluster.local@evil.example.com",
            "http://evil.example.com/.svc.cluster.local",
            "http://evil.example.com#.svc.cluster.local",
            "http://svc.cluster.local.evil.example.com",
            "http://x.svc.cluster.local.evil.example.com",
            "http://user:pw@x.svc.cluster.local",
            "http://x.svc.cluster.local/some/path",
            "http://x.svc.cluster.local?q=1",
            "http://x.svc.cluster.local#frag",
            "http://x.svc.cluster.local.",
            "http://svc.cluster.local",
            "ftp://x.svc.cluster.local",
            "x.svc.cluster.local",
            "",
        ];
        for (const endpoint of refused) {
            const { env } = emulatorEnv({
                KNEXT_CDN_EMULATOR_ENDPOINT: endpoint,
            });
            const h = await harness(env);
            h.purger.enqueue(["a"]);
            await h.purger.flush();
            expect({ endpoint, seen: h.fetchShim.seen }).toEqual({
                endpoint,
                seen: [],
            });
            expect(h.count("emulator", "skipped_invalid_target")).toBe(1);
        }
    });

    it("accepts well-formed cluster-local endpoints", async () => {
        for (const [endpoint, base] of [
            [
                "http://cdn-emulator.e2e.svc.cluster.local:8080",
                "http://cdn-emulator.e2e.svc.cluster.local:8080",
            ],
            [
                "https://emu.ns.svc.cluster.local",
                "https://emu.ns.svc.cluster.local",
            ],
            [
                "http://emu.ns.svc.cluster.local/",
                "http://emu.ns.svc.cluster.local",
            ],
        ] as const) {
            const { env } = emulatorEnv({
                KNEXT_CDN_EMULATOR_ENDPOINT: endpoint,
            });
            const h = await harness(env);
            h.purger.enqueue(["a"]);
            await h.purger.flush();
            expect(h.fetchShim.seen).toEqual([
                `${base}/client/v4/zones/zone-1/purge_cache`,
            ]);
        }
    });

    it("the real provider URL cannot be redirected by ANY env var or option", async () => {
        const { env } = cloudflareEnv({
            KNEXT_CDN_EMULATOR_ENDPOINT: "http://emu.ns.svc.cluster.local",
            KNEXT_CDN_PURGE_URL: "http://evil.example.com",
            KNEXT_CDN_PURGE_ENDPOINT: "http://evil.example.com",
            KNEXT_CDN_API_BASE: "http://evil.example.com",
            KNEXT_CDN_BASE_URL: "http://evil.example.com",
            CLOUDFLARE_API_BASE: "http://evil.example.com",
        });
        const h = await harness(env, {
            baseUrl: "http://evil.example.com",
            endpoint: "http://evil.example.com",
            apiBase: "http://evil.example.com",
        });
        h.purger.enqueue(["a"]);
        await h.purger.flush();
        expect(h.fetchShim.seen).toEqual([
            `https://api.cloudflare.com/client/v4/zones/${env.KNEXT_CDN_PURGE_TARGET}/purge_cache`,
        ]);
    });

    it("the Authorization header never follows a redirect: a 3xx is a failed, non-retried outcome", async () => {
        const trap = await startFakeCdn();
        servers.push(trap);
        const { env } = cloudflareEnv();
        const h = await harness(env);
        h.cdn.reply(() => ({
            status: 302,
            headers: { location: `http://127.0.0.1:${trap.port}/stolen` },
        }));
        h.purger.enqueue(["a"]);
        await h.purger.flush();
        expect(trap.requests.length).toBe(0);
        expect(h.cdn.requests.length).toBe(1);
        expect(h.count("cloudflare", "failed")).toBe(1);
    });
});

describe("the token never leaves the request header (ADR-0068 D10)", () => {
    it("is absent from logs, console, metrics and thrown errors across every failure mode", async () => {
        const { captureConsole } = await import("./helpers/cdn-purge-fixtures");
        const scenarios: {
            name: string;
            reply: (token: string) => Any;
            fetchThrows?: boolean;
        }[] = [
            { name: "ok", reply: () => ({ status: 200 }) },
            { name: "500", reply: () => ({ status: 500 }) },
            {
                name: "429",
                reply: () => ({ status: 429, headers: { "retry-after": "1" } }),
            },
            {
                name: "403 echoing the token in the body",
                reply: (t) => ({
                    status: 403,
                    body: `{"errors":[{"message":"bad token ${t}"}]}`,
                }),
            },
            { name: "network error", reply: () => ({ destroy: true }) },
            {
                name: "redirect",
                reply: () => ({
                    status: 307,
                    headers: { location: "http://x.invalid/" },
                }),
            },
            {
                name: "fetch rejects with the token in its message and cause",
                reply: () => ({ status: 200 }),
                fetchThrows: true,
            },
        ];
        for (const s of scenarios) {
            const { env, token } = cloudflareEnv();
            const { lines, result } = await captureConsole(async () => {
                const h = await harness(
                    env,
                    s.fetchThrows
                        ? {
                              fetch: () =>
                                  Promise.reject(
                                      Object.assign(
                                          new Error(
                                              `connect failed with ${token}`,
                                          ),
                                          {
                                              cause: new Error(
                                                  `Bearer ${token}`,
                                              ),
                                          },
                                      ),
                                  ),
                          }
                        : {},
                );
                h.cdn.reply(() => s.reply(token));
                const out = h.purger.enqueue(["a"]);
                await h.purger.flush();
                return {
                    out,
                    injected: h.logs.lines,
                    metrics: h.metrics.render(),
                    status: JSON.stringify(h.purger.status?.() ?? {}),
                };
            });
            const everything = [
                ...lines,
                ...result.injected,
                result.metrics,
                result.status,
                JSON.stringify(result.out),
            ].join("\n");
            expect({
                scenario: s.name,
                leaked: everything.includes(token),
            }).toEqual({
                scenario: s.name,
                leaked: false,
            });
        }
    });
});

describe("non-blocking and drain (ADR-0068 D6.3, D6.6)", () => {
    it("enqueue returns before any network I/O: a hung provider cannot hold the caller", async () => {
        const h = await harness(cloudflareEnv().env, { flushIntervalMs: 5 });
        h.cdn.reply(() => ({ hang: true }));
        const t0 = Date.now();
        h.purger.enqueue(["a"]);
        expect(Date.now() - t0).toBeLessThan(50);
        expect(h.cdn.requests.length).toBe(0);
        h.cdn.release();
        await h.purger.flush();
    });

    it("the purge is tracked so the SIGTERM drain waits for it", async () => {
        const reg: Any = await import("../adapters/cache-write-registry.js");
        const h = await harness(cloudflareEnv().env, { flushIntervalMs: 5 });
        h.cdn.reply(() => ({ hang: true }));
        const before = reg.inFlightCacheWriteCount();
        h.purger.enqueue(["a"]);
        expect(reg.inFlightCacheWriteCount()).toBe(before + 1);

        let drained = false;
        const draining = reg.drainCacheWrites(5000).then(() => {
            drained = true;
        });
        await new Promise((r) => setTimeout(r, 120));
        expect(h.cdn.requests.length).toBe(1);
        expect(drained).toBe(false);

        h.cdn.release();
        await draining;
        expect(drained).toBe(true);
        expect(reg.inFlightCacheWriteCount()).toBe(before);
        expect(h.count("cloudflare", "ok")).toBe(1);
    });

    it("the drain is bounded: a provider that never answers cannot hold shutdown past the cap", async () => {
        const reg: Any = await import("../adapters/cache-write-registry.js");
        const h = await harness(cloudflareEnv().env, {
            flushIntervalMs: 5,
            requestTimeoutMs: 60_000,
        });
        h.cdn.reply(() => ({ hang: true }));
        h.purger.enqueue(["a"]);
        const t0 = Date.now();
        await reg.drainCacheWrites(200);
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(h.cdn.requests.length).toBe(1);
        h.cdn.release();
        await h.purger.flush();
    });

    it("a tag still waiting in the coalescing window is tracked too", async () => {
        const reg: Any = await import("../adapters/cache-write-registry.js");
        const h = await harness(cloudflareEnv().env, { flushIntervalMs: 80 });
        h.purger.enqueue(["a"]);
        expect(h.cdn.requests.length).toBe(0);
        await reg.drainCacheWrites(5000);
        expect(h.cdn.requests.length).toBe(1);
    });
});

describe("metrics (ADR-0068 D6.5)", () => {
    it("renders knext_cdn_purge_total{provider,result} in Prometheus text format", async () => {
        const h = await harness(cloudflareEnv().env);
        h.purger.enqueue(["a"]);
        await h.purger.flush();
        const text: string = h.metrics.render();
        expect(text).toContain("# TYPE knext_cdn_purge_total counter");
        expect(text).toContain(
            'knext_cdn_purge_total{provider="cloudflare",result="ok"} 1',
        );
    });

    it("the default registry is anchored on globalThis, shared by duplicated module records (ADR-0027)", async () => {
        const a: Any = await import(`${PURGE}?record=a`);
        const b: Any = await import(`${PURGE}?record=b`);
        expect(a).not.toBe(b);
        a.defaultMetricsRegistry().inc("knext_cdn_purge_total", {
            provider: "emulator",
            result: "ok",
        });
        expect(
            b.defaultMetricsRegistry().get("knext_cdn_purge_total", {
                provider: "emulator",
                result: "ok",
            }),
        ).toBe(1);
        expect(b.renderCdnPurgeMetrics()).toContain(
            'knext_cdn_purge_total{provider="emulator",result="ok"} 1',
        );
        expect(
            (globalThis as Any)[Symbol.for("knext.core.cdn.metrics")],
        ).toBeDefined();
    });
});

describe("public entry points (the wire-in surface for cache-handler.js)", () => {
    it("enqueuePurge / firstReadyPurge delegate to an injected purger and never throw when disabled", async () => {
        const mod: Any = await import(PURGE);
        expect(typeof mod.enqueuePurge).toBe("function");
        expect(typeof mod.firstReadyPurge).toBe("function");
        // Default singleton with no KNEXT_CDN_PROVIDER in this process: inert.
        delete process.env.KNEXT_CDN_PROVIDER;
        expect(() => mod.enqueuePurge(["a"])).not.toThrow();
        await expect(mod.firstReadyPurge("build", {})).resolves.toMatchObject({
            purged: false,
        });
    });

    it("the default purger is a globalThis-anchored singleton", async () => {
        const a: Any = await import(`${PURGE}?single=a`);
        const b: Any = await import(`${PURGE}?single=b`);
        expect(a.getCdnPurger()).toBe(b.getCdnPurger());
    });
});
