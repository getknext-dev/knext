/**
 * planAppData's directory walk and the name check below `node_modules`:
 * the walk has a bound and fails with a clear error, the exact-path opt-out
 * works for a package file under a package-manager link layout (pnpm), and
 * what the credential-name check does with directories below `node_modules`
 * is pinned on both the embed and the refuse side.
 */
import { afterAll, describe, expect, it } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planAppData } from "../adapters/app-data-embed.mjs";

const temps: string[] = [];
afterAll(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function app(files: Record<string, string>): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "knext-walk-")));
    temps.push(root);
    for (const [rel, body] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), body);
    }
    return root;
}
const rels = (p: { files: { rel: string }[] }) => p.files.map((f) => f.rel);

/** `n` directories under `data/`, each holding a link to every other one. */
function denseLinks(n: number): string {
    const root = app({ "data/seed.json": "{}" });
    for (let i = 0; i < n; i++) mkdirSync(join(root, `data/d${i}`));
    for (let i = 0; i < n; i++) {
        writeFileSync(join(root, `data/d${i}/f.json`), "{}");
        for (let j = 0; j < n; j++) {
            if (i !== j)
                symlinkSync(
                    join(root, `data/d${j}`),
                    join(root, `data/d${i}/l${j}`),
                );
        }
    }
    return root;
}

describe("the walk is bounded", () => {
    it("a dense graph of mutually linked directories fails fast with a clear error", () => {
        const root = denseLinks(9);
        const started = Date.now();
        let message = "";
        try {
            planAppData({ root, includes: ["data"] });
        } catch (e) {
            message = (e as Error).message;
        }
        const took = Date.now() - started;
        expect(message).toMatch(/outputFileTracingIncludes/);
        expect(message).toMatch(/'data'/);
        expect(message).toMatch(/symlink/);
        expect(message).toMatch(/too many|limit/i);
        expect(took).toBeLessThan(15_000);
    }, 30_000);

    it("a wide link fan-out is bounded by entries, not only by directories", () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 400; i++) files[`data/shared/f${i}.json`] = "{}";
        const root = app(files);
        mkdirSync(join(root, "data/fan"));
        for (let i = 0; i < 600; i++) {
            symlinkSync(
                join(root, "data/shared"),
                join(root, `data/fan/l${i}`),
            );
        }
        expect(() => planAppData({ root, includes: ["data/fan"] })).toThrow(
            /more than 200,000 entries/,
        );
    }, 30_000);

    it("a fan-out of links to empty directories is bounded by directories", () => {
        const root = app({ "data/a.json": "{}" });
        mkdirSync(join(root, "data/empty"));
        mkdirSync(join(root, "data/fan"));
        for (let i = 0; i < 10_050; i++) {
            symlinkSync(join(root, "data/empty"), join(root, `data/fan/l${i}`));
        }
        expect(() => planAppData({ root, includes: ["data"] })).toThrow(
            /more than 10,000 directories/,
        );
    }, 30_000);

    it("the same bound applies to a glob", () => {
        const root = denseLinks(9);
        expect(() =>
            planAppData({ root, includes: ["data/**/*.json"] }),
        ).toThrow(/too many|limit/i);
    }, 30_000);

    it("a small link graph and a diamond are unaffected", () => {
        const root = denseLinks(3);
        const plan = planAppData({ root, includes: ["data"] });
        expect(rels(plan)).toContain("data/d0/f.json");
        const big: Record<string, string> = {};
        for (let i = 0; i < 400; i++) big[`data/many/f${i}.json`] = "{}";
        const r2 = app(big);
        mkdirSync(join(r2, "data/a"));
        symlinkSync(join(r2, "data/many"), join(r2, "data/a/m"));
        symlinkSync(join(r2, "data/many"), join(r2, "data/b"));
        expect(
            planAppData({ root: r2, includes: ["data"] }).files,
        ).toHaveLength(400);
    });
});

/** A pnpm layout: `node_modules/pkg` is a link into `node_modules/.pnpm/pkg@1/node_modules/pkg`. */
function pnpm(files: Record<string, string>): string {
    const root = app(
        Object.fromEntries(
            Object.entries(files).map(([rel, body]) => [
                `node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/${rel}`,
                body,
            ]),
        ),
    );
    symlinkSync(
        ".pnpm/pkg@1.0.0/node_modules/pkg",
        join(root, "node_modules/pkg"),
    );
    return root;
}

