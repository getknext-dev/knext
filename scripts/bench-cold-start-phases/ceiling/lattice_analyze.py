#!/usr/bin/env python3
"""Analyzer for the kubelet ceiling test: does a 100 ms relist remove the pod-IP wait, and is the
cycle lock the relist's?

Offline and read-only: it reads harness JSONL (drive.py rows) and makes no cluster call. The design is
in RUNBOOK.md beside it. One patched worker P and one untouched control worker S are woken in pairs
(one wake on P, one on S, per round), in six blocks, each block run under a different kubelet on P:

  b1 oke -> b2 stock -> b3 relist100 -> b4 relist100 -> b5 stock -> b6 oke

The two treatments are in ABBA order so a linear drift on P alone cancels in their difference; an ABAB
order would leave one block's worth of drift in it.

`oke` is the binary OKE ships, `stock` is our own build of the same version, `relist100` is our build
with the relist constant at 100 ms. S keeps its OKE binary in every block and is the concurrent drift
control. Rows carry the block label (`drive.py --block=b1`).

  python3 lattice_analyze.py rows.jsonl [--p-arm=p] [--s-arm=s] [--blocks=b1:oke,b2:stock,...]
                                        [--perms=100] [--boot=2000] [--seed=1]

The primary quantity is the WAIT: pod IP time minus the queue-proxy's first log, per wake. The stock
relist makes it 0-1000 ms; a 100 ms relist should make it about 150 ms or less. It is judged as a
difference in differences against S: median(P - S over pairs) under relist100 minus the same under
stock, with a bootstrap interval resampled within each block. The cycle lock (Rayleigh statistic of
pod-IP arrival times against a per-group shuffled null) is secondary and is tested per block and per
arm, never pooled across blocks: every kubelet restart resets the lattice phase, and over a long span a
slowly drifting period smears the peak. The period scan grid is set from the span of each group.

Exit codes: 0 analysis printed (whatever the verdict); 2 unreadable or malformed input, or a bad flag;
3 a block missing or too few complete pairs in a block, refused with nothing judged from it; 4 more than
10% of the wakes in some block unusable (failed, no node, no first byte or IP, no logs, no clock offset or
one with a round trip over 50 ms). The 10% check runs before the missing-block check, so it also fires on
a partial file.

The wait is only as good as the clock offset: pod IP is read on the harness clock, the queue-proxy log on
the node's clock re-based by the offset the harness measured. cold-cycle.mjs falls back to offset 0 when it
finds no agent on the node; such rows, and rows whose offset round trip is over 50 ms, are unusable.

VERDICT is one of the rows of the reading table in RUNBOOK.md section 10, first match wins, in this order:
  INVALID_NODES               P or S rows on more than one node, or P and S on the same node
  INVALID_LOCK_PERSISTS       the 1 s lock persists on P in ALL relist100 blocks, each at alpha / (number of
                              relist100 blocks) (binary not running, or the relist is not the lock's
                              source); any wait move is reported, not attributed
  NO_BASELINE_LOCK            no 1 s lock on P under the stock build, so there is no lock to remove
  INCONCLUSIVE_LOCK_MIXED     the 1 s lock persists in some relist100 blocks but not all: one block does
                              not condemn the binary (a working patch trips one of two blocks about 5% of
                              the time even with the corrected alpha)
  CARRYOVER                   blocks of one treatment differ (99% interval excludes 0): not exchangeable
  FLOOR_WAIT_UNMOVED          lock gone, but the wait difference in differences includes 0
  WAIT_WORSE                  the wait got longer under relist100
  FLOOR_WAIT_PARTIAL          wait moved down, but P's relist100 wait is not at or under 150 ms
  WAIT_REMOVED_LOCK_UNSEEN    wait collapsed and 1 s lock gone, but no 100 ms lock detected
                              (may be the best reachable verdict: a simulated 100 ms lock was detected
                              0 of 12 times at 1 ms per-cycle jitter, 9 of 12 at 0.5 ms; the wait is primary)
  RELIST_IS_WAIT_GOAL_MET_ONCE   all of the above plus a 100 ms lock; goal interval under 1000 ms
  RELIST_IS_WAIT_FLOOR        all of the above plus a 100 ms lock; goal interval not under 1000 ms
There is no PASS: first-byte medians vary 1276-1806 ms from run to run with no change, so one run cannot
pass the goal. A run that does not reach the goal is reported as a floor.

A two-block screen (--blocks=b2:stock,b3:relist100) is accepted: it has no carryover or build comparison, and
a single relist100 block is judged at alpha / 1. It cannot separate order or build effects.
"""
import argparse
import cmath
import json
import math
import random
import statistics
import sys
from datetime import datetime

