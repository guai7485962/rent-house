/**
 * 咖啡廳 renderer 收尾:`at_cafe` 的坐姿 + 咖啡杯,以及**既有姿勢的回歸釘子**。
 *
 * 本檔最重要的不是新功能,而是第 1 節那張矩陣:`setFurniturePose()` 是**所有**家具姿勢
 * 的共用路徑,這次為了讓 recipe sprite 的咖啡廳桌椅坐得下去,動了它的第一行 early return。
 * 所以這裡把「全家具目錄 × 全 visualState」的結果,逐一比對一份**照舊邏輯重寫的參考實作**
 * (`legacyPose()`,原封不動抄改動前的分支),只要有任何一格對不上就失敗。
 *
 * 其餘各節:資料驅動 `seat` 欄位的契約、`at_cafe` 真的坐得下去、咖啡廳空無一物時的退路、
 * renderer 真的畫了杯子,以及 balance 快照窗(第 0～9 遊戲日)仍然 0 次 `at_cafe`。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { TENANT_VISUAL_STATES } = await import("../src/types");
const { CATALOG, getDef } = await import("../src/furniture/catalog");
const { nextRotation } = await import("../src/furniture/rotation");
const {
  getPlacements, placementFootprint, placementRotation, placementInteract,
  removePlacementAt, placeCafeStarterSet, furnitureAt, CAFE_STARTER_PLACEMENTS,
} = await import("../src/sim/placements");
const { setFurniturePose, applyHour } = await import("../src/sim/tick");
const { CAFE_FIRST_DAY, cafeSitHourForDay, routineSlot, resolveTarget } = await import("../src/sim/routine");
/** `Role` 的完整列舉(`routine.ts` 只 export type,這裡照抄一份供窮舉用) */
const ROLES = ["bed", "desk", "kitchen", "bathroom", "laundry", "sofa", "tv", "out", "cafe"] as const;
const { buildGrid, TILE } = await import("../src/floor/map");
const { composeFloor } = await import("../src/floor/floorScene");
const { state, roomOfTenant } = await import("../src/store");
const { GAME_START } = await import("../src/sim/gameState");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

type PoseResult = {
  pose: "sit" | "lie" | null;
  surface: "furniture" | "chair" | null;
  tile: { c: number; r: number } | null;
  rotation: number;
};

/** 呼叫真正的 `setFurniturePose()`,回傳它寫進 runtime 的四個欄位 */
function actualPose(st: any, p: any, fallbackTile: { c: number; r: number }): PoseResult {
  const rt: any = { activityPose: null, activitySurface: null, activityTile: null, activityRotation: 0 };
  setFurniturePose(rt, st, p, fallbackTile);
  return {
    pose: rt.activityPose, surface: rt.activitySurface,
    tile: rt.activityTile, rotation: rt.activityRotation,
  };
}

// ---------------------------------------------------------------------------
// 1) 🔴 回歸釘子:改動前的 setFurniturePose 參考實作 × 全目錄 × 全 visualState
// ---------------------------------------------------------------------------

/** 改動**之前**的 `SEATED_STATES`(刻意不含 at_cafe) */
const LEGACY_SEATED = new Set<string>([
  "idle", "reading", "watching_tv", "gaming", "streaming", "working_at_desk", "playing_with_cat",
]);

