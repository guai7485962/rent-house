/**
 * 存檔/載入/遷移(store 拆分:persistence 模組)。
 *
 * 遷移層(設計檢討 §5):存檔帶版本號 v;載入時 migrateSave() 從舊版逐段升級到
 * SAVE_VERSION,壞檔/未知版本安全 fallback(當沒有存檔、開新遊戲)。
 * 之後改存檔結構的流程:SAVE_VERSION++ → 在 MIGRATIONS 加一段「舊版 → 新版」升級函式。
 */
import { reactive } from "vue";
import type { Tenant } from "../types";
import { hasDef } from "../furniture/catalog";
import { placements, starterPlacementsAgainst } from "./placements";
import { normalizeRotation } from "../furniture/rotation";
import { upgradeState } from "./upgrades";
import { serializeRelationships, loadRelationships, pruneRomanceIntegrity } from "./social";
import { registerRoutine } from "./routine";
import { setCustomAppearance } from "../pixel/scene";
import { sanitizeAppearanceInPlace } from "../pixel/parts";
import { state, tenants, refreshAppearances, ARC_HISTORY_CAP, GAME_START, gameDayIndex, cohabitingPartnerId, normalizeMemoryCaps, sanitizeCafeState, type Txn } from "./gameState";
import { ensureDiaryHours } from "./narration";
import { ensurePets } from "./pets";
import { ensureWishes } from "./wishes";
import { stopTicker } from "./lifecycle";
import { sanitizeDiaryText } from "./narrativeQuality";
import { sanitizeGrowthTags } from "./growth";
import { genderForKnownName } from "./recruit";

export const SAVE_KEY = "rent_house_save_v1";
export const SAVE_VERSION = 10;

/**
 * 逐版升級表:key = 來源版本,函式回傳「升一版後」的存檔(記得把 v 改成 key+1)。
 */
