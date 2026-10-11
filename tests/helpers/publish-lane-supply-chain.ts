import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parse } from 'yaml';
import { splitSourceIntoStatements } from './shell-statements';

/**
 * Engine for `tests/publish-lane-supply-chain.test.ts` (#2044, v2 task R8).
 *
 * Question asked of a directory of workflows: does EVERY job that can publish to
 * npm transitively `needs` (a) the npm-audit gate and (b) the SBOM job?
 *
 * ## Discovery is INVERTED: over-match, then allowlist (round 2)
 *
 * Round 1 recognised publish lanes by enumerating COMMAND FORMS (`npm publish`,
 * `changeset publish`, a 4-token window, a known set of wrappers...), and the
 * review built a bypass for every form it did not list: `for d in ..; do npm
 * publish; done`, `npm -w a -w b publish`, `npx @changesets/cli publish`,
 * `xargs npm publish`, `JS-DevTools/npm-publish`, a continuation-split `|| true`.
 * That is the enumerate-the-forms trap this repo has written down three times.
 *
 * So discovery now asks the opposite question. A job is a lane CANDIDATE if ANY
 * of these holds, and every candidate is a lane that must pass the gates unless
 * it is NAMED in a small reviewed `nonLanes` allowlist (keyed by workflow + job,
 * with a one-line reason; an entry matching no candidate is itself a failure):
 *
 *   1. the word `publish` (also `PUBLISH_CMD`-style variable names and
 *      `publish.sh`-style script names) appears in a `run` statement, after
 *      joining line continuations and dropping comments and PROSE heredocs. A
 *      heredoc is prose only when its command is `cat`/`tee`/`echo`/`printf` at
 *      statement position AND it goes to stdout, `$GITHUB_STEP_SUMMARY`, or a pipe
 *      into an issue-body command; one written to a file (`cat > r.sh <<EOF`),
 *      fed to a shell, chained, unterminated, or sharing a line with another
 *      heredoc is executable content and is scanned. `<<WORD` inside a quoted
 *      string or `$((…))` is not a heredoc at all;
 *   2. it appears in a `uses:` name, a `with:` value, or an `env:` value (so a
 *      third-party publish action, `nick-fields/retry` with `command: npm
 *      publish`, and `env: CMD: npm publish` are all candidates);
 *   3. a `changesets/action` step carries a `publish`/`publish-script` input;
 *   4. a `<pm> run <script>` whose root `package.json` script body has the word;
 *   5. a local composite action (`uses: ./...`) contains any of the above, or
 *      cannot be read;
 *   6. the job holds the npm credential (`NODE_AUTH_TOKEN`, `secrets.NPM_TOKEN`,
 *      an `npm-publish*` or expression `environment`) — in the job OR in the
 *      workflow-level `env:`, which GitHub merges into every job (a workflow-level
 *      `env:` value that says `publish` is likewise inherited by every job). This
 *      is the sturdy rule:
 *      whatever a credentialed job runs — `$CMD`, `eval`, `bash x.sh`,
 *      `${{ inputs.cmd }}` — it is a candidate, so a form nobody listed cannot
 *      slip past it;
 *   7. the job has `id-token: write` (its own `permissions:`, else the
 *      workflow's; `write-all` counts) and runs npm, pnpm, yarn, npx, changeset or
 *      lerna anywhere in a `run` statement — OIDC trusted publishing
 *      (`npm publish --provenance` with no token) holds no credential to key on.
 *
 * ## The allowlist is keyed on the PROPERTY that excused a job
 *
 * An entry names a job, but a reviewer excuses it for a property ("opens an
 * issue", "holds no credential"). An allowlisted job that NOW holds the npm
 * credential (job or workflow level), uses a publish action or a
 * changesets/action publish input, or runs a statement with `publish` as an
 * argument (an `echo`/`printf` mention or an assignment is not one) is a
 * PROBLEM regardless of the entry.
 *
 * Nothing names a workflow file or a job id except the allowlist, and the
 * allowlist can only REMOVE a job from the lane set, visibly, in review.
 *
 * ## The gates are found by what they run, not by job id
 *
 *   - THE AUDIT GATE — a job whose step runs `scripts/audit-published.mjs`
 *     (`npm audit --omit=dev` over the packed production closure) as a bare,
 *     own-line, argument-free statement: after joining continuations it must not
 *     be preceded by anything on its line (a subshell, `a ||`, `!`), followed by
 *     `||`, `;`, `&` or a comment-less remainder, or carry ANY argument
 *     (`--help` included; the script takes none). Neutralisers are a RULE, not a
 *     list of spellings: ANY `exit`/`return` statement in the step, ANY
 *     `set +<flags containing e>` or `set +o errexit`, a later `true`/`:`, a
 *     step `if`, any `continue-on-error`, or an EFFECTIVE shell (step `shell:`,
 *     else the job's, else the workflow's `defaults.run.shell`) that does not
 *     keep errexit (`bash {0}`, `pwsh`, `python`…).
 *   - THE SBOM JOB — a job running that same script and uploading a
 *     `*.cdx.json` artifact with an upload step that is itself reliable (no
 *     `continue-on-error`, no non-trivial `if`). The script is the single source of truth for both
 *     the audit and the CycloneDX SBOM, so today one job is both; the guard
 *     requires the lane to reach at least one of each, not two distinct jobs.
 *
 * ## Fail closed
 *
 * A workflow or composite action that cannot be read, cannot be parsed, or
 * parses to something with no `jobs` mapping is a PROBLEM, never "no lanes
 * found". So is a `needs` entry naming a missing job, a missing workflow
 * directory, and a stale or reason-less allowlist entry.
 *
 * ## The `needs` graph
 *
 * An edge `J needs K` is only a gate when J cannot start after K FAILED. A job
 * whose `if` carries `always()`, `failure()` or `cancelled()` does exactly that,
 * so its outgoing edges are dropped from the closure (the lane's own `if`, or an
 * intermediate job's).
 *
 * ## Known blind spots (stated, not dressed up)
 *
 *   - ENV-INDIRECTED and SCRIPT-HIDDEN commands: `run: $CMD`, `eval "$X"`,
 *     `${{ inputs.cmd }}`, `bash ./deploy.sh` that shells to `npm publish`. In an
 *     UNcredentialed job whose text never says `publish` they are invisible.
 *     Over-matching catches most of them anyway (a variable or script NAMED
 *     `*publish*`, an `env:` value that says it), and the credential rule (6)
 *     catches every one in a job that can authenticate to npm — but a
 *     publish done with a token that is not named `NODE_AUTH_TOKEN` /
 *     `NPM_TOKEN` and a command that never says `publish` is not seen.
 *   - OIDC trusted publishing is caught only through rule 7 (a job with
 *     `id-token: write` that runs an npm-family tool). It is not seen where the
 *     publish goes through a tool outside that set, or through a reusable workflow.
 *   - Shell quote-splitting (`npm pub""lish`, `npm "pub"lish`, `p=pub; npm ${p}lish`)
 *     defeats the word rule; it is caught only by the credential and `id-token`
 *     rules.
 *   - A token not named `NODE_AUTH_TOKEN` / `NPM_TOKEN` (e.g.
 *     `secrets.NPM_AUTOMATION_TOKEN`) is not recognised as the credential.
 *   - Hyphenated names (`publish-all`, `publish-packages`) are NOT matched by the
 *     word rule (they would also match `publish-lane-guard` / `publish-preflight`
 *     on every job here); they are caught by the credential rule or the alias
 *     rule only.
 *   - Reusable workflows are not followed (`jobs.<id>.uses` is scanned for the
 *     word only); a called workflow's own lane is found in its own file.
 *   - `<pm> run` aliases are resolved against the ROOT `package.json` only.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const SBOM_PATH = /\.cdx\.json\b/;
const STATUS_BYPASS = /\b(always|failure|cancelled)\s*\(\s*\)/;

/**
 * The word `publish` as a shell word. Not preceded by a letter/digit, not
 * followed by a letter/digit/hyphen: matches `npm publish`, `--publish`,
 * `npm-publish`, `$PUBLISH_CMD`, `inputs.publish_cmd`, `publish.sh`; does NOT
 * match `published`, `publishes`, `publish-lane-guard.mjs`, `publish-preflight`.
 */
