/** CAFE-22：永久樓寵物白天下樓與咖啡廳認養可達性。 */
import type { Pet } from "../src/types";

const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

const { state } = await import("../src/store");
const { buildGrid } = await import("../src/floor/map");
const {
  CAFE_PET_VISIT_END_HOUR,
  CAFE_PET_VISIT_PERCENT,
  CAFE_PET_VISIT_START_HOUR,
  createPetAgents,
  petAgentRegion,
  tickPetAgents,
} = await import("../src/floor/petAgents");
const { generateCafeGuest } = await import("../src/sim/cafeGuests");
const { acceptCafeGuestAdoption, HOUSE_PET_OWNER } = await import("../src/sim/pets");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

const grid = buildGrid();
const permanentPet = (name: string): Pet => ({
  name,
  kind: "cat",
  color: 1,
  ownerId: HOUSE_PET_OWNER,
  hangout: "lounge",
  sinceMs: state.gameMs - 12 * 24 * 3600 * 1000,
  housePlacement: "permanent",
});
const atLocalHour = (day: number, hour: number) => new Date(2026, 7, day, hour, 0, 0, 0).getTime();
const firstCafeHour = (petId: string, pet: Pet) => {
  for (let day = 1; day <= 14; day++) {
    for (let hour = CAFE_PET_VISIT_START_HOUR; hour < CAFE_PET_VISIT_END_HOUR; hour++) {
      const gameMs = atLocalHour(day, hour);
      if (petAgentRegion(petId, pet, gameMs, true) === "cafe_pet") return gameMs;
    }
  }
  return null;
};

const petId = "cafe22_house_pet";
const tenantId = "cafe22_tenant_pet";
const fosterId = "cafe22_foster_pet";
const pet = permanentPet("小栗");
const cafeHour = firstCafeHour(petId, pet);
check("下樓規則使用 10–16 點白天、35% 穩定時段", CAFE_PET_VISIT_START_HOUR === 10 && CAFE_PET_VISIT_END_HOUR === 16 && CAFE_PET_VISIT_PERCENT === 35);
check("永久樓寵物在兩週樣本內有可預期的 cafe_pet 時段", cafeHour !== null);
if (cafeHour == null) throw new Error("fixture 找不到咖啡廳時段");

let randomCalls = 0;
const originalRandom = Math.random;
Math.random = () => { randomCalls++; return 0; };
const regionA = petAgentRegion(petId, pet, cafeHour, true);
const regionB = petAgentRegion(petId, pet, cafeHour, true);
check("同寵物同小時結果決定性且零 RNG", regionA === "cafe_pet" && regionB === regionA && randomCalls === 0, `region=${regionA}, calls=${randomCalls}`);
check("咖啡廳未開張時不會下樓", petAgentRegion(petId, pet, cafeHour, false) === "lounge");
check("非白天時段不會下樓", petAgentRegion(petId, pet, atLocalHour(2, 3), true) === "lounge");

const tenantPet = { ...pet, ownerId: "tenant_visitor" };
const fosterPet = { ...pet, housePlacement: "foster" as const };
const partnerFosterPet = { ...pet, housePlacement: "partner_foster" as const };
check("房客寵物不會被咖啡廳規則改道", petAgentRegion(tenantId, tenantPet, cafeHour, true) === "lounge");
check("兩種媒合中樓寵物都不會被咖啡廳規則改道", petAgentRegion(fosterId, fosterPet, cafeHour, true) === "lounge"
  && petAgentRegion("cafe22_partner_foster", partnerFosterPet, cafeHour, true) === "lounge");
const pairedPet = { ...pet, pairWith: tenantId, pairAction: "greet" as const, pairUntilMs: cafeHour + 1000 };
check("配對演出中的永久樓寵物留在原 hangout", petAgentRegion(petId, pairedPet, cafeHour, true) === "lounge");

state.cafe.open = true;
state.gameMs = cafeHour;
state.pets[petId] = pet;
state.pets[tenantId] = tenantPet;
state.pets[fosterId] = fosterPet;
const agentsAtCafe = createPetAgents();
const cafeAgent = agentsAtCafe.find((agent) => agent.petId === petId);
const tenantAgent = agentsAtCafe.find((agent) => agent.petId === tenantId);
check("符合條件的永久樓寵物建立在 cafe_pet 可走格", !!cafeAgent && grid[cafeAgent.r]?.[cafeAgent.c] === "cafe_pet", cafeAgent ? `${cafeAgent.c},${cafeAgent.r}` : "missing");
check("同時存在的房客寵物仍建立在原 hangout", !!tenantAgent && grid[tenantAgent.r]?.[tenantAgent.c] === "lounge");

state.gameMs = atLocalHour(2, 3);
const walkingPetId = "cafe22_walking_pet";
state.pets[walkingPetId] = permanentPet("小步");
const walkingAgent = createPetAgents().find((agent) => agent.petId === walkingPetId)!;
const walkingCafeHour = firstCafeHour(walkingPetId, state.pets[walkingPetId]);
if (walkingCafeHour == null) throw new Error("walking fixture 找不到咖啡廳時段");
state.gameMs = walkingCafeHour;
walkingAgent.restUntil = 0;
walkingAgent.moving = false;
walkingAgent.path = [];
tickPetAgents([walkingAgent], 0);
const walkingGoal = walkingAgent.path.at(-1);
check("樓寵物會沿跨樓層路徑走向 cafe_pet 而非改寫 hangout", walkingAgent.moving && !!walkingGoal && grid[walkingGoal.r]?.[walkingGoal.c] === "cafe_pet" && state.pets[walkingPetId].hangout === "lounge");

const guest = generateCafeGuest({ seed: "cafe22-adoption", arrivedMs: state.gameMs, intent: "adopt" });
const homesBefore = state.petHomes.length;
const adopted = acceptCafeGuestAdoption(guest, petId);
check("畫面可達的 cafe_pet 樓寵物可完成咖啡廳認養", adopted.ok && !state.pets[petId] && state.petHomes.length === homesBefore + 1 && state.petHomes[0]?.id === `cafe:${guest.id}`);

Math.random = originalRandom;
console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
