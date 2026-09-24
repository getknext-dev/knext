/**
 * The build/runtime seam (ADR-0036 §"RuntimeContract applies to all three cells",
 * Track B1 of `docs/adr/drafts/bun14-runtime-vinext-builder-plan.md`).
 *
 * ## What this is for
 *
 * knext has two independent user choices — which **builder** produces the app,
 * and which **runtime** executes it. Historically those were modelled as an
 * enumerated matrix of (build, runtime) cells, each cell a special case, with a
 * cluster-side CEL rule to reject the invalid ones. That approach collapsed:
 * adding a builder meant editing a table, a validator and an admission rule, and
 * the matrix in the ADRs drifted away from what the code actually did.
 *
 * This module replaces the table with a **contract**. A builder declares the
 * SHAPE of artifact it emits; a runtime declares which shapes it can execute.
 * Compatibility is then a property of the contract — *"no runtime accepts a
 * shape it cannot execute"* — rather than a list someone must remember to update.
 *
 * ## Why the shape, and not the (build, runtime) pair, is the key
 *
 * ADR-0036 records the load-bearing observation: `RuntimeContract` applies to
 * every cell via exactly **TWO** implementations, and they are keyed by what the
 * builder emitted, not by which runtime runs it —
 *
 *   - `.next/standalone` → the supervisor **spawns** `server.js` as a child;
 *   - nitro `.output`    → an **in-process** entry, run directly.
 *
 * Both vinext cells (node+vinext and bun+vinext) share one implementation. That
 * is why the axes genuinely separate: the runtime is a *parameter* of executing
 * a shape, not a selector of an implementation. Two shapes, N runtimes.
 *
 * ## Scope
 *
 * This is the seam. The `build` config key it feeds is now live (B2), and BOTH
 * builders are selectable: `turbopack` (`next build` -> `.next/standalone`),
 * `vinext` (nitro single executable), and `webpack` (#1219, a second spelling
 * of the standalone shape). ADR-0048 had retired turbopack; ADR-0054 item 6
 * (#1167) re-opened it as the verified 778/0 standalone axis, and ADR-0058
 * (#1183, 2026-09-24) flipped `DEFAULT_BUILDER_ID` to `turbopack` once
 * node/bun × turbopack banked their v1.0 credential — `vinext` stays
 * selectable, v1.x-credentialed.
 *
 * The contract was written for two builders so that the second was an
 * implementation of an existing interface rather than a redesign — which is why
 * flipping turbopack back to `available` is a one-line change here, not a rework.
 */

/**
 * What a builder emits. The unit of compatibility.
 *
 * Not an open string: a runtime must be able to answer "can I execute this?"
 * exhaustively, and an unknown shape has to be a compile error rather than a
 * silent `false`.
 */
export type ArtifactShape =
    | "next-standalone"
    | "nitro-output-bun"
    | "nitro-output-node";

/**
 * NOTE on why the nitro shape carries its PRESET.
 *
 * An earlier version of this type had a preset-blind `"nitro-output"`, on the
 * strength of ADR-0036 prose saying the vinext output runs "on either runtime"
 * via nitro's node-server preset. A design gate MEASURED that and it is false
 * for the artifact this repo actually builds:
 *
 *   $ node examples/bun-exec/.output/server/index.mjs
 *   exit 1 — ReferenceError: Bun is not defined
 *
 * `.output/nitro.json` says `"preset": "bun"`; the entry calls that runtime's
 * global `serve()` at
 * module top level. A nitro `.output` is therefore not ONE shape — it is one
 * shape per preset, and the preset decides which runtimes can execute it.
 * Encoding the preset in the shape is what keeps `isCompatible` honest; a
 * node-preset build would be a DIFFERENT shape, added when something builds one.
 *
 * Something now does (#1260): vinext × node builds nitro's `node` preset.
 * Measured — `.output/nitro.json` says `"preset": "node-server"`, the entry
 * carries no `Bun.` reference, and `node .output/server/index.mjs` serves
 * GET / 200. That artifact is `nitro-output-node`. The bun-preset measurement
 * above is unchanged and node still refuses `nitro-output-bun`.
 */