const PUBLISH_WORD = /(?<![A-Za-z0-9])publish(?![A-Za-z0-9-])/i;

/** The only argv the audit script takes. It takes none; `--help` must not count. */
const AUDIT_ALLOWED_ARGS: readonly string[] = [];

type Job = Record<string, unknown>;
type Step = Record<string, unknown>;

export interface PublishLane {
  file: string;
  jobId: string;
  /** What made this job a lane candidate, for the failure message. */
  why: string;
}

/** A reviewed "this candidate is not a publish lane" entry. */
export interface NonLane {
  file: string;
  job: string;
  reason: string;
}

export interface PublishLaneAudit {
  problems: string[];
  workflowsSeen: number;
  lanes: PublishLane[];
  /** Candidates excused by the allowlist, `file#jobId`. */
  excused: string[];
  /** `file#jobId` of every non-neutralisable job that runs the audit script. */
  auditJobs: string[];
  /** `file#jobId` of every job that runs the audit script and uploads a CycloneDX SBOM. */
  sbomJobs: string[];
}

export interface AuditOptions {
  workflowDir: string;
  /** Root package.json whose `scripts` resolve `<pm> run <script>`. Default: the repo root's. */
  packageJsonPath?: string;
  /** Repo root, to resolve local composite actions (`uses: ./...`). Default: two levels above `workflowDir`. */
  repoRoot?: string;
  /** The reviewed allowlist of candidates that are not publish lanes. */
  nonLanes?: readonly NonLane[];
}

