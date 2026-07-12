/**
 * 寵物貓系統:租客養的貓會在樓層遊走,並引發貓咪事件。
 *
 * 模擬層(無頭可測):每遊戲小時 petsPass() 決定貓這小時待哪個區域(hangout),
 * 並擲骰事件——溜進別的房客房裡(親貓的人被療癒、怕貓/潔癖的人被嚇到)、
 * 打破東西、隨地大小便。渲染層(floor/petAgents)只負責讓貓「走去 hangout 遊蕩」。
 *
 * 取得途徑:種子(陳家豪的橘貓「橘子」,他的作息本來就有逗貓時段)、
 * AI/規則事件的 adopt_cat 行為指令(指令到期後貓留下,成為永久寵物)。
 */
import type { Pet } from "../types";
import { state, clamp, pushSocialLog, notify, roomOfTenant, type TenantRuntime } from "./gameState";
import { adjustRelationship } from "./social";
import { unlock } from "./legacy";
import { getPlacements } from "./placements";
import { roomRect } from "./placements";
import { spawnFx } from "../floor/fx";

/** 領養時的隨機貓名池(種子貓固定叫「橘子」) */
const CAT_NAMES = ["麻糬", "煤球", "湯圓", "布丁", "芝麻", "奶茶", "花捲", "豆花"];

/** 事件冷卻(遊戲毫秒);借用 interactionCooldowns 儲存(入存檔) */
const CD = {
  visit: 12 * 3600 * 1000, // 同一位鄰居半天內不重複串門子事件
  break: 36 * 3600 * 1000,
  poop: 30 * 3600 * 1000,
};

function onCooldown(key: string, cdMs: number): boolean {
  const last = state.interactionCooldowns[key];
  return last != null && state.gameMs - last < cdMs;
}
function markCooldown(key: string) {
  state.interactionCooldowns[key] = state.gameMs;
}

/** 種子寵物補登:陳家豪的作息本來就有「逗貓」時段——把那隻貓變成真的 */
export function ensurePets() {
  const chen = state.runtimes["tenant_chen_engineer"];
  if (chen && !state.pets[chen.tenant.id]) {
    state.pets[chen.tenant.id] = {
      name: "橘子",
      kind: "cat",
      color: 0, // 橘貓
      ownerId: chen.tenant.id,
      hangout: roomOfTenant(chen.tenant.id) ?? "lounge",
      sinceMs: state.gameMs,
    };
  }
}

/** 領養一隻貓(adopt_cat 指令生效 / 帶寵物入住時呼叫;已有貓則不重複)。
 *  preset:指定名字/花色(應徵者自帶的貓);省略則隨機。回傳新貓或 null。 */
export function adoptCat(tenantId: string, preset?: { name: string; color: number }): Pet | null {
  if (state.pets[tenantId]) return null;
  const rt = state.runtimes[tenantId];
  if (!rt) return null;
  const pet: Pet = {
    name: preset?.name ?? CAT_NAMES[Math.floor(Math.random() * CAT_NAMES.length)],
    kind: "cat",
    color: preset?.color ?? 1 + Math.floor(Math.random() * 3), // 黑/白/三花(橘子是種子專屬)
    ownerId: tenantId,
    hangout: roomOfTenant(tenantId) ?? "lounge",
    sinceMs: state.gameMs,
  };
  state.pets[tenantId] = pet;
  notify(`🐈 ${rt.tenant.name} 養了一隻貓「${pet.name}」`);
  return pet;
}

/** 隨機挑一組貓名/花色(給應徵者自帶的貓;花色 1~3,橘色是種子專屬) */
export function randomCatPreset(): { name: string; color: number } {
  return { name: CAT_NAMES[Math.floor(Math.random() * CAT_NAMES.length)], color: 1 + Math.floor(Math.random() * 3) };
}

/** 飼主房間是否擺了某件貓咪家具(貓砂盆/貓跳台 → 降低對應搗蛋機率) */
function ownerRoomHas(pet: Pet, defId: string): boolean {
  const room = roomOfTenant(pet.ownerId);
  return !!room && getPlacements().some((p) => p.room === room && p.defId === defId);
}

