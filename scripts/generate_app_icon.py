#!/usr/bin/env python3
"""Generate ZMate brand icons from assets/logo-source.png (pure stdlib, no Pillow).

Outputs (all under assets/, plus the sidebar logo under public/):
  app-icon.png           — tile artwork cropped to the rounded-square tile (1024)
  app-icon-composed.png  — macOS composition on a transparent canvas (1024)
  tray-icon.png          — black Z silhouette with alpha, for the macOS tray template
  ../public/app-icon.png — 256px sidebar logo
"""

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "logo-source.png"
OUT_TILE = ROOT / "assets" / "app-icon.png"
OUT_COMPOSED = ROOT / "assets" / "app-icon-composed.png"
OUT_TRAY = ROOT / "assets" / "tray-icon.png"
OUT_SIDEBAR = ROOT / "public" / "app-icon.png"

TILE_RADIUS_RATIO = 0.2237   # Apple-style tile corner radius
TILE_INSET = 0.003           # trim the soft shadow fringe just outside the tile edge
SEAM_DELTA = 6               # tile edge reads as a faint seam (~6 levels) against the page
COMPOSED_SCALE = 0.81        # tile size relative to the composed canvas (macOS grid)
SIDEBAR_SIZE = 256
TRAY_SIZE = 88


def read_png(path: Path) -> tuple[int, int, int, bytearray]:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG file")
    pos = 8
    width = height = 0
    colortype = interlace = -1
    depth = 8
    idat = bytearray()
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        ctype = data[pos + 4 : pos + 8]
        chunk = data[pos + 8 : pos + 8 + length]
        if ctype == b"IHDR":
            width, height, depth, colortype, _, _, interlace = struct.unpack(
                ">IIBBBBB", chunk
            )
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"IEND":
            break
        pos += 12 + length
    if depth != 8 or colortype not in (2, 6) or interlace != 0:
        raise ValueError(
            f"unsupported PNG: depth={depth} colortype={colortype} interlace={interlace}"
        )
    bpp = 3 if colortype == 2 else 4
    raw = zlib.decompress(bytes(idat))
    stride = width * bpp
    out = bytearray(stride * height)
    src = 0
    for y in range(height):
        ftype = raw[src]
        src += 1
        start = y * stride
        line = bytearray(raw[src : src + stride])
        src += stride
        if ftype == 1:  # Sub
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ftype == 2:  # Up
            if y:
                prev = start - stride
                for i in range(stride):
                    line[i] = (line[i] + out[prev + i]) & 0xFF
        elif ftype == 3:  # Average
            if y:
                prev = start - stride
                for i in range(stride):
                    a = line[i - bpp] if i >= bpp else 0
                    line[i] = (line[i] + ((a + out[prev + i]) >> 1)) & 0xFF
            else:
                for i in range(bpp, stride):
                    line[i] = (line[i] + (line[i - bpp] >> 1)) & 0xFF
        elif ftype == 4:  # Paeth
            if y:
                prev = start - stride
                for i in range(stride):
                    a = line[i - bpp] if i >= bpp else 0
                    b = out[prev + i]
                    c = out[prev + i - bpp] if i >= bpp else 0
                    p = a + b - c
                    pa = abs(p - a)
                    pb = abs(p - b)
                    pc = abs(p - c)
                    if pa <= pb and pa <= pc:
                        pr = a
                    elif pb <= pc:
                        pr = b
                    else:
                        pr = c
                    line[i] = (line[i] + pr) & 0xFF
            else:
                for i in range(bpp, stride):
                    line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ftype != 0:
            raise ValueError(f"unknown filter {ftype}")
        out[start : start + stride] = line
    return width, height, bpp, out


