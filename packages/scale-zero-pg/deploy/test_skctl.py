#!/usr/bin/env python3
"""Tests for skctl.py — the reverse-engineered safekeeper.control (de)serializer
that writable restore (deploy/_restore-writable.sh) depends on.

WHY THESE EXIST
---------------
`skctl.py` hand-packs a binary `safekeeper.control` struct (magic 0xcafeceef,
format version 9, CRC32C trailer) reverse-engineered from a live neon:8464
safekeeper. It is load-bearing for disaster restore yet had zero automated
coverage (issue #24) and no guard against the neon on-disk format changing under
it (issue #22). A silent packer regression, or a neon image bump that changes the
struct, would produce a *structurally-wrong* control file — a "successful"
restore that is subtly corrupt, the hardest class of failure to detect.

WHAT THE FIXTURE PROVES
-----------------------
`testdata/safekeeper.control.real` is a REAL 1205-byte control file pulled from a
running safekeeper-0 pod on the OKE cluster (neon:8464). It is cluster-internal
state for the drill's synthetic tenant (f000…f001) — no secrets. The round-trip
test proves skctl parses this real neon-written binary and re-serializes it
BYTE-IDENTICALLY: the claim "round-trips a live control file byte-identically"
is now guarded, not just asserted in a commit message.

Stdlib only (unittest) — runs in CI without a cluster or pip installs.
"""
import importlib.util
import os
import struct
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "testdata", "safekeeper.control.real")

# skctl.py is a script, not an importable package — load it by path.
_spec = importlib.util.spec_from_file_location("skctl", os.path.join(HERE, "skctl.py"))
skctl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(skctl)


def real_bytes():
    with open(FIXTURE, "rb") as f:
        return f.read()


class RealControlFileRoundTrip(unittest.TestCase):
    """parse(real neon-written file) -> serialize -> identical bytes."""

    def test_fixture_present_and_v9(self):
        b = real_bytes()
        self.assertEqual(len(b), 1205, "fixture size drifted — re-pull from a live safekeeper")
        magic, ver = struct.unpack_from("<II", b, 0)
        self.assertEqual(magic, skctl.SK_CONTROL_MAGIC)
        self.assertEqual(ver, skctl.SK_CONTROL_VERSION)

    def test_round_trip_is_byte_identical(self):
        b = real_bytes()
        st = skctl.unpack_control(b)
        self.assertEqual(
            skctl.pack_control(st), b,
            "skctl no longer round-trips a REAL neon:8464 control file byte-identically",
        )

    def test_crc_trailer_matches_recomputed(self):
        b = real_bytes()
        body, trailer = b[:-4], struct.unpack_from("<I", b, len(b) - 4)[0]
        self.assertEqual(skctl.crc32c(body), trailer)


class FieldLevelAssertions(unittest.TestCase):
    """Known values decoded from the real fixture (cross-checked against
    `safekeeper --dump-control-file`)."""

    @classmethod
    def setUpClass(cls):
        cls.st = skctl.unpack_control(real_bytes())

    def test_identity(self):
        self.assertEqual(self.st["tenant_id"], "f000f000f000f000f000f000f000f001")
        self.assertEqual(self.st["timeline_id"], "f000f000f000f000f000f000f000f002")

    def test_server_fields(self):
        self.assertEqual(self.st["pg_version"], 170005)
        self.assertEqual(self.st["system_id"], 7658049250853740573)
        self.assertEqual(self.st["wal_seg_size"], 16 * 1024 * 1024)

    def test_acceptor_state(self):
        self.assertEqual(self.st["term"], 55)
        self.assertEqual(len(self.st["term_history"]), 54)
        # first & last history entries (from the dump)
        self.assertEqual(self.st["term_history"][0], (2, 0x14E8F98))
        self.assertEqual(self.st["term_history"][-1], (55, 0x18DF32448))

    def test_lsns(self):
        self.assertEqual(self.st["commit_lsn"], 0x18DF36A00)
        self.assertEqual(self.st["backup_lsn"], 0x18D000000)
        self.assertEqual(self.st["peer_horizon_lsn"], 0x18DF36A00)
        self.assertEqual(self.st["remote_consistent_lsn"], 0x28DA95A8)
        self.assertEqual(self.st["timeline_start_lsn"], 0x14E8F98)
        self.assertEqual(self.st["proposer_uuid"], "0" * 32)

    def test_partial_backup_segment(self):
        self.assertEqual(self.st["pb_leading"], 0)
        self.assertEqual(len(self.st["segments"]), 1)
        seg = self.st["segments"][0]
        self.assertEqual(
            seg["name"],
            "00000001000000010000008D_55_000000018DF36A00_000000018DF36A00_sk1.partial",
        )
        self.assertEqual(seg["status"], 1)  # Uploaded
        self.assertEqual(seg["commit"], 0x18DF36A00)
        self.assertEqual(seg["flush"], 0x18DF36A00)
        self.assertEqual(seg["term"], 55)

    def test_eviction_state_present(self):
        self.assertEqual(self.st["eviction_state"], 0)  # Present


