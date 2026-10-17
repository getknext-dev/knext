/**
 * ADR-0052 D3 (amended): the deploy path never shells `func deploy` or
 * `kn service`. The `BackendService` CR is the only deployment path and the
 * operator the only reconciler; the CLI may apply that CR and nothing else.
 *
 * This is a SCANNING guard, not an enumeration: it reads every source file under
 * `packages/kn-next/src/cli/` and `packages/grpc/` (tests, fixtures, templates,
 * generated output and build output excluded) and reds on any spawn of `func`
 * deploying or of `kn`. A spawn it cannot read - a program or an argv built at
 * run time, a `child_process` import it cannot follow, a shell tagged template -
 * FAILS rather than passes, unless it is on a short, justified allowlist whose
 * every entry must still match a real call site (a stale entry fails too).
 *
 * `kn` is refused outright, not only `kn service`: the whole Knative client
 * writes cluster state (revisions, routes, services), and the CLI has no use
 * for it. `func build` (image only) is not a cluster write and is not refused.
 *
 * Each rule has a RED fixture (the bypass) and a GREEN fixture (the shape the
 * real tree uses). `scripts/mutation-prove-2053-cli-cluster-write-surface.mjs`
 * proves the guard goes red when the code it protects is broken.
 */

import { describe, expect, it } from 'bun:test';
import {
  DYNAMIC_SPAWN_ALLOWLIST,
  scanSpawnSource,
  scanSpawnTree,
  spawnScopeFiles,
} from '../scripts/lib/cli-spawn-scan.mjs';

type Allow = { file: string; callee: string; arg: string; count?: number; reason?: string };
const scan = (src: string, allow: Allow[] = []) =>
  scanSpawnSource(src, { file: 'packages/kn-next/src/cli/fixture.ts', allow });
const rules = (src: string, allow: Allow[] = []) => scan(src, allow).violations.map((v) => v.rule);