/** 改動**之前**的 `setFurniturePose()`,逐行照抄(只把賦值改成回傳)。 */
function legacyPose(st: string, p: any, fallbackTile: { c: number; r: number }): PoseResult {
  const empty: PoseResult = { pose: null, surface: null, tile: null, rotation: 0 };
  const def = getDef(p.defId);
  if (!("kind" in def.sprite)) return empty;
  const kind = def.sprite.kind;
  let pose: "sit" | "lie" | null = null;
  let surface: "furniture" | "chair" | null = null;
  if (st === "sleeping_on_bed" && kind === "bed") {
    pose = "lie"; surface = "furniture";
  } else if (st === "sleeping_on_couch" && ["sofa", "beanbag", "chair"].includes(kind)) {
    pose = "lie"; surface = "furniture";
  } else if (st === "taking_bath" && kind === "bathtub") {
    pose = "lie"; surface = "furniture";
  } else if (st === "using_toilet" && kind === "toilet") {
    pose = "sit"; surface = "furniture";
  } else if (LEGACY_SEATED.has(st)) {
    if (["sofa", "beanbag", "chair"].includes(kind)) {
      pose = "sit"; surface = "furniture";
    } else if (["desk", "mic_desk", "tv"].includes(kind)) {
      pose = "sit"; surface = "chair";
    }
  }
  if (!pose || !surface) return empty;
  const fp = placementFootprint(p);
  const rotation = pose === "lie" && kind === "bed"
    ? nextRotation(placementRotation(p))
    : placementRotation(p);
  let tile: { c: number; r: number };
  if (surface === "furniture") {
    let best = { c: p.c, r: p.r };
    let bestDist = Infinity;
    for (let dr = 0; dr < fp.h; dr++) {
      for (let dc = 0; dc < fp.w; dc++) {
        const t = { c: p.c + dc, r: p.r + dr };
        const dist = Math.abs(t.c - fallbackTile.c) + Math.abs(t.r - fallbackTile.r);
        if (dist < bestDist) { best = t; bestDist = dist; }
      }
    }
    tile = best;
  } else {
    tile = { ...fallbackTile };
  }
  return { pose, surface, tile, rotation };
}

const sig = (x: PoseResult) => `${x.pose}|${x.surface}|${x.tile ? `${x.tile.c},${x.tile.r}` : "-"}|${x.rotation}`;

// 家具左上角固定在 (5,5),再用四個不同方位的 fallbackTile 逼出「最近家具格」的分支;
// rotation 0～3 全掃,連睡床多轉 90° 的那條規則也一起釘住。
const FALLBACKS = [{ c: 4, r: 5 }, { c: 8, r: 5 }, { c: 5, r: 4 }, { c: 5, r: 9 }];
const mismatches: string[] = [];
let matrixCells = 0;
let legacyHits = 0;
for (const def of CATALOG) {
  if (def.seat) continue; // 新標記的家具本來就要有新行為,單獨在第 3 節驗
  for (const st of TENANT_VISUAL_STATES) {
    if (st === "at_cafe") continue; // 本批**刻意**改變的唯一 visualState,第 3 節單獨驗
    for (const rotation of [0, 1, 2, 3] as const) {
      for (const fb of FALLBACKS) {
        const p = { defId: def.id, room: "r301", c: 5, r: 5, rotation };
        const want = legacyPose(st, p, fb);
        const got = actualPose(st, p, fb);
        matrixCells++;
        if (want.pose) legacyHits++;
        if (sig(want) !== sig(got)) mismatches.push(`${def.id}/${st}/rot${rotation}: want ${sig(want)} got ${sig(got)}`);
      }
    }
  }
}
check(
  `🔴 全目錄 × 全 visualState 的姿勢與舊邏輯逐格相同(${matrixCells} 格,其中 ${legacyHits} 格有姿勢)`,
  mismatches.length === 0,
  mismatches.slice(0, 5).join(" / "),
);
check("矩陣本身有效:非零格數且真的涵蓋到有姿勢的組合", matrixCells > 5000 && legacyHits > 200,
  `cells=${matrixCells} hits=${legacyHits}`);

