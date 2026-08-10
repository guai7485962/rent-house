/**
 * 2026-08-10 送養合照的測試。
 *
 * 要釘住的不變式:
 *   ① 照片**不進存檔**:PetHomeEntry 只多兩個選填欄位,沒有任何圖片資料;
 *   ② 決定性:同一筆紀錄每次畫出來逐像素相同(舊紀錄沒有飼主資料也一樣);
 *   ③ 涵蓋:每個貓/狗花色都畫得出來,而且彼此不同(新花色不會靜靜畫成橘貓);
 *   ④ 花色是唯一出處:`floorScene` 與 `petPhoto` 讀同一份 `petPalettes`;
 *   ⑤ 咖啡廳認養會把顧客的姓名與外觀留進紀錄(合照畫的是玩家真的看過的那個人)。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const photo = await import("../src/floor/petPhoto");
const { CAT_PALS, DOG_PALS } = await import("../src/floor/petPalettes");
const { sanitizeAppearanceColors } = await import("../src/pixel/parts");
const { state } = await import("../src/store");
const pets = await import("../src/sim/pets");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

/**
 * 極小的 2D context 替身:只記下每一次繪圖呼叫。
 * 無頭環境沒有真的 canvas,但我們要驗的是「畫了什麼、是不是決定性」,
 * 逐呼叫的指紋比真的點陣圖更好比對,也不必拉 canvas 相依。
 */
function fakeCtx() {
  const ops: string[] = [];
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const ctx: any = {
    fillStyle: "", strokeStyle: "", lineWidth: 1, imageSmoothingEnabled: true,
    fillRect: (x: number, y: number, w: number, h: number) => ops.push(`f|${r2(x)},${r2(y)},${r2(w)},${r2(h)}|${ctx.fillStyle}`),
    strokeRect: (x: number, y: number, w: number, h: number) => ops.push(`s|${r2(x)},${r2(y)},${r2(w)},${r2(h)}|${ctx.strokeStyle}|${ctx.lineWidth}`),
    clearRect: (x: number, y: number, w: number, h: number) => ops.push(`c|${r2(x)},${r2(y)},${r2(w)},${r2(h)}`),
    beginPath: () => ops.push("bp"),
    ellipse: (x: number, y: number, rx: number, ry: number) => ops.push(`e|${r2(x)},${r2(y)},${r2(rx)},${r2(ry)}|${ctx.fillStyle}`),
    fill: () => ops.push("fill"),
    save: () => ops.push("save"),
    restore: () => ops.push("restore"),
    translate: (x: number, y: number) => ops.push(`t|${r2(x)},${r2(y)}`),
    scale: (x: number, y: number) => ops.push(`sc|${r2(x)},${r2(y)}`),
  };
  return { ctx, ops };
}
const render = (spec: any) => { const { ctx, ops } = fakeCtx(); photo.drawPetPhoto(ctx, spec); return ops.join(";"); };
const homeOf = (over: Partial<any> = {}) => ({ id: "p1:1000", kind: "cat" as const, color: 0, ...over });

// ── ① 存檔裡沒有圖片資料 ────────────────────────────────────
{
  const spec = photo.photoSpecFromHome(homeOf());
  check("spec 只有 seed/kind/color/appearance 四個欄位",
    JSON.stringify(Object.keys(spec).sort()) === JSON.stringify(["appearance", "color", "kind", "seed"]));
  check("推導出來的外觀是合法的六欄 Appearance",
    ["hairStyle", "hairColor", "shirt", "pants", "skin", "accessory"].every((k) => k in spec.appearance));
  check("推導的外觀通得過既有的配色消毒(髮色/膚色對比等規則)",
    JSON.stringify(sanitizeAppearanceColors({ ...spec.appearance })) === JSON.stringify(spec.appearance));
}

// ── ② 決定性 ───────────────────────────────────────────────
{
  let rngCalls = 0;
  const orig = Math.random;
  Math.random = () => { rngCalls++; return orig(); };
  const a = render(photo.photoSpecFromHome(homeOf()));
  const b = render(photo.photoSpecFromHome(homeOf()));
  Math.random = orig;
  check("同一筆紀錄畫兩次逐呼叫相同", a === b);
  check("畫照片零 Math.random", rngCalls === 0, `實際 ${rngCalls} 次`);
  check("有畫出東西(不是空白)", a.length > 500);
}
check("不同紀錄畫出不同照片",
  render(photo.photoSpecFromHome(homeOf({ id: "p1:1000" })))
    !== render(photo.photoSpecFromHome(homeOf({ id: "p2:2000" }))));
