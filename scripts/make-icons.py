#!/usr/bin/env python3
"""Génère les icônes LazyQ sans dépendance externe.

Pillow n'est pas requis : on encode le PNG à la main (RGBA, filtre 0, zlib).
Le dessin est suréchantillonné puis moyenné, ce qui donne l'antialiasing sans
bibliothèque graphique.
"""

import struct
import zlib
from pathlib import Path

ORANGE = (255, 122, 89)
WHITE = (255, 255, 255)
SUPERSAMPLE = 4

# Géométrie en coordonnées unitaires [0, 1].
CORNER_RADIUS = 0.22
RING_CENTER = (0.46, 0.46)
RING_OUTER = 0.30
RING_INNER = 0.175
TAIL = ((0.55, 0.55), (0.78, 0.78), 0.06)  # départ, arrivée, demi-épaisseur


def in_rounded_square(x, y, r=CORNER_RADIUS):
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_ring(x, y):
    dx, dy = x - RING_CENTER[0], y - RING_CENTER[1]
    d2 = dx * dx + dy * dy
    return RING_INNER ** 2 <= d2 <= RING_OUTER ** 2


def in_tail(x, y):
    (x0, y0), (x1, y1), half = TAIL
    vx, vy = x1 - x0, y1 - y0
    t = ((x - x0) * vx + (y - y0) * vy) / (vx * vx + vy * vy)
    t = min(max(t, 0.0), 1.0)
    px, py = x0 + t * vx, y0 + t * vy
    return (x - px) ** 2 + (y - py) ** 2 <= half * half


def sample(x, y):
    """Couleur et opacité d'un point du carré unité."""
    if not in_rounded_square(x, y):
        return None
    if in_ring(x, y) or in_tail(x, y):
        return WHITE
    return ORANGE


def render(size):
    n = size * SUPERSAMPLE
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0
            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    x = (px * SUPERSAMPLE + sx + 0.5) / n
                    y = (py * SUPERSAMPLE + sy + 0.5) / n
                    color = sample(x, y)
                    if color:
                        r += color[0]
                        g += color[1]
                        b += color[2]
                        a += 255
            total = SUPERSAMPLE * SUPERSAMPLE
            if a:
                # Moyenne sur les seuls échantillons couverts : sans ça, les
                # bords tireraient vers le noir.
                covered = a // 255
                row += bytes((r // covered, g // covered, b // covered, a // total))
            else:
                row += b'\x00\x00\x00\x00'
        rows.append(bytes(row))
    return rows


def chunk(tag, data):
    return (struct.pack('>I', len(data)) + tag + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, size):
    rows = render(size)
    raw = b''.join(b'\x00' + row for row in rows)
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw, 9))
           + chunk(b'IEND', b''))
    path.write_bytes(png)
    return len(png)


if __name__ == '__main__':
    out = Path(__file__).resolve().parent.parent / 'extension' / 'icons'
    out.mkdir(parents=True, exist_ok=True)
    for size in (16, 48, 128):
        written = write_png(out / f'icon{size}.png', size)
        print(f'icon{size}.png — {written} octets')
