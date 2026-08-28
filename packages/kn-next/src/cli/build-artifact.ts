/**
 * Where `kn-next build` should expect this app's output to land.
 *
 * `build.ts` used to hardcode `.next/standalone` in five places: two log lines,
 * the bun-exports heal, the bytecode pass, and a warning that names
 * `output:'standalone'` as the likely cause when the directory is missing. All
 * correct for turbopack, all wrong for anything else — a vinext build would be
 * told to check a Next.js config option that has nothing to do with it.
 *
 * Asking the contract instead means adding a builder does not require auditing
 * every path literal in the build command. That is the difference the artifact
 * contract is for.
 *
 * NOTE on what `kn-next build` actually does: it does NOT run `next build`
 * itself. It runs the app's own `npm run build` (see `project-build.ts`), so an
 * app configured for vinext already builds with vinext today. What was missing
 * was knext knowing where to LOOK afterwards, and which post-build steps still
 * apply. This module supplies exactly that.
 */

import {
    BUILDERS,
    type BuildArtifact,
    type BuilderAdapter,
} from "../adapters/artifact-contract";
import type { KnativeNextConfig } from "../config";
import { UsageError } from "./shared";

/** The default builder — absence of `config.build` means turbopack. */
const DEFAULT_BUILD = "vinext";

export interface ResolvedBuild {
    readonly builder: BuilderAdapter;
    readonly artifact: BuildArtifact;
}

/**
 * Resolve the builder and its artifact for this config.
 *
 * Throws on an unknown builder rather than falling back to the default. A
 * silent fallback would build one thing, look for another, and report success
 * — the #857 shape, where `next build` exited 0 the whole way while emitting a
 * server nothing could find. `validateConfig` normally rejects this first; the
 * throw is the backstop for a bypassed validator, not a duplicate of it.
 */
export function resolveBuildArtifact(
    config: KnativeNextConfig,
    root: string,
): ResolvedBuild {
    const id = config.build ?? DEFAULT_BUILD;
    const builder = BUILDERS.find((b) => b.id === id);
    if (!builder) {
        // UsageError, not a plain Error: this is a config mistake, and the
        // CLI renders that family as a friendly message + exit 1 rather than
        // `log.fatal({ err })` with a stack and a dist chunk path
        // (cli-dispatch-contract.test.ts enforces the distinction).
        throw new UsageError(
            `Unknown build system '${id}' in kn-next.config.ts. Known: ${BUILDERS.map((b) => b.id).join(", ")}.`,
        );
    }
    return { builder, artifact: builder.describeArtifact(root) };
}

/**
 * Do the standalone-tree post-build steps apply to this artifact?
 *
 * The bun-condition export heal and the Bun bytecode pass both walk a
 * `.next/standalone` tree. Keyed on the SHAPE rather than on the builder id, so
 * a future builder that also emits a standalone tree inherits them, and one
 * that does not is never handed a step that cannot mean anything for it.
 */
export function standaloneStepsApply(artifact: BuildArtifact): boolean {
    return artifact.shape === "next-standalone";
}