check("同一隻寵物、不同飼主外觀 ⇒ 照片不同", (() => {
  const base = photo.photoSpecFromHome(homeOf());
  const other = { ...base, appearance: { ...base.appearance, shirt: "#123456" } };
  return render(base) !== render(other);
})());

// ── ③ 花色涵蓋 ─────────────────────────────────────────────
{
  const catShots = CAT_PALS.map((_, i) => render(photo.photoSpecFromHome(homeOf({ color: i }))));
  check("每個貓花色都畫得出來且彼此不同", new Set(catShots).size === CAT_PALS.length,
    `${CAT_PALS.length} 色 → ${new Set(catShots).size} 種畫面`);
  const dogShots = DOG_PALS.map((_, i) => render(photo.photoSpecFromHome(homeOf({ kind: "dog", color: i }))));
  check("每個狗花色都畫得出來且彼此不同", new Set(dogShots).size === DOG_PALS.length,
    `${DOG_PALS.length} 色 → ${new Set(dogShots).size} 種畫面`);
  check("貓和狗畫出來不一樣", catShots[0] !== dogShots[0]);
  check("超出範圍的花色退回第一色,不會炸掉",
    render(photo.photoSpecFromHome(homeOf({ color: 99 }))) === catShots[0]);
}

// ── ④ 花色單一出處 ─────────────────────────────────────────
{
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const scene = readFileSync(fileURLToPath(new URL("../src/floor/floorScene.ts", import.meta.url)), "utf8");
  check("floorScene 不再自己定義花色,改讀 petPalettes",
    !/const CAT_PALS\s*[:=]/.test(scene) && !/const DOG_PALS\s*[:=]/.test(scene)
      && scene.includes('from "./petPalettes"'));
  check("既有花色順序與色碼沒被動到(pet.color 是存檔索引)",
    CAT_PALS[0].body === "#e0913f" && CAT_PALS[1].body === "#413e4e"
      && CAT_PALS[2].body === "#eae5da" && CAT_PALS[3].patch === true
      && DOG_PALS[0].body === "#c9823d" && DOG_PALS[3].body === "#8b9199");
}

// ── ⑤ 咖啡廳認養留下新飼主 ──────────────────────────────────
{
  const petId = "photo_test_cat";
  state.pets[petId] = {
    name: "小福", kind: "cat", color: 2, sinceMs: state.gameMs - 5 * 24 * 3600 * 1000,
    ownerId: pets.HOUSE_PET_OWNER, housePlacement: "permanent", hangout: "lounge",
  } as any;
  const appearance = photo.derivedAdopterAppearance("guest_seed");
  const res = pets.acceptCafeGuestAdoption(
    { id: "g_photo", name: "周雨潔", intent: "adopt", appearance },
    petId,
  );
  check("咖啡廳認養成功", res.ok, res.text);
  const home = state.petHomes.find((h) => h.id === "cafe:g_photo");
  check("送養紀錄記下新飼主姓名", home?.adopterName === "周雨潔");
  check("送養紀錄記下新飼主外觀(合照畫的是玩家看過的那位顧客)",
    JSON.stringify(home?.adopterAppearance) === JSON.stringify(appearance));
  check("合照用的是存下來的外觀,不是推導的",
    home ? JSON.stringify(photo.photoSpecFromHome(home).appearance) === JSON.stringify(appearance) : false);
  check("紀錄裡沒有任何圖片資料(不會撐爆存檔)",
    !!home && !Object.values(home).some((v) => typeof v === "string" && v.startsWith("data:")));
}

// 沒有飼主資料的舊紀錄也要有照片
check("舊送養紀錄(沒有 adopter 欄位)照樣畫得出合照",
  render(photo.photoSpecFromHome(homeOf({ id: "legacy:1", color: 3 }))).length > 500);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