describe('the D3 spawn scan: RED fixtures', () => {
  it.each([
    ['a run* wrapper with func deploy', 'runInherit(["func", "deploy"]);'],
    [
      'func deploy with flags before the subcommand',
      'runInherit(["func", "--verbose", "deploy", "--registry", r]);',
    ],
    ['execFileSync func deploy', 'execFileSync("func", ["deploy"]);'],
    ['spawnSync kn service', 'spawnSync("kn", ["service", "create", "x"]);'],
    ['any kn invocation, not only kn service', 'runCapture(["kn", "revision", "list"]);'],
    ['any kn invocation in a shell string', 'execSync("kn revision list");'],
    ['sh -c wrapping any kn', 'runInherit(["sh", "-c", "kn revision list"]);'],
    ['execSync of a func deploy shell string', 'execSync("func deploy --image x");'],
    ['exec of a kn service shell string', 'exec("kn service create x", cb);'],
    ['a chained shell string', 'execSync("make build && func deploy");'],
    ['sh -c wrapping kn service', 'runInherit(["sh", "-c", "kn service apply -f x"]);'],
    ['env wrapping func deploy', 'runInherit(["env", "FOO=1", "func", "deploy"]);'],
    ['func with a spread tail (cannot prove it is not deploy)', 'runInherit(["func", ...rest]);'],
    ['func with a computed subcommand', 'runInherit(["func", sub]);'],
    ['a computed program next to deploy', 'runInherit([prog, "deploy"]);'],
    ['a template literal program', 'runInherit([`func`, "deploy"]);'],
    ['Bun.spawn func deploy', 'Bun.spawn(["func", "deploy"]);'],
    ['an argv handed to a seam that is not a known spawn', 'host.run(["func", "deploy"], ctx);'],
    ['an argv returned from a function', 'function f() {\n  return ["func", "deploy"];\n}'],
    ['an argv bound to a variable', 'const cmd = ["kn", "service", "create", name];'],
    [
      'an argv inside a wrapper bound to a variable',
      'const cmd = ["env", "X=1", "func", "deploy"];',
    ],
    [
      'an aliased child_process import',
      'import { spawnSync as s } from "node:child_process";\ns("func", ["deploy"]);',
    ],
    [
      'an absolute-path kn bound to a constant, handed to a seam',
      "const KN = '/usr/local/bin/kn';\nhost.run([KN, 'service', 'apply']);",
    ],
    ['execa with an absolute-path kn', "execa('/usr/local/bin/kn', ['service']);"],
    ['execa with an absolute-path func deploy', "execa('/opt/func', ['deploy']);"],
    ['a member call handed an absolute-path kn argv', "x.run(['/usr/local/bin/kn', 'service']);"],
    ['an optional-chained member spawn of func deploy', "host?.run(['/opt/func', 'deploy']);"],
    [
      'a let-bound absolute-path kn handed to a seam',
      "let KN = '/usr/local/bin/kn';\nhost.run([KN, 'service', 'apply']);",
    ],
    [
      'createRequire(...) of child_process, then kn',
      "const req = createRequire(import.meta.url)('node:child_process');\nreq.execFileSync('kn', ['service']);",
    ],
    ['a kn.exe argv', "runInherit(['kn.exe', 'service']);"],
    [
      'a backtick dynamic import with an aliased callee',
      'const { spawnSync: s } = await import(`node:child_process`);\ns("func", ["deploy"]);',
    ],
  ])('reds %s', (_label, src) => {
    expect(scan(src).violations.length).toBeGreaterThan(0);
  });

  it.each([
    ['a computed argv', 'runInherit(argv);'],
    ['a computed argv from a call', 'runInherit(build(x));'],
    ['a computed program', 'execFileSync(program, args);'],
    ['a template literal with a hole as a shell string', 'execSync(`${tool} deploy`);'],
    ['a shell tagged template', 'const r = $`echo ${name}`;'],
    [
      'a namespace child_process import',
      'import * as cp from "node:child_process";\ncp.execSync(x);',
    ],
    ['a default child_process import', 'import cp from "node:child_process";\ncp.execSync(x);'],
    ['a require of child_process', 'const cp = require("node:child_process");\ncp.execSync(x);'],
    ['a dynamic import of child_process', 'const cp = await import("node:child_process");'],
    [
      'a backtick dynamic import of child_process',
      'const cp = await import(`node:child_process`);',
    ],
    [
      'createRequire(...) of child_process',
      "const cp = createRequire(import.meta.url)('node:child_process');",
    ],
    [
      'createRequire(...) of child_process, backtick',
      'const cp = createRequire(import.meta.url)(`child_process`);',
    ],
    [
      'a reassigned let program handed to a seam',
      "let P = '/bin/ls';\nP = pick();\nhost.run([P, 'x']);",
    ],
    ['a backtick require of child_process', 'const cp = require(`node:child_process`);'],
    ['a member call handed an array with a computed program', "host.run([program, 'x']);"],
    [
      'a member call handed an array with a program defined elsewhere',
      "x.spawn([TOOL, 'service']);",
    ],
  ])('fails (does not pass) on an unparseable construct: %s', (_label, src) => {
    const v = scan(src).violations;
    expect(v.length).toBeGreaterThan(0);
    expect(v.every((x) => x.rule === 'unparseable-spawn' || x.rule === 'unparseable-import')).toBe(
      true,
    );
  });

  it('reads a let-bound program as the string it is, and a reassigned one as unreadable', () => {
    const bound = "let KN = '/usr/local/bin/kn';\nhost.run([KN, 'service', 'apply']);";
    expect(rules(bound)).toContain('forbidden-spawn');
    const moved = "let KN = '/usr/local/bin/kn';\nKN = pick();\nhost.run([KN, 'service']);";
    expect(rules(moved)).toEqual(['unparseable-spawn']);
  });

  it('reads kn behind a wrapper in an argv array', () => {
    expect(rules("runInherit(['sudo', '-u', 'root', 'kn', 'service']);")).toContain(
      'forbidden-spawn',
    );
  });

  it('reads a program kept in a constant as the string it is (forbidden, not merely unreadable)', () => {
    const src = "const KN = '/usr/local/bin/kn';\nhost.run([KN, 'service', 'apply']);";
    expect(rules(src)).toContain('forbidden-spawn');
  });

  it('reds the literal text "func deploy" / "kn service" even when it is not passed straight to a spawn', () => {
    expect(rules('const cmd = "func deploy";\nrun(cmd);')).toContain('forbidden-literal');
    expect(rules("const cmd = 'kn service create';")).toContain('forbidden-literal');
  });

  it('reds the program name "kn" as a bare string anywhere', () => {
    expect(rules('const bin = "kn";')).toContain('forbidden-literal');
  });

  it('names the file and the line of every violation', () => {
    const [v] = scan('const a = 1;\n\nrunInherit(["func", "deploy"]);\n').violations;
    expect(v?.file).toBe('packages/kn-next/src/cli/fixture.ts');
    expect(v?.line).toBe(3);
  });

  it('survives formatting: multi-line argv, comments between elements, trailing commas', () => {
    const src = `runInherit([
      "func", // the knative functions CLI
      /* never */ "deploy",
    ]);`;
    expect(rules(src)).toContain('forbidden-spawn');
  });
});

