/**
 * `knext build` / `knext deploy` WARN when the app resolves a Next.js with a
 * published critical/high advisory (#2594 round 2). A warning, not a refusal:
 * the peer range still admits these versions, and `knext doctor` is the gate
 * that FAILs. The version is read the way doctor reads it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    nextAdvisoryWarning,
    warnOnVulnerableNext,
} from "../cli/next-advisory-warning";
import { runProjectBuild } from "../cli/project-build";

const IDS = [
    "GHSA-2464-fhr4-w9xw",
    "GHSA-673q-mjm6-r5xr",
    "GHSA-p3m5-59mp-jv5r",
];

let dir: string;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-next-adv-"));
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

function installNext(version: string): void {
    writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "app", scripts: { build: "next build" } }),
    );
    mkdirSync(join(dir, "node_modules", "next"), { recursive: true });
    writeFileSync(
        join(dir, "node_modules", "next", "package.json"),
        JSON.stringify({ name: "next", version }),
    );
}

describe("nextAdvisoryWarning", () => {
    it("names every advisory, the fixed version and doctor for an affected next", () => {
        const w = nextAdvisoryWarning("16.3.8") ?? "";
        for (const id of IDS) expect(w).toContain(id);
        expect(w).toContain("16.3.8");
        expect(w).toContain("16.4.1");
        expect(w).toContain("knext doctor");
    });

    it("is silent for a fixed next, an unknown version and no next", () => {
        expect(nextAdvisoryWarning("16.4.3")).toBeUndefined();
        expect(nextAdvisoryWarning("canary")).toBeUndefined();
        expect(nextAdvisoryWarning(undefined)).toBeUndefined();
    });
});

describe("warnOnVulnerableNext reads the installed next from the app dir", () => {
    it("writes the warning for an installed 16.3.8", () => {
        installNext("16.3.8");
        const lines: string[] = [];
        warnOnVulnerableNext(dir, (l) => lines.push(l));
        expect(lines.join("\n")).toContain("GHSA-673q-mjm6-r5xr");
    });

    it("writes nothing for an installed 16.4.3", () => {
        installNext("16.4.3");
        const lines: string[] = [];
        warnOnVulnerableNext(dir, (l) => lines.push(l));
        expect(lines).toEqual([]);
    });
});

describe("deploy --skip-build warns from the app dir too", () => {
    // deploy() is a 1000-line orchestration with a live cluster behind it; the
    // build path is covered behaviourally below (runProjectBuild). The
    // --skip-build path is asserted structurally: exactly one call, gated on
    // skipBuild and NOT on --image (whose Next.js is not this directory's).
    it("calls warnOnVulnerableNext once, only for a local --skip-build deploy", () => {
        const src = readFileSync(
            join(import.meta.dirname, "..", "cli", "deploy.ts"),
            "utf8",
        );
        const calls = src.match(/warnOnVulnerableNext\(/g) ?? [];
        expect(calls.length).toBe(1);
        expect(src).toMatch(
            /if \(options\.skipBuild && !options\.image\) \{\s*warnOnVulnerableNext\(process\.cwd\(\)\);\s*\}/,
        );
    });
});

describe("build --skip-next warns from the app dir too", () => {
    it("calls warnOnVulnerableNext once, gated on skipNextBuild", () => {
        const src = readFileSync(
            join(import.meta.dirname, "..", "cli", "build.ts"),
            "utf8",
        );
        expect((src.match(/warnOnVulnerableNext\(/g) ?? []).length).toBe(1);
        expect(src).toMatch(
            /if \(options\.skipNextBuild\) \{\s*warnOnVulnerableNext\(process\.cwd\(\)\);\s*\}/,
        );
    });
});

describe("runProjectBuild (build, deploy and preview) carries the warning", () => {
    const build = (warn: (l: string) => void) =>
        runProjectBuild({
            requireEsm: false,
            cwd: dir,
            run: () => {},
            builderId: "webpack",
            runtimeId: "node",
            warn,
        });

    it("warns, and still builds, on a vulnerable next", () => {
        installNext("16.4.0");
        const lines: string[] = [];
        expect(() => build((l) => lines.push(l))).not.toThrow();
        expect(lines.join("\n")).toContain("GHSA-2464-fhr4-w9xw");
    });

    it("stays quiet on a fixed next", () => {
        installNext("16.4.3");
        const lines: string[] = [];
        build((l) => lines.push(l));
        expect(lines.join("\n")).not.toContain("GHSA-");
    });
});
