/**
 * ARP / neighbour-table primer (#1760) — a dependency-free CommonJS preload
 * that sends ONE best-effort outbound UDP datagram to the pod's default
 * gateway, as early as possible at process start, before anything listens.
 *
 * WHY: on a flannel-VXLAN node (measured on OKE, `knext-oke`) whose pod-IP
 * allocator has wrapped, a node can hold a STALE neighbour (ARP) entry for a
 * recycled pod IP, pointing at the MAC of the pod that previously held it.
 * Traffic reaching the new pod from outside its own node (cross-node, and
 * the node's OWN host network namespace — i.e. the kubelet's readiness
 * probe) is black-holed for ~8.5s: Linux's `delay_first_probe_time` (5s)
 * plus `ucast_solicit * retrans_time` (3 * 1s) of unicast re-probes to the
 * wrong MAC, before it falls back to broadcast ARP. ANY outbound frame from
 * the pod refreshes the node's neighbour entry at once (captured live:
 * STALE -> DELAY -> PROBE x3 on the stale MAC, replaced by REACHABLE on the
 * correct MAC the instant the pod's own packet is seen).
 *
 * Evidence: docs/benchmarks/cold-start-phase-breakdown-2026-10-01.md (E1 —
 * exec'd DNS lookup, 9928ms -> 2379ms, p = 0.007) and
 * docs/benchmarks/arp-primer-oke-partial-ab-2026-10-01.md (this mechanism,
 * median 10234ms -> 2940ms on the affected node, p = 0.004). GKE shows no
 * such stall (its CNI does not share this failure mode).
 *
 * Mirrors PR #1762's operator-side `spec.coldStart.arpPrimer` init
 * container's CHOICE of mechanism — a single best-effort UDP datagram to
 * the default gateway, resolved at runtime (never the Downward API, never
 * `ip route` shelled out) — but fires from INSIDE the runtime process
 * instead of a separate init container, so it can land ~1s+ earlier (no
 * container-create round trip) and needs no Knative feature flag at all
 * (`kubernetes.podspec-init-containers` / `-fieldref`).
 *
 * Target: the gateway from the FIRST default route (destination 0.0.0.0) in
 * `/proc/net/route` — not the node IP — because the one artifact every
 * mechanism explanation agrees on is the pod's OWN ARP request for its
 * gateway on the node's bridge (`cni0`), which is exactly what sending a
 * gateway-directed packet elicits; any outbound frame would do, but the
 * default gateway is reachable from every pod network layout this fix
 * targets (flannel, one /25 per node) without needing to resolve the host
 * IP via Kubernetes' Downward API.
 *
 * Contract (binding — every caller depends on this):
 *   - NEVER throws. Every failure path (unreadable /proc/net/route, no
 *     default route, dgram errors, a malformed route line) is swallowed.
 *   - NEVER blocks or delays the caller. `require()`/`primeArpNow()` always
 *     returns synchronously; the UDP send is fire-and-forget (its callback,
 *     if it ever fires, only closes the socket — nothing downstream awaits
 *     it).
 *   - Linux-only. Any other `process.platform` (darwin, win32, ...) is a
 *     no-op — most are dev machines, and none of them carry this node-local
 *     condition. `/proc/net/route` simply does not exist there either.
 *   - Opt-out: `KNEXT_ARP_PRIMER=0` skips entirely (e.g. a cluster whose CNI
 *     does not exhibit this, or a security posture that forbids a pod
 *     sending any packet before its own readiness is established).
 *
 * See `apps/docs/content/docs/scale-to-zero.mdx` for the user-facing note.
 */
'use strict';

/** Discard-ish port; nothing needs to be listening — the SEND is the point. */
const ARP_PRIMER_TARGET_PORT = 9;

/**
 * Parse `/proc/net/route`'s text and return the gateway (dotted-quad IPv4)
 * of the first default route (destination `00000000`), or `undefined` if
 * there is none. Pure — no I/O, no process access — so it is unit-testable
 * against a fixture without touching the real filesystem.
 *
 * `/proc/net/route` columns (tab/space separated, header row first):
 *   Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT
 * `Destination` and `Gateway` are little-endian hex, one byte reversed per
 * octet (so `0102000A` is `10.0.2.1`, not `1.2.0.10`).
 *
 * @param {string} text
 * @returns {string | undefined}
 */
