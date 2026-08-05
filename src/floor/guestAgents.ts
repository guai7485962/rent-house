/**
 * 咖啡廳顧客的獨立走位層。
 *
 * 不共用租客 Agent,也不讀寫 state.runtimes。資料來源只有 `state.cafe.guests`,
 * 而那批人從 P2 起**就是結帳的那批人**(`tick.ts` 的 `cafeHourlyPass()` 逐筆生成),
 * 所以這裡演的每一位都對應帳本上真的收過的一筆錢。
 *
 * ## 動線(設計文件 §4.5 §4.6)
 *
 * ```
 * 店門 →[排隊]→ 吧台 → ordering →(料齊)served →(有空席)seated → leaving → departed
 *                                               └(無空席)外帶 ─────→ leaving → departed
 *                               →(缺料)refused ──────────────────→ leaving → departed
 * ```
 *
 * P4b 起 `entering` 多了一段**排隊**:同時能結帳的人數 = `min(員工數, 點餐位數)`,
 * 輪不到的人站進 `cafeQueueTiles()` 的人龍(`queueTile`)。排隊是**純表現層**——
 * 錢在 `tick.ts` 早就收完了,隊伍只是把「產能吃緊」畫出來(設計文件 §4.9)。
 *
 * 🔴 A 批(2026-08-05,使用者拍板)在人龍上加了**唯一一個出口**:
 * `order.abandoned` 的顧客永遠拿不到點餐位,排滿 `GUEST_ABANDON_SECONDS` 就轉進
 * `leaving` 走出大門。**判定不在這裡**——$0 與聲譽 −1 早在 `cafeHourlyPass()`
 * 就結算完了(理由見該函式註解),本層只演。先到先服務的配對邏輯一行未改。
 *
 * 席次一律查 `placements`(`cafeSeatSpots()`),**沒有硬編座位表**——
 * P1 之前的 `CAFE_GUEST_PREFERRED_SEATS` 正是「顧客站在空地板上」的根因。
 */
import type { CafeGuest } from "../types";
import type { CharView } from "../pixel/sprites";
import { cafeCounterSpots, cafeQueueTiles, cafeSeatSpots, type CafeSeatSpot } from "../sim/placements";
import { TILE } from "./map";
import { currentBlocked, findPath, type Tile } from "./pathfind";

export const CAFE_GUEST_ENTRY_TILES: readonly Tile[] = [
  { c: 7, r: 51 },
  { c: 8, r: 51 },
];

/**
 * 顧客的七個階段。`served` / `refused` 是**站在吧台前的短暫演出幀**
 * (浮字 / ❌ 泡泡),不是停留狀態;演完就往座位或門口走。
 */
export type GuestAgentPhase =
  | "entering"
  | "ordering"
  | "served"
  | "refused"
  | "seated"
  | "leaving"
  | "departed";

/** 各階段的演出秒數(現實秒,由 dt 累加;與遊戲時鐘無關 ⇒ 快轉不會吃掉演出)。 */
export const GUEST_ORDER_SECONDS = 2.2;
export const GUEST_SERVED_SECONDS = 2.6;
export const GUEST_REFUSED_SECONDS = 2.4;
/**
 * 走不到目的地時的放棄秒數。
 *
 * 吧台前被別的顧客站滿、或玩家把家具擺成死路時,顧客不能就這樣卡在門口一輩子——
 * 逾時就地進入下一階段,演出照樣看得到,不會出現「有人結帳但畫面上沒動作」。
 */
export const GUEST_WALK_TIMEOUT_SECONDS = 14;

/**
 * 🔴 A 批:排隊排到放棄的秒數(現實秒)。
 *
 * 只作用在**模擬層已經判定會放棄**的顧客(`guest.order.abandoned`)——這裡不做任何
 * 新判定,只決定「他在畫面上站多久才轉身」。錢與聲譽早在 `cafeHourlyPass()` 就結算完了。
 *
 * 18 秒的推導:一次結帳演出是 `GUEST_ORDER_SECONDS 2.2` + 走到吧台約 1.5 秒 ≈ 3.7 秒,
 * 也就是隊伍每 ~3.7 秒前進一位。18 秒 ≈ **眼看著前面走掉四、五個人還輪不到自己**,
 * 玩家看得出他是「等到不耐煩」而不是「一進門就走」;同時遠短於外帶客的停留時間
 * (`CAFE_TAKEAWAY_STAY_HOURS 0.25` 遊戲小時 ≈ 128 現實秒),所以他一定演得完才被清掉。
 */
