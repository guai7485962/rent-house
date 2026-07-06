/**
 * 離線渲染像素場景 → PNG 預覽圖(開發用)
 * 用法: npx tsx scripts/render-preview.ts <輸出路徑.png>
 * 不依賴瀏覽器與 node-canvas:自製 FakeCtx + 純 zlib PNG 編碼。
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { composeScene, SCENE_W, SCENE_H, type SceneState } from "../src/pixel/scene";

// ---------------------------------------------------------------------------
// FakeCtx:只實作 scene.ts 用到的 fillStyle / fillRect / clearRect
// ---------------------------------------------------------------------------

function parseColor(c: string): [number, number, number, number] {
  if (c.startsWith("#")) {
    return [
      parseInt(c.slice(1, 3), 16),
      parseInt(c.slice(3, 5), 16),
      parseInt(c.slice(5, 7), 16),
      1,
    ];
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(",").map((v) => parseFloat(v.trim()));
    return [parts[0], parts[1], parts[2], parts[3] ?? 1];
  }
  return [255, 0, 255, 1]; // 洋紅 = 解析失敗警示色
}

class FakeCtx {
  buf: Uint8ClampedArray;
  fillStyle = "#000000";
  constructor(
    public w: number,
    public h: number,
  ) {
    this.buf = new Uint8ClampedArray(w * h * 4);
  }
  clearRect(x: number, y: number, w: number, h: number) {
    for (let j = y; j < y + h; j++)
      for (let i = x; i < x + w; i++) {
        const o = (j * this.w + i) * 4;
        this.buf[o] = this.buf[o + 1] = this.buf[o + 2] = this.buf[o + 3] = 0;
      }
  }
  fillRect(x: number, y: number, w: number, h: number) {
    const [r, g, b, a] = parseColor(this.fillStyle);
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++) {
      for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) {
        const o = (j * this.w + i) * 4;
        // src-over 混合
        this.buf[o] = r * a + this.buf[o] * (1 - a);
        this.buf[o + 1] = g * a + this.buf[o + 1] * (1 - a);
        this.buf[o + 2] = b * a + this.buf[o + 2] * (1 - a);
        this.buf[o + 3] = 255;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 純 Node PNG 編碼(truecolor, 8-bit)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

function encodePNG(rgba: Uint8ClampedArray, w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 每行前加 filter byte 0
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 場景清單(涵蓋主要視覺狀態組合)
// ---------------------------------------------------------------------------

const SCENES: SceneState[] = [
  {
    tenantId: "tenant_chen_engineer",
    visualState: "working_at_desk",
    roomProps: ["delivery_boxes_piled", "screen_glow"],
    cleanliness: 35,
    frame: 0,
  },
  {
    tenantId: "tenant_chen_engineer",
    visualState: "sleeping_on_couch",
    roomProps: ["delivery_boxes_piled", "cat_sleeping_on_couch", "lights_off"],
    cleanliness: 32,
    frame: 1,
  },
  {
    tenantId: "tenant_chen_engineer",
    visualState: "playing_with_cat",
    roomProps: ["cat_on_table", "screen_glow"],
    cleanliness: 40,
    frame: 0,
  },
  {
    tenantId: "tenant_chen_engineer",
    visualState: "away",
    roomProps: ["delivery_boxes_piled", "trash_overflow", "cat_on_table"],
    cleanliness: 30,
    frame: 1,
  },
  {
    tenantId: "tenant_lin_asmr",
    visualState: "streaming",
    roomProps: ["mic_setup_active", "curtains_closed", "screen_glow"],
    cleanliness: 92,
    frame: 0,
  },
  {
    tenantId: "tenant_lin_asmr",
    visualState: "sleeping_on_bed",
    roomProps: ["curtains_closed"],
    cleanliness: 92,
    frame: 1,
  },
  {
    tenantId: "tenant_chen_engineer",
    visualState: "crying",
    roomProps: ["lights_off"],
    cleanliness: 45,
    frame: 0,
  },
  {
    tenantId: "tenant_lin_asmr",
    visualState: "talking_on_phone",
    roomProps: ["curtains_closed", "mic_setup_active"],
    cleanliness: 90,
    frame: 1,
  },
];

// ---------------------------------------------------------------------------
// 拼接 contact sheet(2 欄)並放大 3 倍輸出
// ---------------------------------------------------------------------------

const COLS = 2;
const GAP = 4;
const SCALE = 3;
const rows = Math.ceil(SCENES.length / COLS);
const sheetW = COLS * SCENE_W + (COLS + 1) * GAP;
const sheetH = rows * SCENE_H + (rows + 1) * GAP;
const sheet = new Uint8ClampedArray(sheetW * sheetH * 4);
// 背景填深色
for (let i = 0; i < sheet.length; i += 4) {
  sheet[i] = 13; sheet[i + 1] = 12; sheet[i + 2] = 18; sheet[i + 3] = 255;
}

SCENES.forEach((scene, idx) => {
  const ctx = new FakeCtx(SCENE_W, SCENE_H);
  composeScene(ctx as any, scene);
  const ox = GAP + (idx % COLS) * (SCENE_W + GAP);
  const oy = GAP + Math.floor(idx / COLS) * (SCENE_H + GAP);
  for (let y = 0; y < SCENE_H; y++) {
    for (let x = 0; x < SCENE_W; x++) {
      const src = (y * SCENE_W + x) * 4;
      const dst = ((oy + y) * sheetW + (ox + x)) * 4;
      sheet[dst] = ctx.buf[src];
      sheet[dst + 1] = ctx.buf[src + 1];
      sheet[dst + 2] = ctx.buf[src + 2];
      sheet[dst + 3] = 255;
    }
  }
});

// 最近鄰放大
const outW = sheetW * SCALE;
const outH = sheetH * SCALE;
const out = new Uint8ClampedArray(outW * outH * 4);
for (let y = 0; y < outH; y++) {
  for (let x = 0; x < outW; x++) {
    const src = ((y / SCALE | 0) * sheetW + (x / SCALE | 0)) * 4;
    const dst = (y * outW + x) * 4;
    out[dst] = sheet[src];
    out[dst + 1] = sheet[src + 1];
    out[dst + 2] = sheet[src + 2];
    out[dst + 3] = 255;
  }
}

const outPath = process.argv[2] ?? "preview.png";
writeFileSync(outPath, encodePNG(out, outW, outH));
console.log(`寫出 ${outPath} (${outW}x${outH})`);
