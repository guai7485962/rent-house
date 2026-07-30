/**
 * 月度全樓事件鏈(章節感):3 條鏈 × 4 階段的跨日連鎖劇情。
 *
 * 都更傳聞 / 颱風夜停電 / 頂樓漏水整修——每條鏈約 4 遊戲日推進一話,
 * 四話走完後休息一段時間再換下一條,讓掛機生活有「這個月正在發生一件事」的章節感。
 *
 * 刻意的設計約束:
 * - **零 RNG**:選鏈、選文案一律用決定性雜湊(同 community.sceneIndex / weather 的作法),
 *   不呼叫 Math.random,才不會改變 balance 快照的亂數次序。
 * - **純模板文案**:章節文字全部寫死,離線補進度、AI 額度用完時一樣成立;
 *   只在關鍵階段掛一個「純中文人話」的伏筆旗標,讓既有 AI 每日觀察自然提到它
 *   (旗標不含系統鍵,可安全餵給模型,不必進 narration 的過濾名單)。
 * - **獨立抉擇槽**:用 state.pendingChainEvent,不與 state.pendingGroupEvent 共用——
 *   後者有 group_any 3 日冷卻,共用會兩邊互相餓死。
 * - **可跳階、冪等**:掛機補進度時中間的遊戲日不會被 hourlyTick 走過,所以推進條件寫成
 *   「距上次推進 ≥ STAGE_DAYS 就推一話」,每次 pass 最多推一話(不會重複發),
 *   拖太久(超過 CHAIN_MAX_DAYS)則跳過中間話直接收束到最後一話。
 * - **前 CHAIN_FIRST_DAY 天不開章**:新局先讓玩家熟悉基本循環,也讓 balance-test
 *   的 10 遊戲日固定種子跑完全程碰不到本系統(零漂移)。
 */
import type { ChainEvent, FloorChainEntry, GroupChoice, GroupDelta } from "../types";
import { state, addFlag, clamp, gameDayIndex, notify, pushSocialLog, type TenantRuntime } from "./gameState";
import { adjustRelationship } from "./social";
import { addMoney } from "./economy";
import { save } from "./persistence";
import { spawnFx } from "../floor/fx";
import { LOUNGE_HALL_RECT } from "../floor/map";
import { MS_PER_GAME_HOUR, REAL_MS_PER_GAME_HOUR } from "./clock";
import { clearGroupScene, startGroupScene, type GroupSceneLayout } from "../floor/groupScene";

/** 每話之間的遊戲日間隔 */
export const STAGE_DAYS = 4;
/** 一條鏈完結後,隔多少遊戲日才開下一條(4 話 12 天 + 休息 16 天 ≈ 28~30 天一輪) */
export const CHAIN_REST_DAYS = 16;
/** 新局前幾天不開章(也讓 balance-test 的 10 遊戲日完全碰不到本系統) */
export const CHAIN_FIRST_DAY = 14;
/** 一條鏈最多拖這麼多遊戲日;超過就跳過中間話、直接收束到最後一話 */
export const CHAIN_MAX_DAYS = 30;

interface ChainStage {
  /** 這一話的標題(章節卡列出) */
  title: string;
  /** 全樓公告(進通知歷史與動態 Feed) */
  notice: string;
  /** 在場租客的個人日誌文案池(決定性挑一句) */
  lines: string[];
  /** 對在場租客的數值影響 */
  effect?: GroupDelta;
  /** 在場租客兩兩關係變化 */
  bond?: number;
  /** 這一話掛出的伏筆旗標(純中文,可安全當 AI 敘事素材) */
  flag?: string;
  /** 交誼廳特效(讓事發地看得到) */
  fx?: "chat" | "anger" | "lights";
  /** 明確寫到大家聚在交誼廳的話，接管參與者走位並顯示現場標題。 */
  scene?: { layout: GroupSceneLayout };
  /** 這一話要房東抉擇(掛上 state.pendingChainEvent) */
  decision?: { title: string; description: string; choices: GroupChoice[] };
}

interface ChainDef {
  id: string;
  icon: string;
  title: string;
  stages: ChainStage[];
}