export const GUEST_ABANDON_SECONDS = 18;

/** 這位顧客是不是模擬層判定「排到放棄」的那一批(舊存檔沒有這欄 ⇒ false)。 */
export function guestAbandons(agent: GuestAgent): boolean {
  return agent.guest.order?.abandoned === true;
}

export interface GuestAgent {
  guest: CafeGuest;
  c: number;
  r: number;
  px: number;
  py: number;
  path: Tile[];
  goal: Tile | null;
  moving: boolean;
  hidden: boolean;
  walkPhase: number;
  phase: GuestAgentPhase;
  /** 目前階段已經過的現實秒數(演出計時用)。 */
  phaseT: number;
  view: CharView;
  entryTile: Tile;
  /** 點餐位(吧台前)。 */
  counterTile: Tile;
  /**
   * 🔴 P4b:他正在排的那一格;`null` = 已經輪到他,可以走去 `counterTile` 點餐。
   *
   * 由 `tickGuestAgents()` 每幀依「同時能結帳的人數」重算 ⇒ 前面的人點完走掉,
   * 後面整條隊伍就往前遞補一格。**純表現層**,不影響任何金流。
   */
  queueTile: Tile | null;
  /**
   * 🔴 A 批:他已經在人龍裡等了幾現實秒(輪到他 ⇒ 歸零)。
   *
   * `phaseT` 在排隊時被刻意歸零(排隊不算「走不到目的地」),所以放棄計時需要
   * 自己這一格。只有 `guestAbandons()` 的顧客會因為它而離場。
   */
  queueT: number;
  /** 他的席位;`null` = 外帶或撲空,不入座。 */
  seatSpot: CafeSeatSpot | null;
  /** 下一格被別人擋住而原地等了多久(現實秒);超過門檻就繞路。 */
  stuckT: number;
}

/**
 * 被擋住多久就重新規劃一條「繞開站著不動的人」的路。
 *
 * 沒有這條會死鎖:P2 起同一小時會有一整批顧客進場,先坐下的人就站在別人的必經格上,
 * 而 `findPath` 不認得 agent ⇒ 後到的人會抱著一條永遠走不通的舊路徑等到天荒地老
 * (實測:六人同時進場時有兩位永遠卡在吧台前)。
 */
const REPATH_AFTER_BLOCKED_SECONDS = 0.8;

const SPEED = 40;
const EMPTY_BLOCKED: ReadonlySet<string> = new Set();
const tileKey = (tile: Tile) => `${tile.c},${tile.r}`;
const sameTile = (a: Tile | null, b: Tile | null) => !!a && !!b && a.c === b.c && a.r === b.r;

/** 顧客是否處在「站著演出、不移動」的階段。 */
function isPerforming(phase: GuestAgentPhase) {
  return phase === "ordering" || phase === "served" || phase === "refused";
}

/**
 * 這位顧客該坐哪張椅子。
 *
 * `guest.seatTile` 是**模擬層在結帳當下配好的**(來自 `cafeSeatSpots()`),
 * 這裡只是把它對回目前的席位清單 —— 玩家中途把那張椅子拆了就找不到,
 * 他自動退化成外帶(站著點完就走),不會卡住也不會坐在空地板上。
 */
function seatSpotFor(guest: CafeGuest, spots: readonly CafeSeatSpot[]): CafeSeatSpot | null {
  if (!guest.seatTile) return null;
  return spots.find((spot) => spot.seat.c === guest.seatTile!.c && spot.seat.r === guest.seatTile!.r) ?? null;
}

/**
 * 把 `state.cafe.guests` 同步成畫面 agent。
 *
 * **既有 agent 依 id 原地保留**:新顧客每個營業小時都會進來一批,若像舊版那樣整批
 * 重建,已經坐下的人會被瞬移回店門口——那正好毀掉 P2 要演的「走進來、坐下」。
 */
