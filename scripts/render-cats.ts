/**
 * 離線渲染:四種花色 × 走/坐/睡 的貓咪 sprite 目檢(開發檢視用)
 * 用法: npx tsx scripts/render-cats.ts [輸出.png]
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { composeFloor, FLOOR_W, FLOOR_H } = await import("../src/floor/floorScene");
import type { PetAgent } from "../src/floor/petAgents";

function parseColor(c: string): [number, number, number, number] {
  if (c.startsWith("#")) return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), 1];
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(",").map((v) => parseFloat(v.trim()));
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  return [255, 0, 255, 1];
}

class FakeCtx {
  buf: Uint8ClampedArray;
  fillStyle = "#000000";
  globalAlpha = 1;
  constructor(public w: number, public h: number) {
    this.buf = new Uint8ClampedArray(w * h * 4);
  }
  save() {}
  restore() { this.globalAlpha = 1; }
  clearRect() {}
  fillRect(x: number, y: number, w: number, h: number) {
    const [r, g, b, a0] = parseColor(this.fillStyle);
    const a = a0 * this.globalAlpha;
    for (let j = Math.max(0, y | 0); j < Math.min(this.h, y + h); j++)
      for (let i = Math.max(0, x | 0); i < Math.min(this.w, x + w); i++) {
        const o = (j * this.w + i) * 4;
        this.buf[o] = r * a + this.buf[o] * (1 - a);
        this.buf[o + 1] = g * a + this.buf[o + 1] * (1 - a);
        this.buf[o + 2] = b * a + this.buf[o + 2] * (1 - a);
        this.buf[o + 3] = 255;
      }
  }
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}
function encodePNG(rgba: Uint8ClampedArray, w: number, h: number) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
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

// 貓狗各四種花色 × 走(右)/走(左)/坐/睡,集中輸出成寵物 contact sheet。
const petAgent = (kind: "cat" | "dog", color: number, c: number, r: number, o: Partial<PetAgent>): PetAgent => ({
  petId: `${kind}_demo${color}_${c}_${r}`,
  name: "demo",
  kind,
  color,
  c, r,
  px: c * 16,
  py: r * 16,
  path: [],
  moving: false,
  walkPhase: 0,
  restUntil: Number.MAX_SAFE_INTEGER,
  sleeping: false,
  facing: 1,
  ...o,
});
const cats: PetAgent[] = [];
for (let color = 0; color < 4; color++) {
  const r = 10 + color;
  cats.push(petAgent("cat", color, 2, r, { moving: true, facing: 1 }));
  cats.push(petAgent("cat", color, 4, r, { moving: true, facing: -1, walkPhase: 1 }));
  cats.push(petAgent("cat", color, 6, r, {}));
  cats.push(petAgent("cat", color, 7, r, { sleeping: true }));
}

for (let color = 0; color < 4; color++) {
  const r = 10 + color;
  cats.push(petAgent("dog", color, 9, r, { moving: true, facing: 1 }));
  cats.push(petAgent("dog", color, 11, r, { moving: true, facing: -1, walkPhase: 1 }));
  cats.push(petAgent("dog", color, 13, r, {}));
  cats.push(petAgent("dog", color, 15, r, { sleeping: true }));
}

// 五種雙貓互動演出；每對固定相鄰，方便一次目檢共享道具與前景特效。
const actions = ["chase", "groom", "nap", "territory", "mischief"] as const;
for (let i = 0; i < actions.length; i++) {
  const ownerA = `pair_${i}_a`;
  const ownerB = `pair_${i}_b`;
  const r = 15 + i * 2;
  cats.push(petAgent("cat", 0, 5, r, {
    petId: ownerA,
    pairAction: actions[i],
    pairWith: ownerB,
    pairLeader: true,
    moving: actions[i] === "chase",
    sleeping: actions[i] === "nap",
  }));
  cats.push(petAgent("cat", 1, 6, r, {
    petId: ownerB,
    pairAction: actions[i],
    pairWith: ownerA,
    pairLeader: false,
    moving: actions[i] === "chase",
    sleeping: actions[i] === "nap",
    facing: -1,
  }));
}

const ctx = new FakeCtx(FLOOR_W, FLOOR_H);
composeFloor(ctx as any, 0, undefined, undefined, undefined, cats);

const SCALE = 3;
const outW = FLOOR_W * SCALE;
const outH = FLOOR_H * SCALE;
const out = new Uint8ClampedArray(outW * outH * 4);
for (let y = 0; y < outH; y++)
  for (let x = 0; x < outW; x++) {
    const src = (((y / SCALE) | 0) * FLOOR_W + ((x / SCALE) | 0)) * 4;
    const dst = (y * outW + x) * 4;
    out[dst] = ctx.buf[src];
    out[dst + 1] = ctx.buf[src + 1];
    out[dst + 2] = ctx.buf[src + 2];
    out[dst + 3] = 255;
  }
const outPath = process.argv[2] ?? "pets.png";
writeFileSync(outPath, encodePNG(out, outW, outH));
console.log(`寫出 ${outPath} (${outW}x${outH})`);
