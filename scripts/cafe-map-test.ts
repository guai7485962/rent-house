/** CAFE-03 地圖擴充：舊三樓零漂移、咖啡廳 Region 與跨樓層尋路。 */
import { createHash } from "node:crypto";

const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (key: string) => mem[key] ?? null,
  setItem: (key: string, value: string) => { mem[key] = value; },
  removeItem: (key: string) => { delete mem[key]; },
};

const { GRID_H, GRID_W, TILE, CAFE_RECTS, INITIAL_PLACEMENTS, buildGrid, isWalkable } = await import("../src/floor/map");
const { FLOOR_H } = await import("../src/floor/floorScene");
const { buildBlocked, findPath } = await import("../src/floor/pathfind");
const { canPlaceFree, placements } = await import("../src/sim/placements");
const { resolveTarget } = await import("../src/sim/routine");
const { COMMUNAL_AREA_IDS, COMMUNAL_NEUTRAL } = await import("../src/sim/comfort");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` (${detail})` : ""}`); }
};
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const grid = buildGrid();
check("GRID_H 擴充為 52", GRID_H === 52);
check("網格為 52×16", grid.length === 52 && grid.every((row) => row.length === GRID_W));
check("floorScene 模組載入時取得完整新高度", FLOOR_H === GRID_H * TILE && FLOOR_H === 832);
check(
  "rows 0–32 逐格零漂移",
  sha256(grid.slice(0, 33)) === "49d377afd1be8169d9864c7ab4bee8a44266951e93c16d6f131414d82301c6e7",
);
check(
  "INITIAL_PLACEMENTS 完整零漂移",
  INITIAL_PLACEMENTS.length === 35 && sha256(INITIAL_PLACEMENTS) === "34073680172e1dd99775acfd2449edb4a4c4f552d22b85a86df9575bdecad22b",
);

check("六個咖啡廳矩形存在", Object.keys(CAFE_RECTS).length === 6);
check("3F 入口覆蓋 stairs 的 row 32，維持舊格", grid[32][7] === "entrance" && grid[32][8] === "entrance");
check("樓梯連接 rows 33–35", [33, 34, 35].every((r) => grid[r][7] === "stairs" && grid[r][8] === "stairs"));
check("咖啡廳主廳範圍成立", grid[36][1] === "cafe_floor" && grid[47][14] === "cafe_floor");
check("吧台覆蓋主廳", grid[38][2] === "cafe_counter" && grid[40][6] === "cafe_counter");
check("寵物區覆蓋主廳", grid[41][9] === "cafe_pet" && grid[46][14] === "cafe_pet");
check("後場範圍成立", grid[48][1] === "cafe_back" && grid[50][14] === "cafe_back");
check("一樓門口成立", grid[51][7] === "cafe_entrance" && grid[51][8] === "cafe_entrance");

const blocked = buildBlocked();
const cafeDoor = { c: 7, r: 51 };
check("家具障礙網格在模組載入時擴至 52 rows", blocked.length === GRID_H && blocked.every((row) => row.length === GRID_W));
const topologyBlocked = grid.map((row) => row.map((cell) => !isWalkable(cell)));
const walkable3f = [] as Array<{ c: number; r: number }>;
for (let r = 0; r <= 32; r++) {
  for (let c = 0; c < GRID_W; c++) {
    if (isWalkable(grid[r][c])) walkable3f.push({ c, r });
  }
}
const unreachable = walkable3f.filter((start) => findPath(start, cafeDoor, topologyBlocked) === null);
check("3F 每個地圖可走格在拓樸上都能到 1F 門口", unreachable.length === 0, `不可達 ${unreachable.length}/${walkable3f.length}`);
check("現有家具障礙下 3F 入口仍能走到 1F 門口", findPath({ c: 7, r: 32 }, cafeDoor, blocked) !== null);

check("咖啡廳四個室內區允許裝飾擺放",
  canPlaceFree(1, 36, 1, 1) === "cafe_floor"
  && canPlaceFree(2, 38, 1, 1) === "cafe_counter"
  && canPlaceFree(9, 41, 1, 1) === "cafe_pet"
  && canPlaceFree(1, 48, 1, 1) === "cafe_back");
check("樓梯與門口禁止家具堵路", canPlaceFree(7, 33, 1, 1) === null && canPlaceFree(7, 51, 1, 1) === null);

const savedPlacements = placements.list.map((placement) => ({ ...placement }));
placements.list.splice(0, placements.list.length, { defId: "shared_sofa", room: "cafe_floor", c: 3, r: 42 });
check("routine 可解析咖啡廳室內家具", resolveTarget("sofa", null)?.placement.room === "cafe_floor");
placements.list.splice(0, placements.list.length, ...savedPlacements);

check("舒適度區域仍只有住宅三區",
  JSON.stringify(COMMUNAL_AREA_IDS) === JSON.stringify(["lounge", "bathroom", "laundry"]));
check("公共舒適中性錨點未變", COMMUNAL_NEUTRAL === 35.28233009708738);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
