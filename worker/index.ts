/**
 * Cloudflare Worker:同時服務靜態網站(env.ASSETS)與 AI 敘事端點。
 * /api/narrate 依租客當天歷史生成「當日觀察日記」+ 可能的新記憶/事件;
 * /api/invite 由名字+個性描述生成特邀租客資料。
 * 日記 provider = Cloudflare Workers AI 免費額度 → Gemini 備援;Claude 僅供特邀租客端點使用。
 * API key 存在 Worker secret,前端同源 fetch,金鑰不外洩。
 * 端點防護:同源檢查 + 請求體上限 + server 端 context 夾值(見 guardRequest / clampCtx),
 * 免得公開端點被裸 POST 刷掉大家共用的免費額度。
 */
import Anthropic from "@anthropic-ai/sdk";
import { sanitizeDiaryText, sanitizeSummaryText, selectDiverseNarrativeLines } from "../src/sim/narrativeQuality";
import { GROWTH_TAGS } from "../src/sim/growth";

export interface Env {
  ASSETS: Fetcher;
  GEMINI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
}

interface NarrateCtx {
  name: string;
  occupation: string;
  bio: string;
  dayLabel: string;
  coreTags: string[];
  memoryTags: string[];
  growthTags?: string[];
  stats: { mood: number; stress: number; affinity: number; satisfaction: number };
  room: { noise: number; soundproof: number; treated: boolean; complaintRisk: boolean };
  todayLog: string[];
  relationships: string[];
  events: string[];
  neighbors: string[];
  /** 滾動劇情摘要(上次的 summaryUpdate) */
  summary?: string;
  /** 進行中的劇情弧(null = 可開新弧;with = 雙人弧的另一位主角) */
  arc?: { theme: string; stage: number; maxStage: number; summary: string; with?: string | null } | null;
  /** 事件連鎖伏筆旗標 */
  flags?: string[];
  eventDue: boolean;
  /** 今日天氣 label(舊版前端/待補 ctx 缺省 = 不提天氣) */
  weather?: string;
  /** 財務狀況一句話(欠租/拮据;缺省 = 一切正常) */
  finance?: string;
}

const GROWTH_TAG_OPTIONS = Object.entries(GROWTH_TAGS)
  .map(([id, def]) => `${id}=${def.label}`)
  .join(" / ");