export const CHAIN_DEFS: ChainDef[] = [
  {
    id: "urban_renewal",
    icon: "🏗️",
    title: "都更傳聞",
    stages: [
      {
        title: "第一話 · 巷口的紅單",
        notice: "巷口貼出建商說明會的紅單,整棟樓開始傳這件事。",
        lines: [
          "🏗️ 巷口電線桿上多了一張都更說明會的紅單,回家路上忍不住多看了兩眼。",
          "🏗️ 樓下早餐店老闆說,最近有建商在打聽這一帶的老公寓,心裡忽然懸了一下。",
          "🏗️ 信箱裡塞進一張沒有署名的都更傳單,拿在手上覺得比想像中沉。",
          "🏗️ 電梯口的公佈欄被人貼了說明會日期,底下已經有人用原子筆寫了問號。",
        ],
        effect: { stress: 2 },
        flag: "都更傳聞在耳邊",
      },
      {
        title: "第二話 · 交誼廳分成兩派",
        notice: "住戶在交誼廳爭到很晚,一派想搬、一派捨不得。",
        lines: [
          "🗣️ 交誼廳的話題整晚繞著都更,有人算補償金,有人只想繼續住下去。",
          "🗣️ 被問到「如果真的要拆你會怎麼辦」,一時之間答不上來。",
          "🗣️ 鄰居各執一詞,泡的茶都涼了還沒有人願意先讓步。",
          "🗣️ 聽到有人說「反正老房子總會拆」,忍不住替這層樓覺得委屈。",
        ],
        effect: { stress: 3, mood: -2 },
        bond: -1,
        fx: "anger",
        scene: { layout: "cluster" },
      },
      {
        title: "第三話 · 建商找上門",
        notice: "建商的人直接找上門,住戶都在等你表態。",
        lines: [
          "📋 建商的人拿著資料上樓,說得客氣,聽起來卻不太像在商量。",
          "📋 走廊上撞見來訪的西裝先生,對方遞來的名片握在手裡有點燙。",
          "📋 說明會的條件被逐條唸出來,越聽越覺得需要有人幫忙看清楚。",
        ],
        effect: { stress: 4 },
        fx: "chat",
        decision: {
          title: "建商找上門,要你表態",
          description: "建商的人直接上樓來談條件,住戶們沒有人先開口,全都在等你這個房東怎麼回應。",
          choices: [
            { id: "attend", label: "陪住戶一起出席說明會", hint: "不用花錢,但你明確站在住戶這邊", all: { satisfaction: 6, affinity: 6, stress: -4 }, bond: 2 },
            { id: "advisor", label: "請代書把條件寫清楚貼公佈欄($1,800)", hint: "花小錢換全樓安心,疑慮降到最低", money: -1800, all: { satisfaction: 8, affinity: 4, stress: -6 } },
            { id: "wait", label: "先不表態,看風向再說", hint: "省事,但住戶會覺得被晾著", all: { satisfaction: -4, affinity: -3, stress: 3 } },
          ],
        },
      },
      {
        title: "第四話 · 塵埃落定",
        notice: "整合沒有談成,這棟樓暫時還是原來的樣子。",
        lines: [
          "🍵 都更的事情最後不了了之,回到熟悉的樓梯間反而鬆了一口氣。",
          "🍵 紅單被雨打爛了一角,沒有人再提說明會的事。",
          "🍵 傳聞散去以後,晚上關燈前特別看了一眼這間住習慣的房間。",
          "🍵 有人在交誼廳說「還好沒拆」,那句話讓整層樓都安靜地笑了。",
        ],
        effect: { stress: -4, mood: 4, satisfaction: 3 },
        bond: 2,
        fx: "chat",
      },
    ],
  },
  {
    id: "typhoon_night",
    icon: "🌀",
    title: "颱風夜停電",
    stages: [
      {
        title: "第一話 · 氣象預警",
        notice: "全樓開始貼膠帶、囤泡麵,超商的水已經被搬空。",
        lines: [
          "🌀 氣象說颱風週末登陸,下班順路把泡麵和礦泉水一次搬回家。",
          "🌀 花了一個晚上在窗上貼米字膠帶,手指黏得都是膠。",
          "🌀 陽台的花盆全搬進屋裡,房間一下子變得好擠。",
          "🌀 手機一直跳颱風警報,睡前把充電線收在枕頭邊。",
        ],
        effect: { stress: 2 },
        flag: "颱風夜還沒過去",
      },
      {
        title: "第二話 · 停電,大家擠在交誼廳",
        notice: "整棟樓跳電,住戶抱著手電筒擠在交誼廳。",
        lines: [
          "🕯️ 半夜整棟跳電,摸黑走到交誼廳才發現大家都在。",
          "🕯️ 手電筒照著天花板,風聲大到要提高音量才聽得見彼此。",
          "🕯️ 冰箱停了,索性把快融的冰棒拿出來分給在場的人。",
          "🕯️ 停電的交誼廳意外地不可怕,因為誰都沒有先回房。",
        ],
        effect: { stress: 5, mood: -2 },
        fx: "lights",
        scene: { layout: "storm" },
        decision: {
          title: "颱風夜停電,你怎麼安排",
          description: "整棟樓沒電,住戶抱著手電筒擠在交誼廳。風雨還要吹一整夜,你打算怎麼做?",
          choices: [
            { id: "supply", label: "發應急照明與熱水($1,200)", hint: "撐過整夜最實在的一手", money: -1200, all: { mood: 6, satisfaction: 8, affinity: 6, stress: -4 }, bond: 3 },
            { id: "delivery", label: "訂一波熱食給大家($900)", hint: "氣氛最好,但天亮還是要摸黑", money: -900, all: { mood: 8, stress: -3 }, bond: 4 },
            { id: "rest", label: "請大家各自回房早點休息", hint: "不花錢,住戶多少有點失望", all: { mood: -3, affinity: -2 } },
          ],
        },
      },
      {
        title: "第三話 · 共度長夜",
        notice: "燈還沒來,住戶在交誼廳講了一整夜的話。",
        lines: [
          "🌙 沒電的夜裡話特別多,聊到後來連小時候颱風假的事都翻出來講。",
          "🌙 有人靠著沙發睡著了,旁邊的人默默把外套蓋上去。",
          "🌙 風雨最大的那一陣子,大家不約而同都沒有說話。",
          "🌙 天快亮時風終於小了,才發現自己一整晚都沒有覺得孤單。",
        ],
        effect: { mood: 5, stress: -3 },
        bond: 4,
        fx: "chat",
        scene: { layout: "storm" },
      },
      {
        title: "第四話 · 復電與收拾",
        notice: "電來了,全樓一起收拾滿地的落葉和積水。",
        lines: [
          "💡 燈亮起來的瞬間交誼廳有人小聲歡呼,接著就是一起掃地。",
          "💡 陽台積了一層落葉,拿掃把出去時鄰居也剛好開門。",
          "💡 冰箱裡壞掉的東西一起丟,順便把架子擦了一遍。",
          "💡 撕下窗上的膠帶時,忽然有點捨不得那個沒電的晚上。",
        ],
        effect: { mood: 4, stress: -4, satisfaction: 3 },
        bond: 2,
      },
    ],
  },
  {
    id: "roof_leak",
    icon: "💧",
    title: "頂樓漏水整修",
    stages: [
      {
        title: "第一話 · 天花板的水漬",
        notice: "天花板浮出一塊水漬,住戶開始拿臉盆接水。",
        lines: [
          "💧 天花板角落浮出一塊淡黃色的水漬,昨天明明還沒有。",
          "💧 半夜被滴水聲吵醒,爬起來拿臉盆接在書桌旁邊。",
          "💧 牆邊的壁紙微微鼓起來,用手一按就知道裡面是濕的。",
          "💧 走廊上多了一條擦不乾的水痕,踩過去要放慢腳步。",
        ],
        effect: { stress: 3, mood: -2 },
        flag: "頂樓的漏水還沒修好",
      },
      {
        title: "第二話 · 師傅上來勘查",
        notice: "抓漏師傅上樓勘查,敲敲打打了一整個下午。",
        lines: [
          "🔨 師傅在頂樓敲了整個下午,樓下聽起來像有人在搬家。",
          "🔨 被電鑽聲吵得沒辦法專心,只好戴上耳機把音量調大。",
          "🔨 師傅說要打掉一部分防水層,聽完只覺得日子還很長。",
          "🔨 樓梯間堆滿工具和水泥袋,上下樓都得側身。",
        ],
        effect: { stress: 4, mood: -2 },
        fx: "anger",
      },
      {
        title: "第三話 · 施工擾民的高峰",
        notice: "施工進到最吵的階段,住戶的耐心快用完了。",
        lines: [
          "🚧 從早上八點吵到傍晚,連在房間喝水都覺得杯子在震。",
          "🚧 灰塵從窗縫飄進來,擦完桌子沒多久又是一層。",
          "🚧 好幾天沒睡飽了,看到樓梯間的水泥袋就想嘆氣。",
          "🚧 忍不住在群組裡問了一句「還要多久」,沒有人回。",
        ],
        effect: { stress: 6, mood: -3 },
        fx: "anger",
        decision: {
          title: "施工吵到最高點,住戶等你處理",
          description: "抓漏工程進到最吵的階段,灰塵和噪音讓每個人都睡不好。你要怎麼處理這幾天?",
          choices: [
            { id: "rush", label: "加錢請師傅趕工($3,200)", hint: "花錢買回安寧,最快結束這場折磨", money: -3200, all: { stress: -8, satisfaction: 7, affinity: 5 } },
            { id: "compensate", label: "這個月租金折讓當補償($1,500)", hint: "還是要吵,但住戶知道你有在意", money: -1500, all: { satisfaction: 6, affinity: 7, stress: -3 } },
            { id: "endure", label: "照原進度,請大家忍一忍", hint: "省下開銷,代價是滿意度直落", all: { stress: 6, satisfaction: -5, affinity: -3 } },
          ],
        },
      },
      {
        title: "第四話 · 完工",
        notice: "防水重做完成,天花板終於乾了。",
        lines: [
          "🌤️ 師傅收工那天特地抬頭看了天花板,乾的,真的乾了。",
          "🌤️ 把接水的臉盆收回廚房,房間一下子空出一塊地。",
          "🌤️ 重新粉刷過的角落白得發亮,看久了心情也跟著平了。",
          "🌤️ 下雨的夜裡第一次沒有起來查看,一覺睡到天亮。",
        ],
        effect: { stress: -6, mood: 4, satisfaction: 4 },
        bond: 2,
        fx: "chat",
      },
    ],
  },
];