/** 貓咪家具對搗蛋機率的乘數:貓跳台壓低破壞、貓砂盆壓低隨地大小便(§A-2) */
export function mischiefRelief(pet: Pet): { break: number; poop: number } {
  return {
    break: ownerRoomHas(pet, "cat_tower") ? 0.3 : 1,
    poop: ownerRoomHas(pet, "litter_box") ? 0.15 : 1,
  };
}

/** 對貓的態度:標籤/職業裡有貓狗動物 → 喜歡;潔癖/過敏/怕貓 → 排斥;其餘中立。
 *  接受結構子集(租客或應徵者都適用;memoryTags 可省略) */
export function catAttitude(t: {
  coreTags: { label: string }[];
  memoryTags?: { label: string }[];
  occupation: string;
  bio: string;
}): "like" | "dislike" | "neutral" {
  const text = [...t.coreTags.map((x) => x.label), ...(t.memoryTags ?? []).map((x) => x.label), t.occupation, t.bio].join(" ");
  if (/怕貓|過敏|潔癖|討厭動物/.test(text)) return "dislike";
  if (/貓|狗|動物|寵物|療癒/.test(text)) return "like";
  return "neutral";
}

/** 住在某房的租客(承租者優先,否則同居者);沒有回 null */
function residentOf(roomId: string): TenantRuntime | null {
  const tid = state.occupancy[roomId] ?? Object.entries(state.cohabits).find(([, r]) => r === roomId)?.[0];
  return tid ? state.runtimes[tid] ?? null : null;
}

/** 這小時貓要待的區域:飼主房 55%、交誼廳 20%、別人的房 25% */
function pickHangout(pet: Pet): string {
  const home = roomOfTenant(pet.ownerId) ?? "lounge";
  const roll = Math.random();
  if (roll < 0.55) return home;
  if (roll < 0.75) return "lounge";
  const others = Object.keys(state.occupancy).filter((r) => r !== home && state.runtimes[state.occupancy[r]]);
  return others.length > 0 ? others[Math.floor(Math.random() * others.length)] : home;
}

/** 在區域中心掛一個特效(渲染層看得到「事發地點」) */
function fxAt(roomId: string, kind: Parameters<typeof spawnFx>[0], dur = 10000) {
  const rect = roomRect(roomId);
  if (rect) spawnFx(kind, Math.floor((rect.c0 + rect.c1) / 2), Math.floor((rect.r0 + rect.r1) / 2), dur);
}

/** 每遊戲小時:每隻貓換去處 + 擲骰貓咪事件 */
export function petsPass() {
  for (const key of Object.keys(state.pets)) {
    const pet = state.pets[key];
    const owner = state.runtimes[pet.ownerId];
    if (!owner) {
      delete state.pets[key]; // 飼主退租 → 貓跟著搬走
      continue;
    }
    pet.hangout = pickHangout(pet);
    rollVisit(pet, owner);
    rollMischief(pet, owner);
  }
}

/** 串門子:貓溜進別的房客房裡(對方在家才成立) */
function rollVisit(pet: Pet, owner: TenantRuntime) {
  const home = roomOfTenant(pet.ownerId);
  if (pet.hangout === home || pet.hangout === "lounge") return;
  const victim = residentOf(pet.hangout);
  if (!victim || victim.tenant.id === pet.ownerId || victim.tenant.visualState === "away") return;
  if (Math.random() > 0.5) return;
  const cdKey = `pet|${pet.ownerId}|visit|${victim.tenant.id}`;
  if (onCooldown(cdKey, CD.visit)) return;
  markCooldown(cdKey);

  const s = victim.tenant.stats;
  const att = catAttitude(victim.tenant);
  if (att === "dislike") {
    s.stress = clamp(s.stress + 6, 0, 100);
    pushSocialLog(victim, `🐈 ${owner.tenant.name} 的貓「${pet.name}」突然竄進房裡,嚇了他一大跳——趕緊把牠請了出去。`, "notable");
    pushSocialLog(owner, `🐈 「${pet.name}」又溜進 ${victim.tenant.name} 的房間闖禍,被抱著送回來,對方臉色不太好看。`, "notable");
    adjustRelationship(pet.ownerId, victim.tenant.id, -3);
    fxAt(pet.hangout, "anger");
  } else if (att === "like") {
    s.mood = clamp(s.mood + 6, 0, 100);
    s.stress = clamp(s.stress - 4, 0, 100);
    pushSocialLog(victim, `🐈 ${owner.tenant.name} 的貓「${pet.name}」溜進房裡蹭他的腳邊,忍不住揉了牠好一陣子,整個人都被療癒了。`, "notable");
    pushSocialLog(owner, `🐈 「${pet.name}」跑去 ${victim.tenant.name} 那裡串門子,被寵得不想回來。`, "notable");
    adjustRelationship(pet.ownerId, victim.tenant.id, 3);
    fxAt(pet.hangout, "hearts");
  } else {
    s.mood = clamp(s.mood + 2, 0, 100);
    pushSocialLog(victim, `🐈 門沒關好,${owner.tenant.name} 的貓「${pet.name}」晃了進來,巡視一圈又晃了出去。`, "minor");
  }
}