const SYSTEM = `你是一款手機遊戲《房東監視中》的 AI 敘事引擎。玩家是房東,透過監視器觀察租客的日常。
你的工作:根據某位租客「今天」發生的事,寫一段房東視角的當日觀察日記。

風格要求:
- 繁體中文。diary 以 **3 個完整句子、120~220 字**為原則；只有重大轉折才可寫第 4 句。像房東在監視器前寫下的札記,冷靜、帶點窺看的趣味與人情味。
- **敘事文字只能用自然繁體中文**:diary、summaryUpdate、newMemory、event 文案與 observation.reason 不得混入英文單字、拼音或羅馬化姓名；租客與鄰居姓名必須逐字照抄 context 的中文原名（例如「陳家豪」不可寫成「Chen 家豪」）。JSON key、白名單 id 與 enum 維持指定英文格式。
- **不要寫成流水帳**:從今天片段中只挑 2~3 個最有意思、彼此能串成一條線的畫面；其餘素材可以捨棄,絕對不要逐條改寫。
- **每件事只能寫一次**:結尾不可再總結或重述開頭。輸出前自行刪除重複句、同義反覆及連續的「他還／她還／看起來」。
- 用具體動作呈現變化,少用「沒有太大變化」「變得比較積極」「行為模式」等空泛結論。避免「聊天時態度」這類生硬搭配,句子要像自然繁體中文。
- 必須延續角色的核心性格與既有記憶標籤,讓劇情有連貫感(例:有[偷養浪貓]就別忘了貓)。
- **必須接續「此前的劇情摘要」**:昨天埋的線今天要有下文(伏筆推進、情緒延續、習慣持續),不要每天各寫各的。
- 扣住今天實際發生的事(日誌、關係變化、房東抉擇),不要無中生有重大事件。
- **尊重房間聲學狀態**:若 context 顯示「室內噪音抗議已阻隔」,不得生成鄰居抗議該租客房內噪音的日記、記憶或事件；可以描寫隔音有效。外部施工等與房內隔音無關的噪音，只有今天日誌已實際提到時才可延續。
- **summaryUpdate(必填)**:輸出 2 個完整句子、60~120 字的更新摘要:以舊摘要為底,只保留仍然重要的事實、未回收伏筆與今天真正的新變化；同一事實只寫一次。這段會在明天餵回給你,是劇情連續性的唯一載體。
- **記憶標籤 newMemory:只要今天出現值得記住的變化(情緒明顯起伏、關係進展、養成新習慣、突發小事、心境轉變…),就給一個 newMemory,讓角色記憶隨時間累積、越玩越立體。不必每天給,但別太吝嗇;標籤要具體(例:[熬夜成癮]、[暗戀林小婕]、[開始晨跑]、[對房東起疑])。已經有的記憶就不要重複。**

- **劇情弧 arcUpdate**:給劇情一條「連載」主線,跨多天推進。context 會告訴你目前是否有進行中的弧:
  - 沒有進行中的弧:若近況適合展開一條多日故事線(藏貓危機、鄰居戀情、職涯轉折、身心低谷、神秘包裹…),回 arcUpdate {"theme":"主題(≤12字)","maxStage":3~5,"stage":1,"summary":"這條線目前的進展(≤80字)","done":false};平淡的日子就填 null,不要硬開。
    **雙人弧**:若這條故事線自然是「他與某位鄰居兩個人」的(戀情發展、共同企劃、恩怨和解…),可加 "with":"鄰居名"(必須來自同棟其他租客清單)——兩人的日記會共同推進同一條線。對方已有進行中的弧或兩人還不夠熟時,系統會自動改成他的單人弧,不必自行判斷。
  - 有進行中的弧:今天的日記與摘要要推進它(stage 最多 +1、不可倒退,theme 不可更換),回更新後的 {"stage":N,"summary":"...","done":false};推進到最後一步、故事收尾時把 done 設 true(這條弧就此完結,系統會替他留下記憶)。
    若 context 顯示這是「與某位鄰居共同」的雙人弧:從**他自己的視角**寫,但劇情要與同一條線一致;收束時兩人會一起落幕。
  - 推進或收束時可附 "tone":這一步對他情緒的方向——"up"(順利/振奮)、"down"(受挫/低落)、"tense"(緊繃/懸念升高);收束時 up=如願以償、down=留下遺憾、tense=如釋重負。系統會轉成小幅數值起伏,讓玩家從數值曲線看到劇情;方向不明確就省略 tone。
  - **只有收束(done=true)時**，若這段經歷確實讓角色產生長期改變，可附 "growthTag"，id 只能從以下白名單選一個：${GROWTH_TAG_OPTIONS}。已在「永久成長」出現的不要重複；沒有明確成長就填 null。開弧或中途推進不得給 growthTag。
  - tone 是當下情緒脈衝；growthTag 是少見的永久性格成長。除此之外弧仍是敘事骨架；較大數值影響照常用 event。
- 事件選項的 effect 可選擇性留 "flag"(≤16 字的伏筆旗標,例:"答應幫忙搬家"、"欠房東一次人情"):會記在租客身上並在之後每天的 context 餵回給你——請在後續日記/事件裡回收這些伏筆。

- **observation(觀察回饋)**:寫完日記後,判斷今天的素材對他的「淨影響」:
  - nudge 是小幅情緒推力:mood/stress/energy/wellbeing 各 ±3 內、affinity(對房東好感)±2 內;只填有依據的欄位,其餘填 0。
  - reason 一句話(≤30 字)指向今天素材裡的**具體事**(玩家會看到這行因果,例:"連兩天被搶洗衣機,悶氣還沒消")。
  - 可選 "behavior":他**自己決定**接下來 1~2 天改變行為(不需房東同意,玩家會在畫面上看到)。格式 {"id":"...","days":1~2},id 只能從這 9 個選:
    night_owl / early_bird / hermit / social / binge_watch /
    comfort_seek(想找人談心,常往朋友房裡跑)/ overtime(加班晚歸,晚上還釘在書桌前)/
    self_care(好好照顧自己,提早上床休息)/ sulk(悶悶不樂,不主動社交但接受別人來訪)。
    用在情緒事件的自然後果(吵架翌日→hermit 或 sulk、失戀挫折→comfort_seek、連日高壓→self_care 或 overtime、熱戀得意→social);沒有明確觸發就填 null。
    adopt_cat 不在此清單:養貓是大事,要走 event 讓房東決定。若他已有進行中的行為改變,系統會自動忽略,不必自行判斷。
  - 可選 "rel":今天素材裡**確實出現**他與某位鄰居的互動時,可回 {"name":"鄰居名(必須來自同棟其他租客清單)","delta":-2~2} 微調兩人關係(正=拉近、負=疏遠)。沒有明確互動就填 null;成為情侶等重大轉變仍只能走 event,系統會擋下越界的推力。
  - 這代表你的「情緒解讀」,不是重算活動效果;不要連日往同一方向堆。
  - 平淡、情緒沒有明確方向的日子 → observation 填 null,不要硬給。

另外:如果今天的處境**值得房東做一個決定**(鄰居衝突、戀情轉折、財務吃緊、崩潰邊緣、養寵物…),可以**額外**產生一個 event(房東抉擇);**平淡的日子就不要給 event(填 null),不要每天都給**。
若 context 顯示「事件機會已到」,請優先檢查今天的處境能否自然形成一個 event;仍然不適合時才填 null。事件機會冷卻中則必須填 null。
event 規則:
- 2~3 個選項,每個選項有 label、hint、effect。
- effect.mood/stress/affinity/satisfaction 建議 ±15 內、money ±3000 內(正=房東收入,負=房東支出)。
- 選項可選擇性留 memory(記憶標籤,讓後續劇情延續)。**不要驅逐租客。**
- 選項可選擇性附 "directive":讓租客接下來幾天的行為**在遊戲畫面上看得見地改變**(玩家會親眼看到)。格式 {"id":"...","days":1~7},id 只能從這 10 個選:
  night_owl(開始熬夜,作息整段後移)/ early_bird(早睡早起,作息提前)/ hermit(閉門不出,不去交誼廳)/
  social(熱衷社交,傍晚泡交誼廳)/ adopt_cat(養了貓,房裡出現貓、每晚逗貓)/ binge_watch(追劇成癮,深夜黏在電視前)/
  comfort_seek(想找人談心,常往朋友房裡跑)/ overtime(加班晚歸)/ self_care(提早上床休息)/ sulk(悶悶不樂,不主動社交)。
  用在劇情自然的地方(失戀→hermit、認識新朋友→social、撿到貓→adopt_cat…),不要硬塞。
- **可以製造牽涉「另一位鄰居」的劇情**(如室友吵架/打架、戀情告白或加速、和好):把 event 的 "with" 設成那位鄰居的名字(必須是上面「同棟其他租客」清單裡的名字)。此時每個選項的 effect 可加:
  - "other":對那位鄰居的數值 {mood,stress,affinity,satisfaction}。
  - "rel":兩人關係 {delta(正=拉近/戀情加速、負=吵架疏遠), couple(true=在一起), breakup(true=分手)}。
  - 例:讓兩人戀情加速 → rel.delta 給較大正值、必要時 couple 設 true;室友打架 → rel.delta 負值 + 雙方 stress 上升。
  - "interaction"(選填,只能搭配 "with"):讓兩人**在遊戲畫面上實際演出**一段互動,id 只能從這 9 個選:
    cuddle_tv(窩著看劇)/ midnight_snack(深夜宵夜)/ lazy_morning(賴床)/ cook_dinner(一起做飯)/
    deep_talk(深夜談心)/ game_night(開黑打電動)/ share_delivery(分外送)/ share_earbuds(共用耳機)/ feed_snack(餵宵夜)。
    用在選項效果自然的地方(勸和好 → deep_talk、撮合 → share_earbuds、慶祝 → cook_dinner);親密內容不在清單內,由遊戲內建規則自行發生,不要嘗試。

只輸出 JSON,格式:
{"diary":"當日日記文字",
 "summaryUpdate":"更新後的劇情摘要(50~150 字)",
 "arcUpdate":{"theme":"主題","with":"鄰居名(選填,僅開新弧)","stage":1,"maxStage":3,"summary":"弧進展摘要","done":false,"tone":"up|down|tense(選填)","growthTag":"白名單 id(僅收束選填)"} 或 null,
 "newMemory":{"label":"[標籤]","hint":"指引"} 或 null,
 "observation":{"nudge":{"mood":0,"stress":0,"energy":0,"wellbeing":0,"affinity":0},"behavior":{"id":"...","days":1} 或 null,"rel":{"name":"鄰居名","delta":0} 或 null,"reason":"一句話理由"} 或 null,
 "event":{"title":"標題","description":"情況","with":"鄰居名字(選填)","choices":[{"label":"選項","hint":"提示","effect":{"mood":0,"stress":0,"affinity":0,"satisfaction":0,"money":0,"memory":null,"directive":null,"other":{"mood":0,"stress":0,"affinity":0,"satisfaction":0},"rel":{"delta":0,"couple":false,"breakup":false},"interaction":null}}]} 或 null}`;

