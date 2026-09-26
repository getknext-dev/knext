import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * #1452 — the patched-Bun base-exe workflow reaches GCP ONLY through Workload
 * Identity Federation (keyless). A static service-account key would be a
 * long-lived credential in the repo's secret store for a job that runs on a
 * schedule; the decision was "no new secrets", so the guard is: no key-shaped
 * input anywhere, and the federated path is present (both halves — a workflow
 * that dropped auth entirely would otherwise pass the negative half).
 */
const WORKFLOW = resolve(import.meta.dirname, '..', '.github/workflows/bun-base-build.yml');
const text = readFileSync(WORKFLOW, 'utf8');
/** Comment lines explain the design and may name the forbidden inputs. */
const code = text
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('#'))
  .join('\n');

describe('bun-base-build.yml authenticates keyless only', () => {
  it.each([
    ['credentials_json', /credentials_json/],
    ['GOOGLE_APPLICATION_CREDENTIALS', /GOOGLE_APPLICATION_CREDENTIALS/],
    ['any repository/environment secret', /secrets\./],
    ['a key file handed to gcloud', /--key-file|activate-service-account/],
  ])('never uses %s', (_name, pattern) => {
    expect(code).not.toMatch(pattern);
  });

  it('uses google-github-actions/auth with workload_identity_provider + service_account from vars', () => {
    expect(code).toMatch(/uses: google-github-actions\/auth@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
    expect(code).toContain('workload_identity_provider: ${{ vars.GCP_WIF_PROVIDER }}');
    expect(code).toContain('service_account: ${{ vars.GCP_BUN_BASE_SA }}');
  });

  it('grants id-token: write (required for federation and cosign keyless)', () => {
    expect(code).toMatch(/id-token: write/);
  });

  it('fails closed before auth when the federation variables are unset', () => {
    const guard = code.indexOf('Require the GCP federation variables');
    const auth = code.indexOf('uses: google-github-actions/auth@');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(auth);
    expect(code).toMatch(
      /if \[ -z "\$WIF_PROVIDER" \] \|\| \[ -z "\$WIF_SA" \]; then[\s\S]*?exit 1/,
    );
  });
});