export const CHAIN_STAGE_COUNT = 4;

/** 決定性雜湊(同 community.sceneIndex 的寫法):同輸入永遠同輸出,不消耗 Math.random */
function chainIndex(key: string, size: number): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return Math.abs(hash) % Math.max(1, size);
}

/** 目前「在場」的租客:沒外出、也沒卡著待決事件(有 pendingEvent 者已被模擬凍結) */
function presentTenants(): TenantRuntime[] {
  return Object.values(state.runtimes)
    .filter((rt) => rt.tenant.visualState !== "away" && !rt.pendingEvent)
    .sort((a, b) => a.tenant.id.localeCompare(b.tenant.id)); // 固定順序 → 文案與關係變化可重現
}

function applyChainDelta(rt: TenantRuntime, d?: GroupDelta) {
  if (!d) return;
  const s = rt.tenant.stats;
  if (d.mood) s.mood = clamp(s.mood + d.mood, 0, 100);
  if (d.stress) s.stress = clamp(s.stress + d.stress, 0, 100);
  if (d.affinity) s.affinity = clamp(s.affinity + d.affinity, 0, 100);
  if (d.satisfaction) rt.satisfaction = clamp(rt.satisfaction + d.satisfaction, 0, 100);
}

function bondAll(parts: TenantRuntime[], delta: number) {
  for (let i = 0; i < parts.length; i++)
    for (let j = i + 1; j < parts.length; j++) adjustRelationship(parts[i].tenant.id, parts[j].tenant.id, delta);
}

