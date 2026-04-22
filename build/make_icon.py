#!/usr/bin/env python3
"""Generate the RoutineTracker app icon.

Reads build/rt-logo.png if present and composites it over the brand
background with a lime accent glow. If the logo file is missing, exits
with instructions.

Brand tokens (from css/styles.css):
  --accent:  #D5FF40
  --bg-0:    #0a0a0c
  --bg-1:    #15161a  (gradient center)
"""
from PIL import Image, ImageDraw, ImageFilter, ImageChops
from pathlib import Path
import sys

HERE = Path(__file__).parent
LOGO_IN = HERE / "rt-logo.png"
OUT = HERE / "icon.png"

SIZE = 1024
ACCENT = (213, 255, 64)
BG_CENTER = (26, 28, 33)
BG_EDGE = (10, 10, 12)
CORNER_RADIUS = int(SIZE * 0.225)   # macOS-style squircle
LOGO_MARGIN_FRAC = 0.14             # padding around the mark inside the icon


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size - 1, size - 1), radius, fill=255)
    return m


def radial_gradient(size, inner, outer):
    grad = Image.new("RGB", (size, size), outer)
    px = grad.load()
    cx = cy = size / 2
    max_r = (cx ** 2 + cy ** 2) ** 0.5
    for y in range(size):
        for x in range(size):
            r = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            t = min(1.0, (r / max_r) ** 1.4)
            px[x, y] = tuple(int(inner[i] * (1 - t) + outer[i] * t) for i in range(3))
    return grad


def dot_texture(size, spacing=6, alpha=6):
    tex = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(tex)
    for y in range(0, size, spacing):
        for x in range(0, size, spacing):
            d.point((x, y), fill=(255, 255, 255, alpha))
    return tex


def load_logo(size):
    """Open rt-logo.png, trim to opaque content, fit into the icon's inner
    box, and return an RGBA image the full SIZE with the mark centered.

    Accepts either a transparent-background logo OR a flat-background one.
    For a flat bg (like the grey sample images), anything with luminance >
    mid-grey is treated as background and dropped."""
    if not LOGO_IN.exists():
        sys.exit(
            f"missing {LOGO_IN}\n"
            "Drop a PNG of the RT mark there and re-run. The script will\n"
            "center it in the icon, so the source can be any size/aspect."
        )

    logo = Image.open(LOGO_IN).convert("RGBA")

    # If the PNG has no real transparency, derive an alpha from luminance
    # (dark = mark, light = background). Works for black-on-grey or
    # black-on-white source logos.
    r, g, b, a = logo.split()
    if a.getextrema() == (255, 255):
        lum = Image.merge("RGB", (r, g, b)).convert("L")
        # Pixels darker than this are kept as mark
        alpha = lum.point(lambda v: 255 if v < 90 else (0 if v > 140 else int((140 - v) * 255 / 50)))
        logo.putalpha(alpha)
        # Recolor kept pixels to true black so remnant grey doesn't muddy the glow
        black = Image.new("RGBA", logo.size, (6, 6, 8, 255))
        black.putalpha(alpha)
        logo = black

    # Trim to opaque bbox
    bbox = logo.getchannel("A").getbbox()
    if bbox:
        logo = logo.crop(bbox)

    # Fit inside the inner icon box
    avail = int(size * (1 - 2 * LOGO_MARGIN_FRAC))
    scale = min(avail / logo.width, avail / logo.height)
    new_w, new_h = int(logo.width * scale), int(logo.height * scale)
    logo = logo.resize((new_w, new_h), Image.LANCZOS)

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(logo, ((size - new_w) // 2, (size - new_h) // 2), logo)
    return canvas


def colorize(rgba, rgb):
    """Return a copy of rgba where opaque pixels are recolored to rgb."""
    solid = Image.new("RGBA", rgba.size, rgb + (255,))
    out = Image.new("RGBA", rgba.size, (0, 0, 0, 0))
    out.paste(solid, (0, 0), rgba.getchannel("A"))
    return out


def main():
    # Base: rounded-square dark gradient + subtle dot grid
    bg = radial_gradient(SIZE, BG_CENTER, BG_EDGE).convert("RGBA")
    bg.alpha_composite(dot_texture(SIZE))

    # Inset accent ring
    ring = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    inset = 14
    ImageDraw.Draw(ring).rounded_rectangle(
        (inset, inset, SIZE - 1 - inset, SIZE - 1 - inset),
        CORNER_RADIUS - inset,
        outline=ACCENT + (90,),
        width=3,
    )
    bg.alpha_composite(ring)

    # Logo + lime glow behind it
    mark = load_logo(SIZE)
    glow_src = colorize(mark, ACCENT)
    bg.alpha_composite(glow_src.filter(ImageFilter.GaussianBlur(38)))
    bg.alpha_composite(glow_src.filter(ImageFilter.GaussianBlur(14)))
    bg.alpha_composite(mark)

    # Clip to squircle
    final = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    final.paste(bg, (0, 0), rounded_mask(SIZE, CORNER_RADIUS))
    final.save(OUT, "PNG")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
