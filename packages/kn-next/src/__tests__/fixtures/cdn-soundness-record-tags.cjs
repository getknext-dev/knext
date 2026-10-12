/**
 * Test-only preload for the CDN soundness test: stands in for the cache handler's
 * write side (owned by another team this sprint) by recording an own-entry
 * `_N_T_` tag for every request, so the allowlist's tag condition is satisfied
 * and the REMAINING conditions (middleware match, path canonicality) are what the
 * test measures. It must be loaded BEFORE cache-control-normalize.cjs, so its
 * emit wrapper runs inside the request store that preload opens.
 */
'use strict';
const http = require('node:http');
const SEAM = Symbol.for('knext.core.cdn.requestTags');
const original = http.Server.prototype.emit;
http.Server.prototype.emit = function recordTagsEmit(event) {
  if (event === 'request') {
    const seam = globalThis[SEAM];
    if (seam) seam.record({ kind: 'page', tags: ['_N_T_/soundness'] });
  }
  return original.apply(this, arguments);
};
