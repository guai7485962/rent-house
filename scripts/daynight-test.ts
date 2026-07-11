/**
 * 日夜光線 + 房間細看重畫(工作項 9)驗證:
 * - dayNightTint:24 小時映射合理(白天無色調、深夜最暗、alpha 有上限)
 * - 離線渲染煙霧測試:正午 vs 深夜整張圖平均亮度,深夜必須更暗;不傳 hour 行為不變
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { dayNightTint, composeFloor, FLOOR_W, FLOOR_H } = await import("../src/floor/floorScene");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

// --- 色調映射 ---
check("白天(9/12/15 時)無色調", [9, 12, 15].every((h) => dayNightTint(h) === null));
check("深夜(23/0/3 時)有色調", [23, 0, 3].every((h) => dayNightTint(h) !== null));
check("黃昏(18 時)有暖色調", dayNightTint(18) !== null);
const alphas = Array.from({ length: 24 }, (_, h) => dayNightTint(h)?.alpha ?? 0);
check("24 小時 alpha 都 ≤ 0.4(不會黑到看不見)", alphas.every((a) => a <= 0.4));
check("深夜比黃昏暗", (dayNightTint(23)?.alpha ?? 0) > (dayNightTint(18)?.alpha ?? 0));
check("色調都是合法 hex 色", Array.from({ length: 24 }, (_, h) => dayNightTint(h)).every((t) => t === null || /^#[0-9a-f]{6}$/i.test(t.color)));

// --- 離線渲染煙霧測試(與 render-floor.ts 同款 FakeCtx)---
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
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++)
      for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) {
        const o = (j * this.w + i) * 4;
        this.buf[o] = r * a + this.buf[o] * (1 - a);
        this.buf[o + 1] = g * a + this.buf[o + 1] * (1 - a);
        this.buf[o + 2] = b * a + this.buf[o + 2] * (1 - a);
        this.buf[o + 3] = 255;
      }
  }
  brightness(): number {
    let sum = 0;
    for (let i = 0; i < this.buf.length; i += 4) sum += this.buf[i] + this.buf[i + 1] + this.buf[i + 2];
    return sum / (this.buf.length / 4);
  }
}

const noon = new FakeCtx(FLOOR_W, FLOOR_H);
composeFloor(noon as any, 0, undefined, undefined, 12);
const night = new FakeCtx(FLOOR_W, FLOOR_H);
composeFloor(night as any, 0, undefined, undefined, 23);
const plain = new FakeCtx(FLOOR_W, FLOOR_H);
composeFloor(plain as any, 0);

check("渲染無崩潰、有內容", noon.brightness() > 10);
check("深夜整張圖比正午暗", night.brightness() < noon.brightness(), `noon=${noon.brightness().toFixed(1)} night=${night.brightness().toFixed(1)}`);
check("正午 = 無色調(與不傳 hour 相同)", Math.abs(noon.brightness() - plain.brightness()) < 0.01);
check("深夜也沒有暗到看不見(亮度 > 正午一半)", night.brightness() > noon.brightness() * 0.5);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
