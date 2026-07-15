#!/usr/bin/env python3
"""
make_logo.py — draw the Reading Room app logo (assets/reading-room-logo.png).

A rounded indigo tile with a "citation constellation": a small network of paper
nodes connected by edges, with one larger hub node — a nod to the connections
graph that is the catalogue's signature. Drawn at 4× and downscaled for clean
anti-aliased edges. Needs Pillow (only to regenerate the logo; the project itself
stays dependency-free):  pip install pillow

After running, rebuild + attach the icon with:  bash assets/build-icon.sh
"""
import os
from PIL import Image, ImageDraw

S = 4                       # supersample factor
N = 1024 * S
HERE = os.path.dirname(os.path.abspath(__file__))


def sc(v):
    return int(round(v * S))


# ---- rounded indigo tile with a vertical gradient ----
def tile(top=(62, 102, 234), bot=(32, 56, 166), margin=90, radius=205):
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    x0, y0, x1, y1 = sc(margin), sc(margin), sc(1024 - margin), sc(1024 - margin)
    grad = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    h = y1 - y0
    for i in range(h):
        t = i / (h - 1)
        gd.line([(x0, y0 + i), (x1, y0 + i)],
                fill=(int(top[0] + (bot[0] - top[0]) * t),
                      int(top[1] + (bot[1] - top[1]) * t),
                      int(top[2] + (bot[2] - top[2]) * t), 255))
    mask = Image.new("L", (N, N), 0)
    ImageDraw.Draw(mask).rounded_rectangle([x0, y0, x1, y1], radius=sc(radius), fill=255)
    img.paste(grad, (0, 0), mask)
    return img


# ---- citation constellation ----
# (x, y, radius); node 0 is the hub (drawn larger, with a soft halo)
NODES = [
    (476, 470, 54),   # 0 hub
    (664, 356, 33),   # 1
    (732, 566, 27),   # 2
    (566, 666, 31),   # 3
    (336, 598, 27),   # 4
    (300, 398, 30),   # 5
    (516, 286, 23),   # 6
]
EDGES = [(0, 1), (0, 3), (0, 4), (0, 5), (0, 6), (1, 2), (2, 3), (1, 6), (4, 5), (3, 4)]


def draw_marks(d):
    edge = (255, 255, 255, 120)
    for a, b in EDGES:
        d.line([sc(NODES[a][0]), sc(NODES[a][1]), sc(NODES[b][0]), sc(NODES[b][1])],
               fill=edge, width=sc(8))
    # soft halo behind the hub for emphasis
    hx, hy, hr = NODES[0]
    d.ellipse([sc(hx - hr - 26), sc(hy - hr - 26), sc(hx + hr + 26), sc(hy + hr + 26)],
              fill=(255, 255, 255, 40))
    for i, (x, y, r) in enumerate(NODES):
        d.ellipse([sc(x - r), sc(y - r), sc(x + r), sc(y + r)], fill=(255, 255, 255, 255))
    # a small indigo core in the hub marks it as the focus node
    d.ellipse([sc(hx - 20), sc(hy - 20), sc(hx + 20), sc(hy + 20)], fill=(46, 78, 196, 255))


base = tile()
ov = Image.new("RGBA", (N, N), (0, 0, 0, 0))
draw_marks(ImageDraw.Draw(ov))
out = Image.alpha_composite(base, ov).resize((1024, 1024), Image.LANCZOS)

path = os.path.join(HERE, "reading-room-logo.png")
out.save(path)
print("  ✓ wrote", path)