function buildPrompt(c: NarrateCtx): string {
  const lines = [
    `租客:${c.name}(${c.occupation})`,
    `側寫:${c.bio}`,
    `核心性格:${c.coreTags.join("、") || "無"}`,
    `既有記憶:${c.memoryTags.join("、") || "無"}`,
    `永久成長:${(c.growthTags ?? []).join("、") || "無"}`,
    `目前狀態:心情 ${c.stats.mood} / 壓力 ${c.stats.stress} / 對房東好感 ${c.stats.affinity} / 滿意度 ${c.stats.satisfaction}`,
    ...(c.weather ? [`今天天氣:${c.weather}(可自然融入描寫,但不要每天都以天氣開頭)`] : []),
    ...(c.finance ? [`財務狀況:${c.finance}(這正在影響他的生活,可寫進日記;沒欠租的日子不要提錢的事)`] : []),
    `房間聲學:噪音 ${c.room.noise} / 隔音 ${c.room.soundproof} / ${c.room.treated ? "已完成永久隔音" : "尚未完成永久隔音"} / ${c.room.complaintRisk ? "仍有室內噪音抗議風險" : "室內噪音抗議已阻隔(不得生成相關抗議)"}`,
    `[背景資料—只供理解,除非今天片段有新進展,不可直接寫成今日事件]`,
    `感情/鄰居關係:${c.relationships.join("、") || "無特別往來"}`,
    `同棟其他租客(可點名製造互動):${c.neighbors.join("、") || "無"}`,
    `此前的劇情摘要(必須接續):${c.summary || "(剛入住,還沒有摘要)"}`,
    c.arc
      ? `進行中的劇情弧(必須推進或收束):「${c.arc.theme}」${c.arc.with ? `(與 ${c.arc.with} 共同的雙人篇章)` : ""}第 ${c.arc.stage}/${c.arc.maxStage} 步——${c.arc.summary}`
      : `進行中的劇情弧:無(適合的話可開新弧)`,
    `未回收的伏筆旗標:${(c.flags ?? []).join("、") || "無"}`,
    `房東抉擇事件機會:${c.eventDue ? "已到(適合就產生 event)" : "冷卻中(event 必須為 null)"}`,
    `[今天可寫素材—已去重,不必全部使用] 今天(${c.dayLabel})的觀察片段:`,
    ...c.todayLog.map((l) => `  - ${l}`),
  ];
  if (c.events.length) lines.push(`今天房東的介入/事件:${c.events.join("、")}`);
  lines.push("", "請先在心中選出一條主線並檢查沒有重複句,再寫出當日觀察日記(只輸出 JSON)。");
  return lines.join("\n");
}