// ── shell-statement classification ─────────────────────────────────────────

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words that run the NEXT command, with optional flags in between. */
const WRAPPERS = new Set([
  'sudo',
  'env',
  'time',
  'exec',
  'command',
  'nohup',
  'npx',
  'bunx',
  'pnpx',
  'corepack',
]);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const RUNNERS = new Set(['node', 'nodejs', 'bun', 'deno', 'tsx', 'ts-node']);

/** Line continuations joined first, so `a \⏎ || true` is one line to every check. */
const joinContinuations = (source: string): string => source.replace(/\\\r?\n[ \t]*/g, ' ');

function tokenize(statement: string): string[] {
  // A word is any run of unquoted chars and quoted strings (`body="a b c"` is ONE word).
  const raw = statement.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return raw.map((t) => t.replace(/^(["'])(.*)\1$/s, '$2'));
}

/** Drops leading `VAR=val` assignments and wrapper words (+ their flags). */
function commandTokens(tokens: string[]): string[] {
  let i = 0;
  for (;;) {
    while (i < tokens.length && ASSIGNMENT.test(tokens[i])) i++;
    if (i < tokens.length && WRAPPERS.has(tokens[i])) {
      i++;
      while (i < tokens.length && tokens[i].startsWith('-')) i++;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

/** Sinks a heredoc may feed and still be PROSE: stdout-ish, never a file or a shell. */
const PROSE_REDIRECT_TARGETS = new Set([
  '$GITHUB_STEP_SUMMARY',
  '"$GITHUB_STEP_SUMMARY"',
  '${GITHUB_STEP_SUMMARY}',
  '"${GITHUB_STEP_SUMMARY}"',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/null',
  '&1',
  '&2',
]);
/** Commands a heredoc may be PIPED to and still be prose (an issue body, a filter). */
const PROSE_PIPE_SINKS = new Set(['gh', 'cat', 'grep', 'sed', 'jq', 'head', 'tail', 'wc', 'sort']);

interface HeredocOp {
  /** The command text before `<<` in its own statement. */
  segment: string;
  /** Everything after the delimiter word, to the end of the line. */
  after: string;
  delim: string;
}

/**
 * Unquoted `<<WORD` operators on ONE line, with the statement they belong to.
 * `<<` inside '…', "…", `$((…))` or after a comment `#` is not a heredoc (round 2
 * treated `echo "v $((1<<SHIFT))"` as one and swallowed the rest of the script),
 * and `<<<` is a here-string.
 */
function heredocOps(line: string): HeredocOp[] {
  const ops: HeredocOp[] = [];
  let quote: '"' | "'" | null = null;
  let arith = 0;
  let segStart = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (arith > 0) {
      if (c === '(') arith++;
      else if (c === ')') arith--;
      continue;
    }
    if (c === '\\') {
      i++;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '$' && line.startsWith('$((', i)) {
      arith = 2;
      i += 2;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      break;
    } else if (c === ';' || c === '|' || c === '&' || c === '(' || c === '{') {
      segStart = i + 1;
    } else if (c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
      const m = /^<<-?\s*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z_][A-Za-z0-9_]*))/.exec(line.slice(i));
      if (!m) continue;
      ops.push({
        segment: line.slice(segStart, i),
        after: line.slice(i + m[0].length),
        delim: m[1] ?? m[2] ?? m[3],
      });
      i += m[0].length - 1;
    }
  }
  return ops;
}

/** Is this heredoc provably PROSE (stdout, the step summary, an issue body)? Unsure → false. */
function isProseHeredoc(op: HeredocOp): boolean {
  const seg = commandTokens(tokenize(op.segment));
  const head = seg[0];
  if (head === undefined || !['cat', 'echo', 'printf', 'tee'].includes(head)) return false;
  // Redirections anywhere on the line: only stdout-ish targets.
  const line = `${op.segment} ${op.after}`;
  for (const m of line.matchAll(/(?:^|\s)(?:\d*|&)>>?\s*(\S+)/g)) {
    if (!PROSE_REDIRECT_TARGETS.has(m[1])) return false;
  }
  // `tee FILE` writes a file; only the step summary is prose.
  if (head === 'tee') {
    const targets = seg.slice(1).filter((t) => !t.startsWith('-'));
    if (targets.some((t) => !PROSE_REDIRECT_TARGETS.has(t))) return false;
  }
  // Anything chained after the heredoc on this line (`; bash x`, `&& node y`) is unknown.
  const bare = op.after.replace(/"[^"]*"|'[^']*'/g, '');
  if (/;|&&|\|\|/.test(bare)) return false;
  // Pipes: every downstream command must be a known text sink.
  const pipes = bare.split(/\|(?!\|)/).slice(1);
  for (const p of pipes) {
    const tokens = commandTokens(tokenize(p.trim()));
    if (tokens[0] === undefined || !PROSE_PIPE_SINKS.has(tokens[0])) {
      if (tokens[0] === 'tee') {
        const t = tokens.slice(1).filter((x) => !x.startsWith('-'));
        if (t.every((x) => PROSE_REDIRECT_TARGETS.has(x))) continue;
      }
      return false;
    }
  }
  return true;
}

/**
 * Removes the BODY of a heredoc that is provably prose — `cat`/`echo`/`printf`/
 * `tee` writing to stdout, the step summary, or piped to an issue-body command.
 * Everything else is executable content and is KEPT for scanning: a heredoc
 * written to a file (`cat > r.sh <<EOF`, `tee r.sh <<EOF`), fed to a shell or
 * interpreter, chained into another command, unterminated, or sharing its line
 * with a second heredoc. Unsure means kept (fail closed).
 */
function stripProseHeredocs(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const ops = heredocOps(lines[i]);
    if (ops.length !== 1 || !isProseHeredoc(ops[0])) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== ops[0].delim) j++;
    if (j >= lines.length) continue; // unterminated: keep the body
    i = j; // the terminator line is dropped with the body
  }
  return out.join('\n');
}
/** The evidence that `source` (a `run` body) can publish, or null. */
function runEvidence(source: string, scripts: Record<string, string>, depth = 0): string | null {
  if (depth > 5) return null;
  const prepared = stripProseHeredocs(joinContinuations(source));
  for (const { text } of splitSourceIntoStatements(prepared)) {
    const word = PUBLISH_WORD.exec(text);
    if (word) return `run statement \`${text.trim().slice(0, 80)}\``;
    const cmd = commandTokens(tokenize(text));
    const head = cmd[0];
    if (head === undefined || !PACKAGE_MANAGERS.has(head)) continue;
    // `<pm> run <script>` / `pnpm <script>` / `yarn <script>` → the package.json script body
    const rest = cmd.slice(1);
    const run = rest.findIndex((t) => t === 'run' || t === 'run-script');
    const candidates =
      run !== -1
        ? rest.slice(run + 1).filter((t) => !t.startsWith('-'))
        : head === 'pnpm' || head === 'yarn'
          ? rest.filter((t) => !t.startsWith('-')).slice(0, 1)
          : [];
    for (const name of candidates) {
      const body = scripts[name];
      if (typeof body !== 'string') continue;
      const inner = runEvidence(body, scripts, depth + 1);
      if (inner) return `\`${head} run ${name}\` → ${inner}`;
    }
  }
  return null;
}

// ── audit-script recognition ───────────────────────────────────────────────

/** `scripts/audit-published.mjs` pinned to that path (optionally `./`-prefixed). */
const AUDIT_PATH = /^(\.\/)?scripts\/audit-published\.mjs$/;

/** Does `source` run the pinned audit script as a program argument (not prose)? */
function runsAuditScript(source: string): boolean {
  for (const { text } of splitSourceIntoStatements(stripProseHeredocs(joinContinuations(source)))) {
    const cmd = commandTokens(tokenize(text));
    if (cmd[0] === undefined || !RUNNERS.has(cmd[0])) continue;
    if (cmd.slice(1).some((t) => AUDIT_PATH.test(t))) return true;
  }
  return false;
}

/** Strictly: `[VAR=x ...] <runner> [node flags] scripts/audit-published.mjs [allowed args] [# comment]`. */
function isBareAuditLine(line: string): boolean {
  const code = line.replace(/\s+#.*$/, '').trim();
  const tokens = tokenize(code);
  if (tokens.some((t) => /[|;&()`{}<>]/.test(t) || t === '!' || t.includes('$('))) return false;
  const cmd = commandTokens(tokens);
  if (
    cmd.length === 0 ||
    tokens.slice(0, tokens.length - cmd.length).some((t) => !ASSIGNMENT.test(t))
  ) {
    return false;
  }
  if (!RUNNERS.has(cmd[0])) return false;
  const at = cmd.findIndex((t) => AUDIT_PATH.test(t));
  if (at === -1) return false;
  if (cmd.slice(1, at).some((t) => !t.startsWith('-'))) return false; // something before the script
  const args = cmd.slice(at + 1);
  return args.every((a) => AUDIT_ALLOWED_ARGS.includes(a));
}

/** Why the run body's audit invocation can NOT be relied on to fail the step (null = it can). */
function auditInvocationProblem(run: string): string | null {
  const joined = stripProseHeredocs(joinContinuations(run));
  const lines = joined.split('\n');
  const mentioning = lines.filter((l) => /audit-published\.mjs/.test(l));
  const bare = mentioning.filter((l) => !l.trim().startsWith('#') && isBareAuditLine(l));
  if (bare.length === 0) {
    return 'invocation is not a bare own-line `node scripts/audit-published.mjs` (a prefix, `||`, `;`, `&`, subshell, or any argument such as --help)';
  }
  // A RULE, not a list of spellings (`exit 0`, `exit "0"`, `exit 00`, `exit $((0))`,
  // `set +eu`, `set +o errexit` all slipped past the round-2 regexes):
  //  - ANY `exit`/`return` statement in the step, before or after the audit, can end
  //    the step with a status the audit did not decide;
  //  - ANY `set +<flags containing e>` or `set +o errexit` turns errexit off;
  //  - after the audit, a bare `true` / `:` is a no-op that only exists to mask it.
  const statementHeads = (src: string) =>
    splitSourceIntoStatements(src).map((s) => {
      const tokens = tokenize(s.text.trim());
      return { tokens, head: commandTokens(tokens)[0] };
    });
  for (const { tokens, head } of statementHeads(joined)) {
    if (head === 'exit' || head === 'return') {
      return 'the step contains an `exit`/`return`, which can end it with a status the audit did not decide';
    }
    if (head === 'set') {
      const rest = tokens.slice(tokens.indexOf('set') + 1);
      const offFlags = rest.some((t) => /^\+[A-Za-z]*e/.test(t));
      const offOption = rest.some((t, i) => t === '+o' && rest[i + 1] === 'errexit');
      if (offFlags || offOption) return 'the step turns errexit off (`set +e…` / `set +o errexit`)';
    }
  }
  const first = lines.findIndex((l) => bare.includes(l));
  for (const { head } of statementHeads(lines.slice(first + 1).join('\n'))) {
    if (head === 'true' || head === ':') return 'a later `true` / `:` masks the exit status';
  }
  return null;
}

// ── workflow reading ───────────────────────────────────────────────────────

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function needsOf(job: Job): string[] {
  const n = job.needs;
  if (typeof n === 'string') return [n];
  if (Array.isArray(n)) return n.map(String);
  return [];
}

function stepsOf(job: Job): Step[] {
  return Array.isArray(job.steps) ? (job.steps.map(asRecord).filter(Boolean) as Step[]) : [];
}

const runOf = (step: Step): string => (typeof step.run === 'string' ? step.run : '');

/** `continue-on-error` is neutralising unless it is the literal `false`. */
function softensFailure(node: Record<string, unknown>): boolean {
  return 'continue-on-error' in node && node['continue-on-error'] !== false;
}

/** Every string VALUE (not key) in a parsed node. */
function stringValues(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const v of node) stringValues(v, out);
  else if (node && typeof node === 'object')
    for (const v of Object.values(node)) stringValues(v, out);
  return out;
}

/** Every string key AND value, for the credential scan. */
function allStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const v of node) allStrings(v, out);
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      out.push(k);
      allStrings(v, out);
    }
  }
  return out;
}

function environmentName(job: Job): string {
  const env = job.environment;
  if (typeof env === 'string') return env;
  if (env && typeof env === 'object' && 'name' in env) return String(env.name);
  return '';
}

/** Can this job authenticate to npm? Comment-free (parsed), dot/bracket access, any case. */
function holdsNpmCredential(job: Job, wf: WorkflowCtx): boolean {
  // A workflow-level `env:` reaches every job, so it counts as the job's own.
  const text = allStrings([job, wf.env]).join('\n');
  const env = environmentName(job);
  return (
    text.includes('NODE_AUTH_TOKEN') ||
    /secrets\s*\.\s*NPM_TOKEN/i.test(text) ||
    /secrets\s*\[\s*['"]NPM_TOKEN['"]\s*\]/i.test(text) ||
    /^npm-publish/.test(env) ||
    env.includes('${{')
  );
}

/**
 * Does this `shell:` keep errexit? A bare `bash` expands to `bash -e{o pipefail} {0}`;
 * a custom template like `bash {0}` does NOT, and a failing audit would no longer
 * stop the step.
 */
const keepsErrexit = (shell: string): boolean =>
  /^(ba)?sh$/.test(shell.trim()) || /^(ba)?sh\b.*\s-[A-Za-z]*e/.test(shell.trim());

/** Workflow-level keys that GitHub merges into every job. */
interface WorkflowCtx {
  env: unknown;
  /** `defaults.run.shell` */
  shell: string | undefined;
  permissions: unknown;
}

const defaultShellOf = (node: Record<string, unknown>): string | undefined => {
  const shell = asRecord(asRecord(node.defaults)?.run)?.shell;
  return typeof shell === 'string' ? shell : undefined;
};

/** `id-token: write` (or `write-all`) in the permissions that apply to the job. */
function grantsIdToken(job: Job, wf: WorkflowCtx): boolean {
  const perms = 'permissions' in job ? job.permissions : wf.permissions;
  if (perms === 'write-all') return true;
  return asRecord(perms)?.['id-token'] === 'write';
}

const NPM_FAMILY = new Set([
  'npm',
  'pnpm',
  'yarn',
  'npx',
  'pnpx',
  'changeset',
  'changesets',
  'lerna',
]);

/** Does any `run` statement in the steps name an npm-family tool (anywhere in the command)? */
function runsNpmFamily(steps: Step[]): boolean {
  for (const step of steps) {
    const run = runOf(step);
    if (!run) continue;
    for (const { text } of splitSourceIntoStatements(stripProseHeredocs(joinContinuations(run)))) {
      if (tokenize(text).some((t) => NPM_FAMILY.has(t.split('/').pop() ?? t))) return true;
    }
  }
  return false;
}

/**
 * Why an ALLOWLISTED job must not stay excused (null = the excuse still holds).
 * The allowlist is keyed on identity, but a reviewer excuses a job for a
 * PROPERTY ("opens an issue", "holds no credential"); if that property stops
 * holding, the entry must not keep the job green.
 */
function excusalProblem(job: Job, steps: Step[], wf: WorkflowCtx, ctx: Ctx): string | null {
  if (holdsNpmCredential(job, wf)) return 'now holds the npm credential';
  for (const step of steps) {
    const uses = typeof step.uses === 'string' ? step.uses : '';
    if (PUBLISH_WORD.test(uses)) return `now uses the publish action \`${uses}\``;
    const withs = asRecord(step.with) ?? {};
    if (/^changesets\/action(@|$)/.test(uses) && (withs['publish-script'] || withs.publish)) {
      return 'now runs changesets/action with a publish input';
    }
    const run = runOf(step);
    if (run && runsRealPublish(run, ctx.scripts)) return 'now runs a real publish command';
  }
  return null;
}

/** A statement that RUNS `publish` as an argument (not prose inside a quoted string or an assignment). */
function runsRealPublish(source: string, scripts: Record<string, string>, depth = 0): boolean {
  if (depth > 5) return false;
  for (const { text } of splitSourceIntoStatements(stripProseHeredocs(joinContinuations(source)))) {
    const cmd = commandTokens(tokenize(text));
    const head = cmd[0];
    if (head === undefined || head === 'echo' || head === 'printf') continue;
    if (cmd.slice(1).some((t) => t === 'publish')) return true;
    if (PACKAGE_MANAGERS.has(head)) {
      const rest = cmd.slice(1);
      const run = rest.findIndex((t) => t === 'run' || t === 'run-script');
      const names =
        run !== -1
          ? rest.slice(run + 1)
          : head === 'pnpm' || head === 'yarn'
            ? rest.filter((t) => !t.startsWith('-')).slice(0, 1)
            : [];
      for (const name of names) {
        const body = scripts[name];
        if (typeof body === 'string' && runsRealPublish(body, scripts, depth + 1)) return true;
      }
    }
  }
  return false;
}

interface JobFacts {
  /** Why this job is a lane candidate, or null. */
  candidate: string | null;
  runsAudit: boolean;
  /** Reason the audit can't gate, when it runs but is neutralised. */
  neutralised: string | null;
  uploadsSbom: boolean;
  /** Why an allowlist entry for this job can no longer excuse it (null = it still can). */
  excusal: string | null;
}

interface Ctx {
  wf: WorkflowCtx;
  scripts: Record<string, string>;
  repoRoot: string;
  problems: string[];
  where: string;
}

/** Candidate evidence in a step list (a job's, or a composite action's). */
function stepsEvidence(steps: Step[], ctx: Ctx, depth: number): string | null {
  for (const step of steps) {
    const run = runOf(step);
    if (run) {
      const e = runEvidence(run, ctx.scripts);
      if (e) return e;
    }
    for (const v of stringValues(step.env)) {
      if (PUBLISH_WORD.test(v)) return `env value \`${v.trim().slice(0, 60)}\``;
    }
    const uses = typeof step.uses === 'string' ? step.uses : '';
    const withs = asRecord(step.with) ?? {};
    const changesets = /^changesets\/action(@|$)/.test(uses);
    if (changesets) {
      for (const key of ['publish-script', 'publish']) {
        const v = withs[key];
        if (v !== undefined && v !== null && v !== '' && v !== false) {
          return `changesets/action \`${key}\` input`;
        }
      }
    }
    if (PUBLISH_WORD.test(uses)) return `action \`${uses}\``;
    for (const [key, v] of Object.entries(withs)) {
      if (changesets && (key === 'publish' || key === 'publish-script')) continue;
      const hit = stringValues(v).find((s) => PUBLISH_WORD.test(s));
      if (hit) return `\`with.${key}\` value \`${hit.trim().slice(0, 60)}\``;
    }
    if (uses.startsWith('./') && depth < 3) {
      const e = compositeEvidence(uses, ctx, depth + 1);
      if (e) return `composite \`${uses}\` → ${e}`;
    }
  }
  return null;
}

function compositeEvidence(uses: string, ctx: Ctx, depth: number): string | null {
  const dir = resolve(ctx.repoRoot, uses);
  const file = ['action.yml', 'action.yaml'].map((n) => resolve(dir, n)).find((p) => existsSync(p));
  if (!file) {
    ctx.problems.push(
      `${ctx.where}: local action \`${uses}\` has no action.yml/action.yaml to scan`,
    );
    return `unreadable local action \`${uses}\``;
  }
  try {
    const doc = asRecord(parse(readFileSync(file, 'utf8')));
    const steps = asRecord(doc?.runs)?.steps;
    if (!Array.isArray(steps)) return null; // a node/docker action: nothing to scan here
    return stepsEvidence(steps.map(asRecord).filter(Boolean) as Step[], ctx, depth);
  } catch (err) {
    ctx.problems.push(
      `${ctx.where}: local action \`${uses}\` cannot be parsed (${String(err).split('\n')[0]})`,
    );
    return `unparseable local action \`${uses}\``;
  }
}

function analyseJob(job: Job, ctx: Ctx): JobFacts {
  let runsAudit = false;
  let neutralised: string | null = null;
  let uploadsSbom = false;
  const jobSoftened = softensFailure(job);
  const steps = stepsOf(job);

  for (const step of steps) {
    const run = runOf(step);
    const effectiveShell =
      typeof step.shell === 'string' ? step.shell : (defaultShellOf(job) ?? ctx.wf.shell);
    if (run && runsAuditScript(run)) {
      runsAudit = true;
      neutralised ??= jobSoftened
        ? 'job has continue-on-error'
        : softensFailure(step)
          ? 'step has continue-on-error'
          : 'if' in step && !isTriviallyTrue(step.if)
            ? `step has a conditional \`if: ${step.if}\``
            : effectiveShell !== undefined && !keepsErrexit(effectiveShell)
              ? `the effective shell \`${effectiveShell}\` (step, job or workflow default) does not keep errexit`
              : auditInvocationProblem(run);
    }
    const uses = typeof step.uses === 'string' ? step.uses : '';
    const withs = asRecord(step.with) ?? {};
    if (
      /^actions\/upload-artifact(@|$)/.test(uses) &&
      SBOM_PATH.test(String(withs.path ?? '')) &&
      !softensFailure(step) &&
      !('if' in step && !isTriviallyTrue(step.if))
    ) {
      uploadsSbom = true;
    }
  }

  let candidate = stepsEvidence(steps, ctx, 0);
  if (candidate === null && typeof job.uses === 'string' && PUBLISH_WORD.test(job.uses)) {
    candidate = `reusable workflow \`${job.uses}\``;
  }
  if (candidate === null) {
    // The workflow-level env reaches every job in the file.
    const hit = [
      ...stringValues(job.env),
      ...stringValues(job.with),
      ...stringValues(ctx.wf.env),
    ].find((s) => PUBLISH_WORD.test(s));
    if (hit) candidate = `job or workflow env/with value \`${hit.trim().slice(0, 60)}\``;
  }
  if (candidate === null && holdsNpmCredential(job, ctx.wf)) {
    candidate =
      'the job holds the npm credential (NODE_AUTH_TOKEN / NPM_TOKEN / npm-publish environment, job or workflow level)';
  }
  if (candidate === null && grantsIdToken(job, ctx.wf) && runsNpmFamily(steps)) {
    candidate =
      'the job has `id-token: write` and runs npm/pnpm/yarn/changeset (OIDC trusted publishing needs no token)';
  }
  const excusal = excusalProblem(job, steps, ctx.wf, ctx);
  return { candidate, runsAudit, neutralised, uploadsSbom, excusal };
}

/** An `if:` that is provably the default (`true` / `success()`), so it cannot skip a step. */
const isTriviallyTrue = (cond: unknown): boolean =>
  /^(true|success\(\))$/.test(String(cond).replace(/[\s${}]/g, ''));

/** Transitive `needs` closure; edges out of a status-bypassing job are dropped. */
function closure(
  jobs: Record<string, Job>,
  start: string,
  problems: string[],
  where: string,
): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    const job = jobs[id];
    if (!job) continue;
    if (STATUS_BYPASS.test(String(job.if ?? ''))) continue; // starts after a FAILED need
    for (const dep of needsOf(job)) {
      if (!(dep in jobs)) {
        problems.push(
          `${where}: job \`${id}\` needs \`${dep}\`, which is not a job in this workflow`,
        );
        continue;
      }
      if (!seen.has(dep)) {
        seen.add(dep);
        stack.push(dep);
      }
    }
  }
  return seen;
}

function readScripts(packageJsonPath: string, problems: string[]): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: unknown };
    const scripts = asRecord(pkg.scripts) ?? {};
    return Object.fromEntries(
      Object.entries(scripts).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  } catch (err) {
    problems.push(`cannot read ${packageJsonPath} to resolve \`<pm> run\` aliases: ${String(err)}`);
    return {};
  }
}

