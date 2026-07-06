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
}

const SYSTEM = `你是一款手機遊戲《房東監視中》的 AI 敘事引擎。玩家是房東,透過監視器觀察租客的日常。
你的工作:根據某位租客「今天」發生的事,寫一段房東視角的當日觀察日記。

風格要求:
- 繁體中文,2~4 句,像房東在監視器前看著寫下的札記,冷靜、帶點窺看的趣味與人情味。
- 必須延續角色的核心性格與既有記憶標籤,讓劇情有連貫感(例:有[偷養浪貓]就別忘了貓)。
- 扣住今天實際發生的事(日誌、關係變化、房東抉擇),不要無中生有重大事件。
- 若今天發生了值得長期記住的轉折(戀愛、養寵物、失業、和好/決裂…),可提出一個新的記憶標籤。

只輸出 JSON,格式:
{"diary": "當日日記文字", "newMemory": {"label": "[標籤]", "hint": "一句行為指引"} 或 null}`;

function buildPrompt(c: NarrateCtx): string {
  const lines = [
    `租客:${c.name}(${c.occupation})`,
    `側寫:${c.bio}`,
    `核心性格:${c.coreTags.join("、") || "無"}`,
    `既有記憶:${c.memoryTags.join("、") || "無"}`,
    `目前狀態:心情 ${c.stats.mood} / 壓力 ${c.stats.stress} / 對房東好感 ${c.stats.affinity} / 滿意度 ${c.stats.satisfaction}`,
    `感情/鄰居關係:${c.relationships.join("、") || "無特別往來"}`,
    `今天(${c.dayLabel})的觀察片段:`,
    ...c.todayLog.map((l) => `  - ${l}`),
  ];
  if (c.events.length) lines.push(`今天房東的介入/事件:${c.events.join("、")}`);
  lines.push("", "請寫出今天的當日觀察日記(只輸出 JSON)。");
  return lines.join("\n");
}

function parseResult(text: string): { diary: string; newMemory: { label: string; hint: string } | null } | null {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    if (typeof obj.diary !== "string") return null;
    const nm = obj.newMemory;
    const newMemory = nm && typeof nm.label === "string" && typeof nm.hint === "string" ? { label: nm.label, hint: nm.hint } : null;
    return { diary: obj.diary.trim(), newMemory };
  } catch {
    return null;
  }
}

/** Gemini(Google AI Studio 免費層)—— 原生 fetch,強制 JSON 輸出 */
async function callGemini(ctx: NarrateCtx, key: string): Promise<string> {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM }] },
      contents: [{ parts: [{ text: buildPrompt(ctx) }] }],
      generationConfig: {
        maxOutputTokens: 1024,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 }, // 關思考,確保輸出、更快更省
      },
    }),
  });
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
