/**
 * Cloudflare Worker:同時服務靜態網站(env.ASSETS)與 AI 敘事端點。
 * /api/narrate 由 Claude 依租客當天歷史生成「當日觀察日記」+ 可能的新記憶標籤。
 * API key 存在 Worker secret(ANTHROPIC_API_KEY),前端同源 fetch,金鑰不外洩。
 */
import Anthropic from "@anthropic-ai/sdk";

export interface Env {
  ASSETS: Fetcher;
  GEMINI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}

interface NarrateCtx {
  name: string;
  occupation: string;
  bio: string;
  dayLabel: string;
  coreTags: string[];
  memoryTags: string[];
  stats: { mood: number; stress: number; affinity: number; satisfaction: number };
  todayLog: string[];
  relationships: string[];
  events: string[];
  neighbors: string[];
  /** 滾動劇情摘要(上次的 summaryUpdate) */
  summary?: string;
  /** 進行中的劇情弧(null = 可開新弧) */
  arc?: { theme: string; stage: number; maxStage: number; summary: string } | null;
  /** 事件連鎖伏筆旗標 */
  flags?: string[];
}

const SYSTEM = `你是一款手機遊戲《房東監視中》的 AI 敘事引擎。玩家是房東,透過監視器觀察租客的日常。
你的工作:根據某位租客「今天」發生的事,寫一段房東視角的當日觀察日記。

風格要求:
- 繁體中文,2~4 句,像房東在監視器前看著寫下的札記,冷靜、帶點窺看的趣味與人情味。
- 必須延續角色的核心性格與既有記憶標籤,讓劇情有連貫感(例:有[偷養浪貓]就別忘了貓)。
- **必須接續「此前的劇情摘要」**:昨天埋的線今天要有下文(伏筆推進、情緒延續、習慣持續),不要每天各寫各的。
- 扣住今天實際發生的事(日誌、關係變化、房東抉擇),不要無中生有重大事件。
- **summaryUpdate(必填)**:輸出一段更新後的劇情摘要(50~150 字):以舊摘要為底,保留仍然重要的事實與未回收的伏筆,寫入今天的變化。這段會在明天餵回給你,是劇情連續性的唯一載體——寫得像「連載的前情提要」。
- **記憶標籤 newMemory:只要今天出現值得記住的變化(情緒明顯起伏、關係進展、養成新習慣、突發小事、心境轉變…),就給一個 newMemory,讓角色記憶隨時間累積、越玩越立體。不必每天給,但別太吝嗇;標籤要具體(例:[熬夜成癮]、[暗戀林小婕]、[開始晨跑]、[對房東起疑])。已經有的記憶就不要重複。**

- **劇情弧 arcUpdate**:給劇情一條「連載」主線,跨多天推進。context 會告訴你目前是否有進行中的弧:
  - 沒有進行中的弧:若近況適合展開一條多日故事線(藏貓危機、鄰居戀情、職涯轉折、身心低谷、神秘包裹…),回 arcUpdate {"theme":"主題(≤12字)","maxStage":3~5,"stage":1,"summary":"這條線目前的進展(≤80字)","done":false};平淡的日子就填 null,不要硬開。
  - 有進行中的弧:今天的日記與摘要要推進它(stage 最多 +1、不可倒退,theme 不可更換),回更新後的 {"stage":N,"summary":"...","done":false};推進到最後一步、故事收尾時把 done 設 true(這條弧就此完結,系統會替他留下記憶)。
  - 弧是純敘事骨架,不帶數值效果;要影響數值請照常用 event。
- 事件選項的 effect 可選擇性留 "flag"(≤16 字的伏筆旗標,例:"答應幫忙搬家"、"欠房東一次人情"):會記在租客身上並在之後每天的 context 餵回給你——請在後續日記/事件裡回收這些伏筆。

另外:如果今天的處境**值得房東做一個決定**(鄰居衝突、戀情轉折、財務吃緊、崩潰邊緣、養寵物…),可以**額外**產生一個 event(房東抉擇);**平淡的日子就不要給 event(填 null),不要每天都給**。
event 規則:
- 2~3 個選項,每個選項有 label、hint、effect。
- effect.mood/stress/affinity/satisfaction 建議 ±15 內、money ±3000 內(正=房東收入,負=房東支出)。
- 選項可選擇性留 memory(記憶標籤,讓後續劇情延續)。**不要驅逐租客。**
- 選項可選擇性附 "directive":讓租客接下來幾天的行為**在遊戲畫面上看得見地改變**(玩家會親眼看到)。格式 {"id":"...","days":1~7},id 只能從這 6 個選:
  night_owl(開始熬夜,作息整段後移)/ early_bird(早睡早起,作息提前)/ hermit(閉門不出,不去交誼廳)/
  social(熱衷社交,傍晚泡交誼廳)/ adopt_cat(養了貓,房裡出現貓、每晚逗貓)/ binge_watch(追劇成癮,深夜黏在電視前)。
  用在劇情自然的地方(失戀→hermit、認識新朋友→social、撿到貓→adopt_cat…),不要硬塞。
- **可以製造牽涉「另一位鄰居」的劇情**(如室友吵架/打架、戀情告白或加速、和好):把 event 的 "with" 設成那位鄰居的名字(必須是上面「同棟其他租客」清單裡的名字)。此時每個選項的 effect 可加:
  - "other":對那位鄰居的數值 {mood,stress,affinity,satisfaction}。
  - "rel":兩人關係 {delta(正=拉近/戀情加速、負=吵架疏遠), couple(true=在一起), breakup(true=分手)}。
  - 例:讓兩人戀情加速 → rel.delta 給較大正值、必要時 couple 設 true;室友打架 → rel.delta 負值 + 雙方 stress 上升。

只輸出 JSON,格式:
{"diary":"當日日記文字",
 "summaryUpdate":"更新後的劇情摘要(50~150 字)",
 "arcUpdate":{"theme":"主題","stage":1,"maxStage":3,"summary":"弧進展摘要","done":false} 或 null,
 "newMemory":{"label":"[標籤]","hint":"指引"} 或 null,
 "event":{"title":"標題","description":"情況","with":"鄰居名字(選填)","choices":[{"label":"選項","hint":"提示","effect":{"mood":0,"stress":0,"affinity":0,"satisfaction":0,"money":0,"memory":null,"directive":null,"other":{"mood":0,"stress":0,"affinity":0,"satisfaction":0},"rel":{"delta":0,"couple":false,"breakup":false}}}]} 或 null}`;