describe('the D3 spawn scan: GREEN fixtures', () => {
  it.each([
    [
      'a kubectl apply',
      'runInherit(["kubectl", "apply", "--validate=strict", "-f", p, "-n", ns]);',
    ],
    [
      'a kubectl argv wrapped by withKubeContext',
      'exec(withKubeContext(["kubectl", "get", "nextapp"], ctx));',
    ],
    ['docker', 'execFileSync("docker", ["build", "-t", tag, "."], { shell: false });'],
    [
      'func build (image only, no cluster write)',
      'runInherit(["func", "build", "--registry", r]);',
    ],
    [
      'a comment naming func deploy',
      '// the CLI never runs func deploy or kn service\nrunInherit(["kubectl", "get", "ns"]);',
    ],
    [
      'a block comment naming func deploy',
      '/* func deploy is prohibited; kn service too */\nconst x = 1;',
    ],
    [
      'an unrelated string that merely contains the letters',
      'const s = "funcs deployed; kn-next service";',
    ],
    [
      'a named child_process import',
      'import { spawnSync } from "node:child_process";\nspawnSync("kubectl", args);',
    ],
    ['a method that is not a spawn', 'registry.exec(x); table.spawn(y);'],
    ['an index access on a name that is not an argv', 'const x = table[key]; const y = names[0];'],
    ['a member call with a literal harmless program', 'deps.run(["docker", "build", "-t", tag]);'],
    ['a member call that is not given an array', 'opts.run(argv); re.exec(text);'],
    ['an argv to a seam that is not func or kn', 'host.run(["kubectl", "apply", "-f", p], ctx);'],
  ])('passes %s', (_label, src) => {
    expect(scan(src).violations).toEqual([]);
  });

  it('an allowlisted computed spawn passes, and only that exact call site', () => {
    const allow = [
      {
        file: 'packages/kn-next/src/cli/fixture.ts',
        callee: 'runInherit',
        arg: 'argv',
        reason: 'the exec helper itself: every caller is scanned at its own call site',
      },
    ];
    expect(scan('runInherit(argv);', allow).violations).toEqual([]);
    // Another computed argv in the same file is not covered by that entry.
    expect(rules('runInherit(argv);\nrunInherit(other);', allow)).toEqual(['unparseable-spawn']);
    // Same text in another file is not covered either.
    expect(
      scanSpawnSource('runInherit(argv);', { file: 'packages/grpc/src/x.ts', allow }).violations
        .length,
    ).toBe(1);
  });

  it('an allowlist entry that matches no call site is reported stale', () => {
    const allow = [
      {
        file: 'packages/kn-next/src/cli/fixture.ts',
        callee: 'runInherit',
        arg: 'gone',
        reason: 'x',
      },
    ];
    expect(scan('runInherit(["kubectl", "get", "ns"]);', allow).unusedAllow).toHaveLength(1);
  });

  it('an allowlisted computed spawn still reds a forbidden literal in the same file', () => {
    const allow = [
      {
        file: 'packages/kn-next/src/cli/fixture.ts',
        callee: 'runInherit',
        arg: 'argv',
        reason: 'x',
      },
    ];
    expect(rules('runInherit(argv);\nconst c = "func deploy";', allow)).toEqual([
      'forbidden-literal',
    ]);
  });
});

describe('the D3 spawn scan: the real tree', () => {
  const files = spawnScopeFiles();
  const result = scanSpawnTree();

  it('covers both packages and is not vacuous', () => {
    const cli = files.filter((f) => f.startsWith('packages/kn-next/src/cli/'));
    const grpc = files.filter((f) => f.startsWith('packages/grpc/'));
    expect(cli.length).toBeGreaterThan(30);
    expect(grpc.length).toBeGreaterThan(10);
    expect(files).toContain('packages/kn-next/src/cli/exec.ts');
    expect(files).toContain('packages/kn-next/src/cli/grpc-dispatch.ts');
    expect(files).toContain('packages/grpc/src/deploy-function.ts');
    expect(files).toContain('packages/grpc/src/buf.ts');
    expect(result.spawnCount).toBeGreaterThan(15);
  });

  it('excludes tests, fixtures and build output from the scope', () => {
    for (const f of files) {
      expect(f, f).not.toMatch(
        /__tests__|\.test\.|\/fixtures\/|\/testdata\/|\/dist\/|\/node_modules\//,
      );
    }
  });

  it('finds no func-deploy / kn spawn, and no spawn it cannot read', () => {
    expect(result.violations).toEqual([]);
  });

  it('no allowlist entry is stale, and each one says why it is safe', () => {
    expect(result.unusedAllow).toEqual([]);
    for (const e of DYNAMIC_SPAWN_ALLOWLIST) {
      expect(e.reason.length, `${e.file} ${e.callee}`).toBeGreaterThan(30);
    }
  });
});
