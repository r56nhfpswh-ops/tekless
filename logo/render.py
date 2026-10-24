#!/usr/bin/env python3
"""Procedural renderer for a glossy 'puffy sticker' planet logo on an orange comic sunburst.

Usage: python3 render.py [render_size] [out_sizes] [out_prefix]
  e.g. python3 render.py 4096 2048,1024,512,256 logo
Everything is computed at render_size and area-downsampled to each output size for clean AA.
Writes <prefix>-<size>.png (full logo) for every size and <prefix>-icon-<first size>.png
(icon only, transparent background).
"""
import math
import sys

import cv2
import numpy as np
from PIL import Image

S = int(sys.argv[1]) if len(sys.argv) > 1 else 2048
SIZES = [int(x) for x in (sys.argv[2] if len(sys.argv) > 2 else "1024").split(",")]
PREFIX = sys.argv[3] if len(sys.argv) > 3 else "logo"
SWIRL = 0.75

PX = 1.0 / S
f32 = np.float32


def hexc(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], f32)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def lerp(a, b, t):
    if np.ndim(t) == 2:
        t = t[..., None]
    return a + (b - a) * t


def blur(img, sigma_norm):
    return cv2.GaussianBlur(img, (0, 0), max(sigma_norm * S, 0.5))


def shift(img, dx_norm, dy_norm):
    M = np.float32([[1, 0, dx_norm * S], [0, 1, dy_norm * S]])
    return cv2.warpAffine(img, M, (S, S), flags=cv2.INTER_LINEAR, borderValue=0)


def outside_dist(alpha):
    m = (alpha < 0.5).astype(np.uint8)
    return cv2.distanceTransform(m, cv2.DIST_L2, cv2.DIST_MASK_PRECISE) * PX


def inside_dist(alpha):
    m = (alpha >= 0.5).astype(np.uint8)
    return cv2.distanceTransform(m, cv2.DIST_L2, cv2.DIST_MASK_PRECISE) * PX


ys, xs = np.mgrid[0:S, 0:S].astype(f32)
U = (xs + 0.5) / S
V = (ys + 0.5) / S
del xs, ys

# --------------------------------------------------------------------------
# Palette
# --------------------------------------------------------------------------
ORANGE = hexc("#FF7A16")
ORANGE_DEEP = hexc("#F2520C")
PEACH = hexc("#FFC47E")
CREAM = hexc("#FFF4E0")
GLOW = hexc("#FFEED6")
RAY = hexc("#FFF8EE")
INK = hexc("#561806")
SHADOW = hexc("#A8320A")
WHITE = hexc("#FFFEFB")
SHADE_TINT = hexc("#FFC8A2")   # shadow side of the white plastic
REFLECT = hexc("#FF8F3A")      # orange environment reflection at grazing angles
BAND = hexc("#FFC896")         # planet stripes

# --------------------------------------------------------------------------
# Background: orange field, radial halftone, swirling sunburst, center glow
# --------------------------------------------------------------------------
CX, CY = 0.5, 0.5
dX = U - CX
dY = V - CY
R = np.sqrt(dX * dX + dY * dY)
TH = np.arctan2(dY, dX)

under = lerp(CREAM, PEACH, smoothstep(0.06, 0.34, R))

spacing = 0.0215
ca, sa = math.cos(math.radians(45)), math.sin(math.radians(45))
gu = (dX * ca + dY * sa) / spacing
gv = (-dX * sa + dY * ca) / spacing
fu = gu - np.round(gu)
fv = gv - np.round(gv)
dot_d = np.sqrt(fu * fu + fv * fv) * spacing
del gu, gv, fu, fv
cov = smoothstep(0.17, 0.47, R)
dot_r = spacing * 0.74 * np.sqrt(cov)
dots = np.clip((dot_r - dot_d) / PX + 0.5, 0.0, 1.0)
del dot_d, dot_r, cov

field = lerp(ORANGE, ORANGE_DEEP, smoothstep(0.38, 0.74, R))
bg = lerp(under, field, dots)
del under, dots, field

