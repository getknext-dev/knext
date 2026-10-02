// Copied into the compile-include e2e app as src/app/api/plugin/route.ts (see
// .github/workflows/compile-include-e2e.yml). Reports whether the included
// module had been evaluated BEFORE this request's import (lazy = 0), then
// imports it and reports it again.
//
// The import goes through a function built at RUNTIME: the app's own `vite
// build` rewrites a non-literal `import(x)` in source into a stub that throws
// "Cannot find module as expression is too dynamic" (measured on the first
// proof run), so only an import the bundler never sees reaches Bun's module
// loader — and with no copy of the file on disk, only the executable's
// embedded module can answer it.
export const dynamic = 'force-dynamic';

type Probe = { __knextPluginEvaluated?: number };
type Loader = (specifier: string) => Promise<{ default: string }>;

export async function GET(): Promise<Response> {
  const g = globalThis as Probe;
  const before = g.__knextPluginEvaluated ?? 0;
  const name = process.env.KNEXT_PROOF_PLUGIN ?? 'greet';
  const load = new Function('s', 'return import(s)') as Loader;
  // Embedded under its path relative to the compile root (the app root: the
  // common ancestor of the entry and the included file).
  const candidates = [`/$bunfs/root/plugins/${name}.js`, `/$bunfs/root/plugins/${name}`];
  const tried: string[] = [];
  for (const spec of candidates) {
    try {
      const m = await load(spec);
      return Response.json({
        before,
        after: g.__knextPluginEvaluated ?? 0,
        spec,
        value: m.default,
        tried,
      });
    } catch (e) {
      tried.push(`${spec}: ${String((e as Error)?.message ?? e).split('\n')[0]}`);
    }
  }
  // Diagnostic only: what the executable says it embeds, and where it runs from.
  const bun = (globalThis as { Bun?: { embeddedFiles?: { name?: string }[] } }).Bun;
  return Response.json(
    {
      before,
      tried,
      argv1: process.argv[1],
      embeddedFiles: (bun?.embeddedFiles ?? []).map((f) => f.name).slice(0, 50),
    },
    { status: 500 },
  );
}