MIN_BLOCK_PAIRS = 24  # planned 30 per block; below this a block is refused
MAX_FAILED_FRACTION = 0.10  # the runbook's abort threshold, per block
GOAL_MS = 1000.0  # the sub-second median goal
WAIT_COLLAPSE_MS = 150.0  # the 100 ms relist should bring the wait to about this or below
SLOW_CUT_MS = 650.0  # bound -> user first log; the cut that split the 2026-11-02 clusters
BAND_1S = (0.990, 1.020)  # stock relist: measured cycle 1.0031-1.0038 s
BAND_100MS = (0.095, 0.110)  # patched relist: 100 ms period plus a few ms of relist work
ALPHA = 0.05
MIN_PERMS = 40  # p <= 0.05 / 2 (two relist100 blocks) is unreachable with fewer shuffles
MAX_CLOCK_RTT_MS = 50.0  # offset error is at most half of this
OVERSAMPLE = 4  # period grid points per resolution cell (1/span in frequency)
MIN_LOCK_N = 10
DEFAULT_BLOCKS = "b1:oke,b2:stock,b3:relist100,b4:relist100,b5:stock,b6:oke"


class InputError(Exception):
    pass


class SampleError(Exception):
    pass


class FailureRateError(Exception):
    pass


def pct(values, p):
    v = sorted(values)
    k = (len(v) - 1) * p
    f = int(k)
    c = min(f + 1, len(v) - 1)
    return v[f] + (v[c] - v[f]) * (k - f)


