/**
 * #1535 round 2 (B2) — pin `--verbose` end to end, through the REAL CLI
 * dispatcher, not just at each individual layer.
 *
 * Round 1 pinned `parseDoctorArgs` (accepting the flag,
 * `doctor/args.test.ts`-adjacent coverage inside `doctor.test.ts`) and
 * `actionableDetail`'s verbose-gate behavior separately, but nothing asserted
 * the flag survives the trip from `process.argv` through `doctorMain` →
 * `runDoctor` → each check's `ctx.verbose` → `actionableDetail`. Two
 * mutations survived because of that gap:
 *   - `doctor/args.ts`: the parser's allowlist stops matching `--verbose`
 *     (it then throws a UsageError instead of accepting the flag).
 *   - `doctor.ts:190`: `runDoctor(deps, args.verbose)` hardcoded to
 *     `runDoctor(deps, false)` — the flag is accepted and parsed, but never
 *     reaches the checks.
 *
 * Spawns the REAL dispatcher entry (`deploy.ts` — the bin doubles as a tiny
 * subcommand router; see the "self-entry hazard" note near its bottom) with
 * a deterministic FAKE `kubectl` (always fails, so no real cluster/network
 * is ever touched) and `KUBECONFIG` pointed at a path that does not exist,
 * landing the run on doctor's "no Kubernetes cluster configured" state —
 * the one case whose raw diagnostic (`NO_KUBE_CONTEXT_SENTENCE` +
 * `actionableDetail`) is well-known plain text to assert on.
 */

import { describe, expect, it, setDefaultTimeout } from "bun:test";

// Same budget rationale as cli-config-not-found.test.ts: spawning bun twice
// per test, under full-suite parallelism, can exceed the 5s default.
setDefaultTimeout(30_000);

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..", "..");
const cliSrcDir = join(pkgRoot, "src", "cli");
const entry = join(cliSrcDir, "deploy.ts");
const bun = process.env.BUN_PATH ?? "bun";

/** Runs `deploy.ts doctor [...flags]` against a cluster-free environment. */
function runDoctor(flags: string[]) {
    // A fake `kubectl` that always fails, fast and deterministically. Created
    // inline so the temp-dir scanner sees the same name at mkdtemp and rmSync.
    const fakeBin = mkdtempSync(join(tmpdir(), "knext-fake-kubectl-"));
    writeFileSync(join(fakeBin, "kubectl"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(fakeBin, "kubectl"), 0o755);
    const kubeconfigDir = mkdtempSync(join(tmpdir(), "knext-no-kubeconfig-"));
    const kubeconfig = join(kubeconfigDir, "does-not-exist");
    try {
        const r = spawnSync(bun, [entry, "doctor", ...flags], {
            encoding: "utf8",
            // An empty directory: doctor's local checks (the vinext version
            // row among them) must not read whatever app this suite runs in.
            cwd: kubeconfigDir,
            env: {
                ...process.env,
                NO_COLOR: "1",
                PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
                KUBECONFIG: kubeconfig,
            },
        });
        return { ...r, kubeconfig };
    } finally {
        rmSync(fakeBin, { recursive: true, force: true });
        rmSync(kubeconfigDir, { recursive: true, force: true });
    }
}

describe("end-to-end: `knext doctor --verbose` threads to the raw diagnostic (#1535 round 2)", () => {
    const probe = spawnSync(bun, ["--version"], { encoding: "utf8" });

    // #1535 round 3: this suite is the ONLY end-to-end pin for `--verbose` —
    // it must never silently skip. A `skipIf(!!probe.error)` here reports
    // the same green whether bun spawned or not, which is exactly the
    // "control that reports success while inert" class this repo keeps
    // finding (round 2 review, R2-B3). Asserting `probe.error` is unset as
    // each test's first statement makes a spawn failure a LOUD failure,
    // carrying the real probe error in the assertion message, instead of a
    // vanished test.
    const bunSpawned = () =>
        expect(
            probe.error,
            `bun failed to spawn (${bun}) — this end-to-end pin cannot skip, it must fail`,
        ).toBeUndefined();

    it("without --verbose: the short actionable sentence only, no raw diagnostic", () => {
        bunSpawned();
        const r = runDoctor([]);
        const combined = `${r.stdout}${r.stderr}`;
        expect(r.status).toBe(0);
        expect(combined).toContain("No Kubernetes cluster configured.");
        expect(combined).not.toContain("[--verbose]");
        expect(combined).not.toContain("no kubeconfig found (searched:");
    });

    it("with --verbose: the raw diagnostic (including the searched path) is appended", () => {
        bunSpawned();
        const r = runDoctor(["--verbose"]);
        const combined = `${r.stdout}${r.stderr}`;
        expect(r.status).toBe(0);
        expect(combined).toContain("No Kubernetes cluster configured.");
        expect(combined).toContain("[--verbose]");
        expect(combined).toContain("no kubeconfig found (searched:");
        expect(combined).toContain(r.kubeconfig);
    });

    it("an unrelated unknown flag is still rejected (parser strictness unchanged by --verbose)", () => {
        bunSpawned();
        const r = spawnSync(bun, [entry, "doctor", "--not-a-real-flag"], {
            encoding: "utf8",
            env: { ...process.env, NO_COLOR: "1" },
        });
        expect(r.status).not.toBe(0);
        expect(`${r.stdout}${r.stderr}`).toContain("unknown argument");
    });
});
