import { getTableConfig, PgDialect, pgTable, serial, text, vector } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  CREATE_VECTOR_EXTENSION,
  cosineDistance,
  createVectorExtension,
  hnsw,
  innerProduct,
  ivfflat,
  l2Distance,
} from '../extensions/pgvector';
import * as schema from '../schema';

// pgvector helpers (#241) sit on the same `@knext/db/schema` seam. The `vector`
// column is drizzle's own (already re-exported); the knext value-add is the index
// DDL emitters (hnsw / ivfflat with the right ops class) — which drizzle does not
// model as standalone SQL — plus the distance-operator query builders (<-> / <=> /
// <#>). pgvector 0.8.0 ships in the compute image; the app self-enables it with
// `CREATE EXTENSION vector` over its own DATABASE_URL, and it survives scale-to-zero
// (scale-zero-pg connecting.md).

const docs = pgTable('docs', {
  id: serial('id').primaryKey(),
  body: text('body').notNull(),
  embedding: vector('embedding', { dimensions: 1536 }),
});

const dialect = new PgDialect();
const toSql = (v: unknown) => dialect.sqlToQuery(v as never).sql;

describe('@knext/db pgvector — CREATE EXTENSION guidance', () => {
  it('emits the self-service, idempotent enable statement', () => {
    expect(createVectorExtension()).toBe('CREATE EXTENSION IF NOT EXISTS vector;');
    expect(CREATE_VECTOR_EXTENSION).toBe('CREATE EXTENSION IF NOT EXISTS vector;');
  });
});

describe('@knext/db pgvector — hnsw() index DDL', () => {
  it('defaults to cosine ops and emits an idempotent CREATE INDEX', () => {
    expect(hnsw('emb_idx', docs.embedding)).toBe(
      'CREATE INDEX IF NOT EXISTS "emb_idx" ON "docs" USING hnsw ("embedding" vector_cosine_ops);',
    );
  });

  it('threads the ops class and WITH build params (m, ef_construction)', () => {
    expect(
      hnsw('emb_idx', docs.embedding, { ops: 'vector_l2_ops', m: 16, efConstruction: 64 }),
    ).toBe(
      'CREATE INDEX IF NOT EXISTS "emb_idx" ON "docs" USING hnsw ("embedding" vector_l2_ops) ' +
        'WITH (m = 16, ef_construction = 64);',
    );
  });

  it('supports CONCURRENTLY and dropping IF NOT EXISTS', () => {
    expect(hnsw('emb_idx', docs.embedding, { concurrently: true, ifNotExists: false })).toBe(
      'CREATE INDEX CONCURRENTLY "emb_idx" ON "docs" USING hnsw ("embedding" vector_cosine_ops);',
    );
  });
});

describe('@knext/db pgvector — ivfflat() index DDL', () => {
  it('emits the ivfflat access method with the lists build param', () => {
    expect(ivfflat('emb_ivf', docs.embedding, { ops: 'vector_l2_ops', lists: 100 })).toBe(
      'CREATE INDEX IF NOT EXISTS "emb_ivf" ON "docs" USING ivfflat ("embedding" vector_l2_ops) ' +
        'WITH (lists = 100);',
    );
  });
});

describe('@knext/db pgvector — distance-operator query builders', () => {
  it('cosineDistance builds the <=> operator', () => {
    expect(toSql(cosineDistance(docs.embedding, [1, 2, 3]))).toContain('<=>');
  });
  it('l2Distance builds the <-> operator', () => {
    expect(toSql(l2Distance(docs.embedding, [1, 2, 3]))).toContain('<->');
  });
  it('innerProduct builds the <#> operator', () => {
    expect(toSql(innerProduct(docs.embedding, [1, 2, 3]))).toContain('<#>');
  });
});

describe('@knext/db pgvector — quote hardening (#278)', () => {
  // The index name / table / column are SQL identifiers → double-quoted with any
  // embedded `"` doubled, so a hostile name cannot break out of the identifier.
  const weird = pgTable('we"ird', {
    id: serial('id').primaryKey(),
    'em"b': vector('em"b', { dimensions: 3 }),
  });

  it('escapes a double-quote in the index name (hnsw)', () => {
    expect(hnsw('id"x', docs.embedding)).toBe(
      'CREATE INDEX IF NOT EXISTS "id""x" ON "docs" USING hnsw ("embedding" vector_cosine_ops);',
    );
  });

  it('escapes a double-quote in the table + column identifiers (hnsw)', () => {
    expect(hnsw('emb_idx', weird['em"b'])).toBe(
      'CREATE INDEX IF NOT EXISTS "emb_idx" ON "we""ird" USING hnsw ("em""b" vector_cosine_ops);',
    );
  });

  it('escapes a double-quote in the index name (ivfflat)', () => {
    expect(ivfflat('id"x', docs.embedding, { lists: 100 })).toBe(
      'CREATE INDEX IF NOT EXISTS "id""x" ON "docs" USING ivfflat ("embedding" vector_cosine_ops) ' +
        'WITH (lists = 100);',
    );
  });

  it('leaves well-formed inputs byte-for-byte unchanged', () => {
    expect(hnsw('emb_idx', docs.embedding)).toBe(
      'CREATE INDEX IF NOT EXISTS "emb_idx" ON "docs" USING hnsw ("embedding" vector_cosine_ops);',
    );
  });
});

describe('@knext/db/schema — re-exports the pgvector helpers on the seam', () => {
  it('exposes hnsw / ivfflat / createVectorExtension + distance ops', () => {
    for (const name of [
      'hnsw',
      'ivfflat',
      'createVectorExtension',
      'cosineDistance',
      'l2Distance',
      'innerProduct',
    ]) {
      expect(typeof (schema as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('the re-exported vector column still builds a real drizzle column', () => {
    const cfg = getTableConfig(docs);
    const emb = cfg.columns.find((c) => c.name === 'embedding');
    expect(emb?.getSQLType()).toBe('vector(1536)');
  });
});