export function syncGuestAgents(
  previous: readonly GuestAgent[],
  guests: readonly CafeGuest[],
  blocked = currentBlocked(),
): GuestAgent[] {
  // 席位與點餐位都必須是**當下真的走得到**的格(家具擋住/掃地機停在那裡都算)。
  const seats = cafeSeatSpots().filter((spot) => blocked[spot.stand.r]?.[spot.stand.c] === false);
  const counters = cafeCounterSpots().filter((tile) => blocked[tile.r]?.[tile.c] === false);
  const byId = new Map(previous.map((agent) => [agent.guest.id, agent]));
  const claimedSeats = new Set<string>();
  return [...guests]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((source, index) => {
      const seatSpot = seatSpotFor(source, seats);
      if (seatSpot) claimedSeats.add(tileKey(seatSpot.seat));
      const kept = byId.get(source.id);
      if (kept) {
        kept.guest = { ...source, seatTile: source.seatTile ? { ...source.seatTile } : null };
        kept.seatSpot = seatSpot;
        return kept;
      }
      const entryTile = { ...CAFE_GUEST_ENTRY_TILES[index % CAFE_GUEST_ENTRY_TILES.length] };
      const counter = counters[index % Math.max(1, counters.length)] ?? entryTile;
      return {
        guest: { ...source, seatTile: source.seatTile ? { ...source.seatTile } : null },
        c: entryTile.c,
        r: entryTile.r,
        px: entryTile.c * TILE,
        py: entryTile.r * TILE,
        path: [],
        goal: null,
        moving: false,
        hidden: false,
        walkPhase: 0,
        phase: "entering" as const,
        phaseT: 0,
        view: "back" as const,
        entryTile,
        counterTile: { c: counter.c, r: counter.r },
        queueTile: null,
        queueT: 0,
        seatSpot,
        stuckT: 0,
      } satisfies GuestAgent;
    });
}

/** 依 id 固定排序後分配入口、點餐位與席位;不修改傳入的 CafeGuest。 */
export function createGuestAgents(guests: readonly CafeGuest[], blocked = currentBlocked()): GuestAgent[] {
  return syncGuestAgents([], guests, blocked);
}

/** state.cafe.guests 改變時供畫面層判斷是否需要同步 agents。 */
export function guestAgentSignature(guests: readonly CafeGuest[]): string {
  return [...guests]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((guest) => `${guest.id}:${guest.leavesMs}:${guest.seatTile?.c ?? "x"},${guest.seatTile?.r ?? "x"}:${guest.order?.itemId ?? "-"}`)
    .join("|");
}

function viewToward(agent: GuestAgent, next: Tile): CharView {
  const dc = next.c - agent.c;
  const dr = next.r - agent.r;
  if (dc !== 0) return dc > 0 ? "side_r" : "side_l";
  if (dr !== 0) return dr > 0 ? "front" : "back";
  return agent.view;
}

/** 面向某一格(可以隔好幾格);主軸取位移較大的那一軸。排隊時面向吧台用。 */
function faceToward(agent: GuestAgent, tile: Tile): CharView {
  const dc = tile.c - agent.c;
  const dr = tile.r - agent.r;
  if (Math.abs(dr) >= Math.abs(dc)) {
    if (dr !== 0) return dr > 0 ? "front" : "back";
    return agent.view;
  }
  return dc > 0 ? "side_r" : "side_l";
}

function reached(agent: GuestAgent, target: Tile) {
  return agent.c === target.c && agent.r === target.r && agent.path.length === 0 && !agent.moving;
}

function enterPhase(agent: GuestAgent, phase: GuestAgentPhase) {
  agent.phase = phase;
  agent.phaseT = 0;
  agent.goal = null;
  agent.path = [];
  agent.moving = false;
  agent.stuckT = 0;
}

/**
 * 🔴 P4b:把「還沒點到餐的人」分成**正在被結帳的**與**在排隊的**兩批(設計文件 §4.9)。
 *
 * 這是整個員工系統的視覺理由:同時能結帳的人數 = `min(員工數, 點餐位數)`,
 * 多出來的人只能站進 `cafeQueueTiles()` 的人龍裡。客流長大而人沒補 ⇒ 隊伍變長,
 * 玩家不必讀任何數字就知道該雇人;淡季隊伍消失、員工發呆 ⇒ 該資遣。
 *
 * **不新增任何模擬**:錢在 `tick.ts` 的 `cafeHourlyPass()` 早就收完了,
 * 這裡只決定「誰站哪一格、誰先演點餐」。排太久也不會有額外懲罰。
 *
 * 排序用 `arrivedMs` → `id`:先到先服務,而且是決定性的(零 RNG)。
 */