/** Which builder produced an artifact. */
export type BuilderId = "turbopack" | "vinext" | "webpack";

/** Which process executes it. Mirrors the shipped `runtime` config key. */
export type RuntimeId = "node" | "bun";

/**
 * How a runtime has to execute an entry. Part of the shape's contract, not the
 * runtime's choice — `.next/standalone` is spawned because it is a Next server
 * that owns its own listener, and the nitro output is in-process because the
 * compiled single-executable path has no child to spawn.
 */
export type ExecutionMode = "spawn" | "in-process";

/**
 * A concrete artifact, as handed from a builder to a runtime.
 *
 * `entry` is relative to `root` so the descriptor stays portable across the
 * build host and the container, which do not share a prefix — the mismatch
 * behind #857.
 */
export interface BuildArtifact {
    readonly shape: ArtifactShape;
    /** Directory `entry` resolves against (the app root inside the image). */
    readonly root: string;
    /** Path to the entry the runtime executes, relative to `root`. */
    readonly entry: string;
    readonly execution: ExecutionMode;
}

/** Produces an artifact of exactly one shape. */
export interface BuilderAdapter {
    readonly id: BuilderId;
    readonly emits: ArtifactShape;
    /**
     * Can this build of knext actually RUN this builder?
     *
     * Separate from being described, and the distinction is load-bearing. A
     * builder's artifact shape is knowable before its toolchain is a
     * dependency — that is what lets the contract be written for two
     * implementors while only one is installable, so adding the second is an
     * implementation rather than a redesign.
     *
     * The validator reports the two cases differently on purpose: an
     * unrecognised builder is a typo, an unavailable one is a real builder this
     * release cannot run. Telling someone selecting `vinext` to check their
     * spelling would be wrong and would waste their time.
     */
    readonly available: boolean;
    /**
     * Where this builder's output lands for an app rooted at `root`.
     * Pure — it describes the artifact, it does not run the build.
     *
     * `runtime` is the runtime the build targets. Most builders emit one
     * shape whatever runs it (and ignore the argument); vinext does not — its
     * nitro preset IS the runtime choice, so it emits a different shape per
     * runtime (#1260). Absent means the builder's default (`emits`).
     */
    describeArtifact(root: string, runtime?: RuntimeId): BuildArtifact;
}

/** Executes artifacts of the shapes it accepts. */
export interface RuntimeAdapter {
    readonly id: RuntimeId;
    /** The shapes this runtime can execute. */
    readonly accepts: readonly ArtifactShape[];
}

/**
 * The invariant that replaces the CEL admission rule: a runtime may only be
 * paired with an artifact whose shape it accepts.
 *
 * Expressed as a total function over the contract rather than a list of
 * forbidden pairs, so a new builder or runtime cannot silently become "valid"
 * by nobody having remembered to forbid it.
 */
export function isCompatible(
    runtime: RuntimeAdapter,
    artifact: BuildArtifact,
): boolean {
    return runtime.accepts.includes(artifact.shape);
}

/**
 * Human-readable refusal, for the CLI validator and the operator's status
 * condition. Returns `null` when the pairing is fine, so callers branch on the
 * value rather than re-deriving the check and risking the two disagreeing.
 */
export function explainIncompatibility(
    runtime: RuntimeAdapter,
    artifact: BuildArtifact,
): string | null {
    if (isCompatible(runtime, artifact)) return null;
    return (
        `runtime '${runtime.id}' cannot execute a '${artifact.shape}' artifact ` +
        `(it accepts: ${runtime.accepts.join(", ") || "nothing"}). ` +
        "Choose a different runtime, or a builder that emits a shape this runtime accepts."
    );
}

