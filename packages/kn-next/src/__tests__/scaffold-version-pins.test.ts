/**
 * #950 — a fresh `kn-next create` app must not be dead on arrival at
 * `npm install`.
 *
 * The S3-V verification run (Finding A-1) reproduced the failure: the scaffold
 * pinned `@getknext/{core,lib}@^0.3.1` while the registry's newest published
 * versions were older, so the FIRST command the CLI tells a new user to run
 * failed with `notarget`. Nothing connected "the version the templates
 * reference" to "the version actually on npm".
 *
 * Three layers close that, and this file pins the first two:
 *
 *   1. DERIVATION (both halves). The template pins `^{{ version }}` — never a
 *      hardcoded literal — and the renderer fills it from the CLI's OWN
 *      manifest version. Sound only because `.changeset/config.json` keeps
 *      every scaffold-pinned package in one `fixed` group with @getknext/core:
 *      they version and publish together, so ONE version string can speak for
 *      all of them. All three halves are guarded here, because losing any one
 *      of them silently re-opens #950 at the next bump.
 *   2. HONESTY AT CREATE TIME. When the CLI's version was never published
 *      (a source checkout, or the publish lane is blocked — #853's dead token
 *      is how #950 happened), `create` WARNS on stderr that `npm install`
 *      will fail, instead of exiting 0 into a dead app. Best-effort: an
 *      unreachable registry stays silent — `create` must work offline, and it
 *      is UX, not a gate.
 *   3. VALUE AT RUN TIME (not in this file): the scaffold-install nightly
 *      resolves the template's pins against the live registry and runs the
 *      quickstart verbatim as a stranger — red on notarget. Same division of
 *      labour as the action-pin and anonymous-install checks: form at PR
 *      time, value at run time.
 *
 * Written RED-first: `src/cli/scaffold-registry.ts` did not exist, so every
 * assertion on it failed on the missing module.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    cliVersion,
    createMain,
    loadTemplates,
    renderScaffold,
} from "../cli/create";
import {
    checkPinsPublished,
    scaffoldGetknextPins,
    unpublishedPinsWarning,
} from "../cli/scaffold-registry";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..", "..");
const repoRoot = resolve(pkgRoot, "..", "..");

const manifestVersion = (): string =>
    (
        JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
            version: string;
        }
    ).version;

const render = () =>
    renderScaffold({
        name: "pins-app",
        standalonePrefix: "",
        version: cliVersion(),
    });

// ── 1a. the template itself carries NO hardcoded @getknext pin ──────────────

describe("scaffold templates — @getknext pins derive, never hardcode (#950)", () => {
    it("every @getknext/* dep in package.json.hbs is exactly '^{{ version }}', and at least one exists", () => {
        // The placeholders sit inside JSON strings, so the raw template parses.
        const raw = loadTemplates().get("package.json");
        expect(raw).toBeDefined();
        const pkg = JSON.parse(raw as string) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        const deps = Object.entries({
            ...pkg.dependencies,
            ...pkg.devDependencies,
        }).filter(([name]) => name.startsWith("@getknext/"));
        // Both halves: the shape AND the presence. A template that dropped the
        // @getknext deps entirely would sail through a pure shape scan.
        expect(deps.length).toBeGreaterThan(0);
        for (const [name, range] of deps) {
            expect(range, `${name} must derive from the CLI version`).toBe(
                "^{{ version }}",
            );
        }
    });

    it("no template file anywhere carries a literal @getknext version pin", () => {
        // Scan, don't enumerate: a NEW template file with a hardcoded pin must
        // fail here without anyone remembering to list it.
        const hardcodedPin = /@getknext\/[\w-]+["']?\s*[:@]\s*["']?[~^=]?\d/;
        for (const [rel, source] of loadTemplates()) {
            expect(
                hardcodedPin.test(source),
                `${rel} hardcodes a @getknext version — pin '^{{ version }}' instead`,
            ).toBe(false);
        }
    });
});

// ── 1b. the rendered pins equal the CLI's own manifest version ──────────────

describe("rendered scaffold — pins tie to the CLI's own version (#950)", () => {
    it("cliVersion() reads the real @getknext/core manifest", () => {
        expect(cliVersion()).toBe(manifestVersion());
    });

    it("every rendered @getknext/* pin is ^<manifest version>", () => {
        const pins = scaffoldGetknextPins(render());
        expect(pins.length).toBeGreaterThan(0);
        for (const pin of pins) {
            expect(pin.range).toBe(`^${manifestVersion()}`);
            expect(pin.version).toBe(manifestVersion());
        }
    });
});

// ── 1c. the policy that makes ONE version sound: the changesets fixed group ─

describe("changesets fixed group — the 'ship together' policy is load-bearing (#950)", () => {
    it("every @getknext package the scaffold pins versions WITH @getknext/core", () => {
        // The scaffold derives every pin from @getknext/core's version. That is
        // only correct while the pinned packages are version-locked to core —
        // un-fixing them re-opens #950 with pins that can NEVER resolve (the
        // published lib@0.2.0 vs core@0.3.x drift was real; see
        // docs/COMPATIBILITY.md "the drift").
        const config = JSON.parse(
            readFileSync(join(repoRoot, ".changeset", "config.json"), "utf8"),
        ) as { fixed?: string[][] };
        const group = (config.fixed ?? []).find((g) =>
            g.includes("@getknext/core"),
        );
        expect(group, "no fixed group contains @getknext/core").toBeDefined();
        for (const pin of scaffoldGetknextPins(render())) {
            expect(
                group,
                `${pin.name} is pinned by the scaffold but not version-fixed to @getknext/core`,
            ).toContain(pin.name);
        }
    });
});

// ── 2. the registry check itself (injected fetch — no network in unit tests) ─

type FetchLike = (
    input: string | URL | Request,
    init?: RequestInit,
) => Promise<Response>;

const registryWith =
    (docs: Record<string, string[] | null>): FetchLike =>
    async (input) => {
        const url = String(input);
        for (const [name, versions] of Object.entries(docs)) {
            if (url.endsWith(encodeURIComponent(name).replace(/%40/i, "@"))) {
                if (versions === null)
                    return new Response("{}", { status: 404 });
                const body = {
                    versions: Object.fromEntries(versions.map((v) => [v, {}])),
                };
                return new Response(JSON.stringify(body), { status: 200 });
            }
        }
        return new Response("{}", { status: 404 });
    };

describe("checkPinsPublished — verdicts (#950)", () => {
    const pins = [
        { name: "@getknext/core", range: "^0.3.1", version: "0.3.1" },
        { name: "@getknext/lib", range: "^0.3.1", version: "0.3.1" },
    ];

    it("ok when every pinned version is on the registry", async () => {
        const verdict = await checkPinsPublished(pins, {
            fetchImpl: registryWith({
                "@getknext/core": ["0.3.0", "0.3.1"],
                "@getknext/lib": ["0.3.1"],
            }),
        });
        expect(verdict.kind).toBe("ok");
    });

    it("missing when the package exists but the version does not", async () => {
        const verdict = await checkPinsPublished(pins, {
            fetchImpl: registryWith({
                "@getknext/core": ["0.3.0"], // 0.3.1 never published — the real #950 state
                "@getknext/lib": ["0.3.1"],
            }),
        });
        expect(verdict.kind).toBe("missing");
        if (verdict.kind === "missing") {
            expect(verdict.missing.map((p) => p.name)).toEqual([
                "@getknext/core",
            ]);
        }
    });

    it("missing when the whole package 404s", async () => {
        const verdict = await checkPinsPublished(pins, {
            fetchImpl: registryWith({
                "@getknext/core": ["0.3.1"],
                "@getknext/lib": null,
            }),
        });
        expect(verdict.kind).toBe("missing");
        if (verdict.kind === "missing") {
            expect(verdict.missing.map((p) => p.name)).toEqual([
                "@getknext/lib",
            ]);
        }
    });

    it("unreachable when the registry cannot be queried — NEVER 'ok'", async () => {
        const verdict = await checkPinsPublished(pins, {
            fetchImpl: async () => {
                throw new Error("ECONNREFUSED");
            },
        });
        expect(verdict.kind).toBe("unreachable");
    });

    it("a pin whose range is not ^exact is skipped, not misreported", async () => {
        // The shape guards above keep this from happening in the template; if a
        // user hand-edits afterwards that is their range, not our verdict.
        let fetched = 0;
        const verdict = await checkPinsPublished(
            [{ name: "@getknext/core", range: "latest", version: null }],
            {
                fetchImpl: async () => {
                    fetched += 1;
                    return new Response("{}", { status: 200 });
                },
            },
        );
        expect(verdict.kind).toBe("ok");
        expect(fetched).toBe(0);
    });

    it("honors an explicit registry override", async () => {
        const seen: string[] = [];
        await checkPinsPublished(pins, {
            registry: "https://npm.example.test/prefix",
            fetchImpl: async (input) => {
                seen.push(String(input));
                return new Response(JSON.stringify({ versions: {} }), {
                    status: 200,
                });
            },
        });
        for (const url of seen) {
            expect(url.startsWith("https://npm.example.test/prefix/")).toBe(
                true,
            );
        }
    });
});

describe("scaffoldGetknextPins — scans the rendered package.json (#950)", () => {
    it("finds every @getknext dep across both dependency sections", () => {
        const files = new Map([
            [
                "package.json",
                JSON.stringify({
                    dependencies: { "@getknext/lib": "^1.2.3", react: "^19" },
                    devDependencies: { "@getknext/core": "^1.2.3" },
                }),
            ],
        ]);
        const pins = scaffoldGetknextPins(files);
        expect(pins.map((p) => p.name).sort()).toEqual([
            "@getknext/core",
            "@getknext/lib",
        ]);
        for (const pin of pins) expect(pin.version).toBe("1.2.3");
    });

    it("returns [] when the map has no package.json", () => {
        expect(scaffoldGetknextPins(new Map())).toEqual([]);
    });
});

describe("unpublishedPinsWarning — the honest message (#950)", () => {
    it("names every missing pin and says npm install will fail", () => {
        const text = unpublishedPinsWarning([
            { name: "@getknext/core", range: "^0.3.1", version: "0.3.1" },
            { name: "@getknext/lib", range: "^0.3.1", version: "0.3.1" },
        ]);
        expect(text).toContain("@getknext/core@0.3.1");
        expect(text).toContain("@getknext/lib@0.3.1");
        expect(text).toContain("npm install");
        expect(text.toLowerCase()).toContain("not");
    });
});

// ── 3. the wiring: createMain actually consults the registry and warns ──────

describe("createMain — warns when the CLI's version was never published (#950)", () => {
    let server: Server | undefined;
    let appDir: string | undefined;
    const envKey = "npm_config_registry";
    const savedEnv = process.env[envKey];

    afterEach(async () => {
        if (server) await new Promise((done) => server?.close(done));
        server = undefined;
        if (appDir) rmSync(appDir, { recursive: true, force: true });
        appDir = undefined;
        if (savedEnv === undefined) delete process.env[envKey];
        else process.env[envKey] = savedEnv;
    });

    /** Serve a registry doc claiming NOTHING is published. */
    const emptyRegistry = async (): Promise<{
        url: string;
        hits: () => number;
    }> => {
        let hits = 0;
        server = createServer((_req, res) => {
            hits += 1;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ versions: {} }));
        });
        await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
        const { port } = server?.address() as AddressInfo;
        return { url: `http://127.0.0.1:${port}`, hits: () => hits };
    };

    const captureStderr = () => {
        const chunks: string[] = [];
        const original = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: string | Uint8Array) => {
            chunks.push(String(chunk));
            return true;
        }) as typeof process.stderr.write;
        return {
            text: () => chunks.join(""),
            restore: () => {
                process.stderr.write = original;
            },
        };
    };

    const captureStdout = () => {
        const original = process.stdout.write.bind(process.stdout);
        process.stdout.write = (() => true) as typeof process.stdout.write;
        return () => {
            process.stdout.write = original;
        };
    };

    it("scaffold succeeds (exit 0) AND stderr carries the unpublished warning", async () => {
        const { url } = await emptyRegistry();
        process.env[envKey] = url;
        appDir = join(mkdtempSync(join(tmpdir(), "knext-pins-")), "app");
        const stderr = captureStderr();
        const restoreOut = captureStdout();
        try {
            const code = await createMain([appDir, "--name", "pins-warn"]);
            expect(code).toBe(0); // the files are written and fine — honesty, not failure
            expect(stderr.text()).toContain(`@getknext/core@${cliVersion()}`);
            expect(stderr.text()).toContain("npm install");
        } finally {
            stderr.restore();
            restoreOut();
        }
    });

    it("stays SILENT when the registry is unreachable — create works offline", async () => {
        // A closed port: connection refused immediately, no warning, exit 0.
        const { url } = await emptyRegistry();
        await new Promise((done) => server?.close(done));
        server = undefined;
        process.env[envKey] = url;
        appDir = join(mkdtempSync(join(tmpdir(), "knext-pins-")), "app");
        const stderr = captureStderr();
        const restoreOut = captureStdout();
        try {
            const code = await createMain([appDir, "--name", "pins-offline"]);
            expect(code).toBe(0);
            expect(stderr.text()).not.toContain("@getknext/core@");
        } finally {
            stderr.restore();
            restoreOut();
        }
    });

    it("--dry-run writes nothing and never touches the registry", async () => {
        const { url, hits } = await emptyRegistry();
        process.env[envKey] = url;
        appDir = join(mkdtempSync(join(tmpdir(), "knext-pins-")), "app");
        const stderr = captureStderr();
        const restoreOut = captureStdout();
        try {
            const code = await createMain([
                appDir,
                "--name",
                "pins-dry",
                "--dry-run",
            ]);
            expect(code).toBe(0);
            expect(hits()).toBe(0);
            expect(stderr.text()).not.toContain("@getknext/core@");
        } finally {
            stderr.restore();
            restoreOut();
        }
    });
});
