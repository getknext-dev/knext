/**
 * Public config-validation entry — `@knext/core/validate`.
 *
 * This is the SUPPORTED public surface for validating a `kn-next.config.ts`
 * against the exact same rules `kn-next deploy` applies. A consumer imports it
 * into their OWN build/test process (e.g. a config-quality CI gate), so this
 * module — and everything in its import graph — is PURE: no `process.exit`, no
 * kubectl, no I/O, no side effects at import time. It only re-exports the pure
 * validator from the internal CLI module (which the bin also consumes); the two
 * share one implementation so there is no drift between the CLI check and the
 * public one.
 *
 * Exports ONLY `validateConfig` and its result type `ConfigValidationError`.
 */

export { ConfigValidationError, validateConfig } from "./cli/validate";