function buildPrompt(c: NarrateCtx): string {
  const lines = [
    `租客:${c.name}(${c.occupation})`,
    `側寫:${c.bio}`,
    `核心性格:${c.coreTags.join("、") || "無"}`,
    `既有記憶:${c.memoryTags.join("、") || "無"}`,
    `目前狀態:心情 ${c.stats.mood} / 壓力 ${c.stats.stress} / 對房東好感 ${c.stats.affinity} / 滿意度 ${c.stats.satisfaction}`,
    `感情/鄰居關係:${c.relationships.join("、") || "無特別往來"}`,
    `同棟其他租客(可點名製造互動):${c.neighbors.join("、") || "無"}`,
    `此前的劇情摘要(必須接續):${c.summary || "(剛入住,還沒有摘要)"}`,
    c.arc
      ? `進行中的劇情弧(必須推進或收束):「${c.arc.theme}」第 ${c.arc.stage}/${c.arc.maxStage} 步——${c.arc.summary}`
      : `進行中的劇情弧:無(適合的話可開新弧)`,
    `未回收的伏筆旗標:${(c.flags ?? []).join("、") || "無"}`,
    `今天(${c.dayLabel})的觀察片段:`,
    ...c.todayLog.map((l) => `  - ${l}`),
  ];
  if (c.events.length) lines.push(`今天房東的介入/事件:${c.events.join("、")}`);
  lines.push("", "請寫出今天的當日觀察日記(只輸出 JSON)。");
  return lines.join("\n");
}

function parseResult(
  text: string,
): { diary: string; newMemory: { label: string; hint: string } | null; event: unknown; summaryUpdate: string | null; arcUpdate: unknown } | null {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    if (typeof obj.diary !== "string") return null;
    const nm = obj.newMemory;
    const newMemory = nm && typeof nm.label === "string" && typeof nm.hint === "string" ? { label: nm.label, hint: nm.hint } : null;
    // event / arcUpdate 原封不動透傳(夾值/消毒在前端 store 端統一做)
    const event = obj.event && typeof obj.event === "object" ? obj.event : null;
    const arcUpdate = obj.arcUpdate && typeof obj.arcUpdate === "object" ? obj.arcUpdate : null;
    const summaryUpdate = typeof obj.summaryUpdate === "string" ? obj.summaryUpdate.slice(0, 220).trim() || null : null;
    return { diary: obj.diary.trim(), newMemory, event, summaryUpdate, arcUpdate };
  } catch {
    return null;
  }
}

/** Gemini(Google AI Studio 免費層)—— 原生 fetch,強制 JSON 輸出;429 退避後重試一次 */
async function callGemini(ctx: NarrateCtx, key: string): Promise<string> {
  const doFetch = () =>
    fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM }] },
        contents: [{ parts: [{ text: buildPrompt(ctx) }] }],
        generationConfig: {
          maxOutputTokens: 1024,
          responseMimeType: "application/json",
          temperature: 1.1, // 敘事多一點變化
          thinkingConfig: { thinkingBudget: 0 }, // 關思考,確保輸出、更快更省
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

/** Claude(備援,需 Anthropic 額度) */
async function callClaude(ctx: NarrateCtx, key: string): Promise<string> {
  const anthropic = new Anthropic({ apiKey: key });
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 500,
    system: SYSTEM,
    messages: [{ role: "user", content: buildPrompt(ctx) }],
  });
  return msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
}

async function handleNarrate(req: Request, env: Env): Promise<Response> {
  const provider = env.GEMINI_API_KEY ? "gemini" : env.ANTHROPIC_API_KEY ? "claude" : null;
  if (!provider) return Response.json({ error: "no_key" }, { status: 503 });

  let ctx: NarrateCtx;
  try {
    ctx = (await req.json()) as NarrateCtx;
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const text =
      provider === "gemini"
        ? await callGemini(ctx, env.GEMINI_API_KEY!)
        : await callClaude(ctx, env.ANTHROPIC_API_KEY!);
    const result = parseResult(text);
    if (!result) return Response.json({ error: "parse_failed", raw: text }, { status: 502 });
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: "upstream", detail: String(e) }, { status: 502 });
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/narrate" && req.method === "POST") return handleNarrate(req, env);
    return env.ASSETS.fetch(req);
  },
};
