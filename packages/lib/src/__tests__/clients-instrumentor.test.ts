import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #317 — the pool-instrumentor seam. `@knext/lib/clients` stays OTel-free (a
// dependency-inversion seam, mirroring `setTraceIdProvider` in ./context): an
// OTel-aware layer installs an instrumentor that is invoked ONCE per pool as it
// is created, with the pool + its role ('writer' | 'reader'). The tracing
// adapter uses it to wrap the pool's first `connect()` in a `knext.db_wake`
// span. When no instrumentor is installed (the default), pool creation is
// unchanged and pays nothing.

// Minimal fake Pool: records nothing, just constructible.
class FakePool {
  constructor(public config: unknown) {}
  end() {
    return Promise.resolve();
  }
}
vi.mock('pg', () => ({ Pool: FakePool }));

describe('@knext/lib/clients — pool instrumentor seam (#317)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    delete process.env.DATABASE_URL_RO;
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_URL_RO;
  });

  it('does NOT call an instrumentor when none is installed (default no-op)', async () => {
    const mod = await import('../clients');
    // No instrumentor installed — creating the pool must just work.
    const pool = mod.getDbPool();
    expect(pool).toBeInstanceOf(FakePool);
  });

  it('invokes the installed instrumentor once with the writer pool + role', async () => {
    const mod = await import('../clients');
    const seen: Array<{ pool: unknown; role: string }> = [];
    mod.setPoolInstrumentor((pool, role) => seen.push({ pool, role }));

    const pool = mod.getDbPool();
    const again = mod.getDbPool(); // singleton — no second instrumentation

    expect(seen).toHaveLength(1);
    expect(seen[0].pool).toBe(pool);
    expect(seen[0].role).toBe('writer');
    expect(again).toBe(pool);
  });

  it('invokes the instrumentor with the reader pool + role when DATABASE_URL_RO is set', async () => {
    process.env.DATABASE_URL_RO = 'postgres://u:p@localhost:55434/db';
    const mod = await import('../clients');
    const roles: string[] = [];
    mod.setPoolInstrumentor((_pool, role) => roles.push(role));

    mod.getDbPool();
    mod.getDbPoolRO();

    expect(roles).toContain('writer');
    expect(roles).toContain('reader');
  });

  it('a throwing instrumentor never breaks pool creation (fail-open)', async () => {
    const mod = await import('../clients');
    mod.setPoolInstrumentor(() => {
      throw new Error('instrumentor blew up');
    });
    // The pool must still be returned — instrumentation is best-effort.
    expect(() => mod.getDbPool()).not.toThrow();
    expect(mod.getDbPool()).toBeInstanceOf(FakePool);
  });

  it('resetPoolInstrumentor restores the default no-op', async () => {
    const mod = await import('../clients');
    const fn = vi.fn();
    mod.setPoolInstrumentor(fn);
    mod.resetPoolInstrumentor();
    mod.getDbPool();
    expect(fn).not.toHaveBeenCalled();
  });
});
