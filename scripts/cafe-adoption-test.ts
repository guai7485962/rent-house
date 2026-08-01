/** CAFE-09：認養意圖立即接入既有幸福新家流程。 */
import type { Pet } from "../src/types";

const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

const { state } = await import("../src/sim/gameState");
const { SAVE_KEY } = await import("../src/sim/persistence");
const { generateCafeGuest } = await import("../src/sim/cafeGuests");
const {
  acceptCafeGuestAdoption,
  CAFE_GUEST_ADOPTION_DESTINATION,
  HOUSE_PET_OWNER,
} = await import("../src/sim/pets");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const originalRandom = Math.random;
let randomCalls = 0;
Math.random = () => { randomCalls++; return 0.25; };

try {
  const makePet = (name: string, ownerId = HOUSE_PET_OWNER, placement: Pet["housePlacement"] = "permanent"): Pet => ({
    name,
    kind: "cat",
    color: 2,
    ownerId,
    hangout: "lounge",
    sinceMs: state.gameMs - 12 * 24 * 3600 * 1000,
    housePlacement: placement,
  });
  const adoptGuest = generateCafeGuest({ seed: "cafe-adopter", arrivedMs: state.gameMs, intent: "adopt" });
  const coffeeGuest = generateCafeGuest({ seed: "coffee-only", arrivedMs: state.gameMs, intent: "coffee" });
  const guestBefore = JSON.stringify(adoptGuest);
  const runtimeIdsBefore = Object.keys(state.runtimes).sort().join("|");
  state.petHomes.splice(0);
  state.noticeLog.splice(0);

  state.pets.cafe_target = makePet("小雪");
  state.pets.cafe_friend = { ...makePet("虎斑"), pairWith: "cafe_target", pairAction: "greet", pairUntilMs: state.gameMs + 1000 };
  state.interactionCooldowns["cafe_target|cafe_friend|pair"] = state.gameMs;
  const homesBeforeReject = state.petHomes.length;
  check("非 adopt 顧客不能認養", !acceptCafeGuestAdoption(coffeeGuest, "cafe_target").ok && state.petHomes.length === homesBeforeReject && !!state.pets.cafe_target);
  check("空白顧客資料被拒絕", !acceptCafeGuestAdoption({ ...adoptGuest, id: "" }, "cafe_target").ok && !!state.pets.cafe_target);
  check("不存在的寵物被拒絕", !acceptCafeGuestAdoption(adoptGuest, "missing_pet").ok && state.petHomes.length === 0);

  state.pets.tenant_pet = makePet("房客貓", "tenant_someone");
  check("房客自己的寵物不能被咖啡廳送養", !acceptCafeGuestAdoption(adoptGuest, "tenant_pet").ok && !!state.pets.tenant_pet);
  state.pets.foster_pet = { ...makePet("媒合貓", HOUSE_PET_OWNER, "foster"), rehomingAtMs: state.gameMs + 1000, rehomingDestination: "adopter" };
  check("已在媒合中的樓寵物不能重複認養", !acceptCafeGuestAdoption(adoptGuest, "foster_pet").ok && !!state.pets.foster_pet);

  const noticesBefore = state.noticeLog.length;
  const accepted = acceptCafeGuestAdoption(adoptGuest, "cafe_target");
  const home = state.petHomes[0];
  check("接受後立即移除樓寵物並新增一筆幸福新家", accepted.ok && !state.pets.cafe_target && state.petHomes.length === 1);
  check("幸福新家 destination 精確標示咖啡廳客人領養", home?.destination === CAFE_GUEST_ADOPTION_DESTINATION && home.destination === "咖啡廳客人領養");
  check("咖啡廳幸福新家 id 對同一顧客穩定", home?.id === `cafe:${adoptGuest.id}`);
  check("幸福新家保留寵物快照與相遇文案", home?.name === "小雪" && home.kind === "cat" && home.color === 2 && home.leftMs === state.gameMs && home.note.includes(adoptGuest.name));
  check("沿用既有完成流程清掉其他寵物的 pair 與 cooldown", !state.pets.cafe_friend.pairWith && !state.pets.cafe_friend.pairAction && !state.pets.cafe_friend.pairUntilMs && !("cafe_target|cafe_friend|pair" in state.interactionCooldowns));
  check("接受認養只新增一次既有幸福新家通知", state.noticeLog.length === noticesBefore + 1 && state.noticeLog.at(-1)?.text.includes("找到幸福新家"));

  state.pets.second_target = makePet("小黑");
  const homesAfterAccept = state.petHomes.length;
  const noticesAfterAccept = state.noticeLog.length;
  check("同一顧客重複接受時冪等且不帶走第二隻", !acceptCafeGuestAdoption(adoptGuest, "second_target").ok && state.petHomes.length === homesAfterAccept && state.noticeLog.length === noticesAfterAccept && !!state.pets.second_target);
  check("同一寵物重複接受不新增名冊", !acceptCafeGuestAdoption(generateCafeGuest({ seed: "another-adopter", arrivedMs: state.gameMs, intent: "adopt" }), "cafe_target").ok && state.petHomes.length === homesAfterAccept);

  const saved = JSON.parse(mem[SAVE_KEY] ?? "{}");
  check("成功結果立即保存且保留咖啡廳去向", saved.petHomes?.[0]?.destination === CAFE_GUEST_ADOPTION_DESTINATION && saved.pets?.cafe_target == null);
  check("認養入口不修改 CafeGuest 輸入", JSON.stringify(adoptGuest) === guestBefore);
  check("認養入口不污染 state.runtimes", Object.keys(state.runtimes).sort().join("|") === runtimeIdsBefore);
  check("認養入口全程零 Math.random", randomCalls === 0, `calls=${randomCalls}`);
} finally {
  Math.random = originalRandom;
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
