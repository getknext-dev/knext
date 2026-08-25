import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * Shared readers for `.github/workflows/release.yml`.
 *
 * Two guards need the same view of that file and they must not disagree about
 * it: `release-action-pins.test.ts` (which job holds the publish credential) and
 * `release-lane-liveness.test.ts` (which job can park on an approval). Round one
 * of this change had each of them re-deriving job boundaries with its own
 * regex, and the two regexes did not agree on where a job ended.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
export const WORKFLOW_DIR = resolve(REPO_ROOT, '.github/workflows');
export const RELEASE_YML = 'release.yml';

export function workflowText(file: string = RELEASE_YML): string {
  return readFileSync(resolve(WORKFLOW_DIR, file), 'utf8');
}

export function workflowDoc(file: string = RELEASE_YML): Record<string, unknown> {
  return parse(workflowText(file)) as Record<string, unknown>;
}

export function jobs(file: string = RELEASE_YML): Record<string, Record<string, unknown>> {
  const doc = workflowDoc(file);
  const found = doc.jobs;
  if (!found || typeof found !== 'object') return {};
  return found as Record<string, Record<string, unknown>>;
}

/**
 * The RAW TEXT of each top-level job, keyed by job id.
 *
 * Text rather than the parsed node because the credential check asks about
 * `${{ secrets.NPM_TOKEN }}` — an expression string that survives parsing but
 * reads far more clearly as source, and whose exact form is the thing being
 * asserted.
 *
 * A job block runs from its `  <id>:` key to the next key at the same
 * two-space indent, or EOF.
 */
export function jobBlocks(file: string = RELEASE_YML): Map<string, string> {
  const text = workflowText(file);
  const ids = Object.keys(jobs(file));
  const starts: Array<{ id: string; index: number }> = [];
  for (const id of ids) {
    const index = text.indexOf(`\n  ${id}:`);
    if (index === -1)
      throw new Error(`job \`${id}\` parsed but its \`  ${id}:\` key was not found`);
    starts.push({ id, index });
  }
  starts.sort((a, b) => a.index - b.index);

  const blocks = new Map<string, string>();
  for (const [i, start] of starts.entries()) {
    const end = starts[i + 1]?.index ?? text.length;
    blocks.set(start.id, text.slice(start.index, end));
  }
  return blocks;
}

/**
 * A job's PARSED node, serialised — the comment-free view of what it does.
 *
 * MEASURED, not anticipated: the first version of the credential guard scanned
 * `jobBlocks()` text for `NODE_AUTH_TOKEN` and reddened on the comment that says
 * "NO `NODE_AUTH_TOKEN`". Same false positive `ci.yml` already paid for, where
 * the sentence explaining the cosign rule classified the file as a signing
 * workflow. Round-tripping through the YAML parser drops comments by
 * construction, which is stronger than any strip-the-`#` heuristic.
 */
export function jobJson(jobId: string, file: string = RELEASE_YML): string {
  const job = jobs(file)[jobId];
  return job === undefined ? '' : JSON.stringify(job);
}

/** A job's `needs:` as a flat list, whether scalar or sequence. */
export function jobNeeds(jobId: string, file: string = RELEASE_YML): string[] {
  const need = jobs(file)[jobId]?.needs;
  if (typeof need === 'string') return [need];
  if (Array.isArray(need)) return need.map(String);
  return [];
}

/** A job's `concurrency:` in its object form, or `undefined`. */
export function jobConcurrency(
  jobId: string,
  file: string = RELEASE_YML,
): { group?: unknown; 'cancel-in-progress'?: unknown } | string | undefined {
  return jobs(file)[jobId]?.concurrency as
    | { group?: unknown; 'cancel-in-progress'?: unknown }
    | string
    | undefined;
}
