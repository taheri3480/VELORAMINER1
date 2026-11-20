#!/usr/bin/env python3
"""Composite the official Velora mark into OG + X banner. Exact pixels, no redraw."""
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageEnhance
import numpy as np
import os

ROOT = "/workspace"
MARK_PATH = f"{ROOT}/src/assets/velora-mark.png"
FONT_BOLD = f"{ROOT}/.grok/fonts/Cinzel-Bold.ttf"
FONT_REG = f"{ROOT}/.grok/fonts/Cinzel-Regular.ttf"
BG = np.array([7, 6, 12], dtype=np.float32)
GOLD = (240, 193, 75)
GOLD_HI = (255, 244, 214)
GOLD_MID = (240, 193, 75)
GOLD_DEEP = (176, 124, 36)

def load_mark():
    im = Image.open(MARK_PATH).convert("RGBA")
    # tight to any non-zero alpha so the orbit ring is fully kept
    bbox = im.split()[-1].getbbox()
    # pad 2px inside source if possible
    l, t, r, b = bbox
    l = max(0, l - 2); t = max(0, t - 2)
    r = min(im.width, r + 2); b = min(im.height, b + 2)
    return im.crop((l, t, r, b))

def make_bg(w, h, glow_centers, seed):
    rng = np.random.default_rng(seed)
    img = np.empty((h, w, 3), dtype=np.float32)
    img[:] = BG
    yy, xx = np.mgrid[0:h, 0:w]
    for (gx, gy, radius, strength, color) in glow_centers:
        dist = np.sqrt((xx - gx) ** 2 + (yy - gy) ** 2)
        g = np.clip(1.0 - dist / radius, 0, 1) ** 1.7
        img += g[..., None] * (np.array(color, dtype=np.float32) * strength)
    # edge vignette toward near-black
    vx = (xx - w / 2) / (w / 2)
    vy = (yy - h / 2) / (h / 2)
    vig = np.clip(vx ** 2 * 0.85 + vy ** 2, 0, 1)
    img *= (1.0 - 0.55 * vig)[..., None]
    # fine grain so the black isn't posterized
    img += rng.normal(0, 1.15, (h, w, 1))
    img = np.clip(img, 0, 255).astype(np.uint8)
    base = Image.fromarray(img, "RGB").convert("RGBA")

    dust = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(dust)
    # sparse subtle specks, denser near glows
    n = int(w * h / 2800)
    for i in range(n):
        x = int(rng.integers(0, w))
        y = int(rng.integers(0, h))
        # bias: reject some far from primary glow
        gx, gy = glow_centers[0][0], glow_centers[0][1]
        if rng.random() < 0.45:
            x = int(np.clip(rng.normal(gx, w * 0.28), 0, w - 1))
            y = int(np.clip(rng.normal(gy, h * 0.32), 0, h - 1))
        roll = rng.random()
        if roll < 0.72:
            rad = float(rng.uniform(0.4, 1.15))
            a = int(rng.integers(40, 130))
        elif roll < 0.93:
            rad = float(rng.uniform(1.1, 2.1))
            a = int(rng.integers(30, 90))
        else:
            rad = float(rng.uniform(2.2, 4.2))
            a = int(rng.integers(16, 48))
        tone = rng.random()
        if tone < 0.55:
            col = (240, 193, 75)
        elif tone < 0.8:
            col = (255, 236, 186)
        else:
            col = (196, 146, 58)
        d.ellipse([x - rad, y - rad, x + rad, y + rad], fill=(*col, a))
    # a few soft bokeh motes
    for i in range(14):
        x = int(rng.integers(0, w))
        y = int(rng.integers(0, h))
        rad = float(rng.uniform(6, 16))
        a = int(rng.integers(8, 22))
        d.ellipse([x - rad, y - rad, x + rad, y + rad], fill=(240, 193, 75, a))
    sharp = dust.copy()
    soft = dust.filter(ImageFilter.GaussianBlur(1.15))
    # keep a few crisp specks
    base = Image.alpha_composite(base, soft)
    # re-draw only the brightest tiny specks crisp
    crisp = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    cd = ImageDraw.Draw(crisp)
    for i in range(max(24, n // 8)):
        x = int(rng.integers(0, w))
        y = int(rng.integers(0, h))
        a = int(rng.integers(140, 220))
        cd.ellipse([x, y, x + 1.2, y + 1.2], fill=(255, 244, 210, a))
    base = Image.alpha_composite(base, crisp)
    return base

def fit_mark(mark, width):
    scale = width / mark.width
    h = max(1, int(round(mark.height * scale)))
    return mark.resize((int(width), h), Image.Resampling.LANCZOS)

def paste_mark(canvas, mark, xy, shadow=True, glow=True):
    x, y = xy
    # pad so blur isn't clipped
    pad = 48
    layer = Image.new("RGBA", (mark.width + pad * 2, mark.height + pad * 2), (0, 0, 0, 0))
    layer.paste(mark, (pad, pad), mark)
    alpha = layer.split()[-1]
    if glow:
        g = Image.new("RGBA", layer.size, (0, 0, 0, 0))
        ga = alpha.point(lambda p: int(p * 0.42))
        solid = Image.new("RGBA", layer.size, (240, 180, 60, 255))
        solid.putalpha(ga)
        solid = solid.filter(ImageFilter.GaussianBlur(26))
        canvas.alpha_composite(solid, (x - pad, y - pad))
    if shadow:
        sh = Image.new("RGBA", layer.size, (0, 0, 0, 0))
        sa = alpha.point(lambda p: int(p * 0.65))
        blk = Image.new("RGBA", layer.size, (0, 0, 0, 255))
        blk.putalpha(sa)
        blk = blk.filter(ImageFilter.GaussianBlur(16))
        canvas.alpha_composite(blk, (x - pad, y - pad + 12))
    canvas.alpha_composite(mark, (x, y))

def text_advance(text, font, tracking):
    if not text:
        return 0
    w = 0
    for i, ch in enumerate(text):
        w += font.getlength(ch)
        if i < len(text) - 1:
            w += tracking
    return w

def render_tracked(text, font, tracking, grad_colors):
    """Return RGBA image of tracked text with a vertical gold gradient."""
    ascent, descent = font.getmetrics()
    # generous canvas
    adv = text_advance(text, font, tracking)
    W = int(adv + 32)
    H = ascent + descent + 16
    mask = Image.new("L", (W, H), 0)
    draw = ImageDraw.Draw(mask)
    x = 8
    top = 6
    for i, ch in enumerate(text):
        draw.text((x, top), ch, font=font, fill=255)
        x += font.getlength(ch) + (tracking if i < len(text) - 1 else 0)
    bbox = mask.getbbox()
    if bbox is None:
        raise SystemExit(f"no glyphs for {text!r}")
    mask = mask.crop(bbox)
    mw, mh = mask.size
    grad = Image.new("RGBA", (mw, mh), (0, 0, 0, 0))
    px = grad.load()
    # grad_colors: list of (t, (r,g,b)) t in 0..1
    def sample(t):
        t = max(0.0, min(1.0, t))
        for i in range(len(grad_colors) - 1):
            t0, c0 = grad_colors[i]
            t1, c1 = grad_colors[i + 1]
            if t <= t1 or i == len(grad_colors) - 2:
                u = 0 if t1 == t0 else (t - t0) / (t1 - t0)
                u = max(0, min(1, u))
                return tuple(int(c0[k] + (c1[k] - c0[k]) * u) for k in range(3))
        return grad_colors[-1][1]
    src = mask.load()
    for yy in range(mh):
        col = sample(yy / max(1, mh - 1))
        for xx in range(mw):
            a = src[xx, yy]
            if a:
                px[xx, yy] = (*col, a)
    return grad

def center_paste(canvas, im, cx, top):
    x = int(round(cx - im.width / 2))
    canvas.alpha_composite(im, (x, int(top)))
    return (x, int(top), x + im.width, int(top) + im.height)

def shadow_text(canvas, text_im, xy):
    x, y = xy
    a = text_im.split()[-1]
    sh = Image.new("RGBA", text_im.size, (0, 0, 0, 0))
    blk = Image.new("RGBA", text_im.size, (0, 0, 0, 180))
    blk.putalpha(a.point(lambda p: int(p * 0.75)))
    sh = blk.filter(ImageFilter.GaussianBlur(3))
    canvas.alpha_composite(sh, (x, y + 2))

GOLD_GRAD = [
    (0.0, (255, 248, 224)),
    (0.28, (255, 226, 140)),
    (0.55, (240, 193, 75)),
    (1.0, (186, 132, 40)),
]
TAG_GRAD = [
    (0.0, (244, 220, 150)),
    (1.0, (212, 168, 72)),
]

def build_og(mark):
    W, H = 1200, 630
    # glow sits where the mark will be (upper-middle of the lockup)
    bg = make_bg(W, H, glow_centers=[
        (600, 250, 420, 0.55, (90, 62, 18)),
        (600, 300, 220, 0.35, (140, 100, 30)),
    ], seed=11)
    m = fit_mark(mark, 430)
    # measure text first
    title_font = ImageFont.truetype(FONT_BOLD, 104)
    tag_font = ImageFont.truetype(FONT_REG, 26)
    title = render_tracked("VELORA", title_font, 16, GOLD_GRAD)
    tag = render_tracked("Mine · Stake · Grow", tag_font, 3.2, TAG_GRAD)
    gap_mt = 18
    gap_tt = 16
    block_h = m.height + gap_mt + title.height + gap_tt + tag.height
    top = int(round((H - block_h) / 2))
    # slight optical lift
    top = max(36, top)
    mx = int(round((W - m.width) / 2))
    my = top
    paste_mark(bg, m, (mx, my))
    title_box = center_paste.__wrapped__ if False else None
    ty = my + m.height + gap_mt
    # shadow then text
    tx = int(round(W / 2 - title.width / 2))
    shadow_text(bg, title, (tx, ty))
    bg.alpha_composite(title, (tx, ty))
    gy = ty + title.height + gap_tt
    gx = int(round(W / 2 - tag.width / 2))
    shadow_text(bg, tag, (gx, gy))
    bg.alpha_composite(tag, (gx, gy))
    boxes = {
        "mark": (mx, my, mx + m.width, my + m.height),
        "title": (tx, ty, tx + title.width, ty + title.height),
        "tag": (gx, gy, gx + tag.width, gy + tag.height),
    }
    return bg.convert("RGB"), boxes

def build_banner(mark):
    W, H = 1200, 264
    # lockup lives in the left half, above the midline
    bg = make_bg(W, H, glow_centers=[
        (250, 112, 280, 0.62, (96, 66, 18)),
        (180, 120, 160, 0.4, (150, 108, 32)),
        # faint warmth drifting right — scenery only, no mark
        (860, 90, 340, 0.18, (70, 48, 14)),
    ], seed=23)
    # mark height chosen so word can be large and still stay in the left half
    target_h = 148
    scale = target_h / mark.height
    m = mark.resize((max(1, int(round(mark.width * scale))), target_h), Image.Resampling.LANCZOS)
    title_font = ImageFont.truetype(FONT_BOLD, 58)
    tag_font = ImageFont.truetype(FONT_REG, 20)
    title = render_tracked("VELORA", title_font, 4, GOLD_GRAD)
    tag = render_tracked("Mine · Stake · Grow", tag_font, 1.6, TAG_GRAD)
    left = 48
    # vertical: lockup center above midline (132), glyphs above bottom fifth (y<211)
    # and a comfortable top margin
    text_h = title.height + 8 + tag.height
    lock_h = max(m.height, text_h)
    # place lockup so its center is around y=108 (above 132) and top margin ~32
    top = 34
    my = top + (lock_h - m.height) // 2
    # nudge mark up a hair so the orbit doesn't kiss the bottom fifth
    if my + m.height > 200:
        my = 200 - m.height
    mx = left
    paste_mark(bg, m, (mx, my), shadow=True, glow=True)
    text_x = mx + m.width + 22
    # vertically center text block on the mark
    ty = my + (m.height - text_h) // 2 - 2
    if ty < 28:
        ty = 28
    shadow_text(bg, title, (text_x, ty))
    bg.alpha_composite(title, (text_x, ty))
    gy = ty + title.height + 8
    shadow_text(bg, tag, (text_x, gy))
    bg.alpha_composite(tag, (text_x, gy))
    boxes = {
        "mark": (mx, my, mx + m.width, my + m.height),
        "title": (text_x, ty, text_x + title.width, ty + title.height),
        "tag": (text_x, gy, text_x + tag.width, gy + tag.height),
    }
    return bg.convert("RGB"), boxes

def report(name, boxes, W, H):
    print(f"== {name} {W}x{H}")
    for k, (l, t, r, b) in boxes.items():
        print(f"  {k}: x={l}..{r} y={t}..{b} w={r-l} h={b-t}")

def main():
    mark = load_mark()
    print("cropped mark", mark.size)
    og, ob = build_og(mark)
    report("og", ob, 1200, 630)
    ban, bb = build_banner(mark)
    report("banner", bb, 1200, 264)
    # safety gates
    for k, (l, t, r, b) in ob.items():
        if l < 24 or t < 24 or r > 1200 - 24 or b > 630 - 24:
            raise SystemExit(f"OG {k} too close to edge {(l,t,r,b)}")
    for k in ("title", "tag"):
        l, t, r, b = bb[k]
        if r > 600 or b > 211 or l < 16 or t < 12:
            raise SystemExit(f"banner {k} outside safe lockup {(l,t,r,b)}")
    # right half / bottom fifth must not contain title/tagline
    os.makedirs("/workspace/.grok", exist_ok=True)
    og.save("/workspace/.grok/og-raw.png", "PNG")
    ban.save("/workspace/.grok/banner-raw.png", "PNG")
    print("wrote raw pngs")

if __name__ == "__main__":
    main()