function parseResult(
  text: string,
  expectedNames: string[] = [],
): { diary: string; newMemory: { label: string; hint: string } | null; event: unknown; summaryUpdate: string | null; arcUpdate: unknown; observation: unknown } | null {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    if (typeof obj.diary !== "string") return null;
    const nm = obj.newMemory;
    const newMemory = nm && typeof nm.label === "string" && typeof nm.hint === "string" ? { label: nm.label, hint: nm.hint } : null;
    // event / arcUpdate / observation 原封不動透傳(夾值/消毒在前端 store 端統一做)
    const event = obj.event && typeof obj.event === "object" ? obj.event : null;
    const arcUpdate = obj.arcUpdate && typeof obj.arcUpdate === "object" ? obj.arcUpdate : null;
    const observation = obj.observation && typeof obj.observation === "object" ? obj.observation : null;
    const diary = sanitizeDiaryText(obj.diary, expectedNames);
    if (!diary) return null;
    const summaryUpdate = typeof obj.summaryUpdate === "string" ? sanitizeSummaryText(obj.summaryUpdate, expectedNames) || null : null;
    return { diary, newMemory, event, summaryUpdate, arcUpdate, observation };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 端點防護:公開的 /api/* 沒有帳號,靠同源 + 體積 + server 端夾值擋掉裸 POST 濫用
// (惡意刷 API = 燒光大家共用的 Gemini 免費額度,或觸發 Claude 備援的真實費用)
// ---------------------------------------------------------------------------

const MAX_BODY = 16 * 1024; // 16KB:正常一位租客的 narrate context 遠小於此

/** 同源判定:Origin 或 Referer 的 host 要等於本站 host;兩者皆無(裸 curl)→ 擋。
 *  比對 host 而非寫死網域,換自訂網域也自動適用。 */
function sameOrigin(req: Request): boolean {
  const host = new URL(req.url).host;
  for (const h of [req.headers.get("origin"), req.headers.get("referer")]) {
    if (!h) continue;
    try {
      if (new URL(h).host === host) return true;
    } catch {
      /* 壞掉的 header 當作不符 */
    }
  }
  return false;
}

/** 進入任何 AI 端點前的守門:非同源 → 403、請求體過大 → 413;通過回 null */
function guardRequest(req: Request): Response | null {
  if (!sameOrigin(req)) return Response.json({ error: "forbidden" }, { status: 403 });
  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY) {
    return Response.json({ error: "too_large" }, { status: 413 });
  }
  return null;
}

