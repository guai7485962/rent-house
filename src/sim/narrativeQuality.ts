/** AI 敘事共用品質工具：來源片段去重、日記完整句裁切與重複句移除。 */

const LEADING_FILLER = /^(?:總體來說|總的來說|整體而言|整體來看|今天的變化是|今天看來|今天|此外|另外|同時|而且|不過|但是|他還|她還|接著)+/;

// ---------------------------------------------------------------------------
// 簡體 → 繁體(best-effort):先詞級(處理一簡對多繁的歧義),再字級(只收
// 「簡體獨有、不會出現在正常繁體文中」的字,避免誤轉)。
// Workers AI 的 Qwen/Llama 偶爾整句或零星混簡體,統一在品質閘門修正。
// ---------------------------------------------------------------------------

/** 詞級優先:一簡對多繁(面/复…)或台灣慣用語差異 */
const TRAD_WORDS: [RegExp, string][] = [
  [/泡面/g, "泡麵"], [/面条/g, "麵條"], [/吃面/g, "吃麵"], [/煮面/g, "煮麵"], [/拉面/g, "拉麵"],
  [/重复/g, "重複"], [/回复/g, "回覆"], [/恢复/g, "恢復"],
  [/网络/g, "網路"], [/视频/g, "影片"], [/信息/g, "訊息"],
];

const SIMP_TO_TRAD: Record<string, string> = {
  "们": "們", "来": "來", "说": "說", "时": "時", "间": "間", "过": "過", "还": "還", "没": "沒",
  "对": "對", "开": "開", "关": "關", "门": "門", "问": "問", "见": "見", "觉": "覺", "学": "學",
  "会": "會", "点": "點", "里": "裡", "后": "後", "发": "發", "头": "頭", "张": "張", "让": "讓",
  "记": "記", "话": "話", "语": "語", "谁": "誰", "请": "請", "谢": "謝", "边": "邊", "进": "進",
  "远": "遠", "运": "運", "动": "動", "气": "氣", "现": "現", "观": "觀", "视": "視", "听": "聽",
  "声": "聲", "响": "響", "虑": "慮", "虽": "雖", "随": "隨", "阳": "陽", "阴": "陰", "云": "雲",
  "电": "電", "饭": "飯", "饮": "飲", "馆": "館", "鱼": "魚", "鸟": "鳥", "猫": "貓", "马": "馬",
  "骂": "罵", "惊": "驚", "梦": "夢", "楼": "樓", "层": "層", "厅": "廳", "卫": "衛", "机": "機",
  "灯": "燈", "热": "熱", "烦": "煩", "恼": "惱", "忆": "憶", "忧": "憂", "郁": "鬱", "乐": "樂",
  "兴": "興", "奋": "奮", "紧": "緊", "压": "壓", "惫": "憊", "静": "靜", "闹": "鬧", "争": "爭",
  "执": "執", "处": "處", "决": "決", "选": "選", "择": "擇", "离": "離", "别": "別", "妈": "媽",
  "儿": "兒", "孙": "孫", "亲": "親", "爱": "愛", "恋": "戀", "结": "結", "买": "買", "卖": "賣",
  "钱": "錢", "价": "價", "费": "費", "账": "帳", "单": "單", "简": "簡", "杂": "雜", "乱": "亂",
  "净": "淨", "脏": "髒", "扫": "掃", "厨": "廚", "锅": "鍋", "汤": "湯", "饺": "餃", "药": "藥",
  "医": "醫", "疗": "療", "体": "體", "检": "檢", "验": "驗", "试": "試", "题": "題", "书": "書",
  "读": "讀", "写": "寫", "笔": "筆", "纸": "紙", "画": "畫", "剧": "劇", "频": "頻", "网": "網",
  "络": "絡", "线": "線", "连": "連", "续": "續", "众": "眾", "订": "訂", "阅": "閱", "万": "萬",
  "亿": "億", "数": "數", "计": "計", "组": "組", "织": "織", "团": "團", "队": "隊", "长": "長",
  "员": "員", "职": "職", "业": "業", "专": "專", "属": "屬", "与": "與", "为": "為", "无": "無",
  "从": "從", "优": "優", "势": "勢", "态": "態", "变": "變", "转": "轉", "弯": "彎", "灵": "靈",
  "邻": "鄰", "赶": "趕", "备": "備", "顾": "顧", "这": "這", "吗": "嗎", "么": "麼", "几": "幾",
  "块": "塊", "样": "樣", "应": "應", "该": "該", "给": "給", "够": "夠", "实": "實", "际": "際",
  "确": "確", "难": "難", "错": "錯", "惯": "慣", "习": "習", "弃": "棄", "坚": "堅", "继": "繼", "断": "斷",
};
const SIMP_RE = new RegExp(`[${Object.keys(SIMP_TO_TRAD).join("")}]`, "g");