const MIGRATIONS: Record<number, (s: any) => any> = {
  // v2 → v3:數值模型重整(設計檢討 §4)——stats.hygiene 改名 wellbeing、新增 energy
  2: (s) => {
    for (const rt of Object.values<any>(s.runtimes ?? {})) {
      const st = rt?.tenant?.stats;
      if (st) {
        st.wellbeing = st.wellbeing ?? st.hygiene ?? 70;
        delete st.hygiene;
        st.energy = st.energy ?? 60;
      }
    }
    return { ...s, v: 3 };
  },
  // v3 → v4:安居倒數改以日曆午夜換日；實際起點由 ensureWishes 從心願完成日誌還原。
  3: (s) => ({ ...s, v: 4 }),
  // v4 → v5:樓寵物永久名額／中途送養；既有樓寵物先保留為 permanent，交由玩家挑選超量安置。
  4: (s) => {
    for (const pet of Object.values<any>(s.pets ?? {})) {
      if (pet?.ownerId === "landlord") pet.housePlacement ??= "permanent";
    }
    return { ...s, petHomes: s.petHomes ?? [], v: 5 };
  },
  // v5 → v6:社群事件可排到正確時段；舊檔沒有待演場景，從空佇列開始。
  5: (s) => ({ ...s, scheduledCommunityEvents: s.scheduledCommunityEvents ?? [], v: 6 }),
  /**
   * v6 → v7:補發咖啡廳開張贈品。
   *
   * `placeCafeStarterSet()` 只在按下開張的那一刻跑,所以**在該功能上線前就已經開張的
   * 存檔永遠拿不到贈品,一樓會永遠是空的**(2026-08-03 使用者實玩回報)。
   * 只要已開張就補一次。
   *
   * **刻意不加「一樓已經有家具就跳過」的守衛**:第一版寫了那條,結果只要玩家自己放過
   * **一件**東西(實例:一個貓跳台)就會把整組贈品擋掉,拿不到任何補發——
   * 而「已經有一件家具」跟「已經佈置好了」根本是兩回事。
   * 防覆蓋本來就由 `starterPlacementsAgainst()` 逐格檢查重疊負責,那條守衛既太粗又多餘。
   *
   * 只跑一次:升級表逐版前進,升完 `v = 7` 就不會再回到本函式 ⇒ 玩家事後搬走或
   * 賣掉贈品不會被重新塞回來。
   */
  6: (s) => ({ ...backfillCafeStarter(s), v: 7 }),
  /**
   * v7 → v8:**再補一次**咖啡廳開張贈品。
   *
   * 為什麼需要第二次:v7 上線時的 `MIGRATIONS[6]` 帶了一條「一樓已有家具就整組跳過」的
   * 守衛,只要玩家自己放過一件東西(實例:一個貓跳台)就拿不到任何補發。
   * 那批已經上線,受影響的存檔**已經被標成 v7**,升級表不會回頭 ⇒ 光修 `MIGRATIONS[6]`
   * 對他們永遠不生效,必須再升一版才追得到。
   *
   * 重跑是安全的:`starterPlacementsAgainst()` 逐格檢查重疊,已經拿到贈品的存檔
   * 座標全被佔住 ⇒ 一件也不會多加。這個特性讓本函式對三種存檔都收斂到正確結果:
   * 補過的不變、被守衛擋掉的補齊、開新局的本來就在開張時拿過。
   */
  7: (s) => ({ ...backfillCafeStarter(s), v: 8 }),
  /**
   * v8 → v9:咖啡廳重設計 P1(逐位顧客結帳)。
   *
   * 新增 `cafe.sales`(逐日逐品項銷售紀錄)。舊檔補一個空陣列就完事——
   * 銷售紀錄本來就是「從現在開始累積」的東西,回填假資料只會讓 P3 的銷售排行
   * 顯示玩家從來沒賣過的品項。
   *
   * `standingOrders` / `stock` **刻意原封不動**:原料 id 一個都沒變,變的只有
   * `unitPrice`(進貨變便宜)與 `defaultStandingOrder`(建議值變大)。
   * 舊檔玩家手上的庫存與自訂常備量都仍然合法,只是常備量偏低——
   * 那會在下一個營業日以「缺貨」的形式讓玩家自己看到,並自己調高,
   * 這正是設計文件 §4.3 要的經營回饋,不該由遷移偷偷改掉玩家設定。
   */
  8: (s) => ({ ...s, cafe: s?.cafe ? { ...s.cafe, sales: Array.isArray(s.cafe.sales) ? s.cafe.sales : [] } : s?.cafe, v: 9 }),
  /**
   * v9 → v10:咖啡廳重設計 P2(顧客與結帳合流)。
   *
   * `CafeGuest` 多了 `order`(他點了什麼、付了多少),而**舊檔裡的顧客沒有這份訂單**——
   * 他們是舊那條「55% 門檻純裝飾」路徑生出來的,身上沒有任何一筆錢對應得上。
   * 留著他們只會在畫面上出現「有人在店裡但沒點過任何東西」的殘影,
   * 所以直接清空 `cafe.guests`:顧客本來就是**每小時重生的臨時體**
   * (`sanitizeCafeState` 載入時也會把過期的清掉),清掉不損失任何玩家資產,
   * 下一個營業小時就會有帶著真實訂單的新顧客走進來。
   *
   * `standingOrders` / `stock` / `sales` / `history` / `popularity` 全部原封不動。
   */
  9: (s) => ({ ...s, cafe: s?.cafe ? { ...s.cafe, guests: [] } : s?.cafe, v: 10 }),
};

/** 已開張就把贈品補到 `placements`;重疊由 `starterPlacementsAgainst()` 擋,重跑安全。 */
function backfillCafeStarter(s: any): any {
  if (!s?.cafe?.open) return s;
  const existing = Array.isArray(s.placements) ? s.placements : [];
  return { ...s, placements: [...existing, ...starterPlacementsAgainst(existing)] };
}

