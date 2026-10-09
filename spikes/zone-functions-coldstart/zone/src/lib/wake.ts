// Wake-ahead (Z9 shape): at zone process start, fire one non-blocking request at
// each bound function so its cold start overlaps the zone's own boot. A plain
// GET on /healthz stands in for the generated Connect GET on a health RPC; on
// the wire both are one GET through the activator, which holds it until a pod
// is ready. (The Rust function serves only Connect routes and answers 404 here;
// the pod is woken all the same, which is the only thing this call is for.)
//
// State lives on globalThis because instrumentation and route handlers are
// separate bundles (ADR-0027).
const KEY = Symbol.for('knext.spike.z2.wake');

type WakeEntry = { fn: string; firedAtMs: number; doneAtMs?: number; status?: number | string };
type WakeState = { enabled: boolean; entries: WakeEntry[] };

function state(): WakeState {
  const g = globalThis as unknown as Record<symbol, WakeState | undefined>;
  if (!g[KEY]) g[KEY] = { enabled: false, entries: [] };
  return g[KEY] as WakeState;
}

export function wakeState(): WakeState {
  return state();
}

export function wakeAhead(): void {
  const s = state();
  if (process.env.WAKE_AHEAD !== '1' || s.enabled) return;
  s.enabled = true;
  const ns = process.env.FN_NAMESPACE || 'z2';
  const fns = (process.env.BOUND_FUNCTIONS || '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  for (const fn of fns) {
    const entry: WakeEntry = { fn, firedAtMs: performance.now() };
    s.entries.push(entry);
    // Deliberately not awaited: the zone's boot must not wait on the function.
    fetch(`http://${fn}.${ns}.svc.cluster.local/healthz`, { signal: AbortSignal.timeout(60_000) })
      .then((r) => {
        entry.status = r.status;
      })
      .catch((e: unknown) => {
        entry.status = String((e as Error)?.message ?? e);
      })
      .finally(() => {
        entry.doneAtMs = performance.now();
      });
  }
}
