#!/usr/bin/env python3
"""Generate a small-on-disk, huge-when-decoded PNG (a decompression bomb) and a
non-image file, both dropped into the built client dir so fetchAsset can find them.

10000 x 10000 grayscale = 100,000,000 pixels, well over the entry's 40 MP cap,
but only ~100 KB on disk. Decoded to RGBA it is ~400 MB.
"""
import struct
import sys
import zlib

W = H = 10000


def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


raw = b"".join(b"\x00" + b"\x00" * W for _ in range(H))
png = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 0, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(raw, 9))
    + chunk(b"IEND", b"")
)
out = sys.argv[1]
with open(out, "wb") as f:
    f.write(png)
print(f"{out}: {W}x{H} = {W * H:,} px, {len(png):,} B on disk")
