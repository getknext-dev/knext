/**
 * `kn-next db bind` — one-command BYO Postgres binding (ADR-0019, Workstream C).
 *
 * ADR-0001 discipline: the CLI emits INTENT only. `db bind` issues exactly ONE
 * cluster write — `kubectl patch nextapp <name> --type merge -p <json>` setting
 * spec.database — mirroring rollback.ts. It never writes the ksvc / Secret /
 * anything else, and `--dry-run` performs ZERO exec calls.
 *
 * The validation matrix here mirrors ADR-0019's admission rules CLIENT-SIDE so
 * a user gets the exact conflict at the keyboard instead of an apiserver
 * rejection: DNS-1123 names (rule 1), envMap DATABASE_URL/_RO collisions
 * (rules 3/4), roSecretRef without secretRef (rule 6). Rules 5/7
 * (managed-vs-BYO mutual exclusion / managed-mode-only provisioning knobs)
 * no longer apply — managed database mode was removed by ADR-0025 (#303);
 * BYO via secretRef is the only mode (#404).
 */

import { describe, expect, it, vi } from "vitest";
import {
    analyzeDsn,
    buildDbBindPatch,
    type DbBindOptions,
    extractDsnFromSecretManifest,
    parseDbBindArgs,
    renderDbBindPatchYaml,
    runDbBind,
    validateBindAgainstSpec,
    validateDbBindOptions,
} from "../cli/db-bind";

function opts(partial: Partial<DbBindOptions> = {}): DbBindOptions {
    return {
        namespace: "default",
        secret: "shop-db",
        dryRun: false,
        ...partial,
    };
}

describe("parseDbBindArgs", () => {
    it("parses the full flag surface", () => {
        const o = parseDbBindArgs([
            "--secret",
            "shop-db",
            "--key",
            "uri",
            "--ro-secret",
            "shop-db-ro",
            "--ro-key",
            "uri_ro",
            "--namespace",
            "prod",
            "--dry-run",
        ]);
        expect(o.secret).toBe("shop-db");
        expect(o.key).toBe("uri");
        expect(o.roSecret).toBe("shop-db-ro");
        expect(o.roKey).toBe("uri_ro");
        expect(o.namespace).toBe("prod");
        expect(o.dryRun).toBe(true);
    });

    it("takes the app name as the first positional and defaults namespace", () => {
        const o = parseDbBindArgs(["my-app", "--secret", "shop-db"]);
        expect(o.app).toBe("my-app");
        expect(o.namespace).toBe("default");
        expect(o.dryRun).toBe(false);
    });

    it("accepts --dsn and --secret-file for the contract check", () => {
        const o = parseDbBindArgs([
            "--secret",
            "shop-db",
            "--dsn",
            "postgres://u:p@h:5432/db",
            "--secret-file",
            "./secret.yaml",
        ]);
        expect(o.dsn).toBe("postgres://u:p@h:5432/db");
        expect(o.secretFile).toBe("./secret.yaml");
    });

    it("a value-taking flag as the trailing token errors cleanly (no undefined namespace)", () => {
        expect(() => parseDbBindArgs(["--secret", "shop-db", "-n"])).toThrow(
            /-n requires a value/,
        );
        expect(() => parseDbBindArgs(["--secret"])).toThrow(
            /--secret requires a value/,
        );
    });

    it("a value-taking flag followed by another flag errors cleanly", () => {
        expect(() => parseDbBindArgs(["--secret", "--dry-run"])).toThrow(
            /--secret requires a value/,
        );
    });

    it("rejects unknown flags with a usage hint instead of silently ignoring them", () => {
        expect(() => parseDbBindArgs(["--secert", "shop-db"])).toThrow(
            /unknown flag "--secert".*db bind --help/,
        );
    });

    it("rejects a second positional", () => {
        expect(() =>
            parseDbBindArgs(["app-a", "app-b", "--secret", "shop-db"]),
        ).toThrow(/unexpected positional "app-b"/);
    });
});

describe("validateDbBindOptions (arg-level, ADR-0019 rules 1 + 6)", () => {
    it("requires --secret", () => {
        expect(() =>
            validateDbBindOptions(opts({ secret: undefined })),
        ).toThrow(/--secret/);
    });

    it.each([
        "Shop-DB",
        "shop_db",
        "-shop",
        "shop-",
    ])("rejects a non-DNS-1123 secret name: %s", (bad) => {
        expect(() => validateDbBindOptions(opts({ secret: bad }))).toThrow(
            /DNS-1123/,
        );
    });

    it("rejects a secret name longer than 253 chars", () => {
        expect(() =>
            validateDbBindOptions(opts({ secret: "a".repeat(254) })),
        ).toThrow(/253/);
    });

    it("rejects a non-DNS-1123 --ro-secret name", () => {
        expect(() =>
            validateDbBindOptions(opts({ roSecret: "Bad_Name" })),
        ).toThrow(/DNS-1123/);
    });

    it("rejects --ro-key without --ro-secret (rule 6 shape)", () => {
        expect(() =>
            validateDbBindOptions(opts({ roKey: "DATABASE_URL_RO" })),
        ).toThrow(/--ro-key requires --ro-secret/);
    });

    it("accepts a valid dotted DNS-1123 subdomain", () => {
        expect(() =>
            validateDbBindOptions(opts({ secret: "shop.db-0" })),
        ).not.toThrow();
    });
});

