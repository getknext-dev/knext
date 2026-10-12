/**
 * The CRD `apiVersion` every NextApp the CLI emits carries.
 *
 * Lives in its own dependency-free module, not in `cr-builder.ts`, so that
 * `knext doctor` can read it without importing the CR renderer: the deploy
 * tests replace `cr-builder` wholesale with `mock.module`, and a doctor that
 * imported the constant from there would fail to load under those mocks (and
 * with it every failure-path diagnostic that dynamically imports doctor).
 * `cr-builder.ts` stamps this value on the CR and re-exports it.
 */
export const NEXTAPP_API_VERSION = "apps.kn-next.dev/v1alpha1";