/** 交誼廳大廳中央掛一個特效;現實時間與遊戲時間雙重過期,快轉不會殘留 */
function loungeFx(kind: "chat" | "anger" | "lights") {
  const c = Math.floor((LOUNGE_HALL_RECT.c0 + LOUNGE_HALL_RECT.c1) / 2);
  const r = Math.floor((LOUNGE_HALL_RECT.r0 + LOUNGE_HALL_RECT.r1) / 2);
  spawnFx(kind, c, r, REAL_MS_PER_GAME_HOUR, state.gameMs + MS_PER_GAME_HOUR);
}

export const chainDef = (chainId: string) => CHAIN_DEFS.find((d) => d.id === chainId) ?? null;

/** 清掉全樓身上這條鏈留下的伏筆旗標(鏈結束時呼叫,免得擠掉既有伏筆) */
function clearChainFlags(chainId: string) {
  const flags = new Set((chainDef(chainId)?.stages ?? []).map((s) => s.flag).filter(Boolean) as string[]);
  if (!flags.size) return;
  for (const rt of Object.values(state.runtimes)) {
    for (let i = rt.flags.length - 1; i >= 0; i--) if (flags.has(rt.flags[i])) rt.flags.splice(i, 1);
  }
}

function pushEntry(entry: FloorChainEntry) {
  const chain = state.floorChain;
  if (!chain) return;
  if (chain.entries.some((e) => e.stage === entry.stage)) return; // 冪等:同一話不重複記
  chain.entries.push(entry);
}