describe("validateBindAgainstSpec (ADR-0019 rules 3/4)", () => {
    it("rule 3 — rejects when envMap already defines DATABASE_URL, with the exact conflict message", () => {
        expect(() =>
            validateBindAgainstSpec(
                opts(),
                {
                    secrets: {
                        envMap: {
                            DATABASE_URL: {
                                secretName: "x",
                                secretKey: "DATABASE_URL",
                            },
                        },
                    },
                },
                "config",
            ),
        ).toThrow(
            'spec.database owns DATABASE_URL: it is already defined in spec.secrets.envMap (config). Remove the envMap["DATABASE_URL"] entry — there is no silent precedence (ADR-0019).',
        );
    });

    it("rule 4 — rejects an envMap DATABASE_URL_RO collision only when --ro-secret is given", () => {
        const spec = {
            secrets: {
                envMap: {
                    DATABASE_URL_RO: {
                        secretName: "x",
                        secretKey: "DATABASE_URL_RO",
                    },
                },
            },
        };
        // no roSecret -> envMap DATABASE_URL_RO stays the author's business
        expect(() =>
            validateBindAgainstSpec(opts(), spec, "cluster"),
        ).not.toThrow();
        expect(() =>
            validateBindAgainstSpec(
                opts({ roSecret: "shop-db" }),
                spec,
                "cluster",
            ),
        ).toThrow(
            'spec.database owns DATABASE_URL_RO: it is already defined in spec.secrets.envMap (cluster). Remove the envMap["DATABASE_URL_RO"] entry — there is no silent precedence (ADR-0019).',
        );
    });

    it("passes on a clean spec (no database block, unrelated envMap keys)", () => {
        expect(() =>
            validateBindAgainstSpec(
                opts({ roSecret: "shop-db" }),
                {
                    secrets: {
                        envMap: {
                            API_KEY: { secretName: "x", secretKey: "k" },
                        },
                    },
                },
                "cluster",
            ),
        ).not.toThrow();
    });
});

describe("buildDbBindPatch / renderDbBindPatchYaml", () => {
    it("emits only secretRef.name when keys are defaulted (ADR-0019 rule 2 — server defaults)", () => {
        const patch = buildDbBindPatch(opts()) as {
            spec: { database: Record<string, unknown> };
        };
        expect(patch).toEqual({
            spec: { database: { secretRef: { name: "shop-db" } } },
        });
    });

    it("carries explicit keys and the roSecretRef", () => {
        const patch = buildDbBindPatch(
            opts({ key: "uri", roSecret: "shop-db", roKey: "uri_ro" }),
        );
        expect(patch).toEqual({
            spec: {
                database: {
                    secretRef: { name: "shop-db", key: "uri" },
                    roSecretRef: { name: "shop-db", key: "uri_ro" },
                },
            },
        });
    });

    it("renders YAML a human can review in --dry-run", () => {
        const yamlText = renderDbBindPatchYaml(opts({ roSecret: "shop-db" }));
        expect(yamlText).toContain("database:");
        expect(yamlText).toContain("secretRef:");
        expect(yamlText).toContain("roSecretRef:");
        expect(yamlText).toContain("name: shop-db");
    });
});

