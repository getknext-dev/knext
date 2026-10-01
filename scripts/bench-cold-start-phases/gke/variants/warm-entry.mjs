// BENCH-ONLY prototype of warm-before-ready (#1761) — not product code.
// Replaces the image's dependency-free supervisor entry with: start a localhost
// warm-up loop, then hand off to the unchanged supervisor exactly as the stock
// entry does. The loop GETs the health path every 20 ms until the first 200, so
// the app's one-time first-request cost (route load + first run of the handler)
// starts the moment Next binds :3000 instead of when the first
// kubelet/queue-proxy/activator probe happens to arrive. Readiness is still
// decided by the unchanged probe.
const port = process.env.PORT ?? '3000';
const path = process.env.KNEXT_WARM_PATH ?? '/api/health';
const t0 = performance.now();
(async () => {
  for (let i = 0; i < 1500; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      await r.arrayBuffer();
      if (r.ok) {
        // biome-ignore lint/suspicious/noConsole: bench script, stdout is its output contract
        console.log(
          JSON.stringify({
            msg: 'knext-bench warm-up 200',
            path,
            ms: Math.round(performance.now() - t0),
            tries: i + 1,
          }),
        );
        return;
      }
    } catch {}
    await new Promise((res) => setTimeout(res, 20));
  }
})();
await import('@getknext/core/internal/node-server');
