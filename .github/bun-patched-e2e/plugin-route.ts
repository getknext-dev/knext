// Copied into the bun-patched e2e app as src/app/api/plugin/route.ts (see
// .github/workflows/bun-patched-e2e.yml). Reports whether the `--include`d
// module had been evaluated BEFORE this request's import (lazy = 0), then
// imports it by a computed specifier — something the bundler cannot follow, so
// only the executable's embedded copy can answer — and reports it again.
export const dynamic = 'force-dynamic';

type Probe = { __knextPluginEvaluated?: number };

export async function GET(): Promise<Response> {
  const g = globalThis as Probe;
  const before = g.__knextPluginEvaluated ?? 0;
  const name = process.env.KNEXT_PROOF_PLUGIN ?? 'greet';
  // The executable embeds the included file under its path relative to the
  // compile root; try the absolute embedded path, then the entry-relative one.
  const candidates = [
    `/$bunfs/root/plugins/${name}.js`,
    `../../plugins/${name}.js`,
    `./plugins/${name}.js`,
  ];
  const tried: string[] = [];
  for (const spec of candidates) {
    try {
      const m = (await import(/* @vite-ignore */ spec)) as {
        default: string;
      };
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
  return Response.json({ before, tried }, { status: 500 });
}
