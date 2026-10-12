/**
 * Dependency-free counter registry for the CDN tier (ADR-0068 D6.5) — INTERNAL.
 *
 * Why not prom-client: this code runs inside the Next.js server process, loaded
 * through the cache handler, and may run in a compiled Bun executable. The
 * other in-process modules on that path (`deep-health-lite`, the preloads) are
 * dependency-free for the same reason.
 *
 * The process-wide registry is anchored on `globalThis` under a namespaced
 * `Symbol.for` key (ADR-0027 §3), never a module-level binding: Next duplicates
 * modules across webpack layers, and a bare module-level Map would silently
 * split the counts between copies — the #352 mechanism.
 *
 * Series are bounded by construction: the labels are a closed set chosen by the
 * caller (provider row name, result enum). Never a tag, path or URL.
 *
 * Scrape wiring is NOT here. `renderCdnPurgeMetrics()` returns the Prometheus
 * text for whichever `/metrics` surface the runtime exposes to append it to.
 */

const REGISTRY_KEY = Symbol.for('knext.core.cdn.metrics');

/** The families this module declares up front, so HELP/TYPE exist before a sample. */
export const PURGE_METRIC = 'knext_cdn_purge_total';
const KNOWN = new Map([
  [PURGE_METRIC, 'Purge outcomes of the CDN tag-purge module, one per purge batch or skipped call.'],
]);

const escapeLabel = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

function seriesKey(labels) {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escapeLabel(labels[k])}"`)
    .join(',');
}

/** A fresh, isolated registry (tests; the process-wide one is `defaultMetricsRegistry`). */
export function createMetricsRegistry() {
  /** @type {Map<string, { help: string, series: Map<string, number> }>} */
  const families = new Map();

  const family = (name) => {
    let f = families.get(name);
    if (!f) {
      f = { help: KNOWN.get(name) ?? name, series: new Map() };
      families.set(name, f);
    }
    return f;
  };
  for (const name of KNOWN.keys()) family(name);

  return {
    /** Increment a counter series by `by` (default 1). */
    inc(name, labels = {}, by = 1) {
      const f = family(name);
      const key = seriesKey(labels);
      f.series.set(key, (f.series.get(key) ?? 0) + by);
    },
    /** Current value of one series (0 when never incremented). */
    get(name, labels = {}) {
      return families.get(name)?.series.get(seriesKey(labels)) ?? 0;
    },
    /** Prometheus text exposition of every family. */
    render() {
      const out = [];
      for (const [name, f] of families) {
        out.push(`# HELP ${name} ${f.help}`, `# TYPE ${name} counter`);
        for (const [key, value] of [...f.series].sort(([a], [b]) => (a < b ? -1 : 1))) {
          out.push(`${name}${key ? `{${key}}` : ''} ${value}`);
        }
      }
      return `${out.join('\n')}\n`;
    },
  };
}

/** The process-wide registry — one instance however many copies of this module load. */
export function defaultMetricsRegistry() {
  let registry = globalThis[REGISTRY_KEY];
  if (!registry) {
    registry = createMetricsRegistry();
    globalThis[REGISTRY_KEY] = registry;
  }
  return registry;
}

/** Prometheus text for the process-wide registry (append to the runtime's /metrics). */
export function renderCdnPurgeMetrics() {
  return defaultMetricsRegistry().render();
}
