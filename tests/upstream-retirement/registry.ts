/**
 * Upstream-retirement registry (#1450): one entry per knext shim that exists
 * only because of an upstream bug or missing feature.
 *
 * Each entry carries a `repro` that runs against the PINNED toolchain and
 * reports whether the upstream problem is still there. retirement.test.ts
 * requires `stillBroken === true` for every entry, so a Bun or vinext bump that
 * fixes the problem goes red with "upstream fixed — delete shim <id>". The rule
 * (plan: "Patch carrier"): a shim is deleted in the SAME PR as the bump that
 * turns its probe red — never kept "just in case".
 *
 * `kind` says what the marker sits on: 'shim' (code to delete) or 'constraint'
 * (a documented limitation + its pinned test; e.g. bun-cjs-dirname-inlined).
 *
 * Each shim's source carries a one-line `// @upstream-shim <id>` marker; the
 * marker scan in retirement.test.ts ties markers and entries in both
 * directions, so a shim cannot exist without a probe, nor a probe without a
 * shim.
 *
 * A repro is an ORACLE, not a smoke test: each one runs a CONTROL that must
 * behave as expected before the verdict counts. A probe whose control fails
 * throws ("probe inconclusive") rather than reporting either way — an
 * environment problem must never read as "upstream fixed", or as "still
 * broken".
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { detectCompileInclude } from '../../packages/kn-next/src/adapters/compile-embed.mjs';
import { bunOnPath, pinnedVinext, REPO_ROOT, sandbox } from './probe-kit';

export type UpstreamRef = `${'oven-sh/bun' | 'cloudflare/vinext' | 'vercel/next.js'}#${number}`;

export type Probe = { stillBroken: boolean; evidence: string };

export type RetirementEntry = {
  /** The id used by the `// @upstream-shim <id>` marker(s). */
  id: string;
  /** The upstream issue or PR whose fix retires the shim. */
  upstream: UpstreamRef;
  /**
   * A fragment of the upstream title, checked against GitHub by
   * retirement.test.ts — an existing-but-wrong number (a typo) must red.
   */
  upstreamTitle: string;
  /** An upstream PR that fixes `upstream`, when one exists (verified by the probe). */
  fixedBy?: { ref: UpstreamRef; title: string };
  /** The knext issue that tracks the retirement. */
  issue: `#${number}`;
  /**
   * `shim` = code that is deleted on the upstream fix; `constraint` = what the
   * marker sits on is a documented limitation plus its pinned test (the
   * upstream fix retires the documented workaround, not a code path).
   */
  kind: 'shim' | 'constraint';
  /** Which single-exec shape ships the shim. */
  shape: 'next' | 'vinext' | 'both';
  /** Which pinned dependency the repro runs against. */
  against: 'bun' | 'vinext';
  repro: () => Promise<Probe>;
};

const inconclusive = (id: string, why: string): never => {
  throw new Error(`probe ${id} inconclusive (control failed): ${why}`);
};

/** `@img/sharp-<platform>` + `@img/sharp-libvips-<platform>` of the installed sharp. */
function sharpNativeDirs(): {
  addon: string;
  libvipsLib: string;
  libvipsFile: string;
  platform: string;
} {
  // A missing optional native dep is an environment problem, not a verdict.
  const resolvePkg = (pkg: string, from: string): string => {
    try {
      return dirname(Bun.resolveSync(`${pkg}/package.json`, from));
    } catch {
      return inconclusive('sharp-addon-dlopen', `${pkg} not installed (resolved from ${from})`);
    }
  };
  const sharpDir = resolvePkg('sharp', join(REPO_ROOT, 'apps/file-manager'));
  const libc =
    process.platform === 'linux' &&
    !(process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined)
      ?.header?.glibcVersionRuntime
      ? 'musl'
      : '';
  const platform = `${process.platform}${libc}-${process.arch}`;
  const addonPkg = resolvePkg(`@img/sharp-${platform}`, sharpDir);
  const libvipsPkg = resolvePkg(`@img/sharp-libvips-${platform}`, addonPkg);
  const addonFile = readdirSync(join(addonPkg, 'lib')).find((f) => f.endsWith('.node'));
  const libvipsFile = readdirSync(join(libvipsPkg, 'lib')).find((f) => /^libvips-cpp\./.test(f));
  if (!addonFile || !libvipsFile) {
    return inconclusive(
      'sharp-addon-dlopen',
      `sharp native payload not found for ${platform} (addon ${addonFile}, libvips ${libvipsFile})`,
    );
  }
  return {
    addon: join(addonPkg, 'lib', addonFile),
    libvipsLib: join(libvipsPkg, 'lib'),
    libvipsFile,
    platform,
  };
}