// ---------------------------------------------------------------------------
// 2) 既有姿勢的硬寫死釘子(不靠參考實作,直接寫出期望值)
// ---------------------------------------------------------------------------
const PINS: Array<[string, string, string]> = [
  // [defId, visualState, 期望 pose|surface|tile|rotation](家具在 (5,5)、fallback (4,5)、rotation 0)
  ["single_bed", "sleeping_on_bed", "lie|furniture|5,5|90"],     // 床要多轉 90°
  ["canopy_bed", "sleeping_on_bed", "lie|furniture|5,5|90"],
  ["shared_sofa", "sleeping_on_couch", "lie|furniture|5,5|0"],   // 沙發不轉
  ["beanbag", "sleeping_on_couch", "lie|furniture|5,5|0"],
  ["wood_chair", "sleeping_on_couch", "lie|furniture|5,5|0"],
  ["bathtub", "taking_bath", "lie|furniture|5,5|0"],
  ["toilet", "using_toilet", "sit|furniture|5,5|0"],
  ["shared_sofa", "idle", "sit|furniture|5,5|0"],
  ["loveseat", "reading", "sit|furniture|5,5|0"],
  ["beanbag", "playing_with_cat", "sit|furniture|5,5|0"],
  ["plastic_stool", "idle", "sit|furniture|5,5|0"],
  ["gaming_desk", "working_at_desk", "sit|chair|4,5|0"],         // 桌前留在互動格
  ["gaming_desk", "gaming", "sit|chair|4,5|0"],
  ["mic_desk", "streaming", "sit|chair|4,5|0"],
  ["lounge_tv", "watching_tv", "sit|chair|4,5|0"],
  ["tv_console", "watching_tv", "sit|chair|4,5|0"],
  // 對不上的組合一律沒有姿勢
  ["single_bed", "sleeping_on_couch", "null|null|-|0"],
  ["shared_sofa", "sleeping_on_bed", "null|null|-|0"],
  ["toilet", "idle", "null|null|-|0"],
  ["bathtub", "using_toilet", "null|null|-|0"],
  ["single_bed", "cooking", "null|null|-|0"],
  ["bookshelf", "reading", "null|null|-|0"],
  ["stove", "cooking", "null|null|-|0"],
];
const pinFails: string[] = [];
for (const [defId, st, want] of PINS) {
  const got = sig(actualPose(st as any, { defId, room: "r301", c: 5, r: 5 }, { c: 4, r: 5 }));
  if (got !== want) pinFails.push(`${defId}/${st}: want ${want} got ${got}`);
}
check(`既有 ${PINS.length} 組代表性姿勢的 pose/surface/tile/rotation 完全不變`,
  pinFails.length === 0, pinFails.join(" / "));

// 沒標 seat 的 recipe 家具仍然在第一行 early return(這是舊行為的關鍵路徑)
const recipeNoSeat = CATALOG.filter((d) => !("kind" in d.sprite) && !d.seat);
check(`沒標 seat 的 recipe 家具(${recipeNoSeat.length} 件)在所有 visualState 下都不產生姿勢`,
  recipeNoSeat.every((d) => TENANT_VISUAL_STATES.every(
    (st) => actualPose(st, { defId: d.id, room: "cafe_floor", c: 5, r: 5 }, { c: 4, r: 5 }).pose === null)));

// ---------------------------------------------------------------------------
// 3) 資料驅動的 seat 欄位:契約與 at_cafe 的坐姿
// ---------------------------------------------------------------------------
const seatDefs = CATALOG.filter((d) => d.seat);
check("只有咖啡廳的桌 + 兩款椅標了 seat",
  seatDefs.map((d) => d.id).sort().join(",") === "cafe_chair_front,cafe_chair_side,cafe_table",
  seatDefs.map((d) => d.id).join(","));
check("seat 只用 on/at 兩個值", seatDefs.every((d) => d.seat === "on" || d.seat === "at"));
check("標了 seat 的家具都是 recipe sprite(kind 家具走原本的白名單,不該重複宣告)",
  seatDefs.every((d) => !("kind" in d.sprite)));

check("at_cafe + 咖啡廳椅 → 跨上椅子格(sit / furniture / 椅子本格)",
  sig(actualPose("at_cafe", { defId: "cafe_chair_front", room: "cafe_floor", c: 5, r: 5 }, { c: 4, r: 5 }))
    === "sit|furniture|5,5|0");
check("at_cafe + 側面椅 → 同樣跨上椅子格",
  sig(actualPose("at_cafe", { defId: "cafe_chair_side", room: "cafe_floor", c: 5, r: 5 }, { c: 4, r: 5 }))
    === "sit|furniture|5,5|0");
check("at_cafe + 小圓桌 → 坐在桌前(sit / chair / 停在互動格,不是坐上桌面)",
  sig(actualPose("at_cafe", { defId: "cafe_table", room: "cafe_floor", c: 5, r: 5 }, { c: 4, r: 6 }))
    === "sit|chair|4,6|0");
