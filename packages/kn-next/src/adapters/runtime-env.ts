/**
 * The env var `knext build`/`deploy`/`preview` export to the app's build with
 * the configured runtime id (`config.runtime ?? DEFAULT_RUNTIME_ID`). The knext
 * adapter reads it to point `cacheHandler` at that runtime's entry (#1843).
 *
 * Its own module so the CLI and the adapter share one spelling without the CLI
 * importing the adapter.
 */
export const KNEXT_RUNTIME_ENV = "KNEXT_RUNTIME";