def parse_wall(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()


def parse_blocks(text):
    design = []
    for part in text.split(","):
        label, _, treat = part.partition(":")
        if not label or not treat or any(label == b for b, _ in design):
            raise InputError(f"bad --blocks entry {part!r}; expected label:treatment, labels unique")
        design.append((label, treat))
    treats = {t for _, t in design}
    if not {"stock", "relist100"} <= treats:
        raise InputError("--blocks must contain at least one stock and one relist100 block")
    return design


def load_rows(path, p_arm, s_arm, design):
    """Returns (usable rows, failed count per block, total wakes per block, failure reasons)."""
    labels = {b for b, _ in design}
    rows, failed, total, reasons = [], {}, {}, {}
    try:
        fh = open(path, encoding="utf-8")
    except OSError as e:
        raise InputError(f"cannot read {path}: {e.strerror}")
    with fh:
        for n, line in enumerate(fh, 1):
            if not line.strip():
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError as e:
                raise InputError(f"{path}:{n}: not JSON ({e.msg})")
            if not isinstance(r, dict):
                raise InputError(f"{path}:{n}: not a JSON object")
            arm = r.get("arm")
            if arm not in (p_arm, s_arm):
                raise InputError(f"{path}:{n}: arm {arm!r} is neither {p_arm!r} nor {s_arm!r}")
            block = r.get("block")
            if block not in labels:
                raise InputError(f"{path}:{n}: block {block!r} is not one of {sorted(labels)}")
            if not isinstance(r.get("round"), int):
                raise InputError(f"{path}:{n}: missing integer round")
            total[block] = total.get(block, 0) + 1

            def fail(why):
                failed[block] = failed.get(block, 0) + 1
                reasons[why] = reasons.get(why, 0) + 1

            # drive.py writes an error row (no node, no watch) when a wake produced no result.
            if r.get("error"):
                fail("wake_error")
                continue
            node = r.get("node")
            if not node:
                fail("no_node")
                continue
            try:
                wall = parse_wall(r["wall_start"])
            except (KeyError, TypeError, ValueError):
                fail("bad_wall_start")
                continue
            w = r.get("watch") or {}
            if any(w.get(k) is None for k in ("pod_bound", "pod_ip", "first_byte")):
                fail("no_first_byte_or_ip")
                continue
            logs = r.get("logs") or {}
            user = [x for x in (logs.get("user-container") or []) if "t" in x]
            qp = [x for x in (logs.get("queue-proxy") or []) if "t" in x]
            if not user or not qp:
                fail("no_user_or_queue_proxy_log")
                continue
            clock = r.get("clock")
            if not isinstance(clock, dict) or not all(
                    isinstance(clock.get(k), (int, float)) and not isinstance(clock.get(k), bool)
                    for k in ("offset_ms", "rtt_ms")):
                fail("no_clock_offset")  # cold-cycle.mjs used offset 0: raw clock skew is in the wait
                continue
            if clock["rtt_ms"] > MAX_CLOCK_RTT_MS:
                fail("clock_rtt_too_large")
                continue
            ip, qp0 = float(w["pod_ip"]), float(qp[0]["t"])
            rows.append({
                "arm": arm, "node": node, "block": block, "round": r["round"], "wall": wall,
                "bound": float(w["pod_bound"]), "uf": float(user[0]["t"]), "ip": ip,
                "fb": float(w["first_byte"]), "wait": ip - qp0,
                "foreign": len(r.get("foreign_new_pods") or []), "rtt": float(clock["rtt_ms"]),
            })
    return rows, failed, total, reasons


def pair_rows(rows, p_arm, s_arm):
    """Pairs by (block, round); a round with no usable row on one side is not a pair."""
    by = {}
    for r in rows:
        by.setdefault((r["block"], r["round"]), {}).setdefault(r["arm"], []).append(r)
    pairs, unpaired = {}, {}
    for key in sorted(by, key=lambda k: (k[0], k[1])):
        p, s = by[key].get(p_arm, []), by[key].get(s_arm, [])
        if len(p) == 1 and len(s) == 1:
            pairs.setdefault(key[0], []).append((p[0], s[0]))
        else:
            unpaired[key[0]] = unpaired.get(key[0], 0) + 1
    return pairs, unpaired


def gate(design, pairs, failed, total):
    # The failure rate first: a partial file (a block still to run) must still trip it.
    for label, _ in design:
        if label in total and failed.get(label, 0) > MAX_FAILED_FRACTION * total[label]:
            raise FailureRateError(
                f"block {label}: {failed[label]} of {total[label]} wakes unusable, "
                f"over the {MAX_FAILED_FRACTION:.0%} limit")
    for label, _ in design:
        if label not in total:
            raise SampleError(f"block {label} has no wakes")
    for label, _ in design:
        n = len(pairs.get(label, []))
        if n < MIN_BLOCK_PAIRS:
            raise SampleError(f"block {label} has {n} complete pairs; the protocol needs at least "
                              f"{MIN_BLOCK_PAIRS} (30 planned)")


def lock_scan(ts, lo, hi, oversample=OVERSAMPLE):
    """Best Rayleigh statistic R (0..1) for arrival times ts over periods in [lo, hi], and its period.

    The scan is uniform in frequency with spacing 1/(oversample * span): a peak is about 1/span wide, so
    a fixed period grid that is fine at a short span misses it at a long one."""
    t0 = min(ts)
    xs = [t - t0 for t in ts]
    n = len(xs)
    span = max(xs)
    if span <= 0:
        return 0.0, lo
    f_lo, f_hi = 1.0 / hi, 1.0 / lo
    steps = max(1, int(math.ceil((f_hi - f_lo) * oversample * span)))
    df = (f_hi - f_lo) / steps
    tau = 2j * math.pi
    z = [cmath.exp(tau * f_lo * x) for x in xs]
    e = [cmath.exp(tau * df * x) for x in xs]
    best_r, best_f = abs(sum(z)) / n, f_lo
    for j in range(1, steps + 1):
        z = [a * b for a, b in zip(z, e)]
        r = abs(sum(z)) / n
        if r > best_r:
            best_r, best_f = r, f_lo + j * df
    for i in range(65):  # refine inside one grid step either side of the best point
        f = best_f - df + 2 * df * i / 64
        if f < f_lo or f > f_hi:
            continue
        r = abs(sum(cmath.exp(tau * f * x) for x in xs)) / n
        if r > best_r:
            best_r, best_f = r, f
    return best_r, 1.0 / best_f


def lock_test(rows, band, perms, seed):
    """Is there a cycle lock in one group's pod-IP arrivals? Compared with a per-group shuffled null."""
    walls = [r["wall"] for r in rows]
    offs = [r["ip"] / 1000.0 for r in rows]
    arr = [w + o for w, o in zip(walls, offs)]
    obs, period = lock_scan(arr, *band)
    span = max(arr) - min(arr)
    rng = random.Random(seed)
    null = []
    for _ in range(perms):
        sh = offs[:]
        rng.shuffle(sh)
        null.append(lock_scan([w + o for w, o in zip(walls, sh)], *band)[0])
    p95 = pct(null, 0.95)
    p = (1 + sum(1 for v in null if v >= obs)) / (1 + len(null))
    return {"R": obs, "period": period, "null_p95": p95, "p": p, "span": span,
            "locked": len(rows) >= MIN_LOCK_N and obs > p95 and p < ALPHA}


def is_subharmonic(t1, t100):
    """Is a 100 ms lock just the k-th sub-harmonic of a locked 1 s lattice (the same lattice)?

    A 1 s lattice has exact sub-harmonics at 1 s / k, and 1 s / 10 falls inside the 100 ms band. The match
    tolerance is the measured resolution of the two periods (about period^2 / span each, three times
    over), capped at 1% of the 1 s period; a fixed 1% would also swallow a genuine 100 ms lock whose
    period is within 10 ms of a tenth of the 1 s one."""
    if not (t1["locked"] and t100["locked"]) or t100["period"] <= 0:
        return False
    k = round(t1["period"] / t100["period"])
    if k < 1:
        return False
    span = max(min(t1["span"], t100["span"]), 1e-9)
    tol = 3.0 * (t1["period"] ** 2 + k * t100["period"] ** 2) / span
    tol = min(tol, 0.01 * t1["period"])
    return abs(k * t100["period"] - t1["period"]) < tol


def fmt_ci(ci):
    return f"[{ci[0]:.0f}, {ci[1]:.0f}]"


def med(v):
    return statistics.median(v)


def bootstrap(by_block, design, boot, seed):
    """One joint resample per iteration, within each block, of the pairs. Returns name -> list of values.

    by_block[label] = dict of aligned lists over the block's pairs: wp, ws, fp, fs, sp, ss (slow flags)."""
    rng = random.Random(seed)
    treats = []
    for _, t in design:
        if t not in treats:
            treats.append(t)
    out = {}

    def put(name, v):
        out.setdefault(name, []).append(v)

    for _ in range(boot):
        diffs_w, diffs_f, pw, pf, sl = {}, {}, {}, {}, {}
        per_block = {}
        for label, t in design:
            b = by_block[label]
            n = len(b["wp"])
            idx = [rng.randrange(n) for _ in range(n)]
            dw = [b["wp"][i] - b["ws"][i] for i in idx]
            df_ = [b["fp"][i] - b["fs"][i] for i in idx]
            per_block[label] = (med(dw), med(df_))
            diffs_w.setdefault(t, []).extend(dw)
            diffs_f.setdefault(t, []).extend(df_)
            pw.setdefault(t, []).extend(b["wp"][i] for i in idx)
            pf.setdefault(t, []).extend(b["fp"][i] for i in idx)
            sl.setdefault(t, []).extend(int(b["sp"][i]) - int(b["ss"][i]) for i in idx)
            put(f"block_wait_delta:{label}", per_block[label][0])
            put(f"block_fb_delta:{label}", per_block[label][1])
        for t in treats:
            put(f"wait_delta:{t}", med(diffs_w[t]))
            put(f"fb_delta:{t}", med(diffs_f[t]))
            put(f"p_wait:{t}", med(pw[t]))
            put(f"p_fb:{t}", med(pf[t]))
            put(f"slow_delta:{t}", sum(sl[t]) / len(sl[t]))
        put("did_wait", med(diffs_w["relist100"]) - med(diffs_w["stock"]))
        put("did_fb", med(diffs_f["relist100"]) - med(diffs_f["stock"]))
        put("did_slow", sum(sl["relist100"]) / len(sl["relist100"]) - sum(sl["stock"]) / len(sl["stock"]))
        if "oke" in treats:
            put("build_wait", med(diffs_w["stock"]) - med(diffs_w["oke"]))
            put("build_fb", med(diffs_f["stock"]) - med(diffs_f["oke"]))
        for t in treats:
            labels = [b for b, tt in design if tt == t]
            if len(labels) >= 2:
                put(f"carry:{t}", per_block[labels[-1]][0] - per_block[labels[0]][0])
    return out


def ci95(vals):
    return pct(vals, 0.025), pct(vals, 0.975)


def ci99(vals):
    return pct(vals, 0.005), pct(vals, 0.995)


def reading(verdict):
    return {
        "INVALID_NODES": "P or S rows span more than one node, or P and S share a node; the arms are "
                         "not what the design says. Nothing is judged.",
        "INVALID_LOCK_PERSISTS": "the 1 s lock persists on P under relist100: the binary is not running "
                                 "or the relist is not the lock's source. Any move in the wait is "
                                 "reported, not attributed to the relist.",
        "INCONCLUSIVE_LOCK_MIXED": "the 1 s lock persists in some relist100 blocks but not all: one "
                                   "block does not condemn the binary and the others do not clear it. "
                                   "Check the relist metric for each block, then repeat.",
        "NO_BASELINE_LOCK": "no 1 s lock on P under the stock build, so there is no lock to remove. "
                            "Wait results are reported, not attributed.",
        "CARRYOVER": "blocks of one treatment differ by more than chance (99% interval excludes 0): "
                     "the blocks are not exchangeable, so the contrast is order-confounded.",
        "FLOOR_WAIT_UNMOVED": "the 1 s lock is gone but the wait did not move (difference in "
                              "differences includes 0): the wait is elsewhere in the pod path.",
        "WAIT_WORSE": "the wait got longer under relist100 (difference in differences above 0).",
        "FLOOR_WAIT_PARTIAL": "the wait moved down but P's relist100 wait is not at or under "
                              f"{WAIT_COLLAPSE_MS:.0f} ms: part of the wait is not the relist.",
        "WAIT_REMOVED_LOCK_UNSEEN": "the wait collapsed and the 1 s lock is gone, but no 100 ms lock "
                                    "was detected: the wait is attributed to the relist constant, "
                                    "the lock mechanism is not confirmed. This may be the best verdict "
                                    "reachable: a simulated 100 ms lock was detected in 0 of 12 runs at "
                                    "1 ms per-cycle jitter and 9 of 12 at 0.5 ms. The wait is the "
                                    "primary signal; the lock is secondary.",
        "RELIST_IS_WAIT_GOAL_MET_ONCE": "the relist is the wait (lock moved from 1 s to 100 ms, wait "
                                        "collapsed) and the goal interval is under 1000 ms in this "
                                        "run. One run is not a pass.",
        "RELIST_IS_WAIT_FLOOR": "the relist is the wait (lock moved from 1 s to 100 ms, wait "
                                "collapsed) but the goal interval is not under 1000 ms: a floor.",
    }[verdict]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("jsonl")
    ap.add_argument("--p-arm", default="p")
    ap.add_argument("--s-arm", default="s")
    ap.add_argument("--blocks", default=DEFAULT_BLOCKS)
    ap.add_argument("--perms", type=int, default=100)
    ap.add_argument("--boot", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args(argv)
    if args.perms < MIN_PERMS:
        ap.error(f"--perms must be at least {MIN_PERMS} (p <= 0.05 divided by the two relist100 blocks is unreachable below that)")
    if args.boot < 100:
        ap.error("--boot must be at least 100")

    try:
        design = parse_blocks(args.blocks)
        rows, failed, total, reasons = load_rows(args.jsonl, args.p_arm, args.s_arm, design)
    except InputError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    pairs, unpaired = pair_rows(rows, args.p_arm, args.s_arm)
    try:
        gate(design, pairs, failed, total)
    except SampleError as e:
        print(f"refused: {e}. Nothing is judged from this sample.", file=sys.stderr)
        return 3
    except FailureRateError as e:
        print(f"refused: {e}. Nothing is judged from this sample.", file=sys.stderr)
        return 4

    treat_of = dict(design)
    print(f"ceiling analysis: {args.jsonl}")
    print(f"rows read {sum(total.values())}, unusable {sum(failed.values())} {reasons}; "
          f"usable pairs {sum(len(v) for v in pairs.values())}, unpaired rounds {sum(unpaired.values())}")
    print(f"gate: every block >= {MIN_BLOCK_PAIRS} complete pairs and <= {MAX_FAILED_FRACTION:.0%} "
          "unusable wakes, passed")
    print(f"{'block':7s}{'treatment':11s}{'pairs':>6s}{'unusable':>9s}  P node / S node")

    p_nodes, s_nodes = set(), set()
    by_block = {}
    for label, t in design:
        prs = pairs[label]
        pn = {p["node"] for p, _ in prs}
        sn = {s["node"] for _, s in prs}
        p_nodes |= pn
        s_nodes |= sn
        print(f"{label:7s}{t:11s}{len(prs):6d}{failed.get(label, 0):9d}  "
              f"{','.join(sorted(pn))} / {','.join(sorted(sn))}")
        by_block[label] = {
            "wp": [p["wait"] for p, _ in prs], "ws": [s["wait"] for _, s in prs],
            "fp": [p["fb"] for p, _ in prs], "fs": [s["fb"] for _, s in prs],
            "sp": [(p["uf"] - p["bound"]) >= SLOW_CUT_MS for p, _ in prs],
            "ss": [(s["uf"] - s["bound"]) >= SLOW_CUT_MS for _, s in prs],
        }
    nodes_ok = len(p_nodes) == 1 and len(s_nodes) == 1 and not (p_nodes & s_nodes)
    foreign_p = sum(1 for r in rows if r["arm"] == args.p_arm and r["foreign"])
    foreign_s = sum(1 for r in rows if r["arm"] == args.s_arm and r["foreign"])
    for tag, arm in (("P", args.p_arm), ("S", args.s_arm)):
        rt = sorted(r["rtt"] for r in rows if r["arm"] == arm)
        print(f"clock offset round trip, {tag}: median {med(rt):.1f} ms, max {rt[-1]:.1f} ms "
              f"(offset error is at most half of it; rows over {MAX_CLOCK_RTT_MS:.0f} ms are unusable)")
    print(f"nodes: P {sorted(p_nodes)}, S {sorted(s_nodes)} -> {'ok' if nodes_ok else 'INVALID'}")
    if foreign_p or foreign_s:
        print(f"WARNING: other workloads appeared on the woken node: {foreign_p} wakes on P, "
              f"{foreign_s} on S (the runbook aborts on any on P)")

    print("\n== cycle lock, per block and arm (arrival = wall_start + pod_ip; per-group shuffled null, "
          f"perms={args.perms}, alpha={ALPHA}); never pooled across blocks: a kubelet restart resets the "
          "phase")
    print(f"{'block':6s}{'treat':10s}{'arm':4s}{'node':14s}{'band':7s}{'R':>6s}{'period':>9s}"
          f"{'null_p95':>9s}{'p':>7s}  locked")
    l1_p, l100_p, l1_s, p1_p = {}, {}, {}, {}
    for label, t in design:
        for tag, getter in (("P", lambda pr: pr[0]), ("S", lambda pr: pr[1])):
            grp = [getter(pr) for pr in pairs[label]]
            node = grp[0]["node"]
            t1 = lock_test(grp, BAND_1S, args.perms, args.seed)
            results = [("1s", t1, t1["locked"], "")]
            if tag == "P":
                t100 = lock_test(grp, BAND_100MS, args.perms, args.seed)
                alias = is_subharmonic(t1, t100)
                results.append(("100ms", t100, t100["locked"] and not alias,
                                " (sub-harmonic of the 1s lock)" if alias else ""))
                l100_p[label] = t100["locked"] and not alias
                l1_p[label] = t1["locked"]
                p1_p[label] = t1["p"]
            else:
                l1_s[label] = t1["locked"]
            for band, tt, locked, note in results:
                print(f"{label:6s}{t:10s}{tag:4s}{node:14.14s}{band:7s}{tt['R']:6.3f}{tt['period']:9.5f}"
                      f"{tt['null_p95']:9.3f}{tt['p']:7.3f}  {'yes' if locked else 'no'}{note}")

    boots = bootstrap(by_block, design, args.boot, args.seed)
    treats = []
    for _, t in design:
        if t not in treats:
            treats.append(t)
    print(f"\n== wait = pod IP minus queue-proxy first log (ms); intervals are {args.boot}-resample "
          "bootstraps over pairs, resampled within each block. The blocks themselves are treated as fixed: "
          "block-to-block variance is not resampled, so intervals are narrower than a random-block model "
          "would give")
    for label, t in design:
        b = by_block[label]
        print(f"{label:6s}{t:10s} P median {med(b['wp']):6.0f}   S median {med(b['ws']):6.0f}   "
              f"P-S delta {med([x - y for x, y in zip(b['wp'], b['ws'])]):6.0f} "
              f"{fmt_ci(ci95(boots[f'block_wait_delta:{label}']))}")
    for t in treats:
        print(f"wait P-S  {t:10s}{med(boots[f'wait_delta:{t}']):7.0f} {fmt_ci(ci95(boots[f'wait_delta:{t}']))}"
              f"   P wait median {med(boots[f'p_wait:{t}']):5.0f} {fmt_ci(ci95(boots[f'p_wait:{t}']))}")
    did_w = ci95(boots["did_wait"])
    p_rel_w = ci95(boots["p_wait:relist100"])
    print(f"wait DiD (relist100 - stock): {statistics.median(boots['did_wait']):.0f} {fmt_ci(did_w)}")
    if "build_wait" in boots:
        print(f"wait build effect (stock - oke): {statistics.median(boots['build_wait']):.0f} "
              f"{fmt_ci(ci95(boots['build_wait']))}")
    carry_flag = False
    for t in treats:
        if f"carry:{t}" in boots:
            c = ci99(boots[f"carry:{t}"])
            bad = c[0] > 0 or c[1] < 0
            carry_flag = carry_flag or bad
            print(f"carryover {t} (last block - first block, P-S wait delta): "
                  f"{statistics.median(boots[f'carry:{t}']):.0f} {fmt_ci(c)} 99% -> "
                  f"{'DIFFERS' if bad else 'no detectable difference'}")

    print("\n== first byte (ms)")
    for t in treats:
        print(f"fb P-S  {t:10s}{med(boots[f'fb_delta:{t}']):7.0f} {fmt_ci(ci95(boots[f'fb_delta:{t}']))}"
              f"   P median {med(boots[f'p_fb:{t}']):5.0f} {fmt_ci(ci95(boots[f'p_fb:{t}']))}")
    print(f"first byte DiD (relist100 - stock): {statistics.median(boots['did_fb']):.0f} "
          f"{fmt_ci(ci95(boots['did_fb']))}")
    for t in treats:
        pf = [p["fb"] for lb, tt in design if tt == t for p, _ in pairs[lb]]
        sf = [s["fb"] for lb, tt in design if tt == t for _, s in pairs[lb]]
        print(f"p95 {t:10s} P {pct(pf, 0.95):6.0f}  S {pct(sf, 0.95):6.0f}   descriptive only: "
              f"n={len(pf)} pairs, the tail is too thin to judge")
    ci_share = ci95(boots["did_slow"])
    print(f"slower cluster (bound -> user first log >= {SLOW_CUT_MS:.0f} ms), share DiD "
          f"(relist100 - stock): {statistics.mean(boots['did_slow']):+.3f} "
          f"[{ci_share[0]:+.3f}, {ci_share[1]:+.3f}] -> "
          f"{'changed (interval excludes 0)' if ci_share[0] > 0 or ci_share[1] < 0 else 'no detectable change (this n cannot show equality)'}")

    stock_b = [b for b, t in design if t == "stock"]
    relist_b = [b for b, t in design if t == "relist100"]
    baseline = all(l1_p[b] for b in stock_b)
    # Persistence is judged at alpha divided by the number of relist100 blocks (any() of k tests at alpha
    # would flag a working patch about 10% of the time with k = 2) and needs every block: one block does
    # not condemn the binary.
    strict = [b for b in relist_b if l1_p[b] and p1_p[b] <= ALPHA / len(relist_b)]
    persists = len(strict) == len(relist_b)
    mixed = bool(strict) and not persists
    lock100 = all(l100_p[b] for b in relist_b)
    s_locked = sum(1 for v in l1_s.values() if v)
    went_down, went_up = did_w[1] < 0, did_w[0] > 0
    collapsed = p_rel_w[1] <= WAIT_COLLAPSE_MS
    goal_ci = ci95(boots["p_fb:relist100"])
    goal_met = goal_ci[1] < GOAL_MS

    if not nodes_ok:
        verdict = "INVALID_NODES"
    elif persists:
        verdict = "INVALID_LOCK_PERSISTS"
    elif not baseline:
        verdict = "NO_BASELINE_LOCK"
    elif mixed:
        verdict = "INCONCLUSIVE_LOCK_MIXED"
    elif carry_flag:
        verdict = "CARRYOVER"
    elif went_up:
        verdict = "WAIT_WORSE"
    elif not went_down:
        verdict = "FLOOR_WAIT_UNMOVED"
    elif not collapsed:
        verdict = "FLOOR_WAIT_PARTIAL"
    elif not lock100:
        verdict = "WAIT_REMOVED_LOCK_UNSEEN"
    else:
        verdict = "RELIST_IS_WAIT_GOAL_MET_ONCE" if goal_met else "RELIST_IS_WAIT_FLOOR"

    print("\n== verdict")
    print(f"1s lock on P: stock blocks {'all' if baseline else 'not all'} locked; relist100 blocks "
          f"{len(strict)} of {len(relist_b)} locked at 1 s (each at alpha / {len(relist_b)}); 100ms lock on P "
          f"in relist100 blocks: {'all' if lock100 else 'not all'}; 1s lock on S in {s_locked} of "
          f"{len(l1_s)} blocks")
    print(f"wait: DiD {fmt_ci(did_w)} ({'down' if went_down else 'up' if went_up else 'includes 0'}); "
          f"P relist100 wait upper bound {p_rel_w[1]:.0f} ms vs {WAIT_COLLAPSE_MS:.0f} ms "
          f"({'collapsed' if collapsed else 'not collapsed'})")
    unattributable = verdict in ("INVALID_NODES", "INVALID_LOCK_PERSISTS", "NO_BASELINE_LOCK",
                                 "INCONCLUSIVE_LOCK_MIXED", "CARRYOVER")
    if unattributable:
        print("goal criterion: not evaluated (the run is invalid or the contrast is not attributable)")
    else:
        print(f"goal criterion: P relist100 median first byte interval {fmt_ci(goal_ci)}, under "
              f"{GOAL_MS:.0f} ms: {'met in this run' if goal_met else 'not met'}")
    print(f"VERDICT: {verdict}")
    print(f"reading: {reading(verdict)}")
    if not unattributable and not goal_met:
        print("report as a floor: the goal is not met on this node under this change; the relist100 "
              "median is the floor, not a shipped default.")
    print("one run is not a pass: first-byte medians vary 1276-1806 ms run to run with no change.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