check("at_cafe + 非座位的咖啡廳家具(吧台)→ 沒有姿勢,不會亂坐",
  actualPose("at_cafe", { defId: "cafe_counter", room: "cafe_counter", c: 5, r: 5 }, { c: 4, r: 5 }).pose === null);
check("非坐姿狀態(睡覺/洗澡)踩到咖啡廳椅也不會躺下去",
  actualPose("sleeping_on_bed", { defId: "cafe_chair_front", room: "cafe_floor", c: 5, r: 5 }, { c: 4, r: 5 }).pose === null
  && actualPose("taking_bath", { defId: "cafe_table", room: "cafe_floor", c: 5, r: 5 }, { c: 4, r: 5 }).pose === null);

// seat 家具**不可能**被 at_cafe 以外的狀態走到:resolveTarget 只有 role="cafe" 會回傳
// 咖啡廳座位,而其它 role 的比對第一關就是 `"kind" in def.sprite`。
const seatIds = new Set(seatDefs.map((d) => d.id));
let leaked = 0;
for (const role of ROLES) {
  if (role === "cafe") continue;
  for (const st of TENANT_VISUAL_STATES) {
    for (const roomId of ["r301", "r302", null]) {
      const t = resolveTarget(role as any, roomId, st);
      if (t && seatIds.has(t.placement.defId)) leaked++;
    }
  }
}
check("其它 role/state 永遠取不到咖啡廳座位(所以新分支只影響 at_cafe)", leaked === 0, `leaked=${leaked}`);

// ---------------------------------------------------------------------------
// 4) 整合:真的跑一次 applyHour,租客會坐在一樓咖啡廳的座位上
// ---------------------------------------------------------------------------
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const grid = buildGrid();
const ids = Object.keys(state.runtimes).sort();
const setDay = (day: number) => { state.gameMs = GAME_START.getTime() + day * DAY_MS + HOUR_MS; };
for (const id of ids) {
  const rt = state.runtimes[id];
  rt.directive = null;
  rt.pendingEvent = null;
  rt.tenant.stats.stress = 40;
}
state.cafe.open = true;
placeCafeStarterSet();

let victim: { id: string; day: number; hour: number } | null = null;
for (let day = CAFE_FIRST_DAY; day < CAFE_FIRST_DAY + 30 && !victim; day++) {
  setDay(day);
  for (const id of ids) {
    const hour = cafeSitHourForDay(id, day);
    if (hour !== null && routineSlot(id, hour).state === "at_cafe") { victim = { id, day, hour }; break; }
  }
}
check("前置:找得到一位會下樓的租客", victim !== null);

const vrt = state.runtimes[victim!.id];
setDay(victim!.day);
applyHour(vrt, victim!.hour, false);
check("整合:visualState = at_cafe", vrt.tenant.visualState === "at_cafe", vrt.tenant.visualState);
check("🔴 整合:租客真的坐下了(不再是站姿)", vrt.activityPose === "sit", String(vrt.activityPose));
check("整合:坐姿落在一樓咖啡廳",
  !!vrt.activityTile && String(grid[vrt.activityTile.r]?.[vrt.activityTile.c]).startsWith("cafe"),
  JSON.stringify(vrt.activityTile));
const seatUsed = resolveTarget("cafe" as any, roomOfTenant(victim!.id))!.placement;
check("整合:走位挑到的確實是標了 seat 的家具", seatIds.has(seatUsed.defId), seatUsed.defId);
// 2026-08-27:租客改成「避開顧客已佔的席位、再依 roomId 雜湊散開坐」,不再固定取贈品組第一件
// (原斷言寫死「第一個座位是小圓桌 ⇒ surface=chair」,散開後就假不成立了)。
// 改成由**實際挑中的家具**推期望值,下面兩段再各自把兩個分支釘死。
const expectSurface = seatUsed.defId === "cafe_table" ? "chair" : "furniture";
check(`整合:坐姿表面與挑到的家具一致(${seatUsed.defId} ⇒ surface=${expectSurface})`,
  vrt.activitySurface === expectSurface, String(vrt.activitySurface));