function assignCounterStations(agents: GuestAgent[], serviceSlots: number, blocked: boolean[][]) {
  const pending = agents
    .filter((agent) => !agent.hidden && (agent.phase === "entering" || agent.phase === "ordering"))
    .sort((a, b) => a.guest.arrivedMs - b.guest.arrivedMs || a.guest.id.localeCompare(b.guest.id));
  if (pending.length === 0) return;
  const counters = cafeCounterSpots().filter((tile) => blocked[tile.r]?.[tile.c] === false);
  if (counters.length === 0) return;
  const slots = Math.max(1, Math.min(counters.length, Math.trunc(serviceSlots)));
  // 已經站在吧台前演出的人先保住位子(玩家中途資遣也不會把他瞬移走)
  const serving = pending.filter((agent) => agent.phase === "ordering");
  const waiting = pending.filter((agent) => agent.phase !== "ordering");
  const taken = new Set(serving.map((agent) => tileKey(agent.counterTile)));
  const free = counters.filter((tile) => !taken.has(tileKey(tile)));
  let openSlots = Math.max(0, slots - serving.length);
  // 🔴 A 批:排到放棄的人一定要有一格人龍可站(他永遠不會遞補點餐位),
  // 否則只剩他一個人在等時 queueNeeded 會算成 0,他反而被送去吧台點餐。
  const abandoning = waiting.filter(guestAbandons).length;
  const queueNeeded = abandoning + Math.max(0, waiting.length - abandoning - openSlots);
  // 已經坐下/演出中的人站著不動,他那一格不能排進隊伍,否則後面的人會頂著他原地抖。
  const parked = new Set(
    agents.filter((agent) => !agent.hidden && !waiting.includes(agent) && !agent.moving).map(tileKey),
  );
  const queue = queueNeeded > 0 ? cafeQueueTiles(queueNeeded + parked.size).filter((tile) => !parked.has(tileKey(tile))) : [];
  let nextFree = 0;
  let nextQueue = 0;
  for (const agent of waiting) {
    // 🔴 A 批的唯一出口:模擬層已經判定他排不到(`order.abandoned`),所以他永遠
    // 拿不到點餐位、只會被排進人龍。先到先服務的配對本身**一行未改**。
    if (openSlots > 0 && nextFree < free.length && !guestAbandons(agent)) {
      agent.counterTile = { ...free[nextFree++] };
      agent.queueTile = null;
      openSlots--;
      continue;
    }
    const spot = queue[nextQueue++];
    agent.queueTile = spot ? { c: spot.c, r: spot.r } : null;
    // 隊伍格全被家具塞滿時退化成舊行為(直接擠去點餐位),不會有人卡在畫面外。
  }
}

/** 目前階段的走位目標;`null` = 站著不動(演出中)。 */
function targetFor(agent: GuestAgent): Tile | null {
  if (agent.phase === "entering") return agent.queueTile ?? agent.counterTile;
  if (agent.phase === "seated") return agent.seatSpot?.stand ?? null;
  if (agent.phase === "leaving") return agent.entryTile;
  return null;
}

/** 顧客實際被畫出來的位置(坐在椅子上時是椅子格,其餘是他站的格)。 */
export function guestDrawX(agent: GuestAgent): number {
  return guestSeated(agent) ? agent.seatSpot!.seat.c * TILE : agent.px;
}

export function guestDrawY(agent: GuestAgent): number {
  return guestSeated(agent) ? agent.seatSpot!.seat.r * TILE : agent.py;
}

/** true = 真的坐在椅子上(走到了席位、而且沒在移動)。 */
export function guestSeated(agent: GuestAgent): boolean {
  const spot = agent.seatSpot;
  if (!spot || agent.phase !== "seated" || agent.moving) return false;
  return agent.c === spot.stand.c && agent.r === spot.stand.r;
}

/**
 * 推進顧客走位與點餐演出。
 *
 * `leavesMs` 永遠是離場的權威:時間到就切 `leaving`,不論演出走到哪一格
 * ——資料層的保險絲(`cafeGuestPass`)才不會清掉還站在畫面上的人。
 */