def write_png(path: Path, width: int, height: int, rgba: bytearray) -> None:
    stride = width * 4
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        raw += rgba[y * stride : (y + 1) * stride]
    compressed = zlib.compress(bytes(raw), 9)

    def chunk(ctype: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + ctype
            + payload
            + struct.pack(">I", zlib.crc32(ctype + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", compressed)
        + chunk(b"IEND", b"")
    )


def pixel(buf: bytearray, w: int, bpp: int, x: int, y: int) -> tuple[int, int, int]:
    o = (y * w + x) * bpp
    return buf[o], buf[o + 1], buf[o + 2]


def seam_scan(
    buf: bytearray, w: int, h: int, bpp: int, bg_lum: int,
    axis: str, fix: int, reverse: bool = False,
) -> int:
    """Position where a scan line crosses the faint tile-edge seam.

    The tile body and the page are both white; only the boundary (and its soft
    shadow) dips a couple of luminance levels, so scan inward until it does.
    """
    limit = w if axis == "x" else h
    threshold = bg_lum - SEAM_DELTA
    order = range(limit - 1, -1, -1) if reverse else range(limit)

    def lum(at: int) -> int:
        x, y = (at, fix) if axis == "x" else (fix, at)
        r, g, b = pixel(buf, w, bpp, x, y)
        return (r * 299 + g * 587 + b * 114) // 1000

    for i in order:
        if lum(i) <= threshold:
            return i
    raise ValueError(f"tile seam not found (axis={axis} fix={fix})")


def tile_bounds(buf: bytearray, w: int, h: int, bpp: int, bg_lum: int) -> tuple[int, int, int, int]:
    """Median tile edges over a few scan lines (the seam is patchy AA)."""
    import statistics

    lows = [h // 2 + d for d in (-80, -40, 0, 40, 80)]
    lefts, rights, tops, bottoms = [], [], [], []
    for f in lows:
        lefts.append(seam_scan(buf, w, h, bpp, bg_lum, "x", f))
        rights.append(seam_scan(buf, w, h, bpp, bg_lum, "x", f, reverse=True))
    for f in [w // 2 + d for d in (-80, -40, 0, 40, 80)]:
        tops.append(seam_scan(buf, w, h, bpp, bg_lum, "y", f))
        bottoms.append(seam_scan(buf, w, h, bpp, bg_lum, "y", f, reverse=True))
    left = int(statistics.median(lefts))
    top = int(statistics.median(tops))
    right = int(statistics.median(rights))
    bottom = int(statistics.median(bottoms))
    return left, top, right + 1, bottom + 1


def resize_area(buf: bytearray, w: int, h: int, bpp: int, tw: int, th: int) -> bytearray:
    """Box-filter resize with premultiplied alpha so transparent edges stay clean."""
    src = bytearray(buf)
    if bpp == 3:  # promote to RGBA
        src = bytearray(len(buf) // 3 * 4)
        for i in range(0, len(buf), 3):
            j = i // 3 * 4
            src[j : j + 3] = buf[i : i + 3]
            src[j + 3] = 255
    premul = bytearray(len(src))
    for i in range(0, len(src), 4):
        a = src[i + 3]
        premul[i] = src[i] * a // 255
        premul[i + 1] = src[i + 1] * a // 255
        premul[i + 2] = src[i + 2] * a // 255
        premul[i + 3] = a

    out = bytearray(tw * th * 4)
    x_ratio = w / tw
    y_ratio = h / th
    for ty in range(th):
        sy0 = int(ty * y_ratio)
        sy1 = max(sy0 + 1, int((ty + 1) * y_ratio))
        for tx in range(tw):
            sx0 = int(tx * x_ratio)
            sx1 = max(sx0 + 1, int((tx + 1) * x_ratio))
            count = (sx1 - sx0) * (sy1 - sy0)
            r = g = b = a = 0
            for sy in range(sy0, sy1):
                base = sy * w * 4
                for sx in range(sx0, sx1):
                    o = base + sx * 4
                    r += premul[o]
                    g += premul[o + 1]
                    b += premul[o + 2]
                    a += premul[o + 3]
            o2 = (ty * tw + tx) * 4
            out[o2] = min(255, r // count)
            out[o2 + 1] = min(255, g // count)
            out[o2 + 2] = min(255, b // count)
            out[o2 + 3] = min(255, a // count)
    # un-premultiply
    for i in range(0, len(out), 4):
        a = out[i + 3]
        if a:
            out[i] = min(255, out[i] * 255 // a)
            out[i + 1] = min(255, out[i + 1] * 255 // a)
            out[i + 2] = min(255, out[i + 2] * 255 // a)
    return out


def rounded_rect_alpha(width: int, height: int, radius: float) -> bytearray:
    """Per-pixel alpha for a rounded rect covering the full image (1px AA)."""
    alpha = bytearray(width * height)
    r = radius
    for y in range(height):
        cy = y + 0.5
        row = y * width
        if cy < r:
            dx = (r * r - (r - cy) ** 2) ** 0.5
            left_edge = r - dx
            right_edge = width - r + dx
        elif cy > height - r:
            dx = (r * r - (cy - (height - r)) ** 2) ** 0.5
            left_edge = r - dx
            right_edge = width - r + dx
        else:
            left_edge = 0.0
            right_edge = float(width)
        for x in range(width):
            cx = x + 0.5
            if cx <= left_edge:
                a = 0
            elif cx >= right_edge:
                a = 0
            else:
                a = int(max(0.0, min(1.0, cx - left_edge, right_edge - cx)) * 255)
            alpha[row + x] = a
    return alpha


def apply_alpha(img: bytearray, alpha: bytearray) -> bytearray:
    out = bytearray(img)
    for i in range(0, len(out), 4):
        out[i + 3] = alpha[i // 4]
    return out


def composite_over(canvas: bytearray, img: bytearray, dx: int, dy: int, w: int, cw: int) -> None:
    for y in range(w):  # square image
        crow = ((dy + y) * cw + dx) * 4
        irow = y * w * 4
        for x in range(w):
            sa = img[irow + x * 4 + 3]
            if sa == 255:
                o = crow + x * 4
                s = irow + x * 4
                canvas[o : o + 4] = img[s : s + 4]
            elif sa:
                o = crow + x * 4
                s = irow + x * 4
                da = canvas[o + 3]
                out_a = sa + da * (255 - sa) // 255
                for c in range(3):
                    canvas[o + c] = (
                        img[s + c] * sa + canvas[o + c] * da * (255 - sa) // 255
                    ) // out_a
                canvas[o + 3] = out_a


def crop_square_rgba(buf: bytearray, w: int, bpp: int, x0: int, y0: int, side: int) -> bytearray:
    crop = bytearray(side * side * 4)
    for y in range(side):
        srow = (y0 + y) * w * bpp + x0 * bpp
        drow = y * side * 4
        for x in range(side):
            so = srow + x * bpp
            do = drow + x * 4
            crop[do] = buf[so]
            crop[do + 1] = buf[so + 1]
            crop[do + 2] = buf[so + 2]
            crop[do + 3] = 255
    return crop


def main() -> None:
    w, h, bpp, buf = read_png(SOURCE)
    print(f"source: {w}x{h} bpp={bpp}")

    # Corner sample tells us the page background level.
    bg = list(pixel(buf, w, bpp, 4, 4))
    bg_lum = (bg[0] * 299 + bg[1] * 587 + bg[2] * 114) // 1000
    print(f"bg rgb~{bg} lum={bg_lum}")

    x0, y0, x1, y1 = tile_bounds(buf, w, h, bpp, bg_lum)
    print(f"tile bounds: {x0},{y0} - {x1},{y1}  size={x1 - x0}x{y1 - y0}")

    # Crop the tile (centered square on the larger side), trim a hair of the soft
    # shadow fringe outside the tile edge.
    side = max(x1 - x0, y1 - y0)
    inset = int(side * TILE_INSET)
    ccx = (x0 + x1) // 2
    ccy = (y0 + y1) // 2
    cside = min(x1 - x0, y1 - y0) - 2 * inset
    tile_crop = crop_square_rgba(buf, w, bpp, ccx - cside // 2, ccy - cside // 2, cside)

    tile = resize_area(tile_crop, cside, cside, 4, 1024, 1024)
    mask = rounded_rect_alpha(1024, 1024, 1024 * TILE_RADIUS_RATIO)
    tile = apply_alpha(tile, mask)
    write_png(OUT_TILE, 1024, 1024, tile)
    print(f"wrote {OUT_TILE}")

    # macOS composition: tile centered on a transparent 1024 canvas.
    composed_size = int(1024 * COMPOSED_SCALE)
    tile_small = resize_area(tile, 1024, 1024, 4, composed_size, composed_size)
    canvas = bytearray(1024 * 1024 * 4)
    offset = (1024 - composed_size) // 2
    composite_over(canvas, tile_small, offset, offset, composed_size, 1024)
    write_png(OUT_COMPOSED, 1024, 1024, canvas)
    print(f"wrote {OUT_COMPOSED}")

    # Tray template icon: black silhouette, alpha = darkness against the white page.
    min_x, min_y, max_x, max_y = w, h, -1, -1
    talpha = bytearray(w * h)
    for y in range(h):
        row = y * w
        for x in range(w):
            r, g, b = pixel(buf, w, bpp, x, y)
            a = 255 - min(r, g, b)
            if a < 24:
                a = 0
            talpha[row + x] = a
            if a:
                if x < min_x:
                    min_x = x
                if x > max_x:
                    max_x = x
                if y < min_y:
                    min_y = y
                if y > max_y:
                    max_y = y
    print(f"silhouette bbox: {min_x},{min_y} - {max_x},{max_y}")
    sw = max_x - min_x + 1
    sh = max_y - min_y + 1
    side_t = max(sw, sh)
    sq = bytearray(side_t * side_t * 4)
    ox = (side_t - sw) // 2
    oy = (side_t - sh) // 2
    for y in range(sh):
        for x in range(sw):
            a = talpha[(min_y + y) * w + (min_x + x)]
            if a:
                sq[((oy + y) * side_t + ox + x) * 4 + 3] = a
    tray = resize_area(sq, side_t, side_t, 4, TRAY_SIZE, TRAY_SIZE)
    for i in range(0, len(tray), 4):  # template icons: solid black, alpha carries shape
        tray[i] = tray[i + 1] = tray[i + 2] = 0
    write_png(OUT_TRAY, TRAY_SIZE, TRAY_SIZE, tray)
    print(f"wrote {OUT_TRAY}")

    # Sidebar logo: whole tile square, downscaled (CSS crops it to a circle).
    sidebar = resize_area(tile_crop, cside, cside, 4, SIDEBAR_SIZE, SIDEBAR_SIZE)
    OUT_SIDEBAR.parent.mkdir(exist_ok=True)
    write_png(OUT_SIDEBAR, SIDEBAR_SIZE, SIDEBAR_SIZE, sidebar)
    print(f"wrote {OUT_SIDEBAR}")


if __name__ == "__main__":
    main()
