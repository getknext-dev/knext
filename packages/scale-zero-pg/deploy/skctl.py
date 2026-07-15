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
  version                          -> "format_version=9 compat_neon_tag=<tag>"
  checkver --file PATH             -> assert PATH is a v9 control file, else abort
                                      loudly (runtime guard for the restore path)

The (de)serializer round-trips a real neon control file byte-identically and is
covered by deploy/test_skctl.py (run in CI). unpack_control() HARD-FAILS on wrong
magic / unsupported version / CRC mismatch — see SK_CONTROL_VERSION below.
"""
import base64
import struct
import sys

DEFAULT_WSS = 16 * 1024 * 1024  # 16 MiB

# --- on-disk format identity (reverse-engineered from a live safekeeper) -------
# skctl speaks EXACTLY ONE safekeeper.control format. If neon's on-disk struct
# changes (v10+), a crafted file would be structurally wrong and writable restore
# would silently corrupt — so both the parser (unpack_control) and _validate.sh
# (issue #22) hard-fail on any divergence from this pair.
SK_CONTROL_MAGIC = 0xCAFECEEF
SK_CONTROL_VERSION = 9
# The neon image tag this format was reverse-engineered against. Bumping the
# `neon:` tag in deploy/ REQUIRES re-validating safekeeper.control (dump one from
# the new image, re-run test_skctl.py against it) and updating this constant.
# deploy/_validate.sh asserts this equals the pinned compute/storage tag.
# See docs/operations.md "skctl format coupling".
SK_COMPAT_NEON_TAG = "8464"

_UPGRADE_HINT = (
    "skctl speaks safekeeper.control v%d only (reverse-engineered from neon:%s). "
    "Bumping the neon image requires re-validating the on-disk format and updating "
    "SK_CONTROL_VERSION / SK_COMPAT_NEON_TAG — see docs/operations.md "
    "'skctl format coupling'." % (SK_CONTROL_VERSION, SK_COMPAT_NEON_TAG)
)


class ControlFormatError(Exception):
    """Raised when bytes are not a valid v%d safekeeper.control file. Never let a
    malformed/foreign-version file misparse silently into a corrupt restore.""" % SK_CONTROL_VERSION


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
    b += struct.pack("<II", SK_CONTROL_MAGIC, SK_CONTROL_VERSION)
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


def unpack_control(b):
    """Parse a v9 safekeeper.control blob into the dict pack_control() consumes.

    Round-trips byte-identically with pack_control(). HARD-FAILS (ControlFormatError)
    on wrong magic, unsupported version, CRC mismatch, or truncation — a foreign or
    corrupt file must never be silently misread into a structurally-wrong restore.
    """
    if len(b) < 12:
        raise ControlFormatError("control file too short (%d bytes)" % len(b))
    magic, version = struct.unpack_from("<II", b, 0)
    if magic != SK_CONTROL_MAGIC:
        raise ControlFormatError(
            "bad magic %#010x (expected %#010x) — not a safekeeper.control file"
            % (magic, SK_CONTROL_MAGIC))
    if version != SK_CONTROL_VERSION:
        raise ControlFormatError(
            "unsupported control-file version %d (expected %d). %s"
            % (version, SK_CONTROL_VERSION, _UPGRADE_HINT))
    if crc32c(b[:-4]) != struct.unpack_from("<I", b, len(b) - 4)[0]:
        raise ControlFormatError("crc32c mismatch — control file is corrupt")

    off = [8]  # cursor past magic+version

    def take(fmt):
        n = struct.calcsize(fmt)
        if off[0] + n > len(b) - 4:
            raise ControlFormatError("control file truncated (reading %s)" % fmt)
        v = struct.unpack_from(fmt, b, off[0])
        off[0] += n
        return v

    def take_str():
        (n,) = take("<Q")
        if off[0] + n > len(b) - 4:
            raise ControlFormatError("control file truncated (string of %d bytes)" % n)
        s = b[off[0]:off[0] + n].decode()
        off[0] += n
        return s

    st = {}
    st["tenant_id"] = take_str()
    st["timeline_id"] = take_str()
    (st["term"],) = take("<Q")
    (nhist,) = take("<Q")
    st["term_history"] = [tuple(take("<QQ")) for _ in range(nhist)]
    (st["pg_version"],) = take("<I")
    (st["system_id"],) = take("<Q")
    (st["wal_seg_size"],) = take("<I")
    st["proposer_uuid"] = take_str()
    for k in ("timeline_start_lsn", "local_start_lsn", "commit_lsn",
              "backup_lsn", "peer_horizon_lsn", "remote_consistent_lsn"):
        (st[k],) = take("<Q")
    (st["pb_leading"],) = take("<Q")
    (nsegs,) = take("<Q")
    st["segments"] = []
    for _ in range(nsegs):
        (status,) = take("<I")
        name = take_str()
        commit, flush, term = take("<QQQ")
        st["segments"].append(
            dict(status=status, name=name, commit=commit, flush=flush, term=term))
    (st["eviction_state"],) = take("<I")
    if off[0] != len(b) - 4:
        raise ControlFormatError(
            "trailing %d unexpected bytes before crc — format drift?" % (len(b) - 4 - off[0]))
    return st


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


def cmd_version():
    # machine-parseable; deploy/_validate.sh + operators read the coupling here.
    print("format_version=%d compat_neon_tag=%s" % (SK_CONTROL_VERSION, SK_COMPAT_NEON_TAG))


def cmd_checkver():
    # Runtime guard for the restore path: parse a control file dumped from the LIVE
    # safekeeper and abort loudly unless it is the version skctl targets. Reject a
    # foreign-format plane BEFORE crafting a structurally-wrong file.
    path = _argval("--file", required=True)
    with open(path, "rb") as f:
        blob = f.read()
    try:
        unpack_control(blob)
    except ControlFormatError as e:
        sys.exit("skctl checkver: %s" % e)
    print("ok - control file is v%d (%s)" % (SK_CONTROL_VERSION, path))


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd = sys.argv[1]
    {"craft": cmd_craft, "seg": cmd_seg, "segrange": cmd_segrange,
     "off": cmd_off, "version": cmd_version, "checkver": cmd_checkver
     }.get(cmd, lambda: sys.exit("skctl: unknown cmd %s" % cmd))()


if __name__ == "__main__":
    main()