/**
 * `next build` → `.next/standalone/server.js`, spawned by the supervisor.
 *
 * The all-apps-verified path, and the DEFAULT since #1183/ADR-0058 (see
 * `DEFAULT_BUILDER_ID`) — `vinext` stays selectable. `node-server.ts` is its
 * runtime half; `STANDALONE_SERVER_PATH` overrides the entry there, and the
 * default below is that same value so the two cannot drift apart silently.
 */
export const turbopackBuilder: BuilderAdapter = {
    id: "turbopack",
    emits: "next-standalone",
    // AVAILABLE again (ADR-0054 item 6, #1167). ADR-0048 had retired this as
    // user-selectable; ADR-0054 reverses that — the `next build` ->
    // `.next/standalone` shape is the verified 778/0 axis (the verified-adapter
    // credential), so it is re-opened as a selectable target. What ships here is
    // the bun/node-standalone image — on Bun, `next build`'s server compiled
    // into a bytecode single executable (#1166, `cli/standalone-exec-build.ts`);
    // on Node, uncompiled with the V8 compile cache; the standalone runtime image +
    // supervisor entrypoint that packages it are staged by `cli/runtime-image.ts`
    // (#1177/#1181, ADR-0055). vinext stays available too (founder-directed) —
    // both are selectable. THE default since #1183/ADR-0058, once the
    // bun-standalone lane was credentialed; see DEFAULT_BUILDER_ID below.
    available: true,
    describeArtifact(root: string): BuildArtifact {
        return {
            shape: "next-standalone",
            root,
            entry: ".next/standalone/server.js",
            execution: "spawn",
        };
    },
};

/**
 * `next build --webpack` → `.next/standalone/server.js`, spawned by the same
 * supervisor as `turbopackBuilder` (#1219).
 *
 * webpack emits the IDENTICAL artifact shape as the turbopack builder —
 * `next-standalone`, same entry, same execution mode — because both are the
 * same `next build` command with a different bundler flag, and the standalone
 * output the adapter produces does not vary by bundler. That identity is the
 * whole point of the shape-keyed contract (see the module docstring): a second
 * builder that emits a shape the contract already knows inherits every
 * downstream step (`standaloneStepsApply`, the runtime-image selection in
 * `runtime-image.ts`, the Bun bytecode compile in `build.ts`) for free, with
 * no new branch anywhere keyed on the builder id. Only `describeArtifact`
 * exists as its own object so `BUILDERS` can enumerate a real, distinct
 * `BuilderAdapter` per id — the object identity is what the CLI reports back
 * (`kn-next.config.ts`'s `build` value), not a difference in what gets built.
 *
 * AVAILABLE from the start: nothing about running `next build --webpack`
 * needs new toolchain — it is the same `next` binary the turbopack target
 * already depends on.
 */
export const webpackBuilder: BuilderAdapter = {
    id: "webpack",
    emits: "next-standalone",
    available: true,
    describeArtifact(root: string): BuildArtifact {
        return {
            shape: "next-standalone",
            root,
            entry: ".next/standalone/server.js",
            execution: "spawn",
        };
    },
};