/** 把任意版本的存檔升級到 SAVE_VERSION;不認得/升不上去回傳 null(視同壞檔) */
export function migrateSave(raw: unknown): any | null {
  let s = raw as any;
  if (!s || typeof s !== "object" || typeof s.v !== "number") return null;
  while (s.v < SAVE_VERSION) {
    const step = MIGRATIONS[s.v];
    if (!step) return null; // 太舊、沒有升級路徑
    s = step(s);
  }
  if (s.v !== SAVE_VERSION) return null; // 比程式還新(未來版),不硬讀
  return s;
}

/** 玩家按下「重新開始」或匯入存檔後設為 true:直到 reload 前不再寫檔 */
let saveBlocked = false;

export function save() {
  if (saveBlocked) return;
  try {
    const runtimes: Record<string, unknown> = {};
    for (const [id, rt] of Object.entries(state.runtimes)) {
      runtimes[id] = {
        tenant: rt.tenant, // 存完整租客(動態入住者沒有原始種子可依)
        roomNo: rt.roomNo,
        cleanliness: rt.cleanliness,
        roomProps: rt.roomProps,
        log: rt.log,
        lastSeenMs: rt.lastSeenMs,
        pendingEvent: rt.pendingEvent,
        decisions: rt.decisions,
        targetTile: rt.targetTile,
        archetypeKey: rt.archetypeKey,
        satisfaction: rt.satisfaction,
        unhappyHours: rt.unhappyHours,
        lastEventDay: rt.lastEventDay,
        rentChangeDay: rt.rentChangeDay,
        directive: rt.directive,
        lastSelfBehaviorDay: rt.lastSelfBehaviorDay,
        wallet: rt.wallet,
        arrears: rt.arrears,
        hardshipUntilDay: rt.hardshipUntilDay,
        lastHardshipDay: rt.lastHardshipDay,
        rentGraceUntilDay: rt.rentGraceUntilDay,
        lastRentPleaDay: rt.lastRentPleaDay,
        wish: rt.wish,
        modelTenant: rt.modelTenant,
        modelSinceDay: rt.modelSinceDay,
        modelSinceCalendarDay: rt.modelSinceCalendarDay,
        lastCareDay: rt.lastCareDay,
        arc: rt.arc,
        sideArc: rt.sideArc,
        arcHistory: rt.arcHistory,
        flags: rt.flags,
        diaryHour: rt.diaryHour,
        lastDiaryDay: rt.lastDiaryDay,
        moveInMs: rt.moveInMs,
      };
    }
    localStorage.setItem(
      SAVE_KEY,
      JSON.stringify({
        v: SAVE_VERSION,
        realAnchorMs: state.realAnchorMs,
        gameAnchorMs: state.gameAnchorMs,
        gameMs: state.gameMs,
        money: state.money,
        starterBonusGiven: state.starterBonusGiven,
        occupancy: state.occupancy,
        cohabits: state.cohabits,
        applicantPools: state.applicantPools,
        placements: placements.list,
        upgrades: upgradeState.byRoom,
        relationships: serializeRelationships(),
        ledger: state.ledger,
        noticeLog: state.noticeLog,
        feedSeenMs: state.feedSeenMs,
        weeklyReports: state.weeklyReports,
        lastWeeklyReportDay: state.lastWeeklyReportDay,
        weeklyRelationshipSnapshot: state.weeklyRelationshipSnapshot,
        lastBackupMs: state.lastBackupMs,
        adultMode: state.adultMode,
        interactionCooldowns: state.interactionCooldowns,
        breakdowns: state.breakdowns,
        feuds: state.feuds,
        pets: state.pets,
        petHomes: state.petHomes,
        achievements: state.achievements,
        wishesFulfilled: state.wishesFulfilled,
        reputation: state.reputation,
        graduateCount: state.graduateCount,
        careGiven: state.careGiven,
        alumni: state.alumni,
        pendingGroupEvent: state.pendingGroupEvent,
        scheduledCommunityEvents: state.scheduledCommunityEvents,
        floorChain: state.floorChain,
        lastChainEndDay: state.lastChainEndDay,
        pendingChainEvent: state.pendingChainEvent,
        pendingDiaries: state.pendingDiaries,
        cafe: state.cafe,
        runtimes,
      }),
    );
  } catch {
    /* localStorage 不可用時忽略 */
  }
}