/** 搗蛋:打破東西 / 隨地大小便(在貓當下待的區域結算)。
 *  貓咪家具(飼主房)會壓低對應機率:貓跳台 → 有地方磨爪攀爬、少破壞;貓砂盆 → 幾乎不隨地大小便。 */
function rollMischief(pet: Pet, owner: TenantRuntime) {
  const here = pet.hangout;
  const victim = here === "lounge" ? null : residentOf(here);
  const place = here === "lounge" ? "交誼廳" : victim && victim.tenant.id !== pet.ownerId ? `${victim.tenant.name} 的房間` : "房間";
  const relief = mischiefRelief(pet);
  const breakChance = 0.03 * relief.break; // 貓跳台:破壞降到三成
  const poopChance = 0.03 * relief.poop; // 貓砂盆:隨地大小便降到 15%

  // 打破東西:碎裂聲 + 清潔度掉、在場的人壓力上升
  if (Math.random() < breakChance && !onCooldown(`pet|${pet.ownerId}|break`, CD.break)) {
    markCooldown(`pet|${pet.ownerId}|break`);
    unlock("cat_burglar"); // 成就:貓生大鬧(§G-7)
    if (victim) victim.cleanliness = clamp(victim.cleanliness - 8, 0, 100);
    pushSocialLog(owner, `🐈💥 「${pet.name}」在${place}把東西掃下桌,摔得粉碎……只好默默去收拾殘局。`, "notable");
    if (victim && victim.tenant.id !== pet.ownerId) {
      victim.tenant.stats.stress = clamp(victim.tenant.stats.stress + 5, 0, 100);
      pushSocialLog(victim, `💥 「${pet.name}」打破了他房裡的東西,${owner.tenant.name} 一邊道歉一邊收拾。`, "notable");
      adjustRelationship(pet.ownerId, victim.tenant.id, -2);
    }
    fxAt(here, "anger");
    return; // 一小時最多鬧一件事
  }

  // 隨地大小便:清潔度大掉,苦主壓力上升
  if (Math.random() < poopChance && !onCooldown(`pet|${pet.ownerId}|poop`, CD.poop)) {
    markCooldown(`pet|${pet.ownerId}|poop`);
    unlock("cat_burglar"); // 成就:貓生大鬧(§G-7)
    if (victim) victim.cleanliness = clamp(victim.cleanliness - 10, 0, 100);
    if (victim && victim.tenant.id !== pet.ownerId) {
      victim.tenant.stats.stress = clamp(victim.tenant.stats.stress + 4, 0, 100);
      pushSocialLog(victim, `🐈💩 在${place}角落發現了「${pet.name}」留下的不可言說的『驚喜』……氣到說不出話。`, "notable");
      pushSocialLog(owner, `🐈💩 「${pet.name}」在 ${victim.tenant.name} 那裡隨地大小便,只好提著清潔用品登門謝罪。`, "notable");
      adjustRelationship(pet.ownerId, victim.tenant.id, -2);
    } else {
      pushSocialLog(owner, `🐈💩 「${pet.name}」沒用貓砂盆,在${place}留下了『驚喜』,捏著鼻子清了半天。`, "minor");
    }
  }
}
