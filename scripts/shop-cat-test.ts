/**
 * B 批:店貓「辣椒」。
 *
 * 五條硬性不變條件,每一條都直接對應使用者的需求或 balance 快照的前提:
 *  1. 咖啡廳未開張時她**完全不存在**(快照零漂移的直接釘子:state.pets 一個 key 都不多)
 *  2. 不佔 permanentHousePetEntries() / 不影響 PERMANENT_HOUSE_PET_LIMIT 的判定
 *  3. 所有送養、媒合、認養、孤兒修復路徑都擋得住她
 *  4. 唯一性:重複呼叫、存檔往返、離線補進度逐小時重跑都只有一隻
 *  5. 全樓溜達:三樓(套房/交誼廳/浴室/洗衣間)與一樓(cafe_pet)兩邊都到得了
 * 另加白底虎斑花色的像素檢查,以及「既有四個花色未被改動」的指紋釘子。
 */
import { createHash } from "node:crypto";
import type { Pet } from "../src/types";
import type { PetAgent } from "../src/floor/petAgents";

const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

// 固定亂數種子(mulberry32),讓 pickHangout 這種機率型行為在 CI 上可重現
let __seed = 20260805;
Math.random = () => {
  __seed |= 0; __seed = (__seed + 0x6d2b79f5) | 0;
  let t = Math.imul(__seed ^ (__seed >>> 15), 1 | __seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const { state } = await import("../src/store");
const {
  ensurePets, ensureShopCat, isShopCat, petsPass, catJournalPass,
  SHOP_CAT_ID, SHOP_CAT_NAME, SHOP_CAT_OWNER, SHOP_CAT_COLOR,
  HOUSE_PET_OWNER, PERMANENT_HOUSE_PET_LIMIT,
  housePetEntries, permanentHousePetEntries, fosterHousePetEntries, needsHousePetReview,
  startHousePetRehoming, cancelHousePetRehoming, resolveHousePetOverload,
  acceptCafeGuestAdoption, processPetRehoming, repairOrphanPets,
} = await import("../src/sim/pets");
const {
  petAgentRegion, createPetAgents, petAgentSignature,
  CAFE_PET_VISIT_START_HOUR, CAFE_PET_VISIT_END_HOUR,
  SHOP_CAT_CAFE_START_HOUR, SHOP_CAT_CAFE_END_HOUR,
} = await import("../src/floor/petAgents");
const { generateCafeGuest } = await import("../src/sim/cafeGuests");
const { save, load } = await import("../src/sim/persistence");
const { composeFloor, FLOOR_W, FLOOR_H } = await import("../src/floor/floorScene");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const shopCatEntries = () => Object.entries(state.pets).filter(([, pet]) => isShopCat(pet));
const HOUR = 3600 * 1000;

// ---------------------------------------------------------------------------
// 1. 未開張 = 完全不存在(balance 快照零漂移的直接釘子)
// ---------------------------------------------------------------------------

check("預設(未開張)咖啡廳", state.cafe.open === false);
check("開局補登不會生出店貓", shopCatEntries().length === 0 && !state.pets[SHOP_CAT_ID]);
check("ensureShopCat() 在未開張時回 false 且不動 state", ensureShopCat() === false && shopCatEntries().length === 0);
check("ensurePets() 在未開張時也不會生出店貓", (ensurePets(), shopCatEntries().length === 0));

const petKeysBefore = Object.keys(state.pets).sort().join("|");
for (let i = 0; i < 48; i++) {
  state.gameMs += HOUR;
  petsPass();
}
check("未開張時逐小時跑 48 次 petsPass 仍然沒有店貓",
  shopCatEntries().length === 0 && Object.keys(state.pets).sort().join("|") === petKeysBefore,
  Object.keys(state.pets).sort().join("|"));

// ---------------------------------------------------------------------------
// 2. 開張 → 登場;唯一性(重複呼叫 / 逐小時 / 存檔往返 / 非正規重複)
// ---------------------------------------------------------------------------

state.cafe.open = true;
state.noticeLog.splice(0);
check("開張後 ensureShopCat() 生出辣椒", ensureShopCat() === true && shopCatEntries().length === 1);

const chili = state.pets[SHOP_CAT_ID];
check("身分欄位:固定 key、店貓標記、專屬哨兵飼主、白底虎斑花色",
  !!chili && chili.name === SHOP_CAT_NAME && chili.kind === "cat"
  && chili.shopCat === true && chili.ownerId === SHOP_CAT_OWNER
  && chili.color === SHOP_CAT_COLOR && SHOP_CAT_COLOR === 4,
  JSON.stringify(chili));
check("店貓不帶 housePlacement(不是樓寵物,也不在媒合流程裡)",
  chili.housePlacement === undefined && chili.rehomingAtMs === undefined);
check("登場時留下一則房東通知", state.noticeLog.some((entry) => entry.text.includes(SHOP_CAT_NAME)));

check("重複呼叫 ensureShopCat() 冪等", ensureShopCat() === false && shopCatEntries().length === 1);
for (let i = 0; i < 72; i++) {
  state.gameMs += HOUR;
  petsPass(); // 離線補進度走的就是逐小時 hourlyTick → petsPass
}
check("離線補進度逐小時重跑 72 次仍然只有一隻", shopCatEntries().length === 1);

save();
check("存檔往返後仍然只有一隻、標記完整",
  load() && shopCatEntries().length === 1
  && state.pets[SHOP_CAT_ID]?.shopCat === true
  && state.pets[SHOP_CAT_ID]?.ownerId === SHOP_CAT_OWNER);

// 手改存檔 / 未來匯入可能塞進非正規 key:收斂回唯一的正規那隻
state.pets["rogue_shop_cat"] = { ...state.pets[SHOP_CAT_ID], name: "冒牌辣椒" };
check("非正規 key 的重複店貓會被收掉",
  ensureShopCat() === true && shopCatEntries().length === 1 && !state.pets["rogue_shop_cat"]);

// 欄位遺失也要收斂(不能被誤認成孤兒貓)
delete (state.pets[SHOP_CAT_ID] as any).shopCat;
check("只剩哨兵飼主也認得出是店貓", isShopCat(state.pets[SHOP_CAT_ID]));
check("消毒會把 shopCat 標記補回來", ensureShopCat() === true && state.pets[SHOP_CAT_ID].shopCat === true);

// ---------------------------------------------------------------------------
// 3. 不佔永久名額 / 不影響 PERMANENT_HOUSE_PET_LIMIT 的判定
// ---------------------------------------------------------------------------

check("PERMANENT_HOUSE_PET_LIMIT 沒有被動過", PERMANENT_HOUSE_PET_LIMIT === 2);
check("店貓不在樓寵物名冊裡",
  !housePetEntries().some(([id]) => id === SHOP_CAT_ID)
  && !permanentHousePetEntries().some(([id]) => id === SHOP_CAT_ID)
  && !fosterHousePetEntries().some(([id]) => id === SHOP_CAT_ID));

const housePet = (name: string): Pet => ({
  name, kind: "cat", color: 1, ownerId: HOUSE_PET_OWNER,
  hangout: "lounge", sinceMs: state.gameMs - 5 * 24 * HOUR, housePlacement: "permanent",
});
state.pets["house_slot_a"] = housePet("阿甲");
state.pets["house_slot_b"] = housePet("阿乙");
check("店貓在場時,兩隻永久樓寵物仍然剛好把名額用滿、不觸發安置會議",
  permanentHousePetEntries().length === PERMANENT_HOUSE_PET_LIMIT && needsHousePetReview() === false);
state.pets["house_slot_c"] = housePet("阿丙");
check("第三隻永久樓寵物才觸發安置會議(判定完全不受店貓影響)",
  permanentHousePetEntries().length === 3 && needsHousePetReview() === true);
delete state.pets["house_slot_c"];

check("孤兒修復不會把店貓轉成樓寵物",
  (repairOrphanPets(), state.pets[SHOP_CAT_ID].ownerId === SHOP_CAT_OWNER
    && state.pets[SHOP_CAT_ID].housePlacement === undefined
    && permanentHousePetEntries().length === PERMANENT_HOUSE_PET_LIMIT));

// ---------------------------------------------------------------------------
// 4. 所有出場路徑都擋得住她
// ---------------------------------------------------------------------------

const homesBefore = state.petHomes.length;
const rehome = startHousePetRehoming(SHOP_CAT_ID, "adopter");
check("房東送養被擋下且說明是店貓", rehome.ok === false && rehome.text.includes("店貓"), rehome.text);

const adoptGuest = generateCafeGuest({ seed: "shop-cat-adopter", arrivedMs: state.gameMs, intent: "adopt" });
const adoption = acceptCafeGuestAdoption(adoptGuest, SHOP_CAT_ID);
check("咖啡廳顧客認養被擋下且說明是店貓", adoption.ok === false && adoption.text.includes("店貓"), adoption.text);

const cancel = cancelHousePetRehoming(SHOP_CAT_ID);
check("取消媒合入口也擋下店貓", cancel.ok === false && cancel.text.includes("店貓"), cancel.text);

state.pets["house_slot_c"] = housePet("阿丙"); // 讓安置會議成立
const overload = resolveHousePetOverload([SHOP_CAT_ID, "house_slot_a"]);
check("超量安置不能把店貓選進留下名單", overload.ok === false, overload.text);
const overloadOk = resolveHousePetOverload(["house_slot_a", "house_slot_b"]);
check("安置會議在店貓在場時仍然可以正常結案", overloadOk.ok === true, overloadOk.text);

state.gameMs += 30 * 24 * HOUR; // 遠遠超過任何媒合期限
processPetRehoming();
check("媒合到期結算不會把店貓送走",
  !!state.pets[SHOP_CAT_ID] && isShopCat(state.pets[SHOP_CAT_ID]));
check("幸福新家名冊裡沒有店貓",
  !state.petHomes.some((home) => home.name === SHOP_CAT_NAME),
  `before=${homesBefore} now=${state.petHomes.length}`);

// 清掉樓寵物固定裝置,後面的溜達統計只看店貓
for (const id of ["house_slot_a", "house_slot_b", "house_slot_c"]) delete state.pets[id];

// ---------------------------------------------------------------------------
// 5. 全樓溜達:三樓四處 + 一樓咖啡廳
// ---------------------------------------------------------------------------

const visited = new Set<string>();
for (let i = 0; i < 400; i++) {
  state.gameMs += HOUR;
  petsPass();
  visited.add(state.pets[SHOP_CAT_ID].hangout);
}
const suites = [...visited].filter((area) => area.startsWith("r3"));
check("三樓:交誼廳、浴室、洗衣間都巡得到",
  visited.has("lounge") && visited.has("bathroom") && visited.has("laundry"),
  [...visited].sort().join(","));
check("三樓:也會晃進有人住的套房", suites.length > 0, [...visited].sort().join(","));

const atHour = (day: number, hour: number) => new Date(2026, 7, day, hour, 0, 0, 0).getTime();
let cafeHours = 0;
let outsideWindow = 0;
for (let day = 1; day <= 14; day++) {
  for (let hour = 0; hour < 24; hour++) {
    const region = petAgentRegion(SHOP_CAT_ID, state.pets[SHOP_CAT_ID], atHour(day, hour), true);
    if (region !== "cafe_pet") continue;
    cafeHours++;
    if (hour < SHOP_CAT_CAFE_START_HOUR || hour >= SHOP_CAT_CAFE_END_HOUR) outsideWindow++;
  }
}
check("一樓:兩週樣本裡有大量下樓顧店的時段", cafeHours > 40, `cafeHours=${cafeHours}`);
check("一樓:上工時段限制在 08–21 點", outsideWindow === 0, `outsideWindow=${outsideWindow}`);
check("咖啡廳未開張時連渲染層都不會把她派去一樓",
  petAgentRegion(SHOP_CAT_ID, state.pets[SHOP_CAT_ID], atHour(3, 12), false) !== "cafe_pet");

// 既有樓寵物的下樓規則(CAFE-22)必須逐條不變
const legacyHousePet: Pet = {
  name: "小栗", kind: "cat", color: 1, ownerId: HOUSE_PET_OWNER,
  hangout: "lounge", sinceMs: state.gameMs - 12 * 24 * HOUR, housePlacement: "permanent",
};
let legacyOutside = 0;
let legacyInside = 0;
for (let day = 1; day <= 14; day++) {
  for (let hour = 0; hour < 24; hour++) {
    if (petAgentRegion("legacy_house_pet", legacyHousePet, atHour(day, hour), true) !== "cafe_pet") continue;
    if (hour < CAFE_PET_VISIT_START_HOUR || hour >= CAFE_PET_VISIT_END_HOUR) legacyOutside++;
    else legacyInside++;
  }
}
check("既有永久樓寵物的下樓窗口仍是 10–16 點", legacyOutside === 0 && legacyInside > 0,
  `outside=${legacyOutside} inside=${legacyInside}`);

check("店貓進得了渲染層 agent 名單",
  createPetAgents().some((agent) => agent.petId === SHOP_CAT_ID)
  && petAgentSignature().includes(`${SHOP_CAT_ID}:cat:${SHOP_CAT_COLOR}`));

// ---------------------------------------------------------------------------
// 6. 互動:文案認得出她是店貓,而且敘事稀疏
// ---------------------------------------------------------------------------

state.noticeLog.splice(0);
state.cafe.guests.splice(0, state.cafe.guests.length,
  generateCafeGuest({ seed: "shop-cat-visitor", arrivedMs: state.gameMs, intent: "coffee" }));
state.gameMs += HOUR;
petsPass();
const shiftNotices = () => state.noticeLog.filter((entry) => entry.text.includes("店貓")).length;
const firstShift = shiftNotices();
check("店裡有客人時會推一則店貓上工的互動", firstShift >= 1, `${firstShift}`);
for (let i = 0; i < 6; i++) {
  state.gameMs += HOUR;
  petsPass();
}
check("同一個遊戲日內不會重複洗版(冷卻 20 小時)", shiftNotices() === firstShift, `${shiftNotices()}`);

// 日誌 cap 是 60,前面的溜達已經把它填滿 —— 先清空才量得準
for (const rt of Object.values(state.runtimes)) rt.log.splice(0, rt.log.length);
const journals = () => Object.values(state.runtimes)
  .flatMap((rt) => rt.log)
  .filter((entry) => entry.text.includes(SHOP_CAT_NAME) && entry.text.includes("觀察筆記"));
catJournalPass();
check("觀察筆記把她寫成店貓而不是誰的寵物",
  journals().length === 1 && journals()[0].text.includes("店貓"),
  journals()[0]?.text ?? "(沒有店貓筆記)");
catJournalPass();
check("觀察筆記有 7 日冷卻,同一天重跑不會再推", journals().length === 1);

// ---------------------------------------------------------------------------
// 7. 白底虎斑:像素檢查 + 既有四花色的指紋釘子
// ---------------------------------------------------------------------------

class PixelCtx {
  fillStyle = "#000000";
  globalAlpha = 1;
  readonly buf = new Uint8Array(FLOOR_W * FLOOR_H * 4);
  save() {}
  restore() { this.globalAlpha = 1; }
  clearRect() {}
  fillRect(x: number, y: number, w: number, h: number) {
    const color = this.fillStyle;
    if (!color.startsWith("#")) return; // 半透明陰影/特效不參與色票統計
    if (this.globalAlpha < 1) return;
    const r = Number.parseInt(color.slice(1, 3), 16);
    const g = Number.parseInt(color.slice(3, 5), 16);
    const b = Number.parseInt(color.slice(5, 7), 16);
    for (let py = Math.max(0, y | 0); py < Math.min(FLOOR_H, y + h); py++) {
      for (let px = Math.max(0, x | 0); px < Math.min(FLOOR_W, x + w); px++) {
        const i = (py * FLOOR_W + px) * 4;
        this.buf[i] = r; this.buf[i + 1] = g; this.buf[i + 2] = b; this.buf[i + 3] = 255;
      }
    }
  }
}

const agent = (color: number, c: number, r: number, extra: Partial<PetAgent> = {}): PetAgent => ({
  petId: `art_${color}_${c}_${r}`, name: "demo", kind: "cat", color,
  c, r, px: c * 16, py: r * 16, path: [], moving: false, walkPhase: 0,
  restUntil: Number.MAX_SAFE_INTEGER, sleeping: false, facing: 1, pairLeader: false,
  ...extra,
});
const poses = (color: number, row: number): PetAgent[] => [
  agent(color, 2, row, { moving: true }),
  agent(color, 4, row),
  agent(color, 6, row, { sleeping: true }),
];

const shopCtx = new PixelCtx();
composeFloor(shopCtx as any, 0, undefined, undefined, undefined, poses(SHOP_CAT_COLOR, 10));
const countColor = (ctx: PixelCtx, hex: string) => {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  let n = 0;
  for (let i = 0; i < ctx.buf.length; i += 4) {
    if (ctx.buf[i] === r && ctx.buf[i + 1] === g && ctx.buf[i + 2] === b) n++;
  }
  return n;
};
const white = countColor(shopCtx, "#f7f2e9");
const socks = countColor(shopCtx, "#fffdf7");
const tabbyA = countColor(shopCtx, "#a68f6d");
const tabbyB = countColor(shopCtx, "#7f6c52");
const eye = countColor(shopCtx, "#63ad5c");
const nose = countColor(shopCtx, "#f0a1ad");
check("白底虎斑:白毛 + 白胸白襪 + 兩階虎斑 + 綠眼 + 粉鼻全部畫得出來",
  white > 0 && socks > 0 && tabbyA > 0 && tabbyB > 0 && eye > 0 && nose > 0,
  `white=${white} socks=${socks} tabbyA=${tabbyA} tabbyB=${tabbyB} eye=${eye} nose=${nose}`);

const calicoCtx = new PixelCtx();
composeFloor(calicoCtx as any, 0, undefined, undefined, undefined, poses(3, 10));
check("三花仍然用原本的補丁色(#cd7f32 / #413e4e)",
  countColor(calicoCtx, "#cd7f32") > 0 && countColor(calicoCtx, "#413e4e") > 0);
check("三花身上不會出現店貓的虎斑或粉鼻",
  countColor(calicoCtx, "#a68f6d") === 0 && countColor(calicoCtx, "#f0a1ad") === 0
  && countColor(calicoCtx, "#63ad5c") === 0);

// 既有四個花色的像素指紋:任何未來改動(含順序變動)都會在這裡現形。
const legacyCtx = new PixelCtx();
const legacyPoses: PetAgent[] = [];
for (let color = 0; color < 4; color++) legacyPoses.push(...poses(color, 10 + color));
composeFloor(legacyCtx as any, 0, undefined, undefined, undefined, legacyPoses);
const band = legacyCtx.buf.subarray(10 * 16 * FLOOR_W * 4, 14 * 16 * FLOOR_W * 4);
const fingerprint = createHash("sha256").update(band).digest("hex").slice(0, 16);
check("既有四個花色的像素指紋不變(pet.color 是存檔索引,不可動)",
  fingerprint === "9d1cc780408535f2", fingerprint);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