function parseDefaultGatewayFromRouteTable(text) {
  if (typeof text !== 'string') return undefined;
  const lines = text.split('\n');
  // Row 0 is the header; skip it unconditionally rather than sniffing for
  // "Iface" so a header-less/reordered fixture still just finds no match.
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].trim().split(/\s+/);
    if (cols.length < 3) continue;
    const destination = cols[1];
    const gateway = cols[2];
    if (destination === '00000000' && gateway && gateway !== '00000000') {
      const ip = hexRouteFieldToIp(gateway);
      if (ip) return ip;
    }
  }
  return undefined;
}

/**
 * Convert a `/proc/net/route` hex field (little-endian IPv4, 8 hex chars) to
 * dotted-quad. Returns `undefined` on anything that is not exactly 8 hex
 * chars — never throws, never guesses.
 *
 * @param {string} hex
 * @returns {string | undefined}
 */
function hexRouteFieldToIp(hex) {
  if (typeof hex !== 'string' || !/^[0-9A-Fa-f]{8}$/.test(hex)) return undefined;
  const bytes = [];
  for (let i = 6; i >= 0; i -= 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return bytes.join('.');
}

/**
 * Read and parse the live `/proc/net/route`. `undefined` on non-Linux, a
 * missing/unreadable file, or no default route — never throws.
 *
 * @param {{ platform?: string, readRouteTable?: () => string }} [deps]
 *   Injectable for the unit test; defaults to the real platform/filesystem.
 * @returns {string | undefined}
 */
function readDefaultGateway(deps) {
  const platform = (deps && deps.platform) || process.platform;
  if (platform !== 'linux') return undefined;
  let text;
  try {
    text = deps && deps.readRouteTable
      // eslint-disable-next-line unicorn/prefer-module -- CJS preload, Node builtins only
      ? deps.readRouteTable()
      : require('node:fs').readFileSync('/proc/net/route', 'utf8');
  } catch {
    return undefined;
  }
  try {
    return parseDefaultGatewayFromRouteTable(text);
  } catch {
    return undefined;
  }
}

/**
 * Fire the primer: resolve the default gateway and send it one best-effort
 * UDP datagram. Synchronous and non-throwing by contract (see module
 * header) — the only asynchronous part is the UDP send itself, whose
 * outcome nothing downstream ever observes.
 *
 * Calling it more than once (e.g. a future caller requiring this preload
 * twice via two specifiers that resolve to the same file) just sends a
 * second, equally harmless packet — there is no idempotency guard to keep
 * this function trivially unit-testable.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   platform?: string,
 *   readRouteTable?: () => string,
 *   createSocket?: () => { unref?: () => void, on: (event: string, cb: (err: unknown) => void) => void, send: (payload: Buffer, port: number, address: string, cb: (err?: unknown) => void) => void, close: () => void },
 * }} [deps]
 *   Injectable for the unit test; defaults to the real process/fs/dgram.
 * @returns {void}
 */
function primeArpNow(deps) {
  const env = (deps && deps.env) || process.env;
  if (env.KNEXT_ARP_PRIMER === '0') return;

  let gateway;
  try {
    gateway = readDefaultGateway(deps);
  } catch {
    gateway = undefined;
  }
  if (!gateway) return;

  try {
    const createSocket = deps && deps.createSocket
      // eslint-disable-next-line unicorn/prefer-module -- CJS preload, Node builtins only
      ? deps.createSocket
      : () => require('node:dgram').createSocket('udp4');
    const socket = createSocket();
    // Never let this socket hold the event loop open on its own.
    if (typeof socket.unref === 'function') socket.unref();
    socket.on('error', () => {
      try {
        socket.close();
      } catch {
        // never throw from the primer
      }
    });
    const payload = Buffer.from('knext-arp-primer');
    socket.send(payload, ARP_PRIMER_TARGET_PORT, gateway, () => {
      // Best-effort: closed/filtered/unreachable is the expected common
      // case (nothing need be listening) — the OUTBOUND frame is the point,
      // not a successful round trip.
      try {
        socket.close();
      } catch {
        // never throw from the primer
      }
    });
  } catch {
    // never throw from the primer
  }
}

// Preload side effect: requiring this file fires the primer immediately,
// synchronously returning control to the caller. No-op on non-Linux, with
// KNEXT_ARP_PRIMER=0, or when no default route is found.
primeArpNow();

module.exports = {
  parseDefaultGatewayFromRouteTable,
  hexRouteFieldToIp,
  readDefaultGateway,
  primeArpNow,
  ARP_PRIMER_TARGET_PORT,
};
