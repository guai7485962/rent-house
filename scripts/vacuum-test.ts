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

const { buildGrid, isWalkable, TILE } = await import("../src/floor/map");
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
  vacuumBlocksTenant,
  pickYieldCell,
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

  // 「租客被掃地機卡住」的連續幀數上限:掃地機會主動讓開,不該長期停滯
  let stallStreak = 0;
  let maxStallStreak = 0;

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

    // 本幀是否有租客的下一步正踩在掃地機身上(= 被卡住的那一幀)
    const vacKeys = vacuumCellKeys(vac);
    const stalled = agents.some((ag) => {
      const nxt = ag.path[0];
      return !ag.hidden && ag.moving && !!nxt && vacKeys.has(`${nxt.c},${nxt.r}`);
    });
    stallStreak = stalled ? stallStreak + 1 : 0;
    if (stallStreak > maxStallStreak) maxStallStreak = stallStreak;
  }

  check("掃地機確實會位移(造訪 >3 個不同格)", distinctCells.size > 3, `distinctCells=${distinctCells.size}`);
  check("掃地機確實會換區域(涵蓋 >=3 個區域)", areasSeen.size >= 3, `areasSeen=${areasSeen.size}`);
  check("全程 0 次與租客同格(避讓端到端成立)", collisions === 0, `collisions=${collisions}`);
  check("長時間跑下來租客不會被永久卡住(卡住連續幀數有上限)", maxStallStreak < 60, `maxStallStreak=${maxStallStreak}`);

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

// --- 6) 主動讓路:擋住租客的單一走廊格(門口)時會自己移開 ---
//
// 地圖上真正的「單一必經格」是房門開口(map.ts DOORS),例如 (6,4) = 301 房 → 走廊:
// 上下都是牆,只剩房內 (5,4) 與走廊 (7,4)。掃地機閒置在這一格就會把租客鎖在房裡。
const grid = buildGrid();
const wallsOnly = grid.map((row) => row.map((cell) => !isWalkable(cell)));

/** 把掃地機硬放到指定格、關掉閒置小巡,單獨觀察讓路行為 */
function vacAt(c: number, r: number) {
  const a = createVacuumAgents()[0];
  a.c = c;
  a.r = r;
  a.px = c * TILE;
  a.py = r * TILE;
  a.path = [];
  a.moving = false;
  a.lastHourIdx = gameHourIndex(state.gameMs); // 別觸發換小時換區域
  a.wanderAt = Number.MAX_SAFE_INTEGER; // 關掉閒置小巡
  a.elapsed = 0;
  a.yieldReadyAt = 0;
  a.yielding = false;
  return a;
}

/** 站在 (5,4)、正要穿過門口 (6,4) 出房的租客 */
const doorTenant = () => ({ c: 5, r: 4, hidden: false, moving: true, path: [{ c: 6, r: 4 }, { c: 7, r: 4 }] });

{
  const tenant = doorTenant();
  check("擋在租客路徑上 → 判定為「我把人擋住了」", vacuumBlocksTenant({ c: 6, r: 4 }, [tenant]));
  check("不在任何租客路徑上 → 不算擋住", !vacuumBlocksTenant({ c: 1, r: 20 }, [tenant]));
  check("租客外出(hidden)→ 不算擋住", !vacuumBlocksTenant({ c: 6, r: 4 }, [{ ...tenant, hidden: true }]));
  check("租客沒在移動 → 不算擋住(它自己就停在那)", !vacuumBlocksTenant({ c: 6, r: 4 }, [{ ...tenant, moving: false }]));

  const v = vacAt(6, 4);
  let movedOff = false;
  for (let i = 0; i < 60; i++) {
    tickVacuumAgents([v], 0.2, [tenant]);
    if (v.c !== 6 || v.r !== 4) { movedOff = true; break; }
  }
  check("掃地機主動讓開單一走廊格(門口)", movedOff, `仍在 ${v.c},${v.r}`);
  for (let i = 0; i < 60; i++) tickVacuumAgents([v], 0.2, [tenant]);
  check("讓路後不再擋住該租客的路徑", !vacuumBlocksTenant({ c: v.c, r: v.r }, [tenant]), `停在 ${v.c},${v.r}`);
  check("讓路後仍站在可走格(沒鑽進牆/家具)", wallsOnly[v.r][v.c] === false);
}

