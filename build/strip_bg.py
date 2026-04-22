#!/usr/bin/env python3
"""Keep only the rounded-square glass tile from the source icon; make everything
outside it transparent.

Step 1: scan the source to find the bounding box of the tile by looking for
any pixel noticeably brighter than pure black.
Step 2: apply a rounded-rectangle alpha mask fit to that bbox, so the edges
of the tile are clean.
"""
from PIL import Image, ImageDraw, ImageFilter

SRC = 'build/4B36AC78-7418-41C9-AC9B-9AC6688A8ADD.png'
OUT = 'images/app-icon.png'

# Tuning
BRIGHT_THRESH = 90       # only the tile's glossy rim is this bright — background
                         # noise maxes out around 35
CORNER_RADIUS_RATIO = 0.18
EXPAND_PX = 10           # grow the bbox outward to include the full anti-aliased
                         # rim that sits just outside the brightest highlight
MASK_BLUR = 1.4          # soften the mask edge for smooth anti-aliasing

img = Image.open(SRC).convert('RGBA')
w, h = img.size
px = img.load()

def row_has_content(y):
    for x in range(w):
        r, g, b, _a = px[x, y]
        if max(r, g, b) > BRIGHT_THRESH:
            return True
    return False

def col_has_content(x):
    for y in range(h):
        r, g, b, _a = px[x, y]
        if max(r, g, b) > BRIGHT_THRESH:
            return True
    return False

top = next(y for y in range(h) if row_has_content(y))
bottom = next(y for y in range(h - 1, -1, -1) if row_has_content(y))
left = next(x for x in range(w) if col_has_content(x))
right = next(x for x in range(w - 1, -1, -1) if col_has_content(x))

# Force square (the tile is square; any bbox asymmetry is noise) and expand
# outward to include the full rim past the highlight detection threshold.
size = min(right - left, bottom - top)
cx = (left + right) // 2
cy = (top + bottom) // 2
half = size // 2 + EXPAND_PX
left = cx - half
right = cx + half
top = cy - half
bottom = cy + half

radius = int((right - left) * CORNER_RADIUS_RATIO)

print(f'tile bbox: ({left},{top})-({right},{bottom}) size={right-left}px radius={radius}px')

# Rounded-rect mask
mask = Image.new('L', (w, h), 0)
ImageDraw.Draw(mask).rounded_rectangle((left, top, right, bottom), radius=radius, fill=255)
if MASK_BLUR > 0:
    mask = mask.filter(ImageFilter.GaussianBlur(radius=MASK_BLUR))

img.putalpha(mask)
img.save(OUT, 'PNG', optimize=True)
print(f'wrote {OUT} ({w}x{h})')