/** 開一條新鏈(決定性選鏈:排除上一條,避免連續同題材) */
function startChain(day: number): boolean {
  const prevId = state.floorChain?.chainId;
  const pool = CHAIN_DEFS.filter((d) => d.id !== prevId);
  const def = pool[chainIndex(`floorChain|${day}`, pool.length)] ?? CHAIN_DEFS[0];
  state.floorChain = {
    chainId: def.id,
    stage: 0,
    startDay: day,
    lastAdvanceDay: day - STAGE_DAYS, // 開章當天就播第一話
    entries: [],
    done: false,
  };
  return fireStage(day, 1, false);
}

/**
 * 播一話。quiet=true 表示這是補進度時被跳過的中間話:只留章節紀錄,
 * 不套數值、不發個人日誌、不掛抉擇(避免離線回來被一次灌爆)。
 */
function fireStage(day: number, stage: number, quiet: boolean): boolean {
  const chain = state.floorChain;
  if (!chain) return false;
  const def = chainDef(chain.chainId);
  if (!def) {
    // 未知鏈 id(舊存檔或改版移除)→ 安全收束,不讓狀態卡死
    chain.done = true;
    state.lastChainEndDay = day;
    return false;
  }
  const st = def.stages[stage - 1];
  if (!st) return false;
  chain.stage = stage;
  chain.lastAdvanceDay = day;

  pushEntry({ stage, title: st.title, text: quiet ? "(這幾天忙著別的事,這一段悄悄過去了)" : st.notice, gameMs: state.gameMs, skipped: quiet || undefined });

  if (!quiet) {
    const parts = presentTenants();
    for (const rt of parts) {
      const line = st.lines[chainIndex(`${def.id}|${stage}|${rt.tenant.id}`, st.lines.length)];
      pushSocialLog(rt, line, "notable");
      applyChainDelta(rt, st.effect);
      if (st.flag) addFlag(rt, st.flag);
    }
    if (st.bond && parts.length >= 2) bondAll(parts, st.bond);
    if (st.scene && parts.length > 0) {
      startGroupScene({
        id: `chain:${def.id}:${stage}:${state.gameMs}`,
        title: `${def.icon} ${st.title}`,
        venue: "lounge",
        layout: st.scene.layout,
        participantIds: parts.map((p) => p.tenant.id),
        fx: st.fx,
        gameNow: state.gameMs,
        priority: 2,
      });
    } else if (st.fx) {
      loungeFx(st.fx);
    }
    notify(`${def.icon} 【${def.title}】${st.title}——${st.notice}`);
    if (st.decision) {
      state.pendingChainEvent = {
        chainId: def.id,
        stage,
        id: `${def.id}_s${stage}`,
        title: st.decision.title,
        description: st.decision.description,
        participantIds: parts.map((p) => p.tenant.id),
        choices: st.decision.choices,
      };
    }
  }

  if (stage >= def.stages.length) endChain(day);
  return true;
}

