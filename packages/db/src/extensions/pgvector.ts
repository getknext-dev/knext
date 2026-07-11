/**
 * `@knext/db` pgvector helpers (#241) — index DDL emitters + distance-operator query
 * builders on the `@knext/db/schema` extension seam (ADR-0021 §2).
 *
 * The `vector(n)` column is drizzle's own and is already re-exported from
 * `@knext/db/schema`. drizzle does **not** model the `hnsw`/`ivfflat` access methods
 * as standalone SQL, so {@link hnsw}/{@link ivfflat} emit the exact `CREATE INDEX`
 * DDL an app runs in its migration (with the right ops class + build params). The
 * distance operators (`<->` / `<=>` / `<#>`) are drizzle's typed `sql` builders,
 * re-exported here so an app finds the whole pgvector vocabulary in one place.
 *
 * ## Self-enable + scale-to-zero (the platform contract)
 *
 * pgvector 0.8.0 ships in the scale-zero-pg compute image, marked `trusted`. Your
 * app **enables it itself**, once, over its own `DATABASE_URL` (no operator, no
 * superuser) — {@link createVectorExtension}, see scale-zero-pg `docs/connecting.md`.
 * Vectors and their indexes live on the pageserver, so they **survive scale-to-zero**.
 * Build the index while the compute is awake (index builds run on your own per-app
 * compute); it persists across sleeps like any other table.
 */

import { getTableName } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

// The distance operators are drizzle's own typed builders: `cosineDistance` → `<=>`,
// `l2Distance` → `<->`, `innerProduct` → `<#>`. Re-exported so the pgvector
// vocabulary (column + index + operators) is importable from `@knext/db/schema`.
export { cosineDistance, innerProduct, l2Distance } from 'drizzle-orm';

/**
 * A pgvector operator class. The distance you query with must match the class you
 * index with (cosine ⇄ `vector_cosine_ops`, L2 `<->` ⇄ `vector_l2_ops`, inner
 * product `<#>` ⇄ `vector_ip_ops`). The union lists the common pgvector 0.8.0
 * classes; any other string (e.g. `halfvec_*`) is still accepted.
 */
export type VectorOpClass =
  | 'vector_cosine_ops'
  | 'vector_l2_ops'
  | 'vector_ip_ops'
  | 'vector_l1_ops'
  // Keep autocomplete for the common classes while accepting any other opclass string.
  | (string & {});

/** The idempotent, self-service statement that enables pgvector for an app DB. */
export const CREATE_VECTOR_EXTENSION = 'CREATE EXTENSION IF NOT EXISTS vector;';

/**
 * Return the `CREATE EXTENSION IF NOT EXISTS vector;` your app runs **once**, over
 * its own `DATABASE_URL`, before creating a `vector` column or index (scale-zero-pg
 * `docs/connecting.md`).
 */
export function createVectorExtension(): string {
  return CREATE_VECTOR_EXTENSION;
}

// A drizzle column carries its own name and its parent table; read both so the
// index helpers take just the column (`docs.embedding`), like drizzle's own index().
function ref(column: PgColumn): { table: string; column: string } {
  return { table: getTableName(column.table), column: column.name };
}

function createIndexPrefix(name: string, concurrently: boolean, ifNotExists: boolean): string {
  const parts = ['CREATE INDEX'];
  if (concurrently) {
    parts.push('CONCURRENTLY');
  }
  // CONCURRENTLY and IF NOT EXISTS may combine; keep the natural SQL order.
  if (ifNotExists) {
    parts.push('IF NOT EXISTS');
  }
  parts.push(`"${name}"`);
  return parts.join(' ');
}

function withClause(params: Array<[string, number | undefined]>): string {
  const set = params.filter(([, v]) => v !== undefined).map(([k, v]) => `${k} = ${v}`);
  return set.length ? ` WITH (${set.join(', ')})` : '';
}

/** Options for {@link hnsw}. */
export interface HnswIndexOptions {
  /** Operator class. Defaults to `vector_cosine_ops` (pair with `cosineDistance`). */
  ops?: VectorOpClass;
  /** HNSW `m` — max connections per layer (build param). */
  m?: number;
  /** HNSW `ef_construction` — candidate list size at build (build param). */
  efConstruction?: number;
  /** Emit `IF NOT EXISTS` so re-running the migration is a no-op. Default `true`. */
  ifNotExists?: boolean;
  /** Emit `CONCURRENTLY` to build without an exclusive lock. Default `false`. */
  concurrently?: boolean;
}

/**
 * Emit a `CREATE INDEX ... USING hnsw` for a `vector` column. HNSW gives fast,
 * high-recall approximate nearest-neighbour search.
 *
 * ```ts
 * import { hnsw } from '@knext/db/schema';
 * // → CREATE INDEX IF NOT EXISTS "emb_idx" ON "docs"
 * //     USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);
 * hnsw('emb_idx', docs.embedding, { m: 16, efConstruction: 64 });
 * ```
 */
export function hnsw(name: string, column: PgColumn, options: HnswIndexOptions = {}): string {
  const {
    ops = 'vector_cosine_ops',
    m,
    efConstruction,
    ifNotExists = true,
    concurrently = false,
  } = options;
  const { table, column: col } = ref(column);
  const prefix = createIndexPrefix(name, concurrently, ifNotExists);
  const withSql = withClause([
    ['m', m],
    ['ef_construction', efConstruction],
  ]);
  return `${prefix} ON "${table}" USING hnsw ("${col}" ${ops})${withSql};`;
}

/** Options for {@link ivfflat}. */
export interface IvfflatIndexOptions {
  /** Operator class. Defaults to `vector_cosine_ops` (pair with `cosineDistance`). */
  ops?: VectorOpClass;
  /** IVFFlat `lists` — number of inverted lists (build param; tune to row count). */
  lists?: number;
  /** Emit `IF NOT EXISTS` so re-running the migration is a no-op. Default `true`. */
  ifNotExists?: boolean;
  /** Emit `CONCURRENTLY` to build without an exclusive lock. Default `false`. */
  concurrently?: boolean;
}

/**
 * Emit a `CREATE INDEX ... USING ivfflat` for a `vector` column. IVFFlat builds
 * faster and uses less memory than HNSW but wants representative data present before
 * the build (tune `lists` to row count).
 *
 * ```ts
 * // → CREATE INDEX IF NOT EXISTS "emb_ivf" ON "docs"
 * //     USING ivfflat ("embedding" vector_l2_ops) WITH (lists = 100);
 * ivfflat('emb_ivf', docs.embedding, { ops: 'vector_l2_ops', lists: 100 });
 * ```
 */
export function ivfflat(name: string, column: PgColumn, options: IvfflatIndexOptions = {}): string {
  const { ops = 'vector_cosine_ops', lists, ifNotExists = true, concurrently = false } = options;
  const { table, column: col } = ref(column);
  const prefix = createIndexPrefix(name, concurrently, ifNotExists);
  const withSql = withClause([['lists', lists]]);
  return `${prefix} ON "${table}" USING ivfflat ("${col}" ${ops})${withSql};`;
}
