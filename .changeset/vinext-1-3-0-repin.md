---
"@getknext/core": patch
---

Apps created with `knext create --builder vinext` pin `vinext` `1.3.0`, and the vinext fixes knext bundles are re-validated against it. Four bundled fixes are dropped because vinext already includes them: `next/dynamic` preload hints rendering inside the Suspense boundary (no stray `<!-- -->` after text), the Pages Router routes listed in `_buildManifest.js` `sortedPages`, a rewrite to a `public/` file being served instead of a 404 or an empty response, and middleware running before a `public/` file its `matcher` covers. Two more are narrowed to the part vinext 1.3.0 still lacks: the custom `loader` prop `srcSet` (the `trailingSlash` image path ships in vinext) and the inline-CSS manifest for Nitro builds (the client stylesheet directory is read correctly in vinext). The remaining fixes are re-ported to vinext `1.3.0`; an app that pins another vinext version skips them with a message saying so.

vinext 1.3.0 requires `react`, `react-dom` and `react-server-dom-webpack` 19.3.1 or later and `@vitejs/plugin-rsc` 0.5.37 or later for App Router builds; the scaffold template pins them accordingly.