const clampStr = (v: unknown, n: number): string => (typeof v === "string" ? v.slice(0, n) : "");
const clampArr = (v: unknown, n: number, itemLen: number): string[] =>
  Array.isArray(v) ? v.slice(0, n).map((x) => String(x).slice(0, itemLen)) : [];
const clampStat = (v: unknown): number => (Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v as number))) : 50);
const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number =>
  Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v as number))) : dflt;

/** server 端把使用者送來的 context 夾到合理上限:防惡意 payload 灌爆 prompt(= 灌爆 token 成本) */
function clampCtx(raw: unknown): NarrateCtx {
  const c = (raw ?? {}) as Record<string, any>;
  const name = clampStr(c.name, 24);
  const neighbors = clampArr(c.neighbors, 8, 24);
  const arc = c.arc && typeof c.arc === "object"
    ? {
        theme: clampStr(c.arc.theme, 40),
        stage: clampInt(c.arc.stage, 1, 9, 1),
        maxStage: clampInt(c.arc.maxStage, 2, 9, 3),
        summary: clampStr(c.arc.summary, 200),
        with: clampStr(c.arc.with, 24) || null,
      }
    : null;
  return {
    name,
    occupation: clampStr(c.occupation, 40),
    bio: clampStr(c.bio, 120),
    dayLabel: clampStr(c.dayLabel, 20),
    coreTags: clampArr(c.coreTags, 8, 40),
    memoryTags: clampArr(c.memoryTags, 12, 40),
    growthTags: clampArr(c.growthTags, 4, 40),
    stats: {
      mood: clampStat(c.stats?.mood),
      stress: clampStat(c.stats?.stress),
      affinity: clampStat(c.stats?.affinity),
      satisfaction: clampStat(c.stats?.satisfaction),
    },
    room: {
      noise: clampInt(c.room?.noise, 0, 100, 0),
      soundproof: clampInt(c.room?.soundproof, 0, 100, 0),
      treated: c.room?.treated === true,
      // 舊版前端／既有待補日記沒有此欄位時採「仍有風險」，避免誤把未知狀態當成已隔音。
      complaintRisk: c.room?.complaintRisk === false ? false : true,
    },
    todayLog: selectDiverseNarrativeLines(clampArr(c.todayLog, 20, 200), 10),
    relationships: clampArr(c.relationships, 12, 80),
    events: selectDiverseNarrativeLines(clampArr(c.events, 12, 200), 6),
    neighbors,
    summary: sanitizeSummaryText(clampStr(c.summary, 400), [name, ...neighbors]),
    arc,
    flags: clampArr(c.flags, 16, 40),
    eventDue: c.eventDue === true,
    weather: clampStr(c.weather, 12),
    finance: clampStr(c.finance, 40),
  };
}