# (center angle deg, half width deg, inner start radius)
RAYS = [
    (-90, 6.5, 0.20), (-63, 2.6, 0.27), (-41, 5.0, 0.22), (-17, 2.2, 0.30),
    (2, 4.2, 0.24), (24, 7.0, 0.20), (47, 2.4, 0.28), (66, 4.6, 0.23),
    (89, 2.2, 0.30), (110, 6.0, 0.21), (134, 2.8, 0.27), (154, 4.4, 0.22),
    (176, 2.4, 0.29), (197, 6.6, 0.20), (222, 2.4, 0.28), (243, 4.0, 0.23),
]
th_s = TH - SWIRL * R
ray_a = np.zeros((S, S), f32)
for ang, hw, r0 in RAYS:
    d = np.mod(th_s - math.radians(ang) + math.pi, 2 * math.pi) - math.pi
    edge = (math.radians(hw) - np.abs(d)) * np.maximum(R, 1e-4) / PX + 0.5
    m = np.clip(edge, 0.0, 1.0) * smoothstep(r0, r0 + 0.09, R)
    ray_a = np.maximum(ray_a, m)
del th_s, d, edge, m
bg = lerp(bg, RAY, ray_a * 0.97)
del ray_a

bg = lerp(bg, GLOW, np.exp(-(R / 0.20) ** 2) * 0.9)
bg = bg * (1.0 - 0.10 * smoothstep(0.5, 0.75, R))[..., None]

# --------------------------------------------------------------------------
# Geometry. Every object: coverage alpha, depth z (toward viewer), height field.
# --------------------------------------------------------------------------
P_X, P_Y, P_R = 0.5, 0.5, 0.19

pdx = U - P_X
pdy = V - P_Y
pr2 = pdx * pdx + pdy * pdy
planet_a = np.clip((P_R - np.sqrt(pr2)) / PX + 0.5, 0.0, 1.0)
planet_h = np.sqrt(np.maximum(P_R * P_R - pr2, 0.0))
planet_z = planet_h.copy()

# Ring: circle of radius A seen from elevation asin(SIN_PHI), rotated by TILT, tube radius T.
A = 0.332
SIN_PHI = 0.27
COS_PHI = math.sqrt(1 - SIN_PHI ** 2)
B = A * SIN_PHI
TILT = math.radians(-19)
T = 0.037
ct, st = math.cos(TILT), math.sin(TILT)
xr = pdx * ct + pdy * st
yr = -pdx * st + pdy * ct

# robust nearest point on the ellipse (Eberly): bisection on the Lagrange parameter
y0 = np.abs(xr).astype(np.float64)
y1 = np.maximum(np.abs(yr).astype(np.float64), 1e-9)
a2, b2 = A * A, B * B
t_lo = -b2 + B * y1
t_hi = -b2 + np.sqrt(a2 * y0 * y0 + b2 * y1 * y1)
for _ in range(42):
    tm = 0.5 * (t_lo + t_hi)
    F = (A * y0 / (tm + a2)) ** 2 + (B * y1 / (tm + b2)) ** 2 - 1.0
    pos = F > 0
    t_lo = np.where(pos, tm, t_lo)
    t_hi = np.where(pos, t_hi, tm)
tm = 0.5 * (t_lo + t_hi)
ex = a2 * y0 / (tm + a2)
ey = b2 * y1 / (tm + b2)
ring_d = np.sqrt((ex - y0) ** 2 + (ey - y1) ** 2).astype(f32)
sn = (np.sign(yr) * np.clip(ey / B, 0, 1)).astype(f32)  # front half of the ring is y' > 0
del y0, y1, t_lo, t_hi, tm, F, pos, ex, ey

ring_a = np.clip((T - ring_d) / PX + 0.5, 0.0, 1.0)
ring_h = np.sqrt(np.maximum(T * T - ring_d * ring_d, 0.0))
ring_zc = (A * sn * COS_PHI).astype(f32)
ring_z = ring_zc + ring_h
del ring_d, xr, yr, sn