// 只留小圓桌、拆掉所有咖啡廳椅 → 一定坐在桌前(補回上面不再固定的 surface=chair 分支)
for (const p of getPlacements().filter((x) => x.defId.startsWith("cafe_chair"))) removePlacementAt(p.c, p.r);
applyHour(vrt, victim!.hour, false);
check("只剩小圓桌時:坐在桌前(surface=chair)",
  vrt.activityPose === "sit" && vrt.activitySurface === "chair",
  `${vrt.activityPose}/${vrt.activitySurface}`);

// 把椅子擺回來(小圓桌還在 ⇒ 贈品組只會補上缺的椅子),再只留椅子、拆掉所有小圓桌
placeCafeStarterSet();
for (const p of getPlacements().filter((x) => x.defId === "cafe_table")) removePlacementAt(p.c, p.r);
applyHour(vrt, victim!.hour, false);
check("拆掉所有小圓桌後:改成跨坐在咖啡廳椅本格(surface=furniture)",
  vrt.activityPose === "sit" && vrt.activitySurface === "furniture",
  `${vrt.activityPose}/${vrt.activitySurface}`);
check("拆掉小圓桌後:坐的那一格真的有一張咖啡廳椅",
  !!vrt.activityTile && furnitureAt(vrt.activityTile.c, vrt.activityTile.r)?.defId?.startsWith("cafe_chair") === true,
  JSON.stringify(vrt.activityTile));

// ---------------------------------------------------------------------------
// 5) 退路:咖啡廳一張座位都沒有時不能崩
// ---------------------------------------------------------------------------
for (const p of getPlacements().filter((x) => x.defId.startsWith("cafe_chair"))) removePlacementAt(p.c, p.r);
check("前置:一樓已無任何座位家具",
  getPlacements().every((p) => !["cafe_table", "cafe_chair_front", "cafe_chair_side"].includes(p.defId)));
let crashed = "";
try {
  applyHour(vrt, victim!.hour, false);
} catch (e) {
  crashed = String(e);
}
check("空咖啡廳:applyHour 不拋錯", crashed === "", crashed);
check("空咖啡廳:仍然是 at_cafe(不會退回 idle 留在房裡)", vrt.tenant.visualState === "at_cafe", vrt.tenant.visualState);
check("空咖啡廳:退回大廳地板格,仍然坐著",
  vrt.activityPose === "sit" && !!vrt.activityTile
    && String(grid[vrt.activityTile.r]?.[vrt.activityTile.c]).startsWith("cafe"),
  JSON.stringify(vrt.activityTile));
check("空咖啡廳:腳下沒有家具(所以 renderer 要自己補一張椅子)",
  !!vrt.activityTile && furnitureAt(vrt.activityTile.c, vrt.activityTile.r) === null);
placeCafeStarterSet(); // 還原贈品組給後面的 renderer 檢查用

// ---------------------------------------------------------------------------
// 6) renderer:咖啡杯真的畫出來了,而且只在 at_cafe 畫
// ---------------------------------------------------------------------------
class RecorderCtx {
  fillStyle = "";
  globalAlpha = 1;
  fills: Array<{ color: string; x: number; y: number; w: number; h: number }> = [];
  fillRect(x: number, y: number, w: number, h: number) {
    this.fills.push({ color: String(this.fillStyle), x, y, w, h });
  }
  save() {}
  restore() {}
  translate() {}
  rotate() {}
  scale() {}
  setTransform() {}
  clearRect() {}
  drawImage() {}
  beginPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  fill() {}
  stroke() {}
  arc() {}
  rect() {}
  createLinearGradient() { return { addColorStop() {} }; }
}

/** 一個坐在指定格上的假 agent(不進模擬,只餵 renderer) */
const fakeAgent = (c: number, r: number, vs: string, pose: string | null, seatBack = false) => ({
  tenantId: ids[0], c, r, px: c * TILE, py: r * TILE, path: [], goal: null, moving: false,
  hidden: false, walkPhase: 0, vs, pose, facing: 0, poseRotation: 0,
  poseOffsetX: 0, poseOffsetY: 0, seatBack,
}) as any;