// 導出給 worker-test 直接驗證(不需啟動 Cloudflare runtime)
export const _internal = { sameOrigin, guardRequest, clampCtx, buildPrompt, parseResult, chooseGeminiModel, extractWorkersAiText, systemPrompt: SYSTEM };

/** Gemini(Google AI Studio 免費層)—— 原生 fetch,強制 JSON 輸出;429 退避後重試一次。
 *  schema 選填:傳入 responseSchema 讓 Gemini 原生保證 JSON 結構(用在欄位固定的 invite)。 */
async function geminiGenerate(
  system: string,
  user: string,
  key: string,
  maxOutputTokens = 1024,
  schema?: unknown,
  model = "gemini-3.1-flash-lite",
): Promise<string> {
  const doFetch = () =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: user }] }],
        generationConfig: {
          maxOutputTokens,
          responseMimeType: "application/json",
          ...(schema ? { responseSchema: schema } : {}),
          temperature: 1.0, // Gemini 3 官方建議維持預設值,避免低溫造成重複
          thinkingConfig: { thinkingLevel: "minimal" }, // 日記不需深度推理,節省延遲與輸出額度
        },
      }),
    });
  let res = await doFetch();
  if (res.status === 429) {
    // 免費層撞到每分鐘上限:退避 5 秒重試一次,再不行才 fallback
    await new Promise((r) => setTimeout(r, 5000));
    res = await doFetch();
  }
  if (!res.ok) throw new Error(`Gemini ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
}

function chooseGeminiModel(ctx: NarrateCtx): "gemini-3-flash-preview" | "gemini-3.1-flash-lite" {
  const important = ctx.eventDue || ctx.events.length > 0 || (ctx.flags?.length ?? 0) > 0 || !!ctx.arc;
  return important ? "gemini-3-flash-preview" : "gemini-3.1-flash-lite";
}

async function callGemini(ctx: NarrateCtx, key: string): Promise<string> {
  return geminiGenerate(SYSTEM, buildPrompt(ctx), key, 1024, undefined, chooseGeminiModel(ctx));
}

/** Cloudflare Workers AI 免費額度備援。 */
async function callWorkersAi(
  ctx: NarrateCtx,
  ai: NonNullable<Env["AI"]>,
  model: "@cf/qwen/qwen3-30b-a3b-fp8" | "@cf/meta/llama-3.1-8b-instruct-fast",
  jsonMode = false,
): Promise<string> {
  const raw = await ai.run(model, {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: buildPrompt(ctx) },
    ],
    max_tokens: 1024,
    temperature: 0.9,
    // Qwen3 的官方模型頁雖接受 response_format，但不在 Workers AI 的 JSON Mode
    // 保證清單中；讓它照 prompt 回 JSON 即可。Llama fast 則是官方支援模型。
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
  });
  const text = extractWorkersAiText(raw);
  if (typeof text !== "string" || !text.trim()) throw new Error("Workers AI empty response");
  return text;
}

/** Workers AI 新版採 OpenAI Chat Completions 格式;同時兼容舊版 response 包裝。 */
function extractWorkersAiText(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  const result = raw as {
    response?: unknown;
    result?: { response?: unknown };
    choices?: { message?: { content?: unknown }; text?: unknown }[];
  };
  // 不用 ?? 串接：有些模型同時回 response:"" 與 choices，空字串不能遮掉有效 choices。
  const candidates = [result.response, result.result?.response, result.choices?.[0]?.message?.content, result.choices?.[0]?.text];
  for (const content of candidates) {
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      const text = content
        .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
        .join("");
      if (text.trim()) return text;
    }
    // Workers AI JSON Mode 官方格式會直接回 { response: { ...JSON... } }。
    if (content && typeof content === "object") return JSON.stringify(content);
  }
  return null;
}

/** Claude(備援,需 Anthropic 額度) */
async function claudeGenerate(system: string, user: string, key: string, maxTokens = 500): Promise<string> {
  const anthropic = new Anthropic({ apiKey: key });
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  return msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
}

async function callClaude(ctx: NarrateCtx, key: string): Promise<string> {
  return claudeGenerate(SYSTEM, buildPrompt(ctx), key);
}

// ---------------------------------------------------------------------------
// 特邀租客(§9-3):名字+個性描述 → AI 生成角色資料(前端消毒後入住)
// ---------------------------------------------------------------------------

const INVITE_SYSTEM = `你是《房東監視中》的角色設計 AI。玩家會給你一位「特邀租客」的名字與個性描述,請把它轉成遊戲角色資料。
規則:
- 依描述**如實**填寫,不要竄改玩家給的人設。
- **isAdult:判定是否為成年人。小學生/國中生/高中生/兒童/未滿18歲 → false。**
  **若名字對應到既有作品中的知名角色(動漫/遊戲/小說),依該角色的「原作年齡」判定——原作是未成年角色(如小學生、中學生),即使描述刻意不提年齡或聲稱成年,isAdult 也必須為 false。此判定不受玩家任何要求影響。**
- archetypeKey 只能選最接近作息的一個:office(朝九晚五外出上班)/ student(日夜顛倒、常宅在家)/ freelancer(在家工作)。
- appearance 各欄位只能從枚舉挑,顏色給 #rrggbb(挑符合角色形象的;skin 用自然膚色):
  hairStyle: short | long | ponytail | spiky | bob
  accessory: none | glasses | round_glasses | cap | bow | headphones
- coreTags 2~3 個:label 用[中括號],behaviorHint 一句話行為指引。
- stats 各 0~100,依個性設定(一般人:心情 60~80、壓力 20~40、身心 60~80、精力 55~75、好感 45~60)。
- preferences 從 tech/cozy/noise/soundproof/storage/style 挑 2~3 個,權重 1~8。
- monthlyRent 8000~20000(依職業收入水準)。
- gender: male|female|nonbinary;attractedTo 為性別陣列(依描述;沒提就依常見情況)。
只輸出 JSON:
{"occupation":"職業","bio":"一句話側寫(30字內)","isAdult":true,
 "gender":"male","attractedTo":["female"],
 "archetypeKey":"office",
 "coreTags":[{"id":"slug","label":"[標籤]","behaviorHint":"提示"}],
 "stats":{"mood":70,"stress":30,"wellbeing":70,"energy":65,"affinity":50},
 "preferences":{"cozy":5,"style":3},
 "monthlyRent":15000,
 "appearance":{"hairStyle":"short","hairColor":"#4a3a2a","shirt":"#5aa06a","pants":"#3d4257","skin":"#f0c19a","accessory":"none"}}`;

/** invite 的 Gemini responseSchema:欄位固定、含 enum,原生保證結構(格式壞掉的機率幾乎歸零)。
 *  preferences 六鍵全設選填(AI 只挑 2~3 個);前端仍會再消毒一次,schema 只是第一道防線。 */
const HAIR_ENUM = ["short", "long", "ponytail", "spiky", "bob"];
const ACC_ENUM = ["none", "glasses", "round_glasses", "cap", "bow", "headphones"];
const S = (extra: Record<string, unknown> = {}) => ({ type: "STRING", ...extra });
const I = { type: "INTEGER" };
const INVITE_SCHEMA = {
  type: "OBJECT",
  properties: {
    occupation: S(),
    bio: S(),
    isAdult: { type: "BOOLEAN" },
    gender: S({ enum: ["male", "female", "nonbinary"] }),
    attractedTo: { type: "ARRAY", items: S({ enum: ["male", "female", "nonbinary"] }) },
    archetypeKey: S({ enum: ["office", "student", "freelancer"] }),
    coreTags: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { id: S(), label: S(), behaviorHint: S() }, required: ["id", "label", "behaviorHint"] },
    },
    stats: {
      type: "OBJECT",
      properties: { mood: I, stress: I, wellbeing: I, energy: I, affinity: I },
      required: ["mood", "stress", "wellbeing", "energy", "affinity"],
    },
    preferences: {
      type: "OBJECT",
      properties: { tech: I, cozy: I, noise: I, soundproof: I, storage: I, style: I },
    },
    monthlyRent: I,
    appearance: {
      type: "OBJECT",
      properties: {
        hairStyle: S({ enum: HAIR_ENUM }),
        hairColor: S(),
        shirt: S(),
        pants: S(),
        skin: S(),
        accessory: S({ enum: ACC_ENUM }),
      },
      required: ["hairStyle", "hairColor", "shirt", "pants", "skin", "accessory"],
    },
  },
  required: ["occupation", "bio", "isAdult", "gender", "attractedTo", "archetypeKey", "coreTags", "stats", "preferences", "monthlyRent", "appearance"],
};

async function handleInvite(req: Request, env: Env): Promise<Response> {
  const blocked = guardRequest(req);
  if (blocked) return blocked;
  const provider = env.GEMINI_API_KEY ? "gemini" : env.ANTHROPIC_API_KEY ? "claude" : null;
  if (!provider) return Response.json({ error: "no_key" }, { status: 503 });

  let body: { name?: string; description?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  const name = String(body.name ?? "").trim().slice(0, 12);
  const description = String(body.description ?? "").trim().slice(0, 200);
  if (!name || !description) return Response.json({ error: "bad_request" }, { status: 400 });

  const user = `特邀租客的名字:${name}\n個性描述:${description}\n請輸出角色資料 JSON。`;
  try {
    const text =
      provider === "gemini"
        ? await geminiGenerate(INVITE_SYSTEM, user, env.GEMINI_API_KEY!, 768, INVITE_SCHEMA)
        : await claudeGenerate(INVITE_SYSTEM, user, env.ANTHROPIC_API_KEY!, 768);
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return Response.json({ error: "parse_failed" }, { status: 502 });
    // 原封不動透傳;白名單/夾值消毒在前端統一做
    return new Response(m[0], { headers: { "content-type": "application/json" } });
  } catch (e) {
    const msg = String(e);
    if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
      return Response.json({ error: "quota" }, { status: 429 });
    }
    return Response.json({ error: "upstream", detail: msg }, { status: 502 });
  }
}

async function handleNarrate(req: Request, env: Env): Promise<Response> {
  const blocked = guardRequest(req);
  if (blocked) return blocked;
  if (!env.GEMINI_API_KEY && !env.AI) return Response.json({ error: "no_key" }, { status: 503 });

  let ctx: NarrateCtx;
  try {
    ctx = clampCtx(await req.json()); // server 端夾值:惡意 payload 灌不爆 prompt
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  const attempts: { provider: "gemini-flash" | "gemini-flash-lite" | "workers-ai-qwen" | "workers-ai-llama"; run: () => Promise<string> }[] = [];
  if (env.AI) {
    // 免費且不受 Google 出口地區限制：先 Qwen（繁中較自然），再用官方支援 JSON Mode 的 Llama fast。
    attempts.push({ provider: "workers-ai-qwen", run: () => callWorkersAi(ctx, env.AI!, "@cf/qwen/qwen3-30b-a3b-fp8") });
    attempts.push({ provider: "workers-ai-llama", run: () => callWorkersAi(ctx, env.AI!, "@cf/meta/llama-3.1-8b-instruct-fast", true) });
  }
  if (env.GEMINI_API_KEY) {
    const provider = chooseGeminiModel(ctx) === "gemini-3-flash-preview" ? "gemini-flash" : "gemini-flash-lite";
    attempts.push({ provider, run: () => callGemini(ctx, env.GEMINI_API_KEY!) });
  }

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const result = parseResult(await attempt.run(), [ctx.name, ...ctx.neighbors]);
      if (!result) throw new Error("parse_failed");
      return Response.json({ ...result, provider: attempt.provider });
    } catch (e) {
      errors.push(`${attempt.provider}: ${String(e)}`);
    }
  }
  const allQuota = errors.length > 0 && errors.every((msg) => /429|RESOURCE_EXHAUSTED|quota/i.test(msg));
  if (allQuota) return Response.json({ error: "quota" }, { status: 429 });
  const parseOnly = errors.length > 0 && errors.every((msg) => msg.includes("parse_failed"));
  return Response.json({ error: parseOnly ? "parse_failed" : "upstream", detail: errors.join(" | ").slice(0, 500) }, { status: 502 });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/narrate" && req.method === "POST") return handleNarrate(req, env);
    if (url.pathname === "/api/invite" && req.method === "POST") return handleInvite(req, env);
    return env.ASSETS.fetch(req);
  },
};