/**
 * vinext (the Vite/rolldown Next reimplementation) → a nitro `.output`, run
 * **in-process**.
 *
 * `available: true`, and the DEFAULT — one of TWO selectable builders, since
 * ADR-0054 item 6 re-opened `turbopack`/`next-standalone` alongside it, so
 * `DEFAULT_BUILDER_ID` is what distinguishes them. Both halves
 * of the pipeline exist: `cli/vinext-build.ts` produces the executable and the
 * scaffolded Dockerfile ships it. (An earlier revision of this docstring said
 * `available: false` because vinext was not yet a dependency; that era ended
 * when the toolchain landed, and `kn-next build` now compiles the binary
 * itself for the nitro shape.)
 *
 * The shape depends on the runtime, because the nitro PRESET is the runtime
 * choice (#1260):
 *
 *   - bun (and an absent runtime — the default cell): nitro's **bun** preset.
 *     `.output/nitro.json` carries `"preset": "bun"` and the entry calls that
 *     runtime's global `serve()` at module top level, so it is executable by
 *     bun and NOT by node. `kn-next build` compiles it into the single
 *     executable.
 *   - node: nitro's **node** preset (`"preset": "node-server"`), entry
 *     `knext-node-entry.mjs`. Run uncompiled — `node .output/server/index.mjs`
 *     — with the V8 compile cache baked into the image (ADR-0035).
 *
 * ADR-0036 once claimed the two cells share ONE entry. That was false for the
 * bun-preset artifact (a design gate ran it: `Bun is not defined`), and it is
 * still false: they are two artifacts from one builder, which is exactly why
 * the preset is part of the shape.
 *
 * `execution: "in-process"` rather than `"spawn"`: unlike the standalone
 * server, there is no child to supervise, so SIGTERM draining has to be handled
 * in-process by the entry itself. That difference is a property of the SHAPE,
 * which is why it belongs on the artifact and not on the runtime.
 */
export const vinextBuilder: BuilderAdapter = {
    id: "vinext",
    emits: "nitro-output-bun",
    // ADR-0048 made this the default target; ADR-0054 item 6 keeps it default
    // while making `turbopack` selectable too. Available because both halves now
    // exist — `cli/vinext-build.ts` produces the executable (vite build ->
    // nitro bun preset -> `bun build --compile --minify --bytecode`, floored at
    // Bun 1.4.0), and `templates/app/Dockerfile.hbs` ships it. The node cell's
    // image is `templates/app/Dockerfile.vinext-node.hbs` (#1260).
    available: true,
    describeArtifact(root: string, runtime?: RuntimeId): BuildArtifact {
        return {
            shape:
                runtime === "node" ? "nitro-output-node" : "nitro-output-bun",
            root,
            entry: ".output/server/index.mjs",
            execution: "in-process",
        };
    },
};

/**
 * Node executes the standalone shape (spawned as a child) and the node-preset
 * nitro output (in-process). NOT the bun-preset nitro output.
 *
 * History, kept because the reasoning is what protects the list:
 * This docstring previously said "Node executes both shapes", citing ADR-0036,
 * and argued that ADR-0042 Decision 2's exclusion of `node + vinext` was policy
 * rather than capability. **Measured, the cell is not capable at all**: the
 * artifact this repo builds is a bun-preset nitro output, and running it under
 * node exits 1 with a missing-global error before serving anything.
 *
 * So there is no "can versus may" tension here to reason about. If something
 * later emits a node-preset nitro output, that is a NEW shape, and ADR-0042's
 * policy question revives at that point rather than having been quietly
 * retired — see `docs/adr/drafts/0048-draft-build-runtime-separation.md`.
 *
 * #1260 is that point, and the policy question was answered by the founder on
 * #1218 (ADR-0054 Amendment 7): vinext × node is a supported cell. The shape
 * was added on MEASUREMENT (GET / 200 under node), not on prose.
 */
export const nodeRuntime: RuntimeAdapter = {
    id: "node",
    // NOT the nitro shape. This listed `nitro-output` until a design gate ran the
    // artifact: `node examples/bun-exec/.output/server/index.mjs` exits 1 with
    // `ReferenceError: Bun is not defined`, because the built entry is nitro's
    // BUN preset and calls that runtime's global `serve()` at module top level.
    //
    // The claim came from ADR-0036 prose ("vinext runs on either runtime — nitro
    // node-server preset for node"), not from measurement, and nothing in the
    // tree builds a node-preset output. Re-add a node-executable nitro shape
    // when something actually emits one; until then this would have made
    // `isCompatible` certify a pairing that crashes on boot.
    //
    // #1260 emits one: `nitro-output-node`, measured serving under node. The
    // bun-preset shape stays OFF this list — that measurement has not changed.
    accepts: ["next-standalone", "nitro-output-node"],
};

