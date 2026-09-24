/**
 * Side-effect module injected as an early import of the compiled entry by
 * vinext-compile (#1320): installs the sidecar-confined `Module._resolveFilename`
 * hook BEFORE any bundled module initialises, and exposes the loader the entry
 * shims use on a `Symbol.for` global (it survives module duplication; see
 * ADR-0027). See sidecar-runtime.mjs for the resolver and the security rationale.
 */
import Module from "node:module";
import {
    installSidecarResolution,
    SIDECAR_GLOBAL,
    sidecarEntryFile,
    sidecarHas,
    sidecarRoot,
} from "./sidecar-runtime.mjs";

const root = sidecarRoot();
installSidecarResolution(Module, root);
globalThis[Symbol.for(SIDECAR_GLOBAL)] = {
    root,
    has: (name) => sidecarHas(name, root),
    entryFile: (request) => sidecarEntryFile(request, root),
};