export function load(): boolean {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    const migratedVersion = parsed?.v !== SAVE_VERSION;
    const s = migrateSave(parsed);
    if (!s) return false;
    let repairedModelSinceDay = false;
    state.realAnchorMs = s.realAnchorMs;
    state.gameAnchorMs = s.gameAnchorMs;
    state.gameMs = s.gameMs;
    state.money = s.money;
    state.starterBonusGiven = s.starterBonusGiven === true; // 舊檔沒有 → 視為未發放,initGame 會補發

    // 家具擺放 + 房間升級(過濾掉目錄已查無的家具,一筆壞資料不能毀掉整個畫面)
    const loadedPlacements = (s.placements as { defId: string }[]).filter((p) => {
      if (hasDef(p.defId)) return true;
      console.warn(`[load] 存檔內有已下架的家具「${p.defId}」,略過`);
      return false;
    });
    placements.list.splice(0, placements.list.length, ...loadedPlacements.map((p: any) => ({ ...p, rotation: normalizeRotation(p.rotation) }) as (typeof placements.list)[number]));
    placements.version++;
    for (const k of Object.keys(upgradeState.byRoom)) delete upgradeState.byRoom[k];
    Object.assign(upgradeState.byRoom, s.upgrades ?? {});

    // 房間佔用 + 同居 + 應徵者池
    for (const k of Object.keys(state.occupancy)) delete state.occupancy[k];
    Object.assign(state.occupancy, s.occupancy);
    for (const k of Object.keys(state.cohabits)) delete state.cohabits[k];
    Object.assign(state.cohabits, s.cohabits ?? {});
    for (const k of Object.keys(state.applicantPools)) delete state.applicantPools[k];
    Object.assign(state.applicantPools, s.applicantPools ?? {});
    // 舊版應徵者的姓名與性別分開亂抽；已知姓名直接以現行角色表校正。
    for (const pool of Object.values(state.applicantPools)) {
      for (const applicant of pool.applicants ?? []) {
        const knownGender = genderForKnownName(applicant.name);
        if (knownGender) applicant.gender = knownGender;
      }
    }

    // 鄰居關係
    loadRelationships(s.relationships ?? []);

    // 收支帳 + 通知歷史
    state.ledger.splice(0, state.ledger.length, ...((s.ledger ?? []) as Txn[]));
    state.noticeLog.splice(0, state.noticeLog.length, ...(s.noticeLog ?? []));
    state.feedSeenMs = s.feedSeenMs ?? 0; // 舊檔沒有 → 全部視為未讀,無害
    state.weeklyReports.splice(0, state.weeklyReports.length, ...(s.weeklyReports ?? []));
    // 舊檔沒有週報基準:從載入當下開始計一週,避免把全部歷史誤報成「本週變化」。
    state.lastWeeklyReportDay = typeof s.lastWeeklyReportDay === "number" ? s.lastWeeklyReportDay : gameDayIndex();
    for (const key of Object.keys(state.weeklyRelationshipSnapshot)) delete state.weeklyRelationshipSnapshot[key];
    Object.assign(
      state.weeklyRelationshipSnapshot,
      s.weeklyRelationshipSnapshot ?? Object.fromEntries((s.relationships ?? []).map((r: { key: string; value: number }) => [r.key, r.value])),
    );
    state.lastBackupMs = s.lastBackupMs ?? 0; // 舊檔沒有 → 視為從未備份
    state.adultMode = s.adultMode === true; // 預設關
    for (const k of Object.keys(state.interactionCooldowns)) delete state.interactionCooldowns[k];
    Object.assign(state.interactionCooldowns, s.interactionCooldowns ?? {});
    for (const k of Object.keys(state.breakdowns)) delete state.breakdowns[k];
    Object.assign(state.breakdowns, s.breakdowns ?? {}); // 舊檔沒有 → 沒故障,無害
    for (const k of Object.keys(state.feuds)) delete state.feuds[k];
    Object.assign(state.feuds, s.feuds ?? {}); // 舊檔沒有 → 沒冷戰,無害
    for (const k of Object.keys(state.pets)) delete state.pets[k];
    Object.assign(state.pets, s.pets ?? {}); // 舊檔沒有 → ensurePets 會補種子貓
    state.petHomes.splice(0, state.petHomes.length, ...((s.petHomes ?? []) as typeof state.petHomes));
    state.achievements.splice(0, state.achievements.length, ...((s.achievements ?? []) as string[]));
    state.wishesFulfilled = typeof s.wishesFulfilled === "number" ? s.wishesFulfilled : 0; // 舊檔沒有 → 0
    state.reputation = typeof s.reputation === "number" ? s.reputation : 0; // 舊檔沒有 → 口碑從 0 累積
    state.graduateCount = typeof s.graduateCount === "number" ? s.graduateCount : 0; // 舊檔沒有 → 0
    state.careGiven = typeof s.careGiven === "number" ? s.careGiven : 0; // 舊檔沒有 → 0
    state.alumni.splice(0, state.alumni.length, ...((s.alumni ?? []) as typeof state.alumni));
    state.pendingGroupEvent = s.pendingGroupEvent ?? null; // 舊檔沒有 → 無待決群體事件
    state.scheduledCommunityEvents.splice(
      0,
      state.scheduledCommunityEvents.length,
      ...(s.scheduledCommunityEvents ?? []),
    );
    // 月度全樓事件鏈(選填欄位,舊檔沒有就從沒有章節開始,不需要升 SAVE_VERSION)
    state.floorChain = s.floorChain ?? null;
    state.lastChainEndDay = typeof s.lastChainEndDay === "number" ? s.lastChainEndDay : -99;
    state.pendingChainEvent = s.pendingChainEvent ?? null;
    state.pendingDiaries.splice(0, state.pendingDiaries.length, ...(s.pendingDiaries ?? []));
    // 一樓寵物咖啡廳(選填欄位,舊檔沒有就從 defaultCafe() 開始,不需要升 SAVE_VERSION)。
    // guests 入存檔,但正規化時已用 gameMs 濾掉到點的客人 → 離線久了店裡自然是空的。
    Object.assign(state.cafe, sanitizeCafeState(s.cafe, state.gameMs));

    // 重建所有租客 runtime(含動態入住者)
    for (const k of Object.keys(state.runtimes)) delete state.runtimes[k];
    for (const [id, saved] of Object.entries<any>(s.runtimes)) {
      const loadedTenant = saved.tenant as Tenant;
      loadedTenant.growthTags = sanitizeGrowthTags(loadedTenant.growthTags);
      normalizeMemoryCaps(loadedTenant);
      // AI 色碼安全化(§9-3):`0accd4b` 之前的特邀租客把未消毒的顏色寫進了存檔,
      // 這裡就地修好。消毒冪等 → 不需升 SAVE_VERSION,也不寫回存檔(下次存檔自然帶乾淨值)。
      // 同一個物件下方會傳給 setCustomAppearance,渲染層拿到的已是消毒後的顏色。
      sanitizeAppearanceInPlace(loadedTenant.appearance);
      const needsModelSinceDayRepair =
        saved.modelTenant === true && !Number.isFinite(saved.modelSinceCalendarDay);
      if (needsModelSinceDayRepair) repairedModelSinceDay = true;
      const loadedDay = gameDayIndex();
      const savedMainArc = saved.arc?.seedId ? null : saved.arc;
      const savedSideArc = saved.sideArc ?? (saved.arc?.seedId ? saved.arc : null);
      // sideArc 只接受本地種子形狀；缺 seedId 的壞資料否則會永久占槽、永遠不會被本地引擎推進。
      const loadedSideArc = savedSideArc && typeof savedSideArc.seedId === "string" && savedSideArc.seedId
        ? { ...savedSideArc, localDay: Number.isFinite(savedSideArc.localDay) ? Math.min(loadedDay, savedSideArc.localDay) : loadedDay }
        : null;
      state.runtimes[id] = reactive({
        tenant: loadedTenant,
        roomNo: saved.roomNo,
        cleanliness: saved.cleanliness,
        roomProps: saved.roomProps,
        // 舊存檔可能保留模型曾產生的重複流水帳；只清理 AI 當日觀察，
        // 一般事件日誌與玩家抉擇原文完全不動。
        log: (saved.log ?? []).map((entry: any) => entry?.daily && entry?.ai && typeof entry.text === "string"
          ? { ...entry, text: sanitizeDiaryText(entry.text, [loadedTenant.name]) || entry.text }
          : entry),
        lastSeenMs: saved.lastSeenMs,
        pendingEvent: saved.pendingEvent,
        decisions: saved.decisions,
        targetTile: saved.targetTile,
        activityPose: null,
        activityTile: null,
        activityRotation: 0,
        activitySurface: null,
        archetypeKey: saved.archetypeKey,
        satisfaction: saved.satisfaction ?? 62,
        unhappyHours: saved.unhappyHours ?? 0,
        lastEventDay: saved.lastEventDay ?? -99,
        rentChangeDay: saved.rentChangeDay ?? -99,
        directive: saved.directive ?? null,
        lastSelfBehaviorDay: saved.lastSelfBehaviorDay ?? -99,
        wallet: saved.wallet, // 缺省 undefined → ensureWallets 依月租補登
        arrears: saved.arrears ?? 0,
        hardshipUntilDay: saved.hardshipUntilDay ?? -99,
        lastHardshipDay: saved.lastHardshipDay ?? -99,
        rentGraceUntilDay: saved.rentGraceUntilDay ?? -99,
        lastRentPleaDay: saved.lastRentPleaDay ?? -99,
        wish: saved.wish ?? null, // 舊檔沒有 → ensureWishes 依職業指派
        modelTenant: saved.modelTenant === true, // 舊檔沒有 → 不是模範房客
        modelSinceDay: Number.isFinite(saved.modelSinceDay) ? saved.modelSinceDay : undefined,
        // 午夜制安居起點缺失時先留空，ensureWishes 會從「心願成真」日誌／fulfilledDay 還原。
        modelSinceCalendarDay: Number.isFinite(saved.modelSinceCalendarDay)
          ? saved.modelSinceCalendarDay
          : undefined,
        lastCareDay: saved.lastCareDay ?? -99,
        // 2026-08-15 前本地種子也占用 arc 主線槽；載入時搬到 sideArc,立刻釋放 AI 主線。
        // 舊 AI 弧沒有 lastProgressDay 時從載入當日開始計 stall,不可一載入就誤收束。
        arc: savedMainArc
            ? { ...savedMainArc, lastProgressDay: Number.isFinite(savedMainArc.lastProgressDay) ? Math.min(loadedDay, savedMainArc.lastProgressDay) : loadedDay }
            : null,
        sideArc: loadedSideArc,
        // 選填欄位:舊存檔沒有 → 空陣列(不升 SAVE_VERSION)
        arcHistory: Array.isArray(saved.arcHistory) ? saved.arcHistory.slice(-ARC_HISTORY_CAP) : [],
        flags: saved.flags ?? [],
        inLounge: false,
        visiting: null,
        visitHostId: null,
        diaryHour: saved.diaryHour ?? -1, // 舊檔沒有 → ensureDiaryHours 指派
        lastDiaryDay: saved.lastDiaryDay ?? -99,
        moveInMs: saved.moveInMs ?? GAME_START.getTime(), // 舊檔沒有 → 當作開場入住
      });
      if (saved.archetypeKey) registerRoutine(id, saved.archetypeKey);
      // 部件化外觀(§9-1):存檔帶有外觀者,重新登錄到渲染層
      const ap = (saved.tenant as Tenant).appearance;
      if (ap) setCustomAppearance(id, ap);
    }
    // 舊存檔的種子租客補性別/取向；舊版隨機姓名則覆寫曾被亂抽錯的性別。
    for (const rt of Object.values(state.runtimes)) {
      const knownGender = genderForKnownName(rt.tenant.name);
      if (knownGender) rt.tenant.gender = knownGender;
      if (!rt.tenant.gender) {
        const seed = tenants.find((t) => t.id === rt.tenant.id);
        if (seed?.gender) {
          rt.tenant.gender = seed.gender;
          rt.tenant.attractedTo = seed.attractedTo;
        }
      }
    }
    // 清掉不合法／多重戀情；同居對象優先保留，否則保留關係值最高的一組。
    pruneRomanceIntegrity((id) => state.runtimes[id]?.tenant, cohabitingPartnerId);
    refreshAppearances(); // 依房間指派配色,修正舊存檔可能的撞色
    ensureDiaryHours(); // 舊檔沒有日記時段 → 指派(每人錯開)
    state.pendingDiaries.splice(
      0,
      state.pendingDiaries.length,
      ...state.pendingDiaries.filter((job) => state.runtimes[job.tenantId]?.log.some((entry) => entry.diaryId === job.diaryId && entry.aiPending)),
    );
    const repairedPets = ensurePets(); // 舊檔沒有寵物資料 → 補種子貓；孤兒／新欄位修復需立即回存
    if (ensureWishes()) repairedModelSinceDay = true; // 同時修復舊安居起點與上一版錯補的「載入當天」
    if (!state.runtimes[state.activeId]) state.activeId = Object.keys(state.runtimes)[0];
    // 安居起點補值當下立即持久化，避免短暫開啟後關閉又重跑遷移。
    if (repairedModelSinceDay || repairedPets || migratedVersion) save();
    return true;
  } catch {
    return false;
  }
}