# Planet stripes: latitude measured against the ring axis
ax_x, ax_y, ax_z = COS_PHI * st, -COS_PHI * ct, SIN_PHI
lat = (pdx * ax_x + pdy * ax_y + planet_h * ax_z) / P_R  # sin(latitude)
band = (smoothstep(0.17, 0.20, lat) * (1 - smoothstep(0.33, 0.36, lat)) +
        0.6 * smoothstep(0.50, 0.53, lat) * (1 - smoothstep(0.59, 0.62, lat)) +
        0.8 * smoothstep(-0.36, -0.33, lat) * (1 - smoothstep(-0.25, -0.22, lat)))
del lat


def rounded(alpha, r):
    """Morphological opening: rounds convex tips with radius r (normalized units)."""
    core = (inside_dist(alpha) > r).astype(f32)
    return np.clip((r - outside_dist(core)) / PX + 0.5, 0, 1)


def sparkle(cx, cy, size, p=0.66):
    x = np.abs(U - cx) / size
    y = np.abs(V - cy) / size
    return ((x ** p + y ** p) <= 1.0).astype(f32)


SPARKS = [(0.205, 0.215, 0.092), (0.808, 0.772, 0.060), (0.792, 0.208, 0.034)]
spark_a = np.zeros((S, S), f32)
for sx, sy, ss in SPARKS:
    spark_a = np.maximum(spark_a, rounded(sparkle(sx, sy, ss), ss * 0.04))
moon_a = np.clip((0.021 - np.sqrt((U - 0.262) ** 2 + (V - 0.792) ** 2)) / PX + 0.5, 0, 1)
spark_a = np.maximum(spark_a, moon_a)
del moon_a
sd = inside_dist(spark_a)
BEVEL = 0.016
spark_h = np.sqrt(np.clip(sd * (2 * BEVEL - sd), 0, None)) * (sd < BEVEL) + BEVEL * (sd >= BEVEL)
spark_h = blur(spark_h.astype(f32), 0.0015)
del sd
spark_z = 1.0 + spark_h


