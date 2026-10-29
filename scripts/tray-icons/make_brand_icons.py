# -*- coding: utf-8 -*-
"""Castalia 三变体品牌图标库生成器

输入:用户精裁好的三张原图(白底、圆角方块图标)
输出:每个变体一套 —— 多尺寸 PNG(白底已抠成透明)+ 多尺寸 .ico + 托盘用 64px

用法:python make_brand_icons.py
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
BRAND = os.path.join(HERE, "brand")
SRC = {
    "lite":  os.path.join(BRAND, "src-lite.png"),
    "anima": os.path.join(BRAND, "src-anima.png"),
    "max":   os.path.join(BRAND, "src-max.png"),
}
SIZES = [16, 24, 32, 48, 64, 128, 256, 512]
ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def _flood_transparent(img, tol=18):
    """从四角 flood fill 把白底变透明(只吃连通的背景,不动图标内部的高光)。"""
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()
    from collections import deque

    def is_bg(p):
        r, g, b, a = p
        return r > 255 - tol and g > 255 - tol and b > 255 - tol

    seen = [[False] * w for _ in range(h)]
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not seen[y][x] and is_bg(px[x, y]):
                seen[y][x] = True
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if not seen[y][x] and is_bg(px[x, y]):
                seen[y][x] = True
                q.append((x, y))
    while q:
        x, y = q.popleft()
        px[x, y] = (255, 255, 255, 0)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx] and is_bg(px[nx, ny]):
                seen[ny][nx] = True
                q.append((nx, ny))
    return img


def _autocrop(img, tol=18):
    """裁到内容(非透明)边界,并补成正方形(留 2% 呼吸位)。"""
    bbox = img.split()[-1].getbbox()
    if not bbox:
        return img
    img = img.crop(bbox)
    w, h = img.size
    side = int(max(w, h) * 1.02)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - w) // 2, (side - h) // 2), img)
    return canvas


def build(variant):
    src = SRC[variant]
    if not os.path.exists(src):
        print(f"  {variant}: 缺少源图 {src} —— 跳过")
        return None
    im = Image.open(src).convert("RGBA")
    im.thumbnail((1024, 1024), Image.LANCZOS)   # 先降到 1024:flood fill 快很多,且 512 输出足够
    im = _flood_transparent(im)
    im = _autocrop(im)
    master = im.resize((512, 512), Image.LANCZOS)
    master.save(os.path.join(BRAND, f"{variant}-512.png"))

    for s in SIZES:
        im.resize((s, s), Image.LANCZOS).save(os.path.join(BRAND, f"{variant}-{s}.png"))
    master.save(os.path.join(BRAND, f"{variant}.ico"), format="ICO", sizes=ICO_SIZES)
    # 托盘用:Windows 通知区在高 DPI 下取 32-64,给 64 由 pystray 缩放
    im.resize((64, 64), Image.LANCZOS).save(os.path.join(BRAND, f"{variant}-tray.png"))
    print(f"  {variant}: 512/256/128/64/48/32/24/16 PNG + {variant}.ico + {variant}-tray.png")
    return master


if __name__ == "__main__":
    print("生成三变体图标库 →", BRAND)
    made = [build(v) for v in ("lite", "anima", "max")]
    # 对比预览
    ok = [m for m in made if m]
    if ok:
        pad, size = 20, 192
        canvas = Image.new("RGBA", (size * len(ok) + pad * (len(ok) + 1), size + pad * 2), (22, 24, 30, 255))
        for i, m in enumerate(ok):
            canvas.paste(m.resize((size, size), Image.LANCZOS), (pad + i * (size + pad), pad), m.resize((size, size), Image.LANCZOS))
        out = os.path.join(BRAND, "preview-3variants.png")
        canvas.convert("RGB").save(out)
        print("预览:", out)
