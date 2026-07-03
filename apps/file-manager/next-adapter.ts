/**
 * apps/file-manager adapter — re-export of the package-shipped knext NextAdapter.
 *
 * The adapter implementation moved into @knext/core (#89) so the official Next.js
 * compatibility harness can point arbitrary fixture apps at it via NEXT_ADAPTER_PATH.
 * This file is now a thin re-export — no behavior change. next.config.ts still wires
 * it through the top-level `adapterPath` config (graduated out of `experimental` at
 * next 16.2).
 *
 * The `NextAdapter` type reference below keeps the official-adapter contract visible
 * at the app boundary (and satisfies the adapter-migration regression test). It is a
 * type-only import and is intentionally NOT assigned onto the re-exported value: the
 * package and app can resolve distinct (peer-deduped) `next` type instances, and a
 * direct assignment would compare those nominally-incompatible RenderingMode enums.
 */

import adapter from '@knext/core/adapter';
import type { NextAdapter as _NextAdapter } from 'next';

// Compile-time assertion that the package adapter conforms to the official shape,
// without forcing a cross-instance assignment on the exported value.
export type KnextAdapter = _NextAdapter;

export default adapter;