export function auditPublishLanes(options: AuditOptions): PublishLaneAudit {
  const problems: string[] = [];
  const lanes: PublishLane[] = [];
  const excused: string[] = [];
  const auditJobs: string[] = [];
  const sbomJobs: string[] = [];
  const nonLanes = options.nonLanes ?? [];
  const scripts = readScripts(
    options.packageJsonPath ?? resolve(REPO_ROOT, 'package.json'),
    problems,
  );
  const repoRoot = options.repoRoot ?? resolve(options.workflowDir, '..', '..');

  for (const e of nonLanes) {
    if (!e.file || !e.job || !e.reason || e.reason.trim().length < 8) {
      problems.push(`allowlist entry ${JSON.stringify(e)} needs a file, a job and a real reason`);
    }
  }

  let names: string[] = [];
  try {
    names = readdirSync(options.workflowDir)
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
      .sort();
  } catch (err) {
    problems.push(`cannot list workflow directory ${options.workflowDir}: ${String(err)}`);
  }

  // Pass 1: read everything. A file we cannot see could hold an ungated lane.
  const parsed: Array<{ file: string; jobs: Record<string, Job>; wf: WorkflowCtx }> = [];
  for (const file of names) {
    let doc: unknown;
    try {
      doc = parse(readFileSync(resolve(options.workflowDir, file), 'utf8'));
    } catch (err) {
      problems.push(`${file}: cannot be read/parsed (${String(err).split('\n')[0]})`);
      continue;
    }
    const jobs = asRecord(asRecord(doc)?.jobs);
    if (jobs === null || Object.keys(jobs).length === 0) {
      problems.push(
        `${file}: parsed but has no \`jobs\` mapping — refusing to read it as "no lanes"`,
      );
      continue;
    }
    const clean: Record<string, Job> = {};
    for (const [id, job] of Object.entries(jobs)) clean[id] = asRecord(job) ?? {};
    const top = asRecord(doc) ?? {};
    parsed.push({
      file: basename(file),
      jobs: clean,
      wf: { env: top.env, shell: defaultShellOf(top), permissions: top.permissions },
    });
  }

  // Pass 2: per workflow, find gates and candidates, then walk each lane's `needs`.
  const usedAllowlist = new Set<NonLane>();
  for (const { file, jobs, wf } of parsed) {
    const facts = new Map<string, JobFacts>();
    for (const [id, job] of Object.entries(jobs)) {
      facts.set(id, analyseJob(job, { wf, scripts, repoRoot, problems, where: `${file}#${id}` }));
    }

    const audits = new Set<string>();
    const sboms = new Set<string>();
    const neutralisedAudits: string[] = [];
    for (const [id, f] of facts) {
      if (!f.runsAudit) continue;
      if (f.neutralised) {
        neutralisedAudits.push(`\`${id}\` (${f.neutralised})`);
        continue;
      }
      audits.add(id);
      auditJobs.push(`${file}#${id}`);
      if (f.uploadsSbom) {
        sboms.add(id);
        sbomJobs.push(`${file}#${id}`);
      }
    }

    for (const [id, f] of facts) {
      if (f.candidate === null) continue;
      const allowed = nonLanes.find((e) => e.file === file && e.job === id);
      if (allowed) {
        usedAllowlist.add(allowed);
        if (f.excusal) {
          problems.push(
            `allowlisted ${file}#${id} ${f.excusal}, so the allowlist reason ("${allowed.reason}") no longer holds and cannot excuse it — gate it behind the audit + SBOM jobs or take it off the allowlist`,
          );
        } else {
          excused.push(`${file}#${id}`);
          continue;
        }
        lanes.push({ file, jobId: id, why: `allowlisted but ${f.excusal}` });
        continue;
      }
      lanes.push({ file, jobId: id, why: f.candidate });
      const reach = closure(jobs, id, problems, `${file}#${id}`);
      const label = `${file}#${id} is a publish-lane candidate (${f.candidate})`;
      const hint = neutralisedAudits.length
        ? ` Neutralised audit job(s) here do not count: ${neutralisedAudits.join(', ')}.`
        : '';
      const fix = ' If it is not a lane, name it in the reviewed non-lane allowlist with a reason.';
      if (![...reach].some((j) => audits.has(j))) {
        problems.push(
          `${label} but does not transitively \`needs\` an npm-audit gate (a job running scripts/audit-published.mjs that cannot be skipped or softened).${hint}${fix}`,
        );
      }
      if (![...reach].some((j) => sboms.has(j))) {
        problems.push(
          `${label} but does not transitively \`needs\` an SBOM job (a job running scripts/audit-published.mjs and uploading a *.cdx.json artifact).${hint}${fix}`,
        );
      }
    }
  }

  for (const e of nonLanes) {
    if (!usedAllowlist.has(e)) {
      problems.push(
        `stale allowlist entry ${e.file}#${e.job}: it matches no lane candidate (job removed, or no longer a candidate) — delete it`,
      );
    }
  }

  return { problems, workflowsSeen: names.length, lanes, excused, auditJobs, sbomJobs };
}
