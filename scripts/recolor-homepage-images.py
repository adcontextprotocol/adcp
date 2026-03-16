#!/usr/bin/env python3
"""Shift homepage illustration accents from teal/emerald toward brand blue.

This keeps skin tones and low-saturation neutrals intact by only remapping
pixels in the saturated teal/cyan hue range.

Requires Pillow:
  python3 -m pip install pillow
"""

from __future__ import annotations

import argparse
import colorsys
from pathlib import Path

from PIL import Image


DEFAULT_FILES = [
    "server/public/images/homepage/panel-01-everyday.png",
    "server/public/images/homepage/panel-02-change.png",
    "server/public/images/homepage/panel-03-stakes.png",
    "server/public/images/homepage/panel-04-community.png",
    "server/public/images/homepage/panel-05-outcomes.png",
    "server/public/images/homepage/panel-06-join.png",
]


def recolor_image(src: Path, dest: Path) -> None:
    image = Image.open(src).convert("RGBA")
    pixels = image.load()

    for y in range(image.height):
        for x in range(image.width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue

            rf, gf, bf = r / 255.0, g / 255.0, b / 255.0
            h, s, v = colorsys.rgb_to_hsv(rf, gf, bf)

            # Limit changes to the saturated teal/cyan band so skin tones,
            # neutrals, and warm highlights remain stable.
            if 0.40 <= h <= 0.56 and s >= 0.10:
                hue_strength = min(1.0, max(0.0, (h - 0.40) / 0.16))
                sat_strength = min(1.0, max(0.0, (s - 0.10) / 0.90))
                strength = 0.25 + hue_strength * 0.30 + sat_strength * 0.25

                target_hue = 217 / 360.0
                new_h = h + (target_hue - h) * strength
                new_s = min(1.0, s * (1.01 + 0.06 * strength))
                new_v = min(1.0, v * (0.995 + 0.02 * strength))

                nr, ng, nb = colorsys.hsv_to_rgb(new_h, new_s, new_v)
                pixels[x, y] = (
                    round(nr * 255),
                    round(ng * 255),
                    round(nb * 255),
                    a,
                )

    dest.parent.mkdir(parents=True, exist_ok=True)
    image.save(dest)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "paths",
        nargs="*",
        help="PNG files to recolor in place. Defaults to the homepage panels.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    paths = [Path(path) for path in (args.paths or DEFAULT_FILES)]

    for path in paths:
        recolor_image(path, path)
        print(path)


if __name__ == "__main__":
    main()
