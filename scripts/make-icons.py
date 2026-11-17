"""Draws RoBugs' app icons (original art): a chunky top-down robo-bug.
Run: python3 scripts/make-icons.py"""
from PIL import Image, ImageDraw

BG = (36, 41, 50, 255)
INK = (17, 19, 24, 255)

def bug(d: ImageDraw.ImageDraw, s: float, ox: float, oy: float):
    def box(x, y, w, h, fill, r=0.06):
        d.rounded_rectangle([ox + x * s, oy + y * s, ox + (x + w) * s, oy + (y + h) * s], radius=r * s, fill=fill, outline=INK, width=max(2, int(0.016 * s)))
    # legs
    for y in (0.40, 0.56, 0.72):
        box(0.10, y, 0.24, 0.09, (140, 152, 166, 255), 0.03)
        box(0.66, y, 0.24, 0.09, (140, 152, 166, 255), 0.03)
    # mandibles
    box(0.36, 0.05, 0.09, 0.16, (229, 72, 77, 255), 0.03)
    box(0.55, 0.05, 0.09, 0.16, (229, 72, 77, 255), 0.03)
    # head, thorax, abdomen
    box(0.33, 0.17, 0.34, 0.2, (242, 193, 78, 255))
    box(0.30, 0.36, 0.40, 0.24, (224, 122, 63, 255))
    box(0.32, 0.59, 0.36, 0.3, (200, 90, 58, 255))
    # eyes + core
    box(0.38, 0.23, 0.08, 0.06, (79, 168, 255, 255), 0.02)
    box(0.54, 0.23, 0.08, 0.06, (79, 168, 255, 255), 0.02)
    box(0.43, 0.42, 0.14, 0.12, (61, 220, 151, 255), 0.03)

def make(path, size, bg=True, scale=0.86):
    img = Image.new('RGBA', (size, size), BG if bg else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = size * scale
    bug(d, s, (size - s) / 2, (size - s) / 2)
    img.save(path)

make('assets/images/icon.png', 1024)
make('assets/images/android-icon-foreground.png', 1024, bg=False, scale=0.6)
make('assets/images/splash-icon.png', 512, bg=False, scale=0.95)
make('assets/images/favicon.png', 64)