/**
 * Bun executes both shapes.
 *
 * `next-standalone` under Bun is not hypothetical: it is the shipped meaning of
 * `runtime: bun` today — see `config.ts`'s own wording, *"Runtime to execute the
 * Next.js standalone server.js: 'bun' or 'node'"* — with per-file bytecode
 * precompilation in `build.ts`. ADR-0036 describes this pairing as "rejected"
 * under a `bun ⇒ vinext` invariant that was never implemented; no such CEL rule
 * exists in the CRD. The contract records what the code does.
 */
export const bunRuntime: RuntimeAdapter = {
    id: "bun",
    accepts: ["next-standalone", "nitro-output-bun"],
};

/**
 * Every builder the contract knows about — including ones this release cannot
 * run. Callers that need "what can I actually select today" must filter on
 * `available`, which is what the CLI validator does.
 */
export const BUILDERS: readonly BuilderAdapter[] = [
    turbopackBuilder,
    vinextBuilder,
    webpackBuilder,
];

/**
 * What an ABSENT `config.build` means: the standalone (`next build`) shape,
 * the bun-standalone family ADR-0054 names the v1.0 default. One constant,
 * because the default is load-bearing in three places that must never
 * disagree — artifact resolution (`build-artifact.ts`), the CR the CLI emits
 * (`cr-builder.ts`, where the resolved value is written explicitly since
 * wire-absence permanently means turbopack), and the asset staging path
 * (`asset-upload.ts`, which sources a different tree per shape).
 *
 * FLIPPED to `turbopack` in #1183 (ADR-0058, founder decision 2026-09-24) —
 * before this, it stayed `vinext` while the bun-standalone axis was
 * credential-gated. It is now credentialed: node × turbopack and
 * bun × turbopack are both v1.0-credentialed cells (ADR-0058 §Decision 2),
 * `next build` standalone output was 778/0 on the official suite, and
 * `runtime: "bun"` compiles to the ADR-0054 bytecode single executable
 * (#1225). `vinext` stays selectable (ADR-0058: v1.x-credentialed, not
 * dropped). See `DEFAULT_RUNTIME_ID` below for the paired runtime default —
 * a bare config now resolves to the bun × turbopack cell (the compiled
 * bytecode executable), the actual ADR-0054 "bun-standalone" default, not
 * node × turbopack.
 */
export const DEFAULT_BUILDER_ID = "turbopack";

/** The builders this release can actually run. */
export const AVAILABLE_BUILDERS: readonly BuilderAdapter[] = BUILDERS.filter(
    (b) => b.available,
);

/** Every runtime the contract knows about. */
export const RUNTIMES: readonly RuntimeAdapter[] = [nodeRuntime, bunRuntime];

/**
 * What an ABSENT `config.runtime` means for the DEFAULT builder — the single
 * shared constant every `config.runtime ?? …` fallback in the CLI must use
 * (#1183 PR review finding #5: `validate.ts` and `build.ts` previously
 * hardcoded "bun" and "node" respectively, silently disagreeing).
 *
 * `"bun"`, matching ADR-0054's actual default cell: bun-standalone, packaged
 * as the compiled `--bytecode` single executable (#1225) — not the uncompiled
 * node-standalone fallback. A bare `kn-next.config.ts` (no `build`, no
 * `runtime`) now resolves to `build: "turbopack"` (`DEFAULT_BUILDER_ID`) ×
 * `runtime: "bun"` (this constant), the credentialed v1.0 default (ADR-0058
 * §Decision 2). This is ALSO vinext's own absent-runtime default (see
 * `vinextBuilder.describeArtifact` above — an absent runtime picks the bun
 * nitro preset), so the constant is consistent across both builders, not
 * turbopack-specific.
 *
 * Explicit `runtime: "node"` is unaffected — this constant only fills the gap
 * when the config is silent, the same rule `DEFAULT_BUILDER_ID` follows for
 * `build`.
 */
export const DEFAULT_RUNTIME_ID: RuntimeId = "bun";