function endChain(day: number) {
  const chain = state.floorChain;
  if (!chain || chain.done) return;
  chain.done = true;
  state.lastChainEndDay = day;
  clearChainFlags(chain.chainId);
}

/**
 * 換日呼叫:必要時開新章或推進一話。回傳是否有推進(給測試與除錯用)。
 * 每次 pass 最多推一話,不會重複發;拖過 CHAIN_MAX_DAYS 則跳過中間話直接收束。
 */
export function floorChainPass(): boolean {
  const day = gameDayIndex();
  if (state.pendingChainEvent) return false; // 有待決抉擇 → 停在原地等房東拍板
  const chain = state.floorChain;

  if (!chain || chain.done) {
    if (day < CHAIN_FIRST_DAY) return false;
    if (day - state.lastChainEndDay < CHAIN_REST_DAYS) return false;
    return startChain(day);
  }

  const def = chainDef(chain.chainId);
  if (!def) {
    chain.done = true;
    state.lastChainEndDay = day;
    return false;
  }
  if (chain.stage >= def.stages.length) {
    endChain(day); // 舊存檔可能停在最後一話卻沒收束
    return false;
  }
  if (day - chain.lastAdvanceDay < STAGE_DAYS) return false;

  // 拖太久(長時間掛機/補進度):中間話只留紀錄,直接收束到最後一話
  if (day - chain.startDay >= CHAIN_MAX_DAYS) {
    for (let s = chain.stage + 1; s < def.stages.length; s++) fireStage(day, s, true);
    return fireStage(day, def.stages.length, false);
  }
  return fireStage(day, chain.stage + 1, false);
}

/** 房東拍板章節抉擇:套用效果到參與者、記帳、補記章節卡,清掉待決槽 */
export function resolveChainEvent(choiceId: string): boolean {
  const ev = state.pendingChainEvent;
  if (!ev) return false;
  const choice = ev.choices.find((c) => c.id === choiceId);
  if (!choice) return false;
  const def = chainDef(ev.chainId);
  if (choice.money) addMoney(choice.money, `全樓章節:${ev.title}`, "event");
  const parts = ev.participantIds.map((id) => state.runtimes[id]).filter(Boolean) as TenantRuntime[];
  for (const rt of parts) {
    applyChainDelta(rt, choice.all);
    rt.unhappyHours = 0;
    pushSocialLog(rt, `${def?.icon ?? "📖"} 「${ev.title}」——房東選擇了「${choice.label}」。`, "notable");
  }
  if (choice.bond && parts.length >= 2) bondAll(parts, choice.bond);
  const entry = state.floorChain?.entries.find((e) => e.stage === ev.stage);
  if (entry) entry.decision = choice.label;
  state.pendingChainEvent = null;
  save();
  return true;
}

export interface FloorChainView {
  chainId: string;
  icon: string;
  title: string;
  stage: number;
  total: number;
  done: boolean;
  entries: FloorChainEntry[];
}

/** 動態頁章節卡的唯讀視圖;沒有進行中/剛完結的章節回 null */
export function floorChainView(): FloorChainView | null {
  const chain = state.floorChain;
  if (!chain) return null;
  const def = chainDef(chain.chainId);
  if (!def) return null;
  return {
    chainId: def.id,
    icon: def.icon,
    title: def.title,
    stage: chain.stage,
    total: def.stages.length,
    done: chain.done,
    entries: chain.entries,
  };
}

/** 測試用:把章節鏈狀態清乾淨(含全樓旗標) */
export function resetFloorChain() {
  if (state.floorChain) clearChainFlags(state.floorChain.chainId);
  state.floorChain = null;
  state.pendingChainEvent = null;
  state.lastChainEndDay = -99;
  clearGroupScene();
}