// --- 存檔管理(8-4:重新開始 / 匯出 / 匯入)---

/** 匯出目前存檔 JSON(先落盤再讀,保證是最新狀態);localStorage 不可用回傳 null。
 *  成功匯出即記下備份時間(供設定頁提醒玩家定期備份)。 */
export function exportSave(): string | null {
  state.lastBackupMs = Date.now(); // 標記備份時間(要在 save() 之前設,才會一起寫進檔)
  save();
  try {
    return localStorage.getItem(SAVE_KEY);
  } catch {
    return null;
  }
}

/** 匯入存檔:JSON 解析 → 遷移到現行版本 → 結構檢查通過才寫入,成功回傳 true(呼叫端負責 reload) */
export function importSave(raw: string): boolean {
  try {
    const s = migrateSave(JSON.parse(raw));
    if (!s || !s.runtimes || !s.occupancy) return false;
    localStorage.setItem(SAVE_KEY, JSON.stringify(s)); // 存「遷移後」的版本
    saveBlocked = true; // 匯入後直到 reload 前,不讓現有狀態把新檔蓋回去
    stopTicker();
    return true;
  } catch {
    return false;
  }
}

/** 清除存檔(重新開始;呼叫端負責 reload)。停掉掛機計時器並封鎖 save,避免 reload 前又被寫回 */
export function clearSave() {
  saveBlocked = true;
  stopTicker();
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* localStorage 不可用時忽略 */
  }
}
