"""重新生成 Castalia 托盘图标库(三版 × 9 档 + ICO + 预览)。

改了高清原图(HD)或想调圆角比例时直接跑:
    python make_icons.py
所有版本都从高清图生成;缩放全程预乘 alpha,避免边缘暗晕。
"""
import os
from PIL import Image, ImageDraw, ImageFilter

HD = r"C:\Users\yuepengcheng\AppData\Roaming\Hermes\composer-images\castalia_c7d0b4.jpg"
CURRENT = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(os.path.dirname(CURRENT), "tray-icons")
SIZES = (16, 24, 32, 48, 64, 96, 128, 256, 512)
ICO = [(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)]
PLATE = (101, 304, 682, 871)          # 实测:盘子边界(含设计描边),高清图坐标
PLATE_R, SQUARE_R, SQUARE_FILL = 0.265, 0.24, 0.78   # 圆角比例 / 方图版占画布比例
GLYPH_EDGE, GLYPH_PAD = (10, 10), 0.06               # 抠图闸门 G-R 的 (偏移, 跨度) / 边距


def pm_resize(img, size):
    """预乘 alpha 缩放:BOX(降采样,覆盖度抗锯齿)/ LANCZOS(放大)"""
    bands = list(img.split()); a = bands[3]; apx = a.load(); pm = []
    for c in bands[:3]:
        m = Image.new("L", img.size); mp = m.load(); cp = c.load()
        for y in range(img.size[1]):
            for x in range(img.size[0]): mp[x, y] = cp[x, y] * apx[x, y] // 255
        pm.append(m)
    rs = Image.Resampling.BOX if size < img.size[0] else Image.Resampling.LANCZOS
    small = [c.resize((size, size), rs) for c in pm] + [a.resize((size, size), rs)]
    sa = small[3].load(); s3 = [c.load() for c in small[:3]]
    o = Image.new("RGBA", (size, size)); op = o.load()
    for y in range(size):
        for x in range(size):
            av = sa[x, y]
            if av == 0: op[x, y] = (0, 0, 0, 0); continue
            f = av / 255.0
            op[x, y] = tuple(max(0, min(255, int(s3[i][x, y] / f))) for i in range(3)) + (av,)
    return o


def round_mask(size, pct, ss=8):
    m = Image.new("L", (size*ss, size*ss), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size*ss-1, size*ss-1), radius=int(size*pct)*ss, fill=255)
    return m.resize((size, size), Image.Resampling.LANCZOS)


def build():
    hd = Image.open(HD).convert("RGB"); HW, HH = hd.size; hp = hd.load()
    cx, cy = (PLATE[0]+PLATE[2])//2, (PLATE[1]+PLATE[3])//2
    # ① 裁到盘边
    pl = hd.crop(PLATE); pw, ph = pl.size; side = max(pw, ph)
    sq = Image.new("RGB", (side, side), hp[6, HH-6]); sq.paste(pl, ((side-pw)//2, (side-ph)//2))
    v_plate = sq.convert("RGBA"); v_plate.putalpha(round_mask(side, PLATE_R))
    # ② 方图圆角
    s2 = int(side / SQUARE_FILL); h = s2//2
    v_square = hd.crop((cx-h, cy-h, cx-h+s2, cy-h+s2)).convert("RGBA")
    v_square.putalpha(round_mask(s2, SQUARE_R))
    # ③ 只剩图案:alpha 由 G-R 闸门给,边界像素按已知底盘反解本色
    a = Image.new("L", (HW, HH)); ap = a.load(); bgs = Image.new("RGB", (HW, HH), (0, 0, 0)); bp = bgs.load()
    off, span = GLYPH_EDGE
    for y in range(HH):
        for x in range(HW):
            r, g, b = hp[x, y]; av = max(0.0, min(1.0, ((g - r) - off) / span))
            ap[x, y] = int(round(av*255))
            if av == 0: bp[x, y] = (r, g, b)
    bgb = bgs.filter(ImageFilter.GaussianBlur(12)).load()
    gl = Image.new("RGBA", (HW, HH)); gp = gl.load()
    for y in range(HH):
        for x in range(HW):
            a255 = ap[x, y]
            if a255 == 0: gp[x, y] = (0, 0, 0, 0); continue
            r, g, b = hp[x, y]
            if a255 < 250:
                f = a255/255.0; pr, pg, pb = bgb[x, y]
                r = max(0, min(255, int((r - pr*(1-f))/f))); g = max(0, min(255, int((g - pg*(1-f))/f))); b = max(0, min(255, int((b - pb*(1-f))/f)))
            gp[x, y] = (r, g, b, a255)
    bb = gl.split()[3].getbbox(); g2 = gl.crop(bb); gw, gh = g2.size
    sd = max(gw, gh); pad = int(sd*GLYPH_PAD)
    cv = Image.new("RGBA", (sd+2*pad, sd+2*pad), (0, 0, 0, 0)); cv.paste(g2, (pad+(sd-gw)//2, pad+(sd-gh)//2), g2)
    return {"plate": v_plate, "square": v_square, "glyph": cv}


def main():
    for key, img in build().items():
        d = os.path.join(LIB, key); os.makedirs(d, exist_ok=True)
        for s in SIZES: pm_resize(img, s).save(os.path.join(d, "castalia-%s-%d.png" % (key, s)))
        pm_resize(img, 64).save(os.path.join(d, "castalia-%s.ico" % key), sizes=ICO)
        pm_resize(img, 256).save(os.path.join(d, "preview.png"))
        print("✓ %-7s 源 %dx%d → %d 档 PNG + ico + preview" % (key, img.size[0], img.size[1], len(SIZES)))
    print("(托盘读的是 active-64.png;换版本用 use-tray-icon.py 或 切换托盘图标.bat)")


if __name__ == "__main__":
    main()
