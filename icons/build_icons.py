"""Generate medical-cross icons for Tab Triage AI.

The brief: must be unmistakable as a medical icon at 16x16 in the Chrome
toolbar, where most icons are dark/monochrome and visually noisy. We use
a saturated red rounded-square background with a thick white cross so
the icon reads as "medical / triage" instantly and stays distinct
against both light and dark Chrome themes.

Symmetry strategy: render one master canvas at 1024px with strictly
integer geometry, then LANCZOS-downsample to every target size. This
guarantees the cross is pixel-symmetric at all sizes — earlier
fractional-coordinate math produced lopsided arms at 16/32 because
PIL's anti-aliasing rounded each edge independently.

Run from the project root:
    python3 icons/build_icons.py
"""
from PIL import Image, ImageDraw
from pathlib import Path

OUT = Path(__file__).parent

SIZES = [16, 32, 48, 128]
MASTER = 1024  # render once at this resolution, downsample to each target

RED = (218, 38, 50, 255)
RED_DARK = (170, 24, 36, 255)
WHITE = (255, 255, 255, 255)


def draw_master() -> Image.Image:
    img = Image.new("RGBA", (MASTER, MASTER), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded square background. All coordinates are integers and the box
    # is centered, so the result is symmetric about both axes.
    pad = MASTER // 16        # 64
    radius = MASTER // 5      # 204
    d.rounded_rectangle(
        (pad, pad, MASTER - pad, MASTER - pad),
        radius=radius,
        fill=RED,
    )

    # Faint inner ring for a hint of depth at large sizes. Downsamples to
    # nearly nothing at 16px, which is fine.
    d.rounded_rectangle(
        (pad + 4, pad + 4, MASTER - pad - 4, MASTER - pad - 4),
        radius=radius - 4,
        outline=RED_DARK,
        width=4,
    )

    # White cross. Two centered rectangles built from integer offsets so
    # both arms have identical extent on each side of the center pixel.
    cx = cy = MASTER // 2                    # 512
    arm_len = (MASTER * 30) // 100           # 307 (≈ 30% of canvas)
    arm_thick = MASTER // 4                  # 256
    # arm_thick is even, so half_thick * 2 == arm_thick — no asymmetry.
    half_thick = arm_thick // 2              # 128

    horizontal = (
        cx - arm_len,
        cy - half_thick,
        cx + arm_len,
        cy + half_thick,
    )
    vertical = (
        cx - half_thick,
        cy - arm_len,
        cx + half_thick,
        cy + arm_len,
    )
    d.rectangle(horizontal, fill=WHITE)
    d.rectangle(vertical, fill=WHITE)

    return img


def enforce_4fold_symmetry(img: Image.Image) -> Image.Image:
    """Mirror the top-left quadrant into the other three.

    PIL's rectangle and rounded_rectangle have inclusive-endpoint semantics
    that leave a 1-pixel asymmetry on shapes meant to be centered. Drawing
    once and forcing 4-fold symmetry is simpler than fighting the
    primitive's off-by-one behavior.
    """
    w, h = img.size
    assert w % 2 == 0 and h % 2 == 0, "canvas must be even-sized"
    tl = img.crop((0, 0, w // 2, h // 2))
    tr = tl.transpose(Image.FLIP_LEFT_RIGHT)
    bl = tl.transpose(Image.FLIP_TOP_BOTTOM)
    br = bl.transpose(Image.FLIP_LEFT_RIGHT)
    out = Image.new(img.mode, (w, h), (0, 0, 0, 0))
    out.paste(tl, (0, 0))
    out.paste(tr, (w // 2, 0))
    out.paste(bl, (0, h // 2))
    out.paste(br, (w // 2, h // 2))
    return out


def main() -> None:
    master = enforce_4fold_symmetry(draw_master())
    for s in SIZES:
        out = master.resize((s, s), Image.LANCZOS)
        path = OUT / f"icon{s}.png"
        out.save(path, format="PNG")
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
