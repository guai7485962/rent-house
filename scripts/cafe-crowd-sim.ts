/**
 * 咖啡廳「整批顧客同時進場」的走位健全性 harness(共用模組,不是測試檔)。
 *
 * 存在的理由:2026-08-26 修掉的顧客互卡(gridlock)之所以活到玩家回報,是因為
 * **沒有任何自動檢查跑過咖啡廳顧客的走位**——`scripts/sim-trace.ts` 只跑租客層,
 * `scripts/cafe-guest-agent-test.ts` 只跑 6 位而且 `serviceSlots = Infinity`(不排隊),
 * 恰好在觸發門檻(同時 5 位以上內用客)以下。
 *
 * 這裡重現真實的進場方式:`tick.ts` 的 `cafeHourlyPass()` 把同一小時的顧客
 * **共用同一個 `state.gameMs`** 逐筆生出來 ⇒ 他們是同一瞬間一起站到門口的。
 *
 * 被 `sim-trace.ts`(CI 健全性檢查)與 `cafe-guest-agent-test.ts`(回歸測試)共用。
 */
import { generateCafeGuest } from "../src/sim/cafeGuests";
import {
  createGuestAgents,
  guestSeated,
  tickGuestAgents,
  type GuestAgent,
} from "../src/floor/guestAgents";
import { cafeSeatSpots } from "../src/sim/placements";
import { currentBlocked } from "../src/floor/pathfind";

export interface CafeCrowdCase {
  /** 內用客人數(有 `seatTile` ⇒ 點完餐要走去坐下)。 */
  dineIn: number;
  /** 外帶客人數(沒有席位 ⇒ 點完就走回店門)。 */
  takeaway: number;
  /** 同時能結帳的人數(= 員工數;`Infinity` = 完全不排隊)。 */
  staff: number;
  /** 模擬幾現實秒(預設 400,遠長於任何正常動線)。 */
  seconds?: number;
}

export interface CafeCrowdResult {
  label: string;
  agents: GuestAgent[];
  /** 跑完還沒抵達目標的人(內用沒坐下 / 外帶沒走出去)——**必須是 0**。 */
  stuck: GuestAgent[];
  /** 走到第 2 層兜底才脫困的人(站著用餐或原地淡出)——不是錯,但值得看見。 */
  degraded: GuestAgent[];
  /** 全部抵達目標的時間(現實秒);`-1` = 沒跑完。 */
  settledAt: number;
  /** 全體實際踩過的格數(換格次數)——繞路失控或路徑被塞住時會膨脹。 */
  steps: number;
}

/** 這位顧客算不算「已經抵達他該去的地方」。 */
export function cafeGuestArrived(agent: GuestAgent): boolean {
  if (agent.phase === "departed") return true; // 外帶/離場客走回店門才會 departed
  return agent.seatSpot ? guestSeated(agent) : false;
}

/** 造一批「同一小時一起進場」的顧客(全部共用 arrivedMs,和 `cafeHourlyPass()` 一致)。 */
function crowdGuests(dineIn: number, takeaway: number, seed: string) {
  const seats = cafeSeatSpots();
  const order = (takeawayFlag: boolean) => ({
    itemId: "x", itemName: "招牌美式咖啡", price: 34, track: "coffee" as const,
    served: true, missing: "", takeaway: takeawayFlag,
  });
  const guests = [];
  for (let i = 0; i < dineIn; i++) {
    guests.push(generateCafeGuest({
      seed, arrivedMs: 0, sequence: i,
      seatTile: seats.length > 0 ? seats[i % seats.length].seat : null,
      order: order(false),
    }));
  }
  for (let i = 0; i < takeaway; i++) {
    guests.push(generateCafeGuest({
      seed, arrivedMs: 0, sequence: 100 + i, seatTile: null, takeaway: true, order: order(true),
    }));
  }
  return guests;
}

/**
 * 跑一個情境並回報誰沒到目標。
 *
 * `gameMs` 固定 0 ⇒ 沒有人會因為 `leavesMs` 到了被強制離場,
 * 卡住的人不會被時間掩蓋過去(這正是原本 bug 難以察覺的原因之一)。
 */
export function runCafeCrowd(input: CafeCrowdCase, seed = "cafe-crowd"): CafeCrowdResult {
  const { dineIn, takeaway, staff, seconds = 400 } = input;
  const agents = createGuestAgents(crowdGuests(dineIn, takeaway, seed));
  const blocked = currentBlocked();
  const dt = 0.05;
  const steps = Math.round(seconds / dt);
  let settledAt = -1;
  let walked = 0;
  const at = new Map(agents.map((agent) => [agent.guest.id, `${agent.c},${agent.r}`]));
  for (let i = 0; i < steps; i++) {
    tickGuestAgents(agents, dt, 0, undefined, blocked, staff);
    for (const agent of agents) {
      const key = `${agent.c},${agent.r}`;
      if (at.get(agent.guest.id) === key) continue;
      at.set(agent.guest.id, key);
      walked++;
    }
    if (settledAt < 0 && agents.every(cafeGuestArrived)) settledAt = Number(((i + 1) * dt).toFixed(2));
  }
  return {
    label: `內用${dineIn}+外帶${takeaway}/店員${staff}`,
    agents,
    stuck: agents.filter((agent) => !cafeGuestArrived(agent)),
    degraded: agents.filter((agent) => agent.standingMeal || agent.fadeT > 0),
    settledAt,
    steps: walked,
  };
}

/**
 * 一定要跑到的情境組(觸發門檻以上)。
 *
 * 門檻是實測出來的:**同時 5 位以上內用客**開始出現永久卡死,而且**與店員數無關**
 * (`staff=Infinity` 完全不排隊也照卡)——排隊只是加重因子。所以這裡刻意涵蓋
 * 「人手不足排長隊」與「完全不排隊」兩端。
 */
export const CAFE_CROWD_CASES: readonly CafeCrowdCase[] = [
  { dineIn: 8, takeaway: 3, staff: 5 },                       // 情境 B:使用者回報的規模
  { dineIn: 9, takeaway: 4, staff: 1 },                       // 一個人顧店 ⇒ 人龍最長
  { dineIn: 9, takeaway: 2, staff: 5 },                       // 席位吃緊 + 中等人手
  { dineIn: 7, takeaway: 4, staff: Number.POSITIVE_INFINITY }, // 完全不排隊也照樣要通得過
];

/** 一句話的檢查結果(給 sim-trace 印出來)。 */
export function describeCafeCrowd(result: CafeCrowdResult): string {
  const stuck = result.stuck.length > 0
    ? `✗ ${result.stuck.length} 人未達目標(${result.stuck.map((a) => `${a.phase}@${a.c},${a.r}`).join(" ")})`
    : `✓ 全員抵達(${result.settledAt}s)`;
  const degraded = result.degraded.length > 0 ? `,${result.degraded.length} 人走兜底` : "";
  return `${result.label}  ${stuck}${degraded}`;
}