# --------------------------------------------------------------------------
# Shading: warm white satin plastic
# --------------------------------------------------------------------------
def normals(h):
    gy, gx = np.gradient(h * S)
    n = np.stack([-gx, -gy, np.ones_like(h)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n


LIGHT = np.array([-0.45, -0.62, 0.64], f32)
LIGHT /= np.linalg.norm(LIGHT)
HALF = LIGHT + np.array([0, 0, 1], f32)
HALF /= np.linalg.norm(HALF)


def shade(h, albedo=None):
    n = normals(h)
    nx, ny, nz = n[..., 0], n[..., 1], n[..., 2]
    del n
    ndl = nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]
    diff = np.clip((ndl + 0.32) / 1.32, 0, 1)
    ndh = np.clip(nx * HALF[0] + ny * HALF[1] + nz * HALF[2], 0, 1)
    spec = np.clip(ndh ** 240 * 0.85 + ndh ** 40 * 0.22 + ndh ** 8 * 0.05, 0, 1)
    fres = np.clip(1.0 - nz, 0, 1) ** 2.0
    toward = np.clip(-(nx * LIGHT[0] + ny * LIGHT[1]) / math.hypot(LIGHT[0], LIGHT[1]), -1, 1)
    base = WHITE if albedo is None else albedo
    col = base * lerp(SHADE_TINT, np.ones(3, f32) * 0.97, diff ** 0.75)
    col = lerp(col, REFLECT, fres * np.clip(-toward, 0, 1) * 0.55)       # warm bounce, far side
    col = col + (fres * np.clip(toward, 0, 1) * 0.30)[..., None]        # rim light, lit side
    col = np.clip(col, 0, 1)
    col = 1.0 - (1.0 - col) * (1.0 - spec[..., None])  # screen keeps stripes readable
    return col


planet_alb = lerp(WHITE, BAND, band)
planet_col = shade(planet_h, planet_alb)
del planet_alb, band
ring_col = shade(ring_h)
spark_col = shade(spark_h)

# Inter-object shadows (2.5D approximations)
front_ring = (ring_a * (ring_zc > 0)).astype(f32)
sh = blur(shift(front_ring, 0.007, 0.013), 0.0065) * planet_a
planet_col = lerp(planet_col, planet_col * SHADE_TINT * 0.92, sh * 0.85)
sh = blur(shift(planet_a, 0.012, 0.02), 0.01) * (ring_zc < 0)
ring_col = lerp(ring_col, ring_col * SHADE_TINT * 0.92, sh * 0.8)
del sh, front_ring

# --------------------------------------------------------------------------
# Compositing: thin outline hull at each object's depth + extruded base behind all
# --------------------------------------------------------------------------
OUTLINE = 0.0098
EXTRUDE = 0.0105


def outline_hull(alpha):
    return np.clip((OUTLINE - outside_dist(alpha)) / PX + 0.5, 0, 1)


ring_hull = outline_hull(ring_a)
planet_hull = outline_hull(planet_a)
spark_hull = outline_hull(spark_a)
sil = np.maximum.reduce([ring_hull, planet_hull, spark_hull])
ext = sil.copy()
for k in range(1, 5):
    ext = np.maximum(ext, shift(sil, 0.0, EXTRUDE * k / 4))

layers = [  # (alpha, z, color or None for ink)
    (ext, np.full((S, S), -5.0, f32), None),
    (ring_hull, ring_zc - 0.002, None),
    (ring_a, ring_z, ring_col),
    (planet_hull, np.full((S, S), -0.002, f32), None),
    (planet_a, planet_z, planet_col),
    (spark_hull, np.full((S, S), 0.99, f32), None),
    (spark_a, spark_z, spark_col),
]

zs = np.stack([np.where(la > 0, lz, -10.0) for la, lz, _ in layers], 0)
order = np.argsort(zs, axis=0).astype(np.int8)
del zs

icon_rgb = np.zeros((S, S, 3), f32)  # premultiplied
icon_a = np.zeros((S, S), f32)
for rank in range(len(layers)):
    idx = order[rank]
    for li, (la, lz, lcol) in enumerate(layers):
        sel = (idx == li) & (la > 0)
        if not sel.any():
            continue
        a = la[sel]
        c = INK if lcol is None else lcol[sel]
        icon_rgb[sel] = icon_rgb[sel] * (1 - a)[:, None] + c * a[:, None]
        icon_a[sel] = icon_a[sel] * (1 - a) + a
del order

full_sil = np.maximum(ext, icon_a)
img = lerp(bg, CREAM, blur(full_sil, 0.03) * 0.55)
drop = blur(shift(full_sil, 0.012, 0.02), 0.012)
img = img * (1 - 0.42 * drop)[..., None] + SHADOW * (0.42 * 0.6 * drop)[..., None]
img = img * (1 - icon_a)[..., None] + icon_rgb

full8 = (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)
for size in SIZES:
    small = cv2.resize(full8, (size, size), interpolation=cv2.INTER_AREA)
    Image.fromarray(small).save(f"{PREFIX}-{size}.png", optimize=True)
    print("saved", f"{PREFIX}-{size}.png")

# transparent icon: downsample premultiplied, then un-premultiply
size = SIZES[0]
pm = cv2.resize(icon_rgb, (size, size), interpolation=cv2.INTER_AREA)
al = cv2.resize(icon_a, (size, size), interpolation=cv2.INTER_AREA)
rgb = np.where(al[..., None] > 1e-4, pm / np.maximum(al, 1e-4)[..., None], 0)
rgba = np.concatenate([np.clip(rgb, 0, 1), al[..., None]], -1)
Image.fromarray((rgba * 255 + 0.5).astype(np.uint8)).save(f"{PREFIX}-icon-{size}.png", optimize=True)
print("saved", f"{PREFIX}-icon-{size}.png")
