/** AI 敘事共用品質工具：來源片段去重、日記完整句裁切與重複句移除。 */

const LEADING_FILLER = /^(?:總體來說|總的來說|整體而言|整體來看|今天的變化是|今天看來|今天|此外|另外|同時|而且|不過|但是|他還|她還|接著)+/;

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
  const normalized = text
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/,/g, "，")
    .replace(/!/g, "！")
    .replace(/\?/g, "？")
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