const CUP_PORCELAIN = "#f6efe6";
const CUP_COFFEE = "#6b4433";
const render = (agent: any) => {
  const ctx = new RecorderCtx();
  composeFloor(ctx as any, 0, [agent], undefined, 14);
  return ctx.fills;
};
const cupFills = (fills: any[], px: number, py: number) =>
  fills.filter((f) => f.color === CUP_PORCELAIN && f.w === 3 && f.h === 3 && f.x === px + 9 && f.y === py + 9);

// 坐在贈品組的正面椅上(座標一律查 CAFE_STARTER_PLACEMENTS,擺法改了也不會鬧鬼)
const starterChair = CAFE_STARTER_PLACEMENTS.find((p) => p.defId === "cafe_chair_front")!;
const CH_C = starterChair.c;
const CH_R = starterChair.r;
const seatedFills = render(fakeAgent(CH_C, CH_R, "at_cafe", "sit"));
check("🔴 renderer:at_cafe 坐姿畫了咖啡杯(白瓷杯身像素落在腹前)",
  cupFills(seatedFills, CH_C * TILE, CH_R * TILE).length === 1);
check("renderer:咖啡杯有咖啡液面(不是白色方塊)",
  seatedFills.some((f) => f.color === CUP_COFFEE && f.w === 3 && f.h === 1));
const standingFills = render(fakeAgent(CH_C, CH_R, "at_cafe", null));
check("renderer:at_cafe 站姿(咖啡廳沒座位時)也拿著杯子",
  standingFills.some((f) => f.color === CUP_PORCELAIN && f.w === 3 && f.h === 3));
const idleFills = render(fakeAgent(CH_C, CH_R, "idle", "sit"));
check("🔴 renderer:非 at_cafe 的坐姿完全不畫杯子",
  idleFills.every((f) => f.color !== CUP_PORCELAIN && f.color !== CUP_COFFEE));
const walkingFills = render({ ...fakeAgent(CH_C, CH_R, "at_cafe", null), moving: true, path: [{ c: CH_C, r: CH_R - 1 }] });
check("renderer:還在走路(下樓途中)不畫杯子",
  walkingFills.every((f) => f.color !== CUP_PORCELAIN));

// 空地板上的坐姿要自己補一張咖啡廳椅;坐在真椅子上則不補(否則會疊兩張椅子)
const CAFE_CHAIR_BACK = "#3c4059";
const emptyFloorFills = render(fakeAgent(6, 43, "at_cafe", "sit"));
check("renderer:空地板上的 at_cafe 坐姿補了一張咖啡廳椅",
  emptyFloorFills.some((f) => f.color === CAFE_CHAIR_BACK && f.x === 6 * TILE + 2 && f.y === 43 * TILE + 2),
  `furnitureAt=${JSON.stringify(furnitureAt(6, 43))}`);
const onChairFills = render(fakeAgent(CH_C, CH_R, "at_cafe", "sit"));
check("renderer:已經坐在真椅子上時不重複補椅子",
  !onChairFills.some((f) => f.color === CAFE_CHAIR_BACK && f.x === CH_C * TILE + 2 && f.y === CH_R * TILE + 2));
const idleEmptyFloorFills = render(fakeAgent(6, 43, "idle", "sit"));
check("renderer:非 at_cafe 的坐姿不會憑空長出椅子(三樓行為不變)",
  !idleEmptyFloorFills.some((f) => f.color === CAFE_CHAIR_BACK));

// 桌前坐姿(seatBack)在咖啡廳要畫咖啡廳椅,不是三樓的棕色木椅。
// 比對限定在「角色腳下那一格」的椅背矩形,避免撞到別處家具剛好同色。
const PLAIN_CHAIR = "#5b4636";
const chairBackAt = (fills: any[], c: number, r: number, color: string) =>
  fills.some((f) => f.color === color
    && f.x === c * TILE + (color === PLAIN_CHAIR ? 3 : 2)
    && f.y === r * TILE + (color === PLAIN_CHAIR ? 4 : 2));
const tableSeatFills = render(fakeAgent(3, 44, "at_cafe", "sit", true));
check("renderer:咖啡廳的桌前坐姿畫咖啡廳椅而不是三樓木椅",
  chairBackAt(tableSeatFills, 3, 44, CAFE_CHAIR_BACK) && !chairBackAt(tableSeatFills, 3, 44, PLAIN_CHAIR));