class RejectMalformed(unittest.TestCase):
    """A bad file must raise loudly — never silently misparse into a
    structurally-wrong restore."""

    def test_bad_magic_rejected(self):
        b = bytearray(real_bytes())
        struct.pack_into("<I", b, 0, 0xDEADBEEF)
        with self.assertRaises(skctl.ControlFormatError):
            skctl.unpack_control(bytes(b))

    def test_wrong_version_rejected(self):
        b = bytearray(real_bytes())
        struct.pack_into("<I", b, 4, 10)  # pretend it's a future v10
        with self.assertRaisesRegex(skctl.ControlFormatError, r"version"):
            skctl.unpack_control(bytes(b))

    def test_corrupt_body_fails_crc(self):
        b = bytearray(real_bytes())
        b[100] ^= 0xFF  # flip a byte inside the body
        with self.assertRaisesRegex(skctl.ControlFormatError, r"crc"):
            skctl.unpack_control(bytes(b))

    def test_truncated_file_rejected(self):
        with self.assertRaises(skctl.ControlFormatError):
            skctl.unpack_control(real_bytes()[:8])


class SerializerDeterminism(unittest.TestCase):
    def test_pack_is_deterministic(self):
        st = skctl.unpack_control(real_bytes())
        self.assertEqual(skctl.pack_control(st), skctl.pack_control(st))

    def test_crafted_file_self_round_trips(self):
        # craft-shaped state (empty segments, single-entry history) must also
        # survive parse->pack unchanged.
        st = dict(
            tenant_id="f000f000f000f000f000f000f000f001",
            timeline_id="f000f000f000f000f000f000f000f002",
            term=40, term_history=[(40, 0x14E8F98)],
            pg_version=170005, system_id=7658049250853740573,
            wal_seg_size=16 * 1024 * 1024, proposer_uuid="0" * 32,
            timeline_start_lsn=0x14E8F98, local_start_lsn=0x14E8F98,
            commit_lsn=0x18E000000, backup_lsn=0x18E000000,
            peer_horizon_lsn=0x18E000000, remote_consistent_lsn=0x18E000000,
            pb_leading=0, segments=[], eviction_state=0,
        )
        packed = skctl.pack_control(st)
        self.assertEqual(skctl.pack_control(skctl.unpack_control(packed)), packed)


class SegmentMath(unittest.TestCase):
    """seg/off helpers cross-checked against the real partial segment."""

    WSS = 16 * 1024 * 1024

    def test_seg_name_matches_real_partial(self):
        # commit_lsn 1/8DF36A00 lives in segment 00000001000000010000008D
        self.assertEqual(skctl.seg_name(0x18DF36A00, self.WSS), "00000001000000010000008D")

    def test_seg_no_and_lsn2int(self):
        self.assertEqual(skctl.lsn2int("1/8DF36A00"), 0x18DF36A00)
        self.assertEqual(skctl.seg_no(0x18DF36A00, self.WSS), 0x18DF36A00 // self.WSS)


class VersionCoupling(unittest.TestCase):
    def test_declared_version_is_nine(self):
        self.assertEqual(skctl.SK_CONTROL_VERSION, 9)

    def test_compat_neon_tag_declared(self):
        # the neon image tag this on-disk format was reverse-engineered against;
        # _validate.sh asserts it equals the pinned compute/storage tag (issue #22)
        self.assertTrue(skctl.SK_COMPAT_NEON_TAG)
        self.assertRegex(skctl.SK_COMPAT_NEON_TAG, r"^[a-z0-9.]+$")


if __name__ == "__main__":
    unittest.main()
