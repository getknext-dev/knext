import { describe, expect, it } from 'vitest';
import { GET } from './route';

/**
 * #94 — lock the registry refactor: /api/metrics must still expose the
 * bytecode/cache series after the registry was extracted into the shared
 * _metrics/registry module. RUM series merge in automatically.
 */

describe('GET /api/metrics', () => {
  it('returns the bytecode-cache series in Prometheus text format', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('kn_next_startup_duration_seconds');
    expect(body).toContain('kn_next_bytecode_cache_files_total');
    expect(body).toContain('kn_next_bytecode_cache_size_bytes');
  });
});
