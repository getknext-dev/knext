#!/usr/bin/env python3
"""skctl.py — neon safekeeper on-disk state helper for the writable-restore drill.

WHY THIS EXISTS (and why it is Python, not Go/sh)
-------------------------------------------------
Promoting a restored plane to a read-WRITE primary on neon:8464 OSS requires
re-seeding a fresh safekeeper's on-disk timeline from the backed-up WAL. That
means writing a byte-exact `safekeeper.control` file: a small binary struct
(magic 0xcafeceef, format version 9) terminated by a CRC32C (Castagnoli)
checksum over the body. There is NO `safekeeper --load-control-file` on 8464
(only `--dump-control-file`), no HTTP timeline-create (POST/PUT -> 404), and no
storage controller — so the file must be crafted directly.

Hand-rolling little-endian struct packing + CRC32C in POSIX sh is error-prone;
this is pure binary-format tooling, not a Kubernetes controller, so a tiny
build-time Python helper is the pragmatic glue (CLAUDE.md rule 1 targets
k8s-native runtime code, not a byte serializer). The format was reverse
engineered from a live safekeeper and the serializer round-trips a real control
file byte-identically (see the drill's evidence).

The struct (v9), all little-endian, strings are u64-len-prefixed ASCII:
  u32 magic=0xcafeceef ; u32 version=9
  str tenant_id ; str timeline_id
  u64 term ; u64 nhist ; [u64 term, u64 lsn] * nhist          # acceptor_state
  u32 pg_version ; u64 system_id ; u32 wal_seg_size           # server
  str proposer_uuid (32 ASCII '0')
  u64 timeline_start_lsn ; u64 local_start_lsn
  u64 commit_lsn ; u64 backup_lsn ; u64 peer_horizon_lsn ; u64 remote_consistent_lsn
  u64 partial_backup.leading(=0) ; u64 nsegs ; [seg]*nsegs    # partial_backup
  u32 eviction_state(=0 Present)
  u32 crc32c(body)                                            # trailer

Subcommands:
  craft   --commit LSN --start LSN [--term N] --sysid N --pgv N --wss N
          -> base64 of a crafted control file positioned at --commit
  seg     --lsn LSN [--wss N]      -> the 24-hex WAL segment filename for LSN
  segrange --from LSN --to LSN [--wss N] -> newline list of segment filenames
  off     --lsn LSN [--wss N]      -> "<segfile> <byte_offset>" for truncation
"""
import base64
import struct
import sys

DEFAULT_WSS = 16 * 1024 * 1024  # 16 MiB


def crc32c(b):
    crc = 0xFFFFFFFF
    poly = 0x82F63B78  # Castagnoli, reflected
    for byte in b:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (poly & -(crc & 1))
    return crc ^ 0xFFFFFFFF


def lsn2int(s):
    s = s.strip()
    if "/" in s:
        hi, lo = s.split("/")
        return (int(hi, 16) << 32) | int(lo, 16)
    return int(s, 0)


def seg_no(lsn, wss):
    return lsn // wss


def seg_name(lsn, wss, tli=1):
    n = seg_no(lsn, wss)
    per_xlogid = (1 << 32) // wss
    hi = n // per_xlogid
    lo = n % per_xlogid
    return "%08X%08X%08X" % (tli, hi, lo)


def pack_control(st):
    b = bytearray()
    b += struct.pack("<II", 0xCAFECEEF, 9)
    for k in ("tenant_id", "timeline_id"):
        s = st[k].encode()
        b += struct.pack("<Q", len(s)) + s
    b += struct.pack("<Q", st["term"])
    b += struct.pack("<Q", len(st["term_history"]))
    for t, l in st["term_history"]:
        b += struct.pack("<QQ", t, l)
    b += struct.pack("<I", st["pg_version"])
    b += struct.pack("<Q", st["system_id"])
    b += struct.pack("<I", st["wal_seg_size"])
    pu = st["proposer_uuid"].encode()
    b += struct.pack("<Q", len(pu)) + pu
    for k in ("timeline_start_lsn", "local_start_lsn", "commit_lsn",
              "backup_lsn", "peer_horizon_lsn", "remote_consistent_lsn"):
        b += struct.pack("<Q", st[k])
    b += struct.pack("<Q", st["pb_leading"])
    b += struct.pack("<Q", len(st["segments"]))
    for seg in st["segments"]:
        nm = seg["name"].encode()
        b += struct.pack("<I", seg["status"]) + struct.pack("<Q", len(nm)) + nm
        b += struct.pack("<QQQ", seg["commit"], seg["flush"], seg["term"])
    b += struct.pack("<I", st["eviction_state"])
    b += struct.pack("<I", crc32c(bytes(b)))
    return bytes(b)


def _argval(flag, default=None, required=False):
    if flag in sys.argv:
        return sys.argv[sys.argv.index(flag) + 1]
    if required:
        sys.exit("skctl: missing required %s" % flag)
    return default


def cmd_craft():
    wss = int(_argval("--wss", DEFAULT_WSS))
    commit = lsn2int(_argval("--commit", required=True))
    start = lsn2int(_argval("--start", required=True))
    term = int(_argval("--term", "40"))
    sysid = int(_argval("--sysid", required=True))
    pgv = int(_argval("--pgv", required=True))
    # timeline_start must not sit above the position we are pinning to.
    if start > commit:
        start = commit
    st = dict(
        tenant_id=_argval("--tenant", "f000f000f000f000f000f000f000f001"),
        timeline_id=_argval("--timeline", "f000f000f000f000f000f000f000f002"),
        term=term, term_history=[(term, start)],
        pg_version=pgv, system_id=sysid, wal_seg_size=wss,
        proposer_uuid="0" * 32,
        timeline_start_lsn=start, local_start_lsn=start,
        commit_lsn=commit, backup_lsn=(commit >> 24) << 24,
        peer_horizon_lsn=commit, remote_consistent_lsn=commit,
        pb_leading=0, segments=[], eviction_state=0,
    )
    sys.stdout.write(base64.b64encode(pack_control(st)).decode())


def cmd_seg():
    wss = int(_argval("--wss", DEFAULT_WSS))
    print(seg_name(lsn2int(_argval("--lsn", required=True)), wss))


def cmd_segrange():
    wss = int(_argval("--wss", DEFAULT_WSS))
    a = seg_no(lsn2int(_argval("--from", required=True)), wss)
    b = seg_no(lsn2int(_argval("--to", required=True)), wss)
    if a < 0:
        a = 0
    for n in range(a, b + 1):
        print(seg_name(n * wss, wss))


def cmd_off():
    wss = int(_argval("--wss", DEFAULT_WSS))
    lsn = lsn2int(_argval("--lsn", required=True))
    seg_start = (lsn // wss) * wss
    off = lsn - seg_start
    name = seg_name(lsn, wss)
    if off == 0:
        # boundary: truncate the PREVIOUS segment at its full length so flush==lsn
        name = seg_name(lsn - 1, wss)
        off = wss
    print("%s %d" % (name, off))


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd = sys.argv[1]
    {"craft": cmd_craft, "seg": cmd_seg, "segrange": cmd_segrange,
     "off": cmd_off}.get(cmd, lambda: sys.exit("skctl: unknown cmd %s" % cmd))()


if __name__ == "__main__":
    main()