export const REGISTRY: RetirementEntry[] = [
  {
    id: 'sidecar-cjs-resolve',
    upstream: 'oven-sh/bun#44053',
    upstreamTitle: 'an --external package is resolved from process.cwd()',
    issue: '#1463',
    kind: 'shim',
    shape: 'vinext',
    against: 'bun',
    // A compiled binary resolves a bare `require` of an --external package from
    // the CWD only, never from beside the executable. The sidecar hook in
    // sidecar-runtime.mjs resolves from `<dir of the binary>/.output/server/node_modules`.
    repro: async () => {
      const box = sandbox('44053');
      try {
        box.write({
          'src/main.cjs':
            'try { console.log("RESULT ok " + require("dep")); } catch (e) { console.log("RESULT fail " + (e.code || e.message)); }\n',
          'bin/node_modules/dep/package.json': '{ "name": "dep", "version": "1.0.0" }\n',
          'bin/node_modules/dep/index.js': 'module.exports = "dep-loaded";\n',
          'elsewhere/.keep': '',
        });
        const built = box.compile(
          'src',
          '{ entrypoints: ["./main.cjs"], external: ["dep"], target: "bun", compile: { outfile: "../bin/app" } }',
        );
        if (built.status !== 'built') inconclusive('sidecar-cjs-resolve', built.detail);
        const app = join(box.dir, 'bin/app');
        const control = box.run([app], join(box.dir, 'bin')).result;
        if (control !== 'ok dep-loaded')
          inconclusive('sidecar-cjs-resolve', `cwd=binary dir: ${control}`);
        const probe = box.run([app], join(box.dir, 'elsewhere')).result;
        return {
          stillBroken: probe !== 'ok dep-loaded',
          evidence: `cwd=binary dir → ${control}; cwd=elsewhere (package beside the binary) → ${probe}`,
        };
      } finally {
        box.dispose();
      }
    },
  },
  {
    id: 'sharp-addon-dlopen',
    upstream: 'oven-sh/bun#44063',
    upstreamTitle: 'an embedded native addon is extracted alone',
    issue: '#1463',
    kind: 'shim',
    shape: 'vinext',
    against: 'bun',
    // An embedded `.node` is extracted ALONE to a temp file before dlopen, so
    // its relative rpath to libvips (embedded beside it, layout intact) does not
    // resolve. sharp-addon-dlopen.mjs dlopens a real on-disk @img tree instead.
    repro: async () => {
      const { addon, libvipsLib, libvipsFile, platform } = sharpNativeDirs();
      const box = sandbox('44063');
      try {
        const addonRel = `@img/sharp-${platform}/lib/addon.node`;
        const libRel = `@img/sharp-libvips-${platform}/lib/${libvipsFile}`;
        box.copy(addon, `fx/${addonRel}`);
        box.copy(join(libvipsLib, libvipsFile), `fx/${libRel}`);
        box.write(
          {
            'main.mjs': `import lib from "./${libRel}" with { type: "file" };\nawait import("./load.cjs");\n`,
            'load.cjs':
              `try { const m = require("./${addonRel}"); console.log("RESULT loaded " + Object.keys(m).length); }\n` +
              'catch (e) { console.log("RESULT fail " + String(e.message).split("\\n")[0]); }\n',
            'control.cjs':
              `try { const m = { exports: {} }; process.dlopen(m, require("node:path").join(__dirname, "${addonRel}")); console.log("RESULT loaded " + Object.keys(m.exports).length); }\n` +
              'catch (e) { console.log("RESULT fail " + String(e.message).split("\\n")[0]); }\n',
            'empty/.keep': '',
          },
          'fx',
        );
        const control = box.run([bunOnPath(), 'control.cjs'], join(box.dir, 'fx')).result;
        if (!control.startsWith('loaded'))
          inconclusive('sharp-addon-dlopen', `on-disk dlopen: ${control}`);
        const built = box.compile(
          'fx',
          '{ entrypoints: ["./main.mjs"], root: ".", target: "bun", naming: { entry: "[dir]/[name].[ext]", asset: "[dir]/[name].[ext]" }, compile: { outfile: "../bin/app" } }',
        );
        if (built.status !== 'built') inconclusive('sharp-addon-dlopen', built.detail);
        const probe = box.run([join(box.dir, 'bin/app')], join(box.dir, 'fx/empty')).result;
        if (probe.startsWith('fail') && !/libvips/.test(probe)) {
          inconclusive(
            'sharp-addon-dlopen',
            `embedded load failed for a reason other than libvips: ${probe}`,
          );
        }
        return {
          stillBroken: probe.startsWith('fail'),
          evidence: `on-disk dlopen → ${control}; embedded addon + embedded libvips → ${probe}`,
        };
      } finally {
        box.dispose();
      }
    },
  },
  {
    id: 'bun-serve-keepalive',
    upstream: 'oven-sh/bun#43848',
    upstreamTitle: 'send Keep-Alive: timeout=<idleTimeout> by default',
    issue: '#1463',
    kind: 'shim',
    shape: 'vinext',
    against: 'bun',
    // Bun.serve keeps HTTP/1.1 connections alive but never announces its idle
    // deadline (`Keep-Alive: timeout=…`), so pooling clients can reuse a socket
    // the server is closing. bun-serve-keepalive-guard.mjs stamps
    // `Connection: close` instead.
    repro: async () => {
      const box = sandbox('43848');
      try {
        box.write({
          'src/main.mjs':
            'import { connect } from "node:net";\n' +
            'const head = async (headers) => {\n' +
            '  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok", { headers }) });\n' +
            '  const raw = await new Promise((res, rej) => {\n' +
            '    const s = connect(server.port, "127.0.0.1", () => s.write("GET / HTTP/1.1\\r\\nHost: probe\\r\\n\\r\\n"));\n' +
            '    let b = ""; s.on("data", (d) => { b += d; if (b.includes("\\r\\n\\r\\n")) { s.destroy(); res(b); } }); s.on("error", rej);\n' +
            '  });\n' +
            '  server.stop(true);\n' +
            '  return raw.split("\\r\\n\\r\\n")[0];\n' +
            '};\n' +
            'const verdict = (h) => !/^HTTP\\/1\\.1 200 /.test(h) ? "bad-response" : /^connection:\\s*close/im.test(h) ? "closes" : /^keep-alive:/im.test(h) ? "keep-alive-announced" : "no-keep-alive";\n' +
            // Control: an app-set `Keep-Alive` header reaches the wire and the
            // oracle sees it — so "no-keep-alive" below means Bun sent none.
            'const control = await head({ "keep-alive": "timeout=5" });\n' +
            'const probe = await head({});\n' +
            'console.log("RESULT " + verdict(probe) + " control=" + verdict(control) + " " + JSON.stringify(probe));\n',
        });
        const built = box.compile(
          'src',
          '{ entrypoints: ["./main.mjs"], target: "bun", compile: { outfile: "../bin/app" } }',
        );
        if (built.status !== 'built') inconclusive('bun-serve-keepalive', built.detail);
        const probe = box.run([join(box.dir, 'bin/app')], box.dir).result;
        if (!/ control=keep-alive-announced /.test(probe))
          inconclusive('bun-serve-keepalive', `control (app-set Keep-Alive header): ${probe}`);
        if (!/^(no-keep-alive|keep-alive-announced|closes) /.test(probe))
          inconclusive('bun-serve-keepalive', probe);
        return { stillBroken: probe.startsWith('no-keep-alive'), evidence: probe };
      } finally {
        box.dispose();
      }
    },
  },
  {
    id: 'bun-serve-cache-control',
    upstream: 'cloudflare/vinext#3487',
    upstreamTitle: 'also normalise an app-set s-maxage',
    issue: '#1437',
    kind: 'shim',
    shape: 'vinext',
    against: 'vinext',
    // With VINEXT_NEXT_DEPLOY_CACHE_CONTROL=1, vinext normalises the shared-cache
    // Cache-Control it COMPUTES, but passes an app-set `s-maxage` through
    // untouched — and so does a `headers()` s-maxage from next.config, applied
    // later. bun-serve-cache-control.mjs normalises every response. KNOWN BLIND
    // SPOT: the Pages-router handler needs a full page-render harness and is not
    // probed, so a fix landing App-side only would turn this red while Pages
    // still leaks — whoever acts on the red must confirm the upstream fix
    // covers the Pages path before deleting the shim.
    repro: async () => {
      const { dir } = pinnedVinext();
      const box = sandbox('3487');
      try {
        const server = join(dir, 'dist/server');
        for (const f of ['app-rsc-response-finalizer.js', 'cache-control.js']) {
          if (!existsSync(join(server, f)))
            inconclusive('bun-serve-cache-control', `pinned vinext has no dist/server/${f}`);
        }
        box.write({
          'probe.mjs':
            `const fin = await import(${JSON.stringify(join(server, 'app-rsc-response-finalizer.js'))});\n` +
            `const cc = await import(${JSON.stringify(join(server, 'cache-control.js'))});\n` +
            'const SHARED = "s-maxage=2, stale-while-revalidate=31535998";\n' +
            'const h = new Headers(); cc.applyCdnResponseHeaders(h, { cacheControl: SHARED });\n' +
            'console.log("CONTROL " + h.get("cache-control"));\n' +
            // Three response shapes, all through the finalizer every App Router
            // response passes: (A) an app-set s-maxage with no config headers,
            // (B) next.config `headers()` setting s-maxage on a response with
            // no Cache-Control of its own (applied later, by
            // applyAppRscConfigHeaders), (C) `headers()` over an app-set policy.
            // The shim normalises ALL of them, so upstream has only caught up
            // when every one is normalised.
            'const CH = [{ source: "/api/:path*", headers: [{ key: "Cache-Control", value: SHARED }] }];\n' +
            'const req = () => new Request("http://localhost/api/probe");\n' +
            'const A = await fin.finalizeAppRscResponse(new Response("ok", { headers: { "cache-control": SHARED } }), req(), { configHeaders: [] });\n' +
            'const B = await fin.finalizeAppRscResponse(new Response("ok"), req(), { configHeaders: CH });\n' +
            'const C = await fin.finalizeAppRscResponse(new Response("ok", { headers: { "cache-control": "public, max-age=5" } }), req(), { configHeaders: CH });\n' +
            'console.log("RESULT " + JSON.stringify({ A: A.headers.get("cache-control"), B: B.headers.get("cache-control"), C: C.headers.get("cache-control") }));\n',
        });
        const { result, output } = box.run([bunOnPath(), 'probe.mjs'], box.dir, {
          VINEXT_NEXT_DEPLOY_CACHE_CONTROL: '1',
        });
        const control = /^CONTROL (.*)$/m.exec(output)?.[1];
        if (control !== 'public, max-age=0, must-revalidate') {
          inconclusive(
            'bun-serve-cache-control',
            `the deploy switch did not normalise a COMPUTED shared policy: ${control}`,
          );
        }
        const shapes = JSON.parse(result) as Record<'A' | 'B' | 'C', string | null>;
        const leaking = (Object.keys(shapes) as ('A' | 'B' | 'C')[]).filter((k) =>
          /s-maxage/.test(shapes[k] ?? ''),
        );
        // "Fixed" needs EVERY shape normalised: a partial upstream fix leaves the
        // shim needed, so it must stay "still broken", never order a delete.
        return {
          stillBroken: leaking.length > 0,
          evidence: `computed policy → ${control}; still leaking s-maxage in [${leaking.join(',')}] of A(app-set)/B(config headers())/C(config over app-set): ${result}`,
        };
      } finally {
        box.dispose();
      }
    },
  },
  {
    id: 'embed-extra-entrypoints',
    upstream: 'oven-sh/bun#44059',
    upstreamTitle: '--include embeds extra files',
    issue: '#1478',
    kind: 'shim',
    shape: 'both',
    against: 'bun',
    // Stock Bun has no `compile.include`, so compile-embed.mjs passes the
    // embed set as extra entrypoints. The same detection compile-embed runs at
    // build time decides here, with its controls (extra-entrypoint embed must
    // load, no embed must not). The probe is red once ANY landing shape embeds
    // — `compile.include` as a file list (what embedBuildOptions passes) or a
    // directory, or the CLI `--include=<dir>` — so a CLI-only landing is not
    // missed.
    repro: async () => {
      const detected = await detectCompileInclude();
      if (!detected.conclusive) inconclusive('embed-extra-entrypoints', detected.evidence);
      return { stillBroken: !detected.landed, evidence: detected.evidence };
    },
  },
  {
    id: 'bun-cjs-dirname-inlined',
    upstream: 'oven-sh/bun#44068',
    upstreamTitle: '__dirname/__filename in an included CommonJS entrypoint are inlined',
    fixedBy: {
      ref: 'oven-sh/bun#29066',
      title: 'Use the virtual $bunfs path for __dirname/__filename',
    },
    issue: '#1451',
    kind: 'constraint',
    shape: 'both',
    against: 'bun',
    // The bundler inlines `__dirname` in an embedded CommonJS module as the
    // BUILD directory, so `require(join(__dirname, x))` misses `$bunfs` from
    // an empty directory; compile-embed.mjs documents the constraint (CJS
    // trees use a RELATIVE computed require). Fixed by oven-sh/bun#29066
    // (verified on a from-source build: this probe flips).
    repro: async () => {
      const box = sandbox('44068');
      try {
        box.write(
          {
            'main.cjs':
              'const { dirname, join } = require("node:path");\n' +
              'const l = require(join(dirname(process.argv[1]), "chunks", "loader.js"));\n' +
              'let rel, abs;\n' +
              'try { rel = l.relative("n1"); } catch (e) { rel = "fail"; }\n' +
              'try { abs = l.dirnameJoin("n1"); } catch (e) { abs = "fail " + String(e.message).split("\\n")[0]; }\n' +
              'console.log("RESULT " + JSON.stringify({ rel, abs }));\n',
            'chunks/loader.cjs':
              'const { join } = require("node:path");\n' +
              'exports.relative = (n) => require("./" + n + ".cjs");\n' +
              'exports.dirnameJoin = (n) => require(join(__dirname, n + ".cjs"));\n',
            'chunks/n1.cjs': 'module.exports = "n1-ok";\n',
          },
          'src',
        );
        const built = box.compile(
          'src',
          '{ entrypoints: ["./main.cjs", "./chunks/loader.cjs", "./chunks/n1.cjs"], root: ".", target: "bun", format: "cjs", naming: "[dir]/[name].[ext]", compile: { outfile: "../bin/app" } }',
        );
        if (built.status !== 'built') inconclusive('bun-cjs-dirname-inlined', built.detail);
        box.remove('src');
        box.write({ '.keep': '' }, 'empty');
        const raw = box.run([join(box.dir, 'bin/app')], join(box.dir, 'empty')).result;
        const { rel, abs } = JSON.parse(raw) as { rel: string; abs: string };
        // Control: the RELATIVE computed require resolves inside `$bunfs`, so
        // the chunk IS embedded and a miss below is the `__dirname` anchor alone.
        if (rel !== 'n1-ok')
          inconclusive('bun-cjs-dirname-inlined', `relative computed require: ${raw}`);
        if (abs !== 'n1-ok' && !/^fail Cannot find module/.test(abs))
          inconclusive('bun-cjs-dirname-inlined', `join(__dirname) failed oddly: ${raw}`);
        return {
          stillBroken: abs !== 'n1-ok',
          evidence: `relative require → ${rel}; require(join(__dirname, …)) → ${abs} (fix: oven-sh/bun#29066)`,
        };
      } finally {
        box.dispose();
      }
    },
  },
];