// --- 7) 讓路是確定性的(同輸入同結果,無 Math.random)---
{
  const cells = new Set<string>(["5,4"]);
  const paths = new Set<string>(["6,4", "7,4"]);
  const y1 = pickYieldCell({ c: 6, r: 4 }, wallsOnly, cells, paths);
  const y2 = pickYieldCell({ c: 6, r: 4 }, wallsOnly, cells, paths);
  check("pickYieldCell 同輸入同輸出", !!y1 && !!y2 && y1.c === y2.c && y1.r === y2.r);
  check("退讓格不是租客站著的格", !!y1 && `${y1.c},${y1.r}` !== "5,4");
  check("退讓格不在租客路徑上", !!y1 && !paths.has(`${y1.c},${y1.r}`));
  check("退讓格可走且不是原地", !!y1 && wallsOnly[y1.r][y1.c] === false && !(y1.c === 6 && y1.r === 4));

  // 端到端:兩次全新模擬的逐幀位置序列必須完全一致
  const runOnce = () => {
    const v = vacAt(6, 4);
    const tenant = doorTenant();
    const seq: string[] = [];
    for (let i = 0; i < 40; i++) {
      tickVacuumAgents([v], 0.2, [tenant]);
      seq.push(`${v.c},${v.r}`);
    }
    return seq.join(">");
  };
  const runA = runOnce();
  check("整段讓路過程可重現(逐幀位置序列相同)", runA === runOnce());
}

// --- 8) 沒有可退讓的格:不崩潰、不亂鑽、不無限迴圈 ---
{
  const allBlocked = grid.map((row) => row.map(() => true));
  check("四周全被擋 → pickYieldCell 回 null", pickYieldCell({ c: 7, r: 10 }, allBlocked, new Set(), new Set()) === null);

  // 門口 (6,4) 的兩個鄰格都被租客站滿 → 完全無處可退
  const boxedIn = [
    { c: 5, r: 4, hidden: false, moving: true, path: [{ c: 6, r: 4 }, { c: 7, r: 4 }] },
    { c: 7, r: 4, hidden: false, moving: false },
  ];
  check("兩側都站著人 → 沒有退讓格", pickYieldCell({ c: 6, r: 4 }, wallsOnly, new Set(["5,4", "7,4"]), new Set(["6,4"])) === null);

  const v = vacAt(6, 4);
  let threw = "";
  try {
    for (let i = 0; i < 120; i++) tickVacuumAgents([v], 0.2, boxedIn);
  } catch (e) {
    threw = String(e);
  }
  check("無處可退時不崩潰(也沒卡在無限迴圈)", threw === "", threw);
  check("無處可退時原地不動(不穿牆、不疊到租客)", v.c === 6 && v.r === 4, `跑到 ${v.c},${v.r}`);
}

// --- 9) 端到端:租客最終一定穿得過被掃地機占住的門口 ---
{
  // 迷你租客模擬,複製 agents.ts 的規則:下一格是掃地機就停在原地等,不繞路。
  // 若掃地機不會主動讓開,這個租客就會永遠走不完 → 直接暴露「永久卡住」的 bug。
  const v = vacAt(6, 19); // 303 房 → 走廊的門口
  const tenant = {
    c: 4,
    r: 19,
    hidden: false,
    moving: true,
    path: [{ c: 5, r: 19 }, { c: 6, r: 19 }, { c: 7, r: 19 }, { c: 8, r: 19 }],
  };
  let stall = 0;
  let maxStall = 0;
  for (let i = 0; i < 400 && tenant.path.length > 0; i++) {
    tickVacuumAgents([v], 0.2, [tenant]);
    const nxt = tenant.path[0];
    if (!nxt) break;
    if (v.c === nxt.c && v.r === nxt.r) {
      stall++;
      if (stall > maxStall) maxStall = stall;
    } else {
      stall = 0;
      tenant.c = nxt.c;
      tenant.r = nxt.r;
      tenant.path.shift();
    }
  }
  check("租客最終穿過被占住的門口(不會永久卡住)", tenant.path.length === 0, `還剩 ${tenant.path.length} 步`);
  check("等待掃地機的幀數有上限", maxStall < 40, `maxStall=${maxStall}`);
}

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
if (fail > 0) process.exit(1);
