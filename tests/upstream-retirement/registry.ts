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
 * Each shim's source carries a one-line `// @knext-shim <id>` marker; the
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

export type Probe = { stillBroken: boolean; evidence: string };

export type RetirementEntry = {
  /** The id used by the `// @knext-shim <id>` marker(s). */
  id: string;
  /** The upstream issue or PR whose fix retires the shim. */
  upstream: `${'oven-sh/bun' | 'cloudflare/vinext' | 'vercel/next.js'}#${number}`;
  /** The knext issue that tracks the retirement. */
  issue: `#${number}`;
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
  const sharpDir = dirname(
    Bun.resolveSync('sharp/package.json', join(REPO_ROOT, 'apps/file-manager')),
  );
  const libc =
    process.platform === 'linux' &&
    !(process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined)
      ?.header?.glibcVersionRuntime
      ? 'musl'
      : '';
  const platform = `${process.platform}${libc}-${process.arch}`;
  const addonPkg = dirname(Bun.resolveSync(`@img/sharp-${platform}/package.json`, sharpDir));
  const libvipsPkg = dirname(
    Bun.resolveSync(`@img/sharp-libvips-${platform}/package.json`, addonPkg),
  );
  const addonFile = readdirSync(join(addonPkg, 'lib')).find((f) => f.endsWith('.node'));
  const libvipsFile = readdirSync(join(libvipsPkg, 'lib')).find((f) => /^libvips-cpp\./.test(f));
  if (!addonFile || !libvipsFile) {
    throw new Error(
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
    issue: '#1463',
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
    issue: '#1463',
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
    issue: '#1463',
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
            'const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });\n' +
            'const raw = await new Promise((res, rej) => {\n' +
            '  const s = connect(server.port, "127.0.0.1", () => s.write("GET / HTTP/1.1\\r\\nHost: probe\\r\\n\\r\\n"));\n' +
            '  let b = ""; s.on("data", (d) => { b += d; if (b.includes("\\r\\n\\r\\n")) { s.destroy(); res(b); } }); s.on("error", rej);\n' +
            '});\n' +
            'server.stop(true);\n' +
            'const head = raw.split("\\r\\n\\r\\n")[0];\n' +
            'const verdict = !/^HTTP\\/1\\.1 200 /.test(head) ? "bad-response" : /^keep-alive:/im.test(head) ? "keep-alive-announced" : "no-keep-alive";\n' +
            'console.log("RESULT " + verdict + " " + JSON.stringify(head));\n',
        });
        const built = box.compile(
          'src',
          '{ entrypoints: ["./main.mjs"], target: "bun", compile: { outfile: "../bin/app" } }',
        );
        if (built.status !== 'built') inconclusive('bun-serve-keepalive', built.detail);
        const probe = box.run([join(box.dir, 'bin/app')], box.dir).result;
        if (probe.startsWith('bad-response')) inconclusive('bun-serve-keepalive', probe);
        return { stillBroken: probe.startsWith('no-keep-alive'), evidence: probe };
      } finally {
        box.dispose();
      }
    },
  },
  {
    id: 'bun-serve-cache-control',
    upstream: 'cloudflare/vinext#3487',
    issue: '#1437',
    shape: 'vinext',
    against: 'vinext',
    // With VINEXT_NEXT_DEPLOY_CACHE_CONTROL=1, vinext normalises the shared-cache
    // Cache-Control it COMPUTES, but passes an app-set `s-maxage` through
    // untouched. bun-serve-cache-control.mjs normalises every response.
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
            'const r = await fin.finalizeAppRscResponse(new Response("ok", { headers: { "cache-control": SHARED } }), new Request("http://localhost/api/probe"), { configHeaders: [] });\n' +
            'console.log("RESULT " + r.headers.get("cache-control"));\n',
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
        return {
          stillBroken: /s-maxage/.test(result),
          evidence: `computed policy → ${control}; app-set policy through finalizeAppRscResponse → ${result}`,
        };
      } finally {
        box.dispose();
      }
    },
  },
  {
    id: 'embed-extra-entrypoints',
    upstream: 'oven-sh/bun#44059',
    issue: '#1451',
    shape: 'both',
    against: 'bun',
    // Stock Bun has no `compile.include`, so compile-embed.mjs passes the
    // embed set as extra entrypoints. The same detection compile-embed runs at
    // build time decides here: once the pinned Bun embeds a DIRECTORY via
    // `compile.include`, the fallback is dead code.
    repro: async () => {
      const detected = await detectCompileInclude();
      return { stillBroken: !detected.supported, evidence: detected.evidence };
    },
  },
];