describe("the exact-path opt-out under a package-manager link layout", () => {
    it("an exact path to a package file reached through the package link embeds", () => {
        const root = pnpm({ "data/.env.public": "A=1" });
        const plan = planAppData({
            root,
            includes: ["node_modules/pkg/data/.env.public"],
        });
        expect(rels(plan)).toEqual([
            "node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/data/.env.public",
        ]);
        expect(plan.files[0].aliases).toEqual([
            "node_modules/pkg/data/.env.public",
        ]);
    });

    it("a glob over the same package still refuses the credential name", () => {
        const root = pnpm({ "data/.env.public": "A=1", "data/ok.json": "{}" });
        expect(() =>
            planAppData({ root, includes: ["node_modules/pkg/data/*"] }),
        ).toThrow(/look like secrets/);
    });

    it("a file that is itself a link is never opted out, even under node_modules", () => {
        const root = pnpm({ "data/x.json": "{}" });
        mkdirSync(join(root, "vault"));
        writeFileSync(join(root, "vault/.env"), "S=1");
        symlinkSync(
            join(root, "vault/.env"),
            join(
                root,
                "node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/data/public.txt",
            ),
        );
        expect(() =>
            planAppData({
                root,
                includes: ["node_modules/pkg/data/public.txt"],
            }),
        ).toThrow(/look like secrets[\s\S]*vault\/\.env/);
    });

    it("a file link whose target is also inside node_modules is still not opted out", () => {
        const root = pnpm({ "data/x.json": "{}" });
        mkdirSync(join(root, "node_modules/other"), { recursive: true });
        writeFileSync(join(root, "node_modules/other/.env"), "S=1");
        symlinkSync(
            join(root, "node_modules/other/.env"),
            join(
                root,
                "node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/data/public.txt",
            ),
        );
        expect(() =>
            planAppData({
                root,
                includes: ["node_modules/pkg/data/public.txt"],
            }),
        ).toThrow(/look like secrets/);
    });

    it("outside node_modules a directory link still withholds the opt-out", () => {
        const root = app({ "vault/.env.public": "A=1" });
        symlinkSync(join(root, "vault"), join(root, "data"));
        expect(() =>
            planAppData({ root, includes: ["data/.env.public"] }),
        ).toThrow(
            /look like secrets[\s\S]*data\/\.env\.public[\s\S]*vault\/\.env\.public/,
        );
    });

    it("a link from node_modules out to a credential directory is refused", () => {
        const root = app({
            ".ssh/known_hosts_extra": "x",
            "node_modules/real/a.json": "{}",
        });
        symlinkSync(join(root, ".ssh"), join(root, "node_modules/linked"));
        expect(() =>
            planAppData({
                root,
                includes: ["node_modules/linked/known_hosts_extra"],
            }),
        ).toThrow(/look like secrets/);
    });
});

describe("directories below node_modules are not judged by the name check", () => {
    it("embed side: a credential-worded package folder is carried when spelled through node_modules", () => {
        const root = app({
            "node_modules/pkg/secrets/words.json": "{}",
            "node_modules/pkg/.ssh/readme.txt": "x",
        });
        expect(
            rels(
                planAppData({
                    root,
                    includes: [
                        "node_modules/pkg/secrets/*.json",
                        "node_modules/pkg/.ssh/readme.txt",
                    ],
                }),
            ).sort(),
        ).toEqual([
            "node_modules/pkg/.ssh/readme.txt",
            "node_modules/pkg/secrets/words.json",
        ]);
    });

    it("embed side: the same folder reached through the pnpm package link", () => {
        const root = pnpm({ "secrets/words.json": "{}" });
        expect(
            rels(
                planAppData({
                    root,
                    includes: ["node_modules/pkg/secrets/*.json"],
                }),
            ),
        ).toEqual([
            "node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/secrets/words.json",
        ]);
    });

    it("refuse side: a credential FILE name below node_modules is still refused by a glob", () => {
        const root = app({ "node_modules/pkg/data/credentials.json": "{}" });
        expect(() =>
            planAppData({ root, includes: ["node_modules/pkg/data/*.json"] }),
        ).toThrow(/look like secrets/);
    });

    it("refuse side: a package folder reached through a link outside node_modules is judged by the path as spelled", () => {
        const root = app({ "node_modules/pkg/secrets/words.json": "{}" });
        symlinkSync(join(root, "node_modules/pkg"), join(root, "vendor"));
        expect(() =>
            planAppData({ root, includes: ["vendor/secrets/words.json"] }),
        ).toThrow(/look like secrets[\s\S]*vendor\/secrets\/words\.json/);
    });

    it("refuse side: a directory ABOVE node_modules is judged", () => {
        const root = app({ "secrets/node_modules/pkg/a.json": "{}" });
        expect(() =>
            planAppData({
                root,
                includes: ["secrets/node_modules/pkg/*.json"],
            }),
        ).toThrow(/look like secrets/);
    });
});
