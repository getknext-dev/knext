/**
 * The `bun:test` equivalent of vitest's `environment: 'happy-dom'` +
 * `vitest.setup.ts` (#871).
 *
 * vitest gives every test file a DOM by configuration. `bun:test` has no
 * equivalent switch — a test that touches `document` gets
 * `ReferenceError: document is not defined` — so the DOM is registered here and
 * this file is passed to `bun test --preload`.
 *
 * ## Why a preload rather than an import in each test
 *
 * `@testing-library/react` reads `document` at module scope. An import inside a
 * test file runs AFTER that module has been hoisted and evaluated, so the DOM
 * would not exist yet at the moment it is needed. A preload runs before any
 * test module is loaded, which is the only ordering that works.
 *
 * ## Why cleanup is not optional
 *
 * Without it, every `render()` leaves its tree in `document.body` and the next
 * file's `getByRole` can match a component from a previous test. That failure
 * mode is worse than a crash: it produces passes, and it produces them
 * dependent on file order.
 */

import { afterEach } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';

GlobalRegistrator.register();

// Imported AFTER registration on purpose: testing-library reads `document` when
// its module is evaluated, so importing it above would capture an undefined
// global and every render would fail with the error this file exists to remove.
const { cleanup } = await import('@testing-library/react');

afterEach(() => {
  cleanup();
});