export function tickGuestAgents(
  agents: GuestAgent[],
  dt: number,
  gameMs: number,
  blockedCells: ReadonlySet<string> = EMPTY_BLOCKED,
  blocked = currentBlocked(),
  /**
   * 🔴 P4b:同時能結帳的人數(= `cafeStaffCount()`)。省略 = 只受點餐位數限制,
   * 也就是 P4b 之前的行為 —— 舊呼叫端與既有測試一位元不變。
   */
  serviceSlots: number = Number.POSITIVE_INFINITY,
) {
  assignCounterStations(agents, serviceSlots, blocked);
  const occupied = new Map<string, GuestAgent>();
  const reservedSteps = new Set<string>();
  for (const agent of agents) if (!agent.hidden) occupied.set(tileKey(agent), agent);

  for (const agent of [...agents].sort((a, b) => a.guest.id.localeCompare(b.guest.id))) {
    if (agent.phase === "departed" || agent.hidden) continue;
    agent.phaseT += Math.max(0, dt);

    // 1) 時間到 → 一律離場(座位上的人起身、演到一半的人也走)
    if (gameMs >= agent.guest.leavesMs && agent.phase !== "leaving") enterPhase(agent, "leaving");

    // 2) 階段轉移
    switch (agent.phase) {
      case "entering": {
        const givesUp = guestAbandons(agent);
        // 排隊中:計時歸零(等待不算「走不到目的地」),輪到他才重新起算逾時。
        if (agent.queueTile) {
          agent.phaseT = 0;
          if (givesUp) {
            agent.queueT += Math.max(0, dt);
            // 🔴 A 批的出口:排滿門檻就轉身走人。走位沿用既有的 `leaving`,
            // 他會照樣走回 `entryTile`(店門)才 `departed` ⇒ 不會原地消失。
            if (agent.queueT >= GUEST_ABANDON_SECONDS) enterPhase(agent, "leaving");
          }
          break;
        }
        agent.queueT = 0;
        if (givesUp) {
          // 人龍格全被家具/其他顧客塞住的退化情況:站在原地等滿同一個門檻再走,
          // 一樣不會走到收銀機前點餐(帳本上他本來就沒有這筆)。
          if (agent.phaseT >= GUEST_ABANDON_SECONDS) enterPhase(agent, "leaving");
          break;
        }
        if (reached(agent, agent.counterTile) || agent.phaseT >= GUEST_WALK_TIMEOUT_SECONDS) {
          enterPhase(agent, "ordering");
          agent.view = "back"; // 面向吧台
        }
        break;
      }
      case "ordering":
        if (agent.phaseT >= GUEST_ORDER_SECONDS) {
          // 訂單缺料 ⇒ 紅色 ❌;沒有訂單資料(舊存檔)一律當作服務成功。
          enterPhase(agent, agent.guest.order && !agent.guest.order.served ? "refused" : "served");
        }
        break;
      case "served":
        if (agent.phaseT >= GUEST_SERVED_SECONDS) enterPhase(agent, agent.seatSpot ? "seated" : "leaving");
        break;
      case "refused":
        if (agent.phaseT >= GUEST_REFUSED_SECONDS) enterPhase(agent, "leaving");
        break;
      default:
        break;
    }

    if (isPerforming(agent.phase)) continue; // 站著演出,不走路

    const target = targetFor(agent);
    if (!target) {
      // 座位被拆了之類的意外:原地待著,時間到再走(不穿牆、不瞬移)
      agent.moving = false;
      continue;
    }
    if (reached(agent, target)) {
      if (agent.phase === "leaving") {
        agent.phase = "departed";
        agent.hidden = true;
        occupied.delete(tileKey(agent));
      } else if (agent.phase === "seated") {
        agent.view = "front";
      } else if (agent.phase === "entering" && agent.queueTile) {
        agent.view = faceToward(agent, agent.counterTile); // 站在隊伍裡,面向吧台
      }
      continue;
    }

    if (!sameTile(agent.goal, target)) {
      agent.goal = { ...target };
      // 卡太久 ⇒ 這次改用「把站著不動的人也當障礙」的地圖重算,真的繞過去。
      const grid = agent.stuckT > 0 ? detourGrid(blocked, agents, agent, target) : blocked;
      const path = grid[target.r]?.[target.c] === false
        ? findPath({ c: agent.c, r: agent.r }, target, grid)
        : null;
      agent.path = path && path.length > 1 ? path.slice(1) : [];
      agent.moving = agent.path.length > 0;
      agent.stuckT = 0;
      if (!agent.moving) agent.goal = null;
    }

    const next = agent.path[0];
    if (!agent.moving || !next) continue;
    const nextKey = tileKey(next);
    const occupant = occupied.get(nextKey);
    if ((occupant && occupant !== agent) || reservedSteps.has(nextKey) || blockedCells.has(nextKey)) {
      agent.stuckT += Math.max(0, dt);
      if (agent.stuckT >= REPATH_AFTER_BLOCKED_SECONDS) {
        agent.goal = null; // 下一幀重算(帶繞路),不要抱著走不通的舊路徑等下去
        agent.path = [];
        agent.moving = false;
      }
      continue;
    }
    agent.stuckT = 0;
    reservedSteps.add(nextKey);
    agent.view = viewToward(agent, next);
    const nx = next.c * TILE;
    const ny = next.r * TILE;
    const dx = nx - agent.px;
    const dy = ny - agent.py;
    const distance = Math.hypot(dx, dy);
    const step = SPEED * Math.max(0, dt);
    if (distance <= step) {
      if (occupied.get(tileKey(agent)) === agent) occupied.delete(tileKey(agent));
      agent.c = next.c;
      agent.r = next.r;
      agent.px = nx;
      agent.py = ny;
      agent.path.shift();
      occupied.set(nextKey, agent);
      agent.moving = agent.path.length > 0;
      if (!agent.moving) {
        if (agent.phase === "leaving") {
          agent.phase = "departed";
          agent.hidden = true;
          occupied.delete(nextKey);
        } else if (agent.phase === "entering") {
          // 排到放棄的人不論站到哪一格都不會點餐;下一幀由階段轉移計時把他送出門。
          if (agent.queueTile || guestAbandons(agent)) agent.view = faceToward(agent, agent.counterTile);
          else { enterPhase(agent, "ordering"); agent.view = "back"; }
        } else if (agent.phase === "seated") {
          agent.view = "front";
        }
      }
    } else if (distance > 0) {
      agent.px += (dx / distance) * step;
      agent.py += (dy / distance) * step;
    }
    agent.walkPhase += dt * 7;
  }
}

