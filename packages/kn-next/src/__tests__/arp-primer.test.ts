/**
 * #1760 — the ARP/neighbour-table primer preload.
 *
 * On a flannel-VXLAN node (measured on OKE, `knext-oke`) whose pod-IP
 * allocator has wrapped, a stale neighbour (ARP) entry for a recycled pod IP
 * can black-hole a freshly-started pod — reachable from inside its own node,
 * unreachable from everywhere else (including the kubelet's own readiness
 * probe) — for ~8.5s, until the pod sends an outbound packet of its own. This
 * preload sends ONE best-effort UDP datagram to the pod's default gateway as
 * early as possible at process start to avoid the stall.
 *
 * See docs/benchmarks/cold-start-phase-breakdown-2026-10-01.md (root-cause
 * evidence) and docs/benchmarks/arp-primer-oke-partial-ab-2026-10-01.md (this
 * mechanism, measured 10234ms -> 2940ms median on the affected node).
 */

import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const MODULE_PATH = resolve(import.meta.dirname, "../adapters/arp-primer.cjs");

// biome-ignore lint/suspicious/noExplicitAny: untyped CJS runtime module
const mod: any = require(MODULE_PATH);

// A real OCI-flannel-shaped /proc/net/route fixture: default route via
// 10.0.1.1, plus a non-default on-link route that must NOT be picked.
const ROUTE_TABLE_FIXTURE = [
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
    "eth0\t00000000\t0101000A\t0003\t0\t0\t0\t00000000\t0\t0\t0",
    "eth0\t000001AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
    "",
].join("\n");

describe("parseDefaultGatewayFromRouteTable", () => {
    it("finds the default route's gateway from a real-shaped fixture", () => {
        // Gateway hex 0101000A, little-endian bytes reversed -> 10.0.1.1
        expect(mod.parseDefaultGatewayFromRouteTable(ROUTE_TABLE_FIXTURE)).toBe(
            "10.0.1.1",
        );
    });

    it("returns undefined when there is no default route", () => {
        const noDefault = [
            "Iface\tDestination\tGateway\tFlags",
            "eth0\t000001AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
            "",
        ].join("\n");
        expect(
            mod.parseDefaultGatewayFromRouteTable(noDefault),
        ).toBeUndefined();
    });

    it("skips a default-destination row whose gateway is 0.0.0.0 (on-link, no gateway)", () => {
        const onLinkOnly = [
            "Iface\tDestination\tGateway\tFlags",
            "eth0\t00000000\t00000000\t0001\t0\t0\t0\t00000000\t0\t0\t0",
            "",
        ].join("\n");
        expect(
            mod.parseDefaultGatewayFromRouteTable(onLinkOnly),
        ).toBeUndefined();
    });

    it("never throws on malformed input", () => {
        expect(() => mod.parseDefaultGatewayFromRouteTable("")).not.toThrow();
        expect(() =>
            mod.parseDefaultGatewayFromRouteTable(
                "garbage\nnot a route table\n",
            ),
        ).not.toThrow();
        expect(() =>
            mod.parseDefaultGatewayFromRouteTable(undefined),
        ).not.toThrow();
        expect(() => mod.parseDefaultGatewayFromRouteTable(42)).not.toThrow();
    });
});

describe("hexRouteFieldToIp", () => {
    it("reverses byte order correctly", () => {
        expect(mod.hexRouteFieldToIp("0101000A")).toBe("10.0.1.1");
        expect(mod.hexRouteFieldToIp("0102000A")).toBe("10.0.2.1");
        expect(mod.hexRouteFieldToIp("00000000")).toBe("0.0.0.0");
    });

    it("returns undefined for anything that is not exactly 8 hex chars", () => {
        expect(mod.hexRouteFieldToIp("")).toBeUndefined();
        expect(mod.hexRouteFieldToIp("ZZZZZZZZ")).toBeUndefined();
        expect(mod.hexRouteFieldToIp("ABCD")).toBeUndefined();
        expect(mod.hexRouteFieldToIp(undefined)).toBeUndefined();
    });
});

describe("readDefaultGateway", () => {
    it("is a no-op (undefined) on a non-Linux platform, even with a route table present", () => {
        const result = mod.readDefaultGateway({
            platform: "darwin",
            readRouteTable: () => ROUTE_TABLE_FIXTURE,
        });
        expect(result).toBeUndefined();
    });

    it("resolves the gateway on 'linux' via the injected route-table reader", () => {
        const result = mod.readDefaultGateway({
            platform: "linux",
            readRouteTable: () => ROUTE_TABLE_FIXTURE,
        });
        expect(result).toBe("10.0.1.1");
    });

    it("never throws when the injected reader itself throws (unreadable file)", () => {
        expect(() =>
            mod.readDefaultGateway({
                platform: "linux",
                readRouteTable: () => {
                    throw new Error("ENOENT: no such file or directory");
                },
            }),
        ).not.toThrow();
        expect(
            mod.readDefaultGateway({
                platform: "linux",
                readRouteTable: () => {
                    throw new Error("ENOENT");
                },
            }),
        ).toBeUndefined();
    });

    it("falls back to the real process.platform / fs when no deps are injected (never throws)", () => {
        expect(() => mod.readDefaultGateway()).not.toThrow();
    });
});