/** 簡體轉繁(詞級優先 → 字級白名單);已是繁體的文字不受影響 */
export function toTraditional(text: string): string {
  let out = text;
  for (const [re, to] of TRAD_WORDS) out = out.replace(re, to);
  return out.replace(SIMP_RE, (ch) => SIMP_TO_TRAD[ch] ?? ch);
}

function canonical(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s「」『』【】（）()\[\]，、。！？!?：:；;…—\-]/g, "")
    .replace(LEADING_FILLER, "");
}

function bigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < text.length - 1; i++) out.add(text.slice(i, i + 2));
  return out;
}

/** 中文沒有空格，使用雙字組 Dice 相似度判斷同一件事是否被換句話說。 */
export function narrativeSimilarity(a: string, b: string): number {
  const aa = canonical(a);
  const bb = canonical(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  if (Math.min(aa.length, bb.length) >= 12 && (aa.includes(bb) || bb.includes(aa))) return 1;
  const ab = bigrams(aa);
  const bbm = bigrams(bb);
  let shared = 0;
  for (const gram of ab) if (bbm.has(gram)) shared++;
  return ab.size + bbm.size ? (2 * shared) / (ab.size + bbm.size) : 0;
}

export function isNarrativeDuplicate(a: string, b: string): boolean {
  return narrativeSimilarity(a, b) >= 0.58;
}

/** 從較新的片段往回挑，保留不同內容後再恢復時間順序。 */
export function selectDiverseNarrativeLines(lines: string[], max = 8): string[] {
  const chosen: string[] = [];
  for (let i = lines.length - 1; i >= 0 && chosen.length < max; i--) {
    const line = lines[i]?.replace(/\s+/g, " ").trim();
    if (!line || chosen.some((old) => isNarrativeDuplicate(line, old))) continue;
    chosen.unshift(line);
  }
  return chosen;
}

export function splitNarrativeSentences(text: string): string[] {
  const normalized = toTraditional(text)
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/,/g, "，")
    .replace(/!/g, "！")
    .replace(/\?/g, "？")
    // 標點連用清理:「不太好,。」→「不太好。」;句號後殘留逗號/重複句號也一併收掉
    .replace(/[，、;；:：]+([。！？])/g, "$1")
    .replace(/([。！？])[，、;；:：。]+/g, "$1")
    .replace(/他的聊天時態度/g, "他聊天時的態度")
    .replace(/她的聊天時態度/g, "她聊天時的態度")
    .replace(/聊天時態度/g, "聊天時的態度")
    .trim();
  if (!normalized) return [];
  return (normalized.match(/[^。！？!?]+[。！？!?]?/g) ?? [])
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (/[。！？!?]$/.test(part) ? part : `${part}。`));
}

function shortenCompleteSentence(sentence: string, maxChars: number): string {
  if (sentence.length <= maxChars) return sentence;
  const body = sentence.slice(0, Math.max(1, maxChars - 1));
  const comma = Math.max(body.lastIndexOf("，"), body.lastIndexOf(","));
  return `${(comma >= Math.floor(maxChars * 0.55) ? body.slice(0, comma) : body).replace(/[，,、；;：:]$/, "")}。`;
}

export function sanitizeNarrativeText(text: string, maxSentences: number, maxChars: number): string {
  const kept: string[] = [];
  for (const sentence of splitNarrativeSentences(text)) {
    if (kept.some((old) => isNarrativeDuplicate(sentence, old))) continue;
    kept.push(sentence);
    if (kept.length >= maxSentences) break;
  }
  if (!kept.length) return "";
  const withinLimit: string[] = [];
  for (const sentence of kept) {
    const room = maxChars - withinLimit.join("").length;
    if (room <= 1) break;
    if (sentence.length <= room) withinLimit.push(sentence);
    else {
      withinLimit.push(shortenCompleteSentence(sentence, room));
      break;
    }
  }
  return withinLimit.join("");
}

export const sanitizeDiaryText = (text: string): string => sanitizeNarrativeText(text, 4, 320);
export const sanitizeSummaryText = (text: string): string => sanitizeNarrativeText(text, 2, 220);

/** 觀察回饋 reason 的品質閘門:轉繁、去引號、子句去重(擋「她們還是…她們還是…」
 *  這類冗贅重複)、去尾標點、截長。回空字串 = 不合格。 */
export function sanitizeReasonText(text: string, maxChars = 60): string {
  const base = toTraditional(text)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'「『]+|["'」』]+$/g, "");
  if (!base) return "";
  const clauses = base.split(/[，,、;；]/).map((c) => c.trim()).filter(Boolean);
  const kept: string[] = [];
  for (const c of clauses) {
    if (kept.some((old) => isNarrativeDuplicate(c, old))) continue;
    kept.push(c);
  }
  return kept.join(",").replace(/[。，,、;；:：!！?？…]+$/, "").slice(0, maxChars);
}