/** 把「站著不動的其他顧客」也標成障礙的暫時地圖(目標格本身永遠保持可走)。 */
function detourGrid(
  blocked: boolean[][],
  agents: readonly GuestAgent[],
  self: GuestAgent,
  target: Tile,
): boolean[][] {
  const grid = blocked.map((row) => [...row]);
  for (const other of agents) {
    if (other === self || other.hidden || other.phase === "departed" || other.moving) continue;
    if (other.c === target.c && other.r === target.r) continue;
    if (grid[other.r]) grid[other.r][other.c] = true;
  }
  return grid;
}

/**
 * 🔴 P4b:正站在吧台前結帳的顧客(給 `staffAgents` 配對用的**唯讀**視圖)。
 *
 * 員工層拿到的只有「誰在哪一格」,拿不到 `GuestAgent` 本體 ⇒ 不可能反向改到顧客走位。
 * 序固定(到店時間 → id),所以同一批輸入永遠配到同一位員工。
 */
export function orderingGuestViews(agents: readonly GuestAgent[]): { id: string; c: number; r: number }[] {
  return agents
    .filter((agent) => !agent.hidden && agent.phase === "ordering")
    .sort((a, b) => a.guest.arrivedMs - b.guest.arrivedMs || a.guest.id.localeCompare(b.guest.id))
    .map((agent) => ({ id: agent.guest.id, c: agent.c, r: agent.r }));
}

/** 🔴 P4b:此刻真的在排隊等的人數(> 0 ⇒ 員工進入「忙碌」表現)。 */
export function queuedGuestCount(agents: readonly GuestAgent[]): number {
  return agents.filter((agent) => !agent.hidden && agent.phase === "entering" && agent.queueTile !== null).length;
}

export function departedGuestIds(agents: readonly GuestAgent[]): string[] {
  return agents.filter((agent) => agent.phase === "departed").map((agent) => agent.guest.id).sort();
}