describe("primeArpNow — the contract: never throws, never blocks", () => {
    it("returns synchronously (void, not a Promise) even when a gateway is found and sent", () => {
        let sent = false;
        const result = mod.primeArpNow({
            env: {},
            platform: "linux",
            readRouteTable: () => ROUTE_TABLE_FIXTURE,
            createSocket: () => ({
                unref: () => {},
                on: () => {},
                send: (
                    _payload: Buffer,
                    _port: number,
                    _addr: string,
                    cb: () => void,
                ) => {
                    sent = true;
                    cb();
                },
                close: () => {},
            }),
        });
        expect(result).toBeUndefined();
        expect(sent).toBe(true);
    });

    it("sends the datagram to the EXACT resolved gateway and port", () => {
        let gotAddress: string | undefined;
        let gotPort: number | undefined;
        mod.primeArpNow({
            env: {},
            platform: "linux",
            readRouteTable: () => ROUTE_TABLE_FIXTURE,
            createSocket: () => ({
                on: () => {},
                send: (
                    _payload: Buffer,
                    port: number,
                    addr: string,
                    cb: () => void,
                ) => {
                    gotPort = port;
                    gotAddress = addr;
                    cb();
                },
                close: () => {},
            }),
        });
        expect(gotAddress).toBe("10.0.1.1");
        expect(gotPort).toBe(mod.ARP_PRIMER_TARGET_PORT);
    });

    it("honors KNEXT_ARP_PRIMER=0 as a full no-op — never even resolves a gateway", () => {
        let createSocketCalled = false;
        mod.primeArpNow({
            env: { KNEXT_ARP_PRIMER: "0" },
            platform: "linux",
            readRouteTable: () => ROUTE_TABLE_FIXTURE,
            createSocket: () => {
                createSocketCalled = true;
                return { on: () => {}, send: () => {}, close: () => {} };
            },
        });
        expect(createSocketCalled).toBe(false);
    });

    it("is a no-op when no default route is found — never calls createSocket", () => {
        let createSocketCalled = false;
        mod.primeArpNow({
            env: {},
            platform: "linux",
            readRouteTable: () => "Iface\tDestination\tGateway\n",
            createSocket: () => {
                createSocketCalled = true;
                return { on: () => {}, send: () => {}, close: () => {} };
            },
        });
        expect(createSocketCalled).toBe(false);
    });

    it("never throws when createSocket itself throws", () => {
        expect(() =>
            mod.primeArpNow({
                env: {},
                platform: "linux",
                readRouteTable: () => ROUTE_TABLE_FIXTURE,
                createSocket: () => {
                    throw new Error("socket creation failed");
                },
            }),
        ).not.toThrow();
    });

    it("never throws when socket.send itself throws synchronously", () => {
        expect(() =>
            mod.primeArpNow({
                env: {},
                platform: "linux",
                readRouteTable: () => ROUTE_TABLE_FIXTURE,
                createSocket: () => ({
                    on: () => {},
                    send: () => {
                        throw new Error("send failed");
                    },
                    close: () => {},
                }),
            }),
        ).not.toThrow();
    });

    it("never throws when socket.close() (in the send callback) itself throws", () => {
        expect(() =>
            mod.primeArpNow({
                env: {},
                platform: "linux",
                readRouteTable: () => ROUTE_TABLE_FIXTURE,
                createSocket: () => ({
                    on: () => {},
                    send: (
                        _p: Buffer,
                        _port: number,
                        _a: string,
                        cb: () => void,
                    ) => cb(),
                    close: () => {
                        throw new Error("close failed");
                    },
                }),
            }),
        ).not.toThrow();
    });

    it("is a no-op on a non-Linux platform regardless of env/route-table", () => {
        let createSocketCalled = false;
        mod.primeArpNow({
            env: {},
            platform: "darwin",
            readRouteTable: () => ROUTE_TABLE_FIXTURE,
            createSocket: () => {
                createSocketCalled = true;
                return { on: () => {}, send: () => {}, close: () => {} };
            },
        });
        expect(createSocketCalled).toBe(false);
    });

    it("never awaits/blocks: 1000 calls complete near-instantly", () => {
        const start = performance.now();
        for (let i = 0; i < 1000; i++) {
            mod.primeArpNow({ env: { KNEXT_ARP_PRIMER: "0" } });
        }
        const elapsed = performance.now() - start;
        // A blocking/awaiting implementation would be orders of magnitude
        // slower than 1000 synchronous no-op calls.
        expect(elapsed).toBeLessThan(200);
    });

    it("falls back to the real process/fs/dgram when no deps injected — never throws", () => {
        expect(() => mod.primeArpNow()).not.toThrow();
        expect(() => mod.primeArpNow({ env: {} })).not.toThrow();
    });
});