describe("runDbBind — CR-only write (ADR-0001)", () => {
    const liveCr = (spec: Record<string, unknown> = {}) =>
        JSON.stringify({
            apiVersion: "apps.kn-next.dev/v1alpha1",
            kind: "NextApp",
            spec: { image: "r/a@sha256:0", ...spec },
        });

    it("--dry-run prints the patch YAML and performs ZERO exec calls", async () => {
        const exec = vi.fn();
        const write = vi.fn();
        await runDbBind("my-app", opts({ dryRun: true }), { exec, write });
        expect(exec).toHaveBeenCalledTimes(0);
        const printed = write.mock.calls.map((c) => c[0]).join("");
        expect(printed).toContain("secretRef:");
        expect(printed).toContain("name: shop-db");
    });

    it("live: reads the CR, issues exactly ONE kubectl patch nextapp --type merge, then verifies the field stuck", async () => {
        const exec = vi
            .fn()
            .mockReturnValueOnce(liveCr()) // kubectl get nextapp -o json (pre-validate)
            .mockReturnValueOnce("") // kubectl patch
            .mockReturnValueOnce(
                liveCr({ database: { secretRef: { name: "shop-db" } } }),
            ); // kubectl get (post-patch prune guard)
        const write = vi.fn();
        await runDbBind("my-app", opts({ namespace: "prod" }), {
            exec,
            write,
        });

        expect(exec).toHaveBeenCalledTimes(3);
        const getArgv = exec.mock.calls[0][0] as string[];
        expect(getArgv.slice(0, 3)).toEqual(["kubectl", "get", "nextapp"]);
        expect(getArgv).toContain("my-app");
        expect(getArgv).toContain("prod");

        const patchArgv = exec.mock.calls[1][0] as string[];
        expect(patchArgv.slice(0, 3)).toEqual(["kubectl", "patch", "nextapp"]);
        expect(patchArgv).toContain("--type");
        expect(patchArgv).toContain("merge");
        const nIdx = patchArgv.indexOf("-n");
        expect(patchArgv[nIdx + 1]).toBe("prod");
        const patch = JSON.parse(patchArgv[patchArgv.indexOf("-p") + 1]);
        expect(patch.spec.database.secretRef.name).toBe("shop-db");

        // The verify step is a READ (still exactly one write in total).
        const verifyArgv = exec.mock.calls[2][0] as string[];
        expect(verifyArgv.slice(0, 3)).toEqual(["kubectl", "get", "nextapp"]);
    });

    it("live: silent-prune guard — a pre-#222 CRD that drops secretRef fails loudly with the upgrade message", async () => {
        const exec = vi
            .fn()
            .mockReturnValueOnce(liveCr()) // pre-validate get
            .mockReturnValueOnce("") // kubectl patch exits 0…
            .mockReturnValueOnce(liveCr()); // …but pruning dropped spec.database.secretRef
        await expect(
            runDbBind("my-app", opts(), { exec, write: vi.fn() }),
        ).rejects.toThrow(
            "operator predates spec.database.secretRef — upgrade the operator bundle (kubectl apply the latest install.yaml), then re-run",
        );
        expect(exec).toHaveBeenCalledTimes(3);
    });

    it("live: an envMap DATABASE_URL collision on the cluster blocks the patch (validation runs BEFORE the write)", async () => {
        const exec = vi.fn().mockReturnValueOnce(
            liveCr({
                secrets: {
                    envMap: {
                        DATABASE_URL: { secretName: "x", secretKey: "y" },
                    },
                },
            }),
        );
        const write = vi.fn();
        await expect(
            runDbBind("my-app", opts(), { exec, write }),
        ).rejects.toThrow(/spec.database owns DATABASE_URL/);
        // Only the read happened; the patch was never issued.
        expect(exec).toHaveBeenCalledTimes(1);
    });

    it("live: a missing NextApp fails with a deploy-first hint", async () => {
        const exec = vi.fn(() => {
            throw new Error("NotFound");
        });
        await expect(
            runDbBind("my-app", opts(), { exec, write: vi.fn() }),
        ).rejects.toThrow(/kn-next deploy|--dry-run/);
    });

    it("warns on sslmode=disable and prints the pool contract when a DSN is given", async () => {
        const exec = vi.fn();
        const write = vi.fn();
        await runDbBind(
            "my-app",
            opts({
                dryRun: true,
                dsn: "postgres://u:p@pggw:55432/shop?sslmode=disable",
            }),
            { exec, write },
        );
        const printed = write.mock.calls.map((c) => c[0]).join("");
        expect(printed).toMatch(/sslmode=disable/);
        expect(printed).toMatch(/60\s?s/); // gateway idle window
        expect(printed).toMatch(/10\s?s/); // connect timeout floor
    });
});

describe("DSN helpers", () => {
    it("analyzeDsn warns on sslmode=disable and always states the pool contract", () => {
        const insecure = analyzeDsn(
            "postgres://u:p@h/db?sslmode=disable",
            "DATABASE_URL",
        );
        expect(insecure.warnings.join(" ")).toMatch(/sslmode=disable/);
        expect(insecure.contract.join(" ")).toMatch(/60s/);
        expect(insecure.contract.join(" ")).toMatch(/10s/);

        const secure = analyzeDsn(
            "postgres://u:p@h/db?sslmode=require",
            "DATABASE_URL",
        );
        expect(secure.warnings).toEqual([]);
        expect(secure.contract.length).toBeGreaterThan(0);
    });

    it("extractDsnFromSecretManifest reads stringData and base64 data", () => {
        const viaStringData = extractDsnFromSecretManifest(
            [
                "apiVersion: v1",
                "kind: Secret",
                "stringData:",
                "  DATABASE_URL: postgres://a@h/db",
            ].join("\n"),
            "DATABASE_URL",
        );
        expect(viaStringData).toBe("postgres://a@h/db");

        const b64 = Buffer.from("postgres://b@h/db").toString("base64");
        const viaData = extractDsnFromSecretManifest(
            ["apiVersion: v1", "kind: Secret", "data:", `  uri: ${b64}`].join(
                "\n",
            ),
            "uri",
        );
        expect(viaData).toBe("postgres://b@h/db");

        expect(
            extractDsnFromSecretManifest("kind: Secret", "DATABASE_URL"),
        ).toBeUndefined();
    });
});
