/**
 * knext-docs adapter — thin re-export of the package-shipped knext NextAdapter.
 *
 * Mirrors apps/file-manager/next-adapter.ts in the knext monorepo. The adapter
 * implementation lives in @knext/core (`@knext/core/adapter`) so the official
 * Next.js compatibility harness can point fixture apps at it via NEXT_ADAPTER_PATH.
 * This file is a thin re-export — no behavior change. next.config.ts wires it
 * through experimental.adapterPath.
 *
 * The `NextAdapter` type below keeps the official-adapter contract visible at the
 * app boundary. It is a type-only import and is intentionally NOT assigned onto the
 * re-exported value (the package and app may resolve distinct, peer-deduped `next`
 * type instances).
 */

import adapter from '@knext/core/adapter';
import type { NextAdapter as _NextAdapter } from 'next';

export type KnextAdapter = _NextAdapter;

export default adapter;
