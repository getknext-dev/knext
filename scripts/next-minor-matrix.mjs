#!/usr/bin/env bun
/**
 * Prints the Next-minor CI matrix as JSON (`{"include":[{"next","minor"}]}`),
 * derived from `NEXT_MATRIX_VERSIONS` in packages/kn-next/src/next-compat.ts -
 * the single source. Run under bun (it imports the TS module directly); the
 * workflow's `plan` job does `bun scripts/next-minor-matrix.mjs`.
 */
import { NEXT_MATRIX_VERSIONS } from '../packages/kn-next/src/next-compat.ts';

export function buildMatrix(versions = NEXT_MATRIX_VERSIONS) {
  return {
    include: versions.map((next) => ({
      next,
      minor: next.split('.').slice(0, 2).join('.'),
    })),
  };
}

if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(buildMatrix())}\n`);
}
