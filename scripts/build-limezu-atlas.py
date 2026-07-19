# -*- coding: utf-8 -*-
"""可重現的 LimeZu atlas 建置管線。

讀 scripts/limezu-manifest.json,從本機已授權的 Modern Interiors 素材
(不進版控)重組出:

  public/assets/limezu/furniture.png  — 家具 atlas(裁透明邊後 1:1 貼入)
  public/assets/limezu/floors.png     — 地板 atlas(每房一列 3 個 16x16 變體)
  public/assets/limezu/walls.png      — 牆面 atlas(頂蓋/牆身 8 件 + 踢腳條)

任何來源缺檔、裁切框不符、atlas 越界或重疊 → 直接報錯,不輸出半成品。

用法(repo 根目錄):python scripts/build-limezu-atlas.py
"""
import json
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
MANIFEST_PATH = os.path.join(HERE, "limezu-manifest.json")


def fail(msg: str) -> None:
    raise SystemExit(f"[build-limezu-atlas] 錯誤:{msg}")


def load_source(root: str, rel: str) -> Image.Image:
    path = os.path.normpath(os.path.join(root, rel))
    if not os.path.exists(path):
        fail(f"來源檔不存在:{path}")
    return Image.open(path).convert("RGBA")


def main() -> None:
    with open(MANIFEST_PATH, encoding="utf-8") as f:
        manifest = json.load(f)

    source_root = os.path.normpath(os.path.join(REPO, manifest["source_root"]))
    if not os.path.isdir(source_root):
        fail(f"素材根目錄不存在:{source_root}")

    # ---------------- furniture atlas ----------------
    fa = manifest["furniture_atlas"]
    atlas = Image.new("RGBA", (fa["width"], fa["height"]), (0, 0, 0, 0))
    placed: dict[str, tuple[int, int, int, int]] = {}  # id -> (ax, ay, w, h)

    entries = manifest["furniture"]
    for fid, spec in entries.items():
        if "alias" in spec:
            continue
        src = load_source(source_root, spec["source"])
        x, y, w, h = spec["crop"]
        if x < 0 or y < 0 or x + w > src.width or y + h > src.height:
            fail(f"{fid} 裁切框 {spec['crop']} 超出來源 {src.size}")
        crop = crop_img = src.crop((x, y, x + w, y + h))
        bbox = crop_img.getchannel("A").getbbox()
        if bbox != (0, 0, w, h):
            fail(f"{fid} 裁切框未貼齊不透明範圍(實際 bbox={bbox}),manifest 需修正")
        ax, ay = spec["atlas"]
        if ax < 0 or ay < 0 or ax + w > fa["width"] or ay + h > fa["height"]:
            fail(f"{fid} atlas 位置 ({ax},{ay}) + {w}x{h} 超出 atlas {fa['width']}x{fa['height']}")
        for other, (ox, oy, ow, oh) in placed.items():
            if ax < ox + ow and ax + w > ox and ay < oy + oh and ay + h > oy:
                fail(f"{fid} 與 {other} 在 atlas 上重疊")
        atlas.alpha_composite(crop, (ax, ay))
        placed[fid] = (ax, ay, w, h)

    for fid, spec in entries.items():
        if "alias" in spec and spec["alias"] not in placed:
            fail(f"{fid} 的 alias 目標 {spec['alias']} 不存在")

    # ---------------- wall atlas ----------------
    wa = manifest["wall_atlas"]
    wall_atlas = Image.new("RGBA", (wa["width"], wa["height"]), (0, 0, 0, 0))
    wall_placed: dict[str, tuple[int, int, int, int]] = {}
    for wid, spec in manifest["walls"].items():
        src = load_source(source_root, spec["source"])
        x, y, w, h = spec["crop"]
        if x < 0 or y < 0 or x + w > src.width or y + h > src.height:
            fail(f"牆件 {wid} 裁切框 {spec['crop']} 超出來源 {src.size}")
        crop = src.crop((x, y, x + w, y + h))
        alpha = crop.getchannel("A").getextrema()
        if alpha[0] != 255:
            fail(f"牆件 {wid} 含透明像素,牆貼圖必須完全不透明")
        ax, ay = spec["atlas"]
        if ax < 0 or ay < 0 or ax + w > wa["width"] or ay + h > wa["height"]:
            fail(f"牆件 {wid} atlas 位置 ({ax},{ay}) + {w}x{h} 超出 atlas {wa['width']}x{wa['height']}")
        for other, (ox, oy, ow, oh) in wall_placed.items():
            if ax < ox + ow and ax + w > ox and ay < oy + oh and ay + h > oy:
                fail(f"牆件 {wid} 與 {other} 在 atlas 上重疊")
        wall_atlas.alpha_composite(crop, (ax, ay))
        wall_placed[wid] = (ax, ay, w, h)

    # ---------------- floor atlas ----------------
    fl = manifest["floor_atlas"]
    sheet = load_source(source_root, fl["source"])
    floors = Image.new("RGBA", (fl["width"], fl["height"]), (0, 0, 0, 0))
    rows_seen: set[int] = set()
    for room, spec in manifest["floors"].items():
        row = spec["row"]
        cells = spec["cells"]
        if len(cells) != 3:
            fail(f"{room} 需要 3 個變體格,拿到 {len(cells)}")
        if row in rows_seen:
            fail(f"{room} 的 row {row} 與其他房重複")
        rows_seen.add(row)
        if (row + 1) * 16 > fl["height"]:
            fail(f"{room} row {row} 超出地板 atlas 高度")
        for i, (c, r) in enumerate(cells):
            if (c + 1) * 16 > sheet.width or (r + 1) * 16 > sheet.height:
                fail(f"{room} 變體格 ({c},{r}) 超出地板 sheet {sheet.size}")
            tile = sheet.crop((c * 16, r * 16, c * 16 + 16, r * 16 + 16))
            alpha = tile.getchannel("A").getextrema()
            if alpha[0] != 255:
                fail(f"{room} 變體格 ({c},{r}) 含透明像素,不是地板格")
            floors.alpha_composite(tile, (i * 16, row * 16))

    # ---------------- 全部驗證通過才落地 ----------------
    out_furniture = os.path.join(REPO, fa["file"])
    out_floors = os.path.join(REPO, fl["file"])
    out_walls = os.path.join(REPO, wa["file"])
    os.makedirs(os.path.dirname(out_furniture), exist_ok=True)
    atlas.save(out_furniture)
    floors.save(out_floors)
    wall_atlas.save(out_walls)
    print(f"OK furniture atlas {fa['width']}x{fa['height']} → {out_furniture}({len(placed)} frames,{len(entries) - len(placed)} alias)")
    print(f"OK floor atlas {fl['width']}x{fl['height']} → {out_floors}({len(rows_seen)} rooms)")
    print(f"OK wall atlas {wa['width']}x{wa['height']} → {out_walls}({len(wall_placed)} pieces)")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 —— 任何未預期錯誤都不留半成品
        sys.exit(f"[build-limezu-atlas] 未預期錯誤:{error}")
