/** CAFE-19：租屋意圖顧客 → 帶初次好感的應徵者（含 rescoreApplicants 後加成仍在）。 */
import type { Applicant } from "../src/sim/recruit";

const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

const { state } = await import("../src/sim/gameState");
const { SAVE_KEY } = await import("../src/sim/persistence");
const { generateCafeGuest, cafeGuestGender } = await import("../src/sim/cafeGuests");
const { ARCHETYPES, acceptCafeGuestApplicant, rescoreApplicants } = await import("../src/sim/recruit");
const { addPlacement, findFreeSlot, roomAttributes } = await import("../src/sim/placements");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const ROOM = "r303";
const FAVOR = 1.25;
const PREF_CAP = 10;
const poolOf = (roomId: string): Applicant[] => state.applicantPools[roomId]?.applicants ?? [];
const cafeOne = (roomId: string, guestId: string) => poolOf(roomId).find((a) => a.fromCafeGuestId === guestId);
const makeGuest = (seed: string, intent: "coffee" | "adopt" | "rent" = "rent") =>
  generateCafeGuest({ seed, arrivedMs: state.gameMs, intent });

// ---------------------------------------------------------------- 1. 拒絕條件
const coffee = makeGuest("cafe-coffee", "coffee");
const adopt = makeGuest("cafe-adopt", "adopt");
const runtimeIdsBefore = Object.keys(state.runtimes).sort().join("|");
check("非 rent 意圖被拒（coffee）", !acceptCafeGuestApplicant(coffee, ROOM).ok && poolOf(ROOM).length === 0);
check("非 rent 意圖被拒（adopt）", !acceptCafeGuestApplicant(adopt, ROOM).ok && poolOf(ROOM).length === 0);

const probe = makeGuest("cafe-rent-probe");
check("空白顧客資料被拒絕", !acceptCafeGuestApplicant({ ...probe, id: "  " }, ROOM).ok
  && !acceptCafeGuestApplicant({ ...probe, name: "" }, ROOM).ok && poolOf(ROOM).length === 0);
check("非套房房號被拒絕", !acceptCafeGuestApplicant(probe, "lounge").ok && !acceptCafeGuestApplicant(probe, "r999").ok);
check("有人住的房被拒絕", !acceptCafeGuestApplicant(probe, "r301").ok && poolOf("r301").length === 0);

// ------------------------------------------------- 2. 成功轉換（挑帶 cozy 偏好的原型）
let guest = probe;
let applicant: Applicant | undefined;
for (let i = 0; i < 60; i++) {
  const g = makeGuest(`cafe-rent-${i}`);
  const res = acceptCafeGuestApplicant(g, ROOM);
  const a = cafeOne(ROOM, g.id);
  if (res.ok && a && a.preferences.cozy) { guest = g; applicant = a; break; }
  delete state.applicantPools[ROOM];
}
check("租屋意圖顧客成功進入應徵者池", !!applicant && poolOf(ROOM).includes(applicant!));
if (!applicant) {
  console.log(`\n結果:${pass} 通過 / ${fail + 1} 失敗`);
  process.exit(1);
}
const ap = applicant;
const archetype = ARCHETYPES.find((a) => a.key === ap.archetypeKey && a.occupation === ap.occupation)!;

check("同時保留常規批次，玩家不會只看到一位應徵者", poolOf(ROOM).length >= 2);
check("Applicant 欄位與既有介面相容", typeof ap.id === "string" && ap.id.length > 0
  && ap.name === guest.name && typeof ap.archetypeKey === "string" && typeof ap.occupation === "string"
  && typeof ap.bio === "string" && Array.isArray(ap.coreTags) && ap.coreTags.every((t) => !!t.id && !!t.label)
  && typeof ap.monthlyRent === "number" && ap.monthlyRent > 0 && ap.monthlyRent % 100 === 0
  && ap.baseRent === archetype.monthlyRent && Number.isInteger(ap.stars)
  && (ap.gender === "male" || ap.gender === "female" || ap.gender === "nonbinary")
  && Array.isArray(ap.attractedTo) && ap.attractedTo.length > 0
  && !!ap.appearance && ap.isAdult === true, JSON.stringify(ap));
check("外觀沿用咖啡廳看到的那位顧客", JSON.stringify(ap.appearance) === JSON.stringify(guest.appearance));
check("性別與姓名綁定（不分開亂抽）", ap.gender === cafeGuestGender(guest.name));
check("成功後立即存檔，池內保留來源顧客 id",
  JSON.parse(mem[SAVE_KEY] ?? "{}").applicantPools?.[ROOM]?.applicants?.some((a: Applicant) => a.fromCafeGuestId === guest.id) === true);
check("轉換不污染 state.runtimes", Object.keys(state.runtimes).sort().join("|") === runtimeIdsBefore);