const loungeSeatFills = render(fakeAgent(6, 20, "working_at_desk", "sit", true));
check("renderer:三樓的桌前坐姿不受影響(不會變成咖啡廳椅)",
  !chairBackAt(loungeSeatFills, 6, 20, CAFE_CHAIR_BACK));

// ---------------------------------------------------------------------------
// 7) 房間細看(pixel/scene.ts)有專屬分支,不再和 away 同一張圖
// ---------------------------------------------------------------------------
const { composeScene, SCENE_W, SCENE_H } = await import("../src/pixel/scene");
const sceneFills = (vs: string) => {
  const ctx = new RecorderCtx();
  composeScene(ctx as any, {
    tenantId: ids[0], visualState: vs as any, roomProps: [], cleanliness: 80, frame: 0,
  } as any);
  return ctx.fills;
};
const cafeScene = sceneFills("at_cafe");
const awayScene = sceneFills("away");
const idleScene = sceneFills("idle");
check("房間細看:at_cafe 的畫面和 away 不一樣了",
  JSON.stringify(cafeScene) !== JSON.stringify(awayScene));
check("房間細看:at_cafe 畫了咖啡杯(白瓷 + 咖啡液面 + 杯墊)",
  cafeScene.some((f) => f.color === CUP_PORCELAIN && f.w === 8 && f.h === 9)
  && cafeScene.some((f) => f.color === CUP_COFFEE)
  && cafeScene.some((f) => f.color === "#cdbfae"));
check("房間細看:at_cafe 的門和 away 一樣會亮(人不在房裡)",
  cafeScene.some((f) => f.color === "#ffe9a8") && awayScene.some((f) => f.color === "#ffe9a8"));
check("房間細看:idle 的門不亮、也沒有杯子(既有行為不變)",
  !idleScene.some((f) => f.color === "#ffe9a8") && !idleScene.some((f) => f.color === CUP_PORCELAIN));
check("房間細看:畫布尺寸沒動", SCENE_W === 192 && SCENE_H === 144);

// ---------------------------------------------------------------------------
// 8) 🔴 balance 快照零漂移:第 0～9 遊戲日仍然 0 次 at_cafe
// ---------------------------------------------------------------------------
state.cafe.open = true; // 刻意打開閘門一,單獨考驗日數閘門
let windowHits = 0;
for (let day = 0; day < 10; day++) {
  setDay(day);
  for (const id of ids) {
    if (cafeSitHourForDay(id, day) !== null && day >= CAFE_FIRST_DAY) windowHits++;
    for (let hour = 0; hour < 24; hour++) if (routineSlot(id, hour).state === "at_cafe") windowHits++;
  }
}
check("🔴 第 0～9 遊戲日(balance 快照窗)仍然 0 次 at_cafe", windowHits === 0, `hits=${windowHits}`);
check("CAFE_FIRST_DAY 仍嚴格大於快照窗", CAFE_FIRST_DAY > 10, `CAFE_FIRST_DAY=${CAFE_FIRST_DAY}`);

// 零 RNG:整個姿勢路徑不得呼叫 Math.random
const realRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls++; return realRandom(); };
for (const def of CATALOG) {
  for (const st of TENANT_VISUAL_STATES) {
    actualPose(st, { defId: def.id, room: "cafe_floor", c: 5, r: 5 }, { c: 4, r: 5 });
  }
}
render(fakeAgent(1, 43, "at_cafe", "sit"));
Math.random = realRandom;
check("零 RNG:姿勢判定與咖啡廳繪製都沒有呼叫 Math.random", randomCalls === 0, `calls=${randomCalls}`);

// 決定性:同樣輸入畫出來的像素完全相同
const a1 = JSON.stringify(render(fakeAgent(1, 43, "at_cafe", "sit")));
const a2 = JSON.stringify(render(fakeAgent(1, 43, "at_cafe", "sit")));
check("決定性:同一輸入連畫兩次像素完全相同", a1 === a2);

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
