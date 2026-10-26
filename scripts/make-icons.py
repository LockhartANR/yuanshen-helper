"""Generate the extension icons (元神助手) from the supplied character image.

Source: assets/icon-source.webp (transparent 162x162 illustration).
Run: python scripts/make-icons.py
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "icon-source.webp"
OUT = ROOT / "public" / "icons"
MASTER_SIZE = 1024

# Crop to the head so the glasses/face survive at small sizes. Values are
# relative to the source image; the source is a 162x162 illustration.
# 16/32 use a tighter face crop, 48/128 keep more of the hair.
HEAD_CROP = (0.136, 0.012, 0.914, 0.815)
SMALL_CROP = (0.160, 0.049, 0.889, 0.790)
MARGIN_RATIO = 0.012


def load_source() -> Image.Image:
    if not SOURCE.exists():
        raise SystemExit(f"Missing source image: {SOURCE}")
    return Image.open(SOURCE).convert("RGBA")


def crop_relative(source: Image.Image, crop: tuple[float, float, float, float]) -> Image.Image:
    width, height = source.size
    left = round(width * crop[0])
    top = round(height * crop[1])
    right = round(width * crop[2])
    bottom = round(height * crop[3])
    return source.crop((left, top, right, bottom))


def make_master(
    source: Image.Image,
    crop: tuple[float, float, float, float],
    margin_ratio: float = MARGIN_RATIO,
) -> Image.Image:
    head = crop_relative(source, crop)
    margin = round(MASTER_SIZE * margin_ratio)
    inner = MASTER_SIZE - margin * 2
    scale = min(inner / head.width, inner / head.height)
    resized = head.resize(
        (max(1, round(head.width * scale)), max(1, round(head.height * scale))),
        Image.Resampling.LANCZOS,
    )
    canvas = Image.new("RGBA", (MASTER_SIZE, MASTER_SIZE), (0, 0, 0, 0))
    canvas.alpha_composite(
        resized,
        ((MASTER_SIZE - resized.width) // 2, (MASTER_SIZE - resized.height) // 2),
    )
    return canvas


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    source = load_source()
    masters = {
        16: make_master(source, SMALL_CROP, 0.008),
        32: make_master(source, SMALL_CROP, 0.010),
        48: make_master(source, HEAD_CROP),
        128: make_master(source, HEAD_CROP),
    }

    for size, master in masters.items():
        icon = master.resize((size, size), Image.Resampling.LANCZOS)
        icon.save(OUT / f"icon{size}.png", optimize=True)
        print(f"wrote {OUT / f'icon{size}.png'}")


if __name__ == "__main__":
    main()
