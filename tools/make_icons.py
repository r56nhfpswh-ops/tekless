#!/usr/bin/env python3
"""Generate the extension's PNG icons: a blue rounded square with a white
queue/stack glyph. Written by hand so the build has no image dependencies.

    python3 tools/make_icons.py
"""
import os
import struct
import zlib

ACCENT = (29, 155, 240)
WHITE = (255, 255, 255)
SIZES = (16, 32, 48, 128)
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")

# Supersample, then box-average down, so edges land smooth without a filter lib.
SS = 8


def coverage(size):
    """Alpha + color grid for one icon, rendered at SS x resolution."""
    n = size * SS
    radius = n * 0.22
    grid = [[(0, 0, 0, 0)] * n for _ in range(n)]

    # Three stacked bars, narrowing toward the bottom: a queue draining.
    bars = [(0.26, 0.50), (0.26, 0.42), (0.26, 0.34)]
    bar_h = n * 0.10
    tops = [n * 0.28, n * 0.45, n * 0.62]

    for y in range(n):
        for x in range(n):
            # Rounded-square mask.
            dx = max(radius - x, 0, x - (n - radius))
            dy = max(radius - y, 0, y - (n - radius))
            if dx and dy and (dx * dx + dy * dy) > radius * radius:
                continue

            px = ACCENT
            for (left_f, width_f), top in zip(bars, tops):
                bx0, bx1 = n * left_f, n * left_f + n * width_f
                if bx0 <= x < bx1 and top <= y < top + bar_h:
                    px = WHITE
                    break
            grid[y][x] = px + (255,)
    return grid


def downsample(grid, size):
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    pr, pg, pb, pa = grid[y * SS + sy][x * SS + sx]
                    r += pr * pa
                    g += pg * pa
                    b += pb * pa
                    a += pa
            if a:
                row += bytes((r // a, g // a, b // a, a // (SS * SS)))
            else:
                row += b"\0\0\0\0"
        rows.append(bytes(row))
    return rows


def chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path, size, rows):
    raw = b"".join(b"\0" + r for r in rows)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        rows = downsample(coverage(size), size)
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        write_png(path, size, rows)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