// ---------------------------------------------------------------- 3. 好感加成與上限
const expectedPrefs = Object.fromEntries(
  Object.entries(archetype.preferences).map(([k, v]) => [k, Math.min(PREF_CAP, Math.round((v ?? 0) * FAVOR))]),
);
check("好感加成 = 偏好權重 ×1.25（記錄在 cafeFavorMultiplier）",
  ap.cafeFavorMultiplier === FAVOR && JSON.stringify(ap.preferences) === JSON.stringify(expectedPrefs));
check("至少一項偏好確實被抬高",
  Object.entries(archetype.preferences).some(([k, v]) => (ap.preferences[k as keyof typeof ap.preferences] ?? 0) > (v ?? 0)));
check("加成有上限：單項不超過 10，也不超過原型最大權重 ×1.25",
  Object.values(ap.preferences).every((v) => (v ?? 0) <= PREF_CAP)
  && Object.entries(archetype.preferences).every(([k, v]) => (ap.preferences[k as keyof typeof ap.preferences] ?? 0) <= Math.ceil((v ?? 0) * FAVOR)));
check("加成不會污染 ARCHETYPES 原型本體",
  ARCHETYPES.find((a) => a.key === ap.archetypeKey && a.occupation === ap.occupation)!.preferences !== ap.preferences
  && JSON.stringify(archetype.preferences) === JSON.stringify(ARCHETYPES.find((a) => a.occupation === ap.occupation)!.preferences));

// ------------------------------------------- 4. rescoreApplicants 後加成不消失（本題最容易錯的點）
const plain: Applicant = { ...ap, id: `${ap.id}_plain`, preferences: { ...archetype.preferences } };
delete plain.fromCafeGuestId;
delete plain.cafeFavorMultiplier;
let sawStarGain = false;
let neverWorse = true;
for (let step = 0; step < 6; step++) {
  const slot = findFreeSlot(ROOM, 1, 1);
  if (!slot) break;
  addPlacement({ defId: "beanbag", room: ROOM, c: slot.c, r: slot.r, rotation: 0 });
  rescoreApplicants([ap, plain], ROOM);
  if (ap.stars > plain.stars) sawStarGain = true;
  if (ap.stars < plain.stars) neverWorse = false;
}
check("重算後偏好加成沒有被抹掉",
  JSON.stringify(ap.preferences) === JSON.stringify(expectedPrefs) && ap.cafeFavorMultiplier === FAVOR);
check("重算後好感仍轉成星等優勢（且從不吃虧）", sawStarGain && neverWorse,
  `cafe=${ap.stars} plain=${plain.stars} attrs=${JSON.stringify(roomAttributes(ROOM))}`);
check("重算後星等仍在 1~5 合法範圍", ap.stars >= 1 && ap.stars <= 5 && Number.isInteger(ap.stars));
check("重算後開價仍以 baseRent 為底，好感不改開價",
  ap.baseRent === archetype.monthlyRent && ap.monthlyRent === plain.monthlyRent);

// ---------------------------------------------------------------- 5. 決定性與冪等
const before = JSON.stringify(guest);
check("同一位顧客重複接受會被擋下（冪等）",
  !acceptCafeGuestApplicant(guest, ROOM).ok && poolOf(ROOM).filter((a) => a.fromCafeGuestId === guest.id).length === 1);
check("同名但不同 id 的顧客在別的房也被擋下",
  !acceptCafeGuestApplicant({ ...guest, id: `${guest.id}_other` }, "r304").ok && poolOf("r304").length === 0);
check("入口不修改 CafeGuest 輸入", JSON.stringify(guest) === before);

// 星等/開價會隨房間裝潢改變，決定性比對排除這三項（它們本來就由 rescore 決定）
const firstJson = JSON.stringify({ ...ap, stars: undefined, monthlyRent: undefined, baseRent: undefined });
const { gameDayIndex } = await import("../src/sim/gameState");
delete state.applicantPools[ROOM];
const originalRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls++; return 0.25; };
try {
  // 預先擺好當日批次 → 這條路徑完全不需要 generateApplicants，可驗證零 Math.random
  // 對照組要改名，否則會撞到「同名應徵者已在等回覆」的防呆
  state.applicantPools[ROOM] = { day: gameDayIndex(), applicants: [{ ...plain, id: "control", name: "對照組" }] };
  const again = acceptCafeGuestApplicant(guest, ROOM);
  const repeated = cafeOne(ROOM, guest.id);
  check("既有當日批次時追加顧客，全程零 Math.random", again.ok && randomCalls === 0, `calls=${randomCalls}`);
  check("同輸入同輸出（決定性）", !!repeated
    && JSON.stringify({ ...repeated, stars: undefined, monthlyRent: undefined, baseRent: undefined }) === firstJson);
} finally {
  Math.random = originalRandom;
}

// ---------------------------------------------------------------- 6. 池量上限
state.applicantPools[ROOM] = {
  day: gameDayIndex(),
  applicants: Array.from({ length: 6 }, (_, i) => ({ ...plain, id: `filler_${i}`, name: `填充${i}` })),
};
check("池滿時拒絕新顧客", !acceptCafeGuestApplicant(makeGuest("cafe-rent-overflow"), ROOM).ok
  && poolOf(ROOM).length === 6);

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
