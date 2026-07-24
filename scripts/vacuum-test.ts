/**
 * 掃地機器人「遊走渲染層」測試(headless,不畫布)。
 * 只驗證「純外觀」邏輯:
 *   1) 每小時區域輪替是確定性的(同輸入同輸出、逐時輪替、週期回繞),無 Math.random。
 *   2) 區域內挑格是確定性的、落在該區、可走、且會避開被擋(含租客佔用)的格。
 *   3) 掃地機下一步踩到租客 → 會讓(vacuumWillYield)。
 *   4) 整合:實際模擬多幀(含跨遊戲小時換區域),掃地機確實會位移、會換區域,
 *      且「任一幀都不會與任何在場租客同格」(避讓機制端到端成立)。
 *
 * 注意:本測試會在 in-memory 的 placements 上加一台 robot_vacuum,只影響本行程;
 * 不碰 INITIAL_PLACEMENTS、不跑 sim tick、不動 balance-snapshot。
 */
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v; },
  removeItem: (k: string) => { delete mem[k]; },
};

const { buildGrid } = await import("../src/floor/map");
const { createAgents, tickAgents } = await import("../src/floor/agents");
const { addPlacement } = await import("../src/sim/placements");
const { MS_PER_GAME_HOUR } = await import("../src/sim/clock");
const { state } = await import("../src/store");
const {
  VACUUM_AREAS,
  gameHourIndex,
  vacuumTargetArea,
  pickAreaCell,
  vacuumWillYield,
  createVacuumAgents,
  tickVacuumAgents,
  vacuumCellKeys,
} = await import("../src/floor/vacuumAgents");

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

// --- 1) 區域輪替:確定性 + 逐時輪替 + 週期回繞 ---
check("vacuumTargetArea 同輸入同輸出", vacuumTargetArea(123) === vacuumTargetArea(123));
{
  const n = VACUUM_AREAS.length;
  const seen = new Set<string>();
  for (let h = 0; h < n; h++) seen.add(vacuumTargetArea(h));
  check("連續一輪涵蓋所有區域(逐時輪替)", seen.size === n);
  check("週期回繞:area(h+len) === area(h)", vacuumTargetArea(5 + n) === vacuumTargetArea(5) && vacuumTargetArea(5) !== vacuumTargetArea(6));
  check("負序號也不炸(取正餘數)", VACUUM_AREAS.includes(vacuumTargetArea(-3)));
}

// --- 2) gameHourIndex ---
check("gameHourIndex = floor(gameMs / 每小時)", gameHourIndex(3 * MS_PER_GAME_HOUR + 5) === 3 && gameHourIndex(0) === 0);

// --- 3) pickAreaCell:確定性、落在該區、可走、避開被擋格 ---
{
  const grid = buildGrid();
  const blocked = grid.map((row) => row.map(() => false)); // 全可走,聚焦區域/確定性判定
  const a = pickAreaCell("r301", 7, blocked);
  const b = pickAreaCell("r301", 7, blocked);
  check("pickAreaCell 同 seed 同格(確定性)", !!a && !!b && a.c === b.c && a.r === b.r);
  check("pickAreaCell 回傳格落在該區域", !!a && grid[a.r][a.c] === "r301");

  // 把某個候選格標記為「被租客佔用」→ 換個 seed 挑出的格不該是那一格
  const target = pickAreaCell("r301", 0, blocked)!;
  blocked[target.r][target.c] = true; // 模擬租客/家具擋住
  let landedOnBlocked = false;
  for (let seed = 0; seed < 50; seed++) {
    const t = pickAreaCell("r301", seed, blocked);
    if (t && t.c === target.c && t.r === target.r) landedOnBlocked = true;
  }
  check("pickAreaCell 不會挑到被擋(租客佔用)的格", !landedOnBlocked);
  check("pickAreaCell 仍能在其餘可走格中挑到有效格", !!pickAreaCell("r301", 3, blocked));
}

// --- 4) vacuumWillYield ---
{
  const tenants = new Set<string>(["7,10"]);
  check("下一步是租客所在格 → 讓", vacuumWillYield({ c: 7, r: 10 }, tenants) === true);
  check("下一步無人 → 不讓", vacuumWillYield({ c: 8, r: 10 }, tenants) === false);
}

// --- 5) 整合:實際多幀模擬,位移 + 換區域 + 全程不與租客同格 ---
{
  // 放一台掃地機在空房 r303(不與既有租客起始位置重疊)
  addPlacement({ defId: "robot_vacuum", room: "r303", c: 3, r: 18, rotation: 0 });
  const vac = createVacuumAgents();
  check("偵測到 robot_vacuum 並生成 1 台遊走 agent", vac.length === 1);

  const agents = createAgents();
  const distinctCells = new Set<string>();
  const areasSeen = new Set<string>();
  let collisions = 0;

  const FRAMES = 1500;
  const DT = 0.1;
  for (let i = 0; i < FRAMES; i++) {
    // 每 100 幀推進一個遊戲小時 → 觸發掃地機換區域(涵蓋多個區域)
    if (i > 0 && i % 100 === 0) state.gameMs += MS_PER_GAME_HOUR;

    const blockedKeys = vacuumCellKeys(vac);
    tickAgents(agents, DT, blockedKeys);
    tickVacuumAgents(vac, DT, agents);

    for (const v of vac) {
      distinctCells.add(`${v.c},${v.r}`);
      areasSeen.add(vacuumTargetArea(v.lastHourIdx));
      // 不變式:掃地機當前格不得與任何在場(未外出)租客同格
      for (const ag of agents) {
        if (!ag.hidden && ag.c === v.c && ag.r === v.r) collisions++;
      }
    }
  }

  check("掃地機確實會位移(造訪 >3 個不同格)", distinctCells.size > 3, `distinctCells=${distinctCells.size}`);
  check("掃地機確實會換區域(涵蓋 >=3 個區域)", areasSeen.size >= 3, `areasSeen=${areasSeen.size}`);
  check("全程 0 次與租客同格(避讓端到端成立)", collisions === 0, `collisions=${collisions}`);

  // 反向驗證:硬把租客塞到掃地機的下一步,掃地機必須「停」而非踩上去
  const v0 = vac[0];
  v0.moving = true;
  const nextStep = { c: v0.c + 1, r: v0.r };
  v0.path = [nextStep];
  v0.wanderAt = Number.MAX_SAFE_INTEGER; // 別讓閒置邏輯改路徑
  const before = `${v0.c},${v0.r}`;
  tickVacuumAgents(vac, 1.0, [{ c: nextStep.c, r: nextStep.r }]); // 租客正站在下一格
  check("下一格有租客時掃地機原地不動(不疊格)", `${v0.c},${v0.r}` === before);
  // 租客離開後,同一步就能走過去
  tickVacuumAgents(vac, 1.0, []);
  check("租客離開後掃地機續走", `${v0.c},${v0.r}` !== before);
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
