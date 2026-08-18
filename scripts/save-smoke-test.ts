/**
 * 存檔啟動煙霧測試 —— 用「既有存檔」把打包後的 app 真的啟動起來。
 *
 * 🔴 為什麼要有這關(2026-08-18 線上白畫面事故的直接產物)
 * 既有關卡全部是**全新 session／全新 state**:`npm test` 是純函式與模擬層、
 * UI Lab 每次開新分頁、`balance-test` 固定種子從零開局。**沒有任何一關會拿一份
 * 「玩很久的既有存檔」去啟動 app**,而且全都不看打包後的產物。所以
 *   (a) 只在載入舊存檔才觸發的例外、
 *   (b) 打包後才現形的模組載入順序問題(循環 import／TDZ)、
 *   (c) 渲染迴圈首幀丟例外
 * 三類問題可以一路全綠 —— 六批一起上線後使用者拿到黑畫面。本檔補的就是這個破口。
 *
 * 🔴 第二類破口(2026-08-19 補):**部署換版造成的白畫面**。
 * `[assets] directory = "./dist"` 每次部署都刪掉上一版的雜湊資產,拿著舊 index.html 的裝置
 * 會去要已不存在的 `/assets/index-XXXX.js` ⇒ 404 ⇒ 白畫面,而且 console 只有一條 404、
 * 沒有任何 JS 例外。`staleHtmlCheck()` 直接重現這個情境,驗自救會重整救回來、
 * 且救不回來時停在可讀錯誤畫面(不無限重載);`distStaticCheck()` 驗 `_headers` 與自救腳本
 * 真的在打包產物裡、位置正確。
 *
 * 做法:`vite build` → 靜態伺服 `dist/` → 無頭 Edge/Chrome(CDP)→
 * 先把 fixture 種進 localStorage,再導向 app → 等畫面長出來 → 收 console error
 * 與未捕捉例外 → 再 reload 一次(驗證這一版寫回去的存檔自己讀得回來)。
 *
 * 用法(必須固定時區):
 *   TZ=Asia/Taipei npx tsx scripts/save-smoke-test.ts
 *   TZ=Asia/Taipei npx tsx scripts/save-smoke-test.ts --no-build   # 沿用現有 dist/
 *   SMOKE_BROWSER="C:/.../chrome.exe" ...                          # 指定瀏覽器
 *
 * fixture 由 `scripts/make-save-fixtures.ts` 產生(見該檔說明)。
 * 判定失敗即 exit 1;每個案例的截圖落在 artifacts/save-smoke/(不入版控)。
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const distDir = join(root, "dist");
const fixtureDir = join(here, "fixtures");
const shotDir = join(root, "artifacts", "save-smoke");
const noBuild = process.argv.includes("--no-build");

const SAVE_KEY = "rent_house_save_v1";
/** 與 src/sim/clock.ts 同步:現實過多久遊戲前進 1 小時。離線時數靠它換算。 */
const REAL_MS_PER_GAME_HOUR = (24 * 3600) / (7 * 24) * 1000;
/** 開起來之後還要在畫面上真的跑一段(rentDebug.fastForward);渲染迴圈與互動演出才會被走到。 */
const FAST_FORWARD_HOURS = 48;

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name} ${detail}`); }
};

/**
 * 案例:每個都是「一份存檔 + 離線了幾個遊戲小時」。
 * offlineHours > MAX_CATCHUP_HOURS(48)會走到「補進度上限 → 重錨」那條分支。
 */
const CASES = [
  { id: "fresh", label: "全新開局(沒有存檔)", fixture: null, offlineHours: 0 },
  { id: "veteran-v10", label: "玩很久的現行版存檔 + 離線 60 遊戲小時(觸發補進度上限)", fixture: "save-veteran-v10.json", offlineHours: 60 },
  { id: "legacy-v8", label: "舊版號存檔 v8(走 8→9→10 遷移)+ 離線 10 遊戲小時", fixture: "save-legacy-v8.json", offlineHours: 10 },
  { id: "stale-ids-v10", label: "存檔混入目錄已查無的 id(成長特質/行為指令/家具/研發)", fixture: "save-stale-ids-v10.json", offlineHours: 60 },
];

// --- 1. 打包(循環 import／TDZ 只在打包後才現形,所以一定要跑在 dist 上)---
if (!noBuild) {
  console.log("→ vite build …");
  const built = spawnSync(process.execPath, [join(root, "node_modules", "vite", "bin", "vite.js"), "build"], {
    cwd: root, encoding: "utf8", timeout: 300_000,
  });
  if (built.status !== 0) {
    console.log("❌ vite build 失敗");
    console.log(`${built.stdout ?? ""}\n${built.stderr ?? ""}`.slice(-4000));
    process.exit(1);
  }
}
if (!existsSync(join(distDir, "index.html"))) {
  console.log("❌ 找不到 dist/index.html(先跑 npm run build)");
  process.exit(1);
}

// --- 2. 靜態伺服 dist/(外加空白頁與 /api stub)---
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".ico": "image/x-icon",
};
/** 自我檢查用:打開後靜態伺服器會在 app 的 JS 最前面塞一個例外(模擬「打包後啟動就炸」)。 */
let injectFault = false;
const FAULT = `throw new Error("save-smoke 自我檢查:故意在模組載入期丟出的例外");
`;
/**
 * 🔴 白畫面事故模擬:把 index.html 裡的雜湊 JS 檔名換成一個不存在的名字,
 * 重現「裝置手上握著舊 HTML、它指向的 /assets/index-XXXX.js 已被下一次部署刪掉」。
 * "once"  = 只有第一次要 HTML 時給舊版(之後給正確的)⇒ 自救重整後應該救得回來。
 * "always" = 永遠給舊版 ⇒ 自救救不了,必須停在可讀的錯誤畫面而不是無限重載。
 */
let staleHtmlMode: "off" | "once" | "always" = "off";
let htmlRequests = 0;
const STALE_ASSET = "/assets/index-STALE000.js";
function serveHtml(): string {
  htmlRequests++;
  const html = readFileSync(join(distDir, "index.html"), "utf8");
  if (staleHtmlMode === "off") return html;
  if (staleHtmlMode === "once") staleHtmlMode = "off";
  return html.replace(/\/assets\/index-[A-Za-z0-9_-]+\.js/g, STALE_ASSET);
}
const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/" || path === "/index.html") {
    res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
    res.end(serveHtml());
    return;
  }
  // 空白頁:必須跟 app 同源才能先種 localStorage
  if (path === "/__smoke_blank__") { res.writeHead(200, { "content-type": MIME[".html"] }); res.end("<!doctype html><title>blank</title>"); return; }
  // AI 後端在本測試裡刻意不存在:narrateDay 會走 fallback,不該產生 console error
  if (path.startsWith("/api/")) { res.writeHead(503, { "content-type": MIME[".json"] }); res.end(`{"error":"no_key"}`); return; }
  const file = path === "/" ? join(distDir, "index.html") : join(distDir, path);
  if (!file.startsWith(distDir) || !existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  if (injectFault && extname(file) === ".js") { res.end(FAULT + readFileSync(file, "utf8")); return; }
  res.end(readFileSync(file));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;

// --- 3. 無頭瀏覽器(CDP;不需要 Docker、不需要下載 driver)---
const BROWSER_CANDIDATES = [
  process.env.SMOKE_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean) as string[];
const browserPath = BROWSER_CANDIDATES.find((p) => existsSync(p));
if (!browserPath) {
  console.log(`❌ 找不到無頭瀏覽器,請設 SMOKE_BROWSER。找過:${BROWSER_CANDIDATES.join(", ")}`);
  server.close();
  process.exit(1);
}
const cdpPort = 9200 + (process.pid % 500);
const profileDir = join(root, "artifacts", "save-smoke-profile");
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });
const browser = spawn(browserPath, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", "--disable-background-networking", "--mute-audio",
  `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`, "about:blank",
], { stdio: "ignore" });

async function browserInfo(): Promise<{ webSocketDebuggerUrl: string }> {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      if (res.ok) return (await res.json()) as { webSocketDebuggerUrl: string };
    } catch { /* 還沒起來 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("瀏覽器 CDP 連不上");
}

type CdpEvent = { method: string; params: any; sessionId?: string };
class Cdp {
  private ws!: WebSocket;
  private next = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handlers: ((e: CdpEvent) => void)[] = [];
  static async connect(url: string): Promise<Cdp> {
    const c = new Cdp();
    c.ws = new WebSocket(url);
    await new Promise<void>((res, rej) => { c.ws.onopen = () => res(); c.ws.onerror = () => rej(new Error("CDP WebSocket 失敗")); });
    c.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id != null) {
        const p = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        if (!p) return;
        if (msg.error) p.reject(new Error(`${msg.error.message}`));
        else p.resolve(msg.result);
      } else c.handlers.forEach((h) => h(msg));
    };
    return c;
  }
  on(h: (e: CdpEvent) => void) { this.handlers.push(h); }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`CDP 逾時:${method}`)); }, 60_000);
    });
  }
  close() { try { this.ws.close(); } catch { /* 已關 */ } }
}

/** 頁面裡跑的體檢:回傳畫面到底有沒有東西。刻意寫成純字串,避免被打包器碰到。 */
const PROBE = `(() => {
  const app = document.getElementById("app");
  const nodes = app ? app.querySelectorAll("*").length : 0;
  const text = (document.body.innerText || "").trim();
  let canvases = 0, painted = 0;
  for (const cv of document.querySelectorAll("canvas")) {
    canvases++;
    try {
      const ctx = cv.getContext("2d");
      if (!ctx || !cv.width || !cv.height) continue;
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4 * 97) seen.add(d[i] + "," + d[i + 1] + "," + d[i + 2]);
      if (seen.size > 1) painted++;
    } catch (e) { /* 跨源或尺寸為 0 */ }
  }
  let saveVersion = null, saveGameMs = null;
  try {
    const raw = localStorage.getItem(${JSON.stringify(SAVE_KEY)});
    if (raw) { const s = JSON.parse(raw); saveVersion = s.v; saveGameMs = s.gameMs; }
  } catch (e) { /* localStorage 不可用 */ }
  return { nodes, textLen: text.length, hasErrorNotice: text.includes("畫面發生錯誤"), hasBootFail: text.includes("遊戲檔案載入失敗"), canvases, painted, saveVersion, saveGameMs };
})()`;

interface Probe { nodes: number; textLen: number; hasErrorNotice: boolean; hasBootFail: boolean; canvases: number; painted: number; saveVersion: number | null; saveGameMs: number | null }

const info = await browserInfo();
const cdp = await Cdp.connect(info.webSocketDebuggerUrl);

async function runCase(c: (typeof CASES)[number]): Promise<void> {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const problems: string[] = [];
  cdp.on((ev) => {
    if (ev.sessionId !== sessionId) return;
    if (ev.method === "Runtime.exceptionThrown") {
      const d = ev.params.exceptionDetails;
      problems.push(`未捕捉例外:${d?.exception?.description ?? d?.text ?? "(無訊息)"}`);
    } else if (ev.method === "Runtime.consoleAPICalled" && ev.params.type === "error") {
      problems.push(`console.error:${(ev.params.args ?? []).map((a: any) => a.description ?? a.value ?? a.type).join(" ")}`);
    } else if (ev.method === "Log.entryAdded" && ev.params.entry?.level === "error" && ev.params.entry?.source !== "network") {
      problems.push(`log(${ev.params.entry.source}):${ev.params.entry.text}`);
    }
  });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Log.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);

  // 先到同源空白頁種存檔,再導向 app —— 這就是「拿既有存檔啟動」的關鍵一步
  await cdp.send("Page.navigate", { url: `${origin}/__smoke_blank__` }, sessionId);
  await new Promise((r) => setTimeout(r, 300));
  if (c.fixture) {
    const raw = JSON.parse(readFileSync(join(fixtureDir, c.fixture), "utf8"));
    // 離線 N 個遊戲小時:重錨到「現在」往回推,啟動時 syncToNow() 必須補完 N 小時
    raw.gameAnchorMs = raw.gameMs;
    raw.realAnchorMs = Date.now() - c.offlineHours * REAL_MS_PER_GAME_HOUR;
    const expr = `localStorage.clear(); localStorage.setItem(${JSON.stringify(SAVE_KEY)}, ${JSON.stringify(JSON.stringify(raw))}); "ok"`;
    const seeded = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId);
    if (seeded.result?.value !== "ok") problems.push("種存檔失敗");
  } else {
    await cdp.send("Runtime.evaluate", { expression: "localStorage.clear()" }, sessionId);
  }
  const fixtureGameMs = c.fixture ? JSON.parse(readFileSync(join(fixtureDir, c.fixture), "utf8")).gameMs as number : 0;

  /** 導向 app 並等畫面長出來;逾時回傳最後一次體檢結果(通常就是白畫面的證據) */
  async function boot(label: string): Promise<Probe> {
    await cdp.send("Page.navigate", { url: `${origin}/` }, sessionId);
    let probe: Probe = { nodes: 0, textLen: 0, hasErrorNotice: false, hasBootFail: false, canvases: 0, painted: 0, saveVersion: null, saveGameMs: null };
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const res = await cdp.send("Runtime.evaluate", { expression: PROBE, returnByValue: true, awaitPromise: false }, sessionId);
        if (res.result?.value) probe = res.result.value as Probe;
      } catch { /* 導向中,下一輪再問 */ }
      if (probe.nodes > 20 && probe.textLen > 20 && probe.painted > 0) break;
    }
    try {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
      writeFileSync(join(shotDir, `${c.id}-${label}.png`), Buffer.from(shot.data, "base64"));
    } catch { /* 截圖失敗不影響判定 */ }
    return probe;
  }

  const first = await boot("boot");
  const name = `${c.id}:${c.label}`;
  check(`${name} · 畫面有內容(非白畫面)`, first.nodes > 20 && first.textLen > 20, `nodes=${first.nodes} textLen=${first.textLen}`);
  check(`${name} · 樓層畫布有畫東西(非黑畫面)`, first.canvases > 0 && first.painted > 0, `canvas=${first.canvases} painted=${first.painted}`);
  check(`${name} · 沒有可見的錯誤通知`, !first.hasErrorNotice);
  check(`${name} · 存檔升到現行版`, first.saveVersion === 10, `v=${first.saveVersion}`);
  if (c.offlineHours > 0) {
    const advanced = (first.saveGameMs ?? 0) - fixtureGameMs;
    check(`${name} · 離線進度真的補上了(syncToNow 跑過 hourlyTick)`, advanced >= 3600_000, `前進 ${Math.round(advanced / 3600_000)} 遊戲小時`);
  }
  // 在畫面活著的狀態下快轉 48 遊戲小時:載入當下沒事,不代表跑起來沒事。
  // 這一段才會讓渲染迴圈、互動演出與姿勢、換日日記真的在瀏覽器裡跑過一遍。
  const beforeFf = first.saveGameMs ?? 0;
  await cdp.send("Runtime.evaluate", { expression: `window.rentDebug?.fastForward?.(${FAST_FORWARD_HOURS})` }, sessionId);
  let after: Probe = first;
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const res = await cdp.send("Runtime.evaluate", { expression: PROBE, returnByValue: true }, sessionId);
    if (res.result?.value) after = res.result.value as Probe;
    if ((after.saveGameMs ?? 0) - beforeFf >= (FAST_FORWARD_HOURS - 1) * 3600_000) break;
  }
  try {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
    writeFileSync(join(shotDir, `${c.id}-fastforward.png`), Buffer.from(shot.data, "base64"));
  } catch { /* 截圖失敗不影響判定 */ }
  check(`${name} · 快轉 ${FAST_FORWARD_HOURS} 遊戲小時後畫面還在`, after.nodes > 20 && after.textLen > 20 && after.painted > 0 && !after.hasErrorNotice,
    `nodes=${after.nodes} painted=${after.painted} 錯誤通知=${after.hasErrorNotice}`);
  check(`${name} · 快轉真的推進了時間(掛機迴圈沒被例外炸斷)`, (after.saveGameMs ?? 0) - beforeFf >= (FAST_FORWARD_HOURS - 1) * 3600_000,
    `前進 ${Math.round(((after.saveGameMs ?? 0) - beforeFf) / 3600_000)} / ${FAST_FORWARD_HOURS} 遊戲小時`);

  // 再開一次:這一版寫回去的存檔,自己必須讀得回來(遷移後的往返)
  const second = await boot("reload");
  check(`${name} · 重新載入仍然起得來`, second.nodes > 20 && second.textLen > 20 && second.painted > 0, `nodes=${second.nodes} painted=${second.painted}`);

  const unique = [...new Set(problems)];
  check(`${name} · 無 console error / 未捕捉例外`, unique.length === 0, unique.length ? `\n    ${unique.slice(0, 6).join("\n    ")}` : "");
  await cdp.send("Target.closeTarget", { targetId });
}

/**
 * 🔴 反向對照:把一個例外塞進打包後的 JS,本測試**必須因此變紅**。
 *
 * 沒有這一關,「35 通過 / 0 失敗」可能只是偵測本身壞了(CDP 事件改名、探針選錯節點、
 * 例外被吞掉)而測不出任何東西 —— 那正是這次事故裡「六關全綠卻上線白畫面」的翻版。
 * 每次執行都自我驗證一次,成本是一次導頁。
 */
async function selfCheck(): Promise<void> {
  injectFault = true;
  try {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    let sawException = false;
    cdp.on((ev) => {
      if (ev.sessionId !== sessionId) return;
      if (ev.method === "Runtime.exceptionThrown" || (ev.method === "Log.entryAdded" && ev.params.entry?.level === "error" && ev.params.entry?.source !== "network")) sawException = true;
    });
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Log.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Page.navigate", { url: `${origin}/` }, sessionId);
    let probe: Probe | null = null;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const res = await cdp.send("Runtime.evaluate", { expression: PROBE, returnByValue: true }, sessionId);
        if (res.result?.value) probe = res.result.value as Probe;
      } catch { /* 導向中 */ }
    }
    check("self-check · 故意打壞打包產物時,本測試偵測得到白畫面", (probe?.nodes ?? 0) <= 20, `nodes=${probe?.nodes}`);
    check("self-check · 故意打壞打包產物時,本測試收得到未捕捉例外", sawException);
    await cdp.send("Target.closeTarget", { targetId });
  } finally {
    injectFault = false;
  }
}

/**
 * 🔴 「舊 HTML 指向已被刪掉的雜湊 JS」關卡 —— 2026-08-18 線上白畫面事故的重現與修復驗收。
 *
 * 事故機制:`[assets] directory = "./dist"` 每次部署都會刪掉上一版的雜湊資產,
 * iOS standalone 又會抓著快取的 index.html 不放 ⇒ 舊 HTML 去要不存在的 JS ⇒ 404 ⇒ 白畫面
 * (console 只有一條 404,沒有 JS 例外,所以上面 selfCheck 那種「丟例外」的偵測抓不到)。
 *
 * 這裡驗兩件事:
 *  (a) 自救會觸發並救回來(重整一次拿到新 HTML);
 *  (b) 救不回來時**不會無限重載**,而是停在看得懂的錯誤畫面。
 */
async function staleHtmlCheck(mode: "once" | "always"): Promise<void> {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  htmlRequests = 0;
  staleHtmlMode = mode;
  await cdp.send("Page.navigate", { url: `${origin}/` }, sessionId);
  let probe: Probe | null = null;
  const recovered = () => mode === "once"
    ? (probe?.nodes ?? 0) > 20 && (probe?.painted ?? 0) > 0
    : !!probe?.hasBootFail;
  for (let i = 0; i < 80; i++) {          // 最多 20 秒:自救含一次 fetch + 一次 reload
    await new Promise((r) => setTimeout(r, 250));
    try {
      const res = await cdp.send("Runtime.evaluate", { expression: PROBE, returnByValue: true }, sessionId);
      if (res.result?.value) probe = res.result.value as Probe;
    } catch { /* 導向中 */ }
    if (recovered()) break;
  }
  try {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
    writeFileSync(join(shotDir, `stale-html-${mode}.png`), Buffer.from(shot.data, "base64"));
  } catch { /* 截圖失敗不影響判定 */ }
  if (mode === "once") {
    check("stale-html(舊 HTML 只出現一次)· 自救重整後畫面救回來了",
      (probe?.nodes ?? 0) > 20 && (probe?.textLen ?? 0) > 20 && (probe?.painted ?? 0) > 0,
      `nodes=${probe?.nodes} painted=${probe?.painted} HTML 請求=${htmlRequests}`);
    check("stale-html(舊 HTML 只出現一次)· 真的有重新抓過 HTML(不是碰巧沒壞)", htmlRequests >= 2, `HTML 請求=${htmlRequests}`);
  } else {
    check("stale-html(HTML 永遠是舊的)· 停在看得懂的錯誤畫面,不是白畫面", !!probe?.hasBootFail,
      `nodes=${probe?.nodes} textLen=${probe?.textLen} HTML 請求=${htmlRequests}`);
    check("stale-html(HTML 永遠是舊的)· 只自救一次,沒有無限重載", htmlRequests <= 4, `HTML 請求=${htmlRequests}`);
  }
  staleHtmlMode = "off";
  await cdp.send("Target.closeTarget", { targetId });
}

/**
 * 打包產物的靜態體檢 —— 不用開瀏覽器就能擋掉的低級錯誤。
 * `_headers` 是白畫面根因修復的第一道(HTML no-store);自救腳本則必須真的活在
 * head 裡、且排在 vite 注入的 module script 之前(曾經因為註解裡寫了 head 結束標籤,
 * 害 vite 把 module script 注入到註解內部,整包 app 直接不載入)。
 */
function distStaticCheck(): void {
  const headersPath = join(distDir, "_headers");
  const hasHeaders = existsSync(headersPath);
  check("dist/_headers · 有被 vite 從 public/ 複製進去", hasHeaders);
  if (hasHeaders) {
    // `_headers` 的區塊格式:一行路徑,下一行縮排的 header
    const headerLines = readFileSync(headersPath, "utf8").split(/\r?\n/);
    const rule = (path: string) => {
      const at = headerLines.findIndex((line) => line.trim() === path);
      return at < 0 ? "" : (headerLines[at + 1] ?? "").trim();
    };
    check("dist/_headers · HTML 設成 no-store", rule("/") === "Cache-Control: no-store", rule("/"));
    check("dist/_headers · /index.html 也 no-store", rule("/index.html") === "Cache-Control: no-store", rule("/index.html"));
    check("dist/_headers · 雜湊資產維持長快取", rule("/assets/*.js").includes("immutable"), rule("/assets/*.js"));
  }
  const html = readFileSync(join(distDir, "index.html"), "utf8");
  const stripped = html.replace(/<!--[\s\S]*?-->/g, "");
  const moduleAt = stripped.indexOf('<script type="module"');
  const inlineAt = stripped.indexOf("__rhBootOk");
  check("dist/index.html · 白畫面自救腳本有進打包產物", inlineAt >= 0);
  check("dist/index.html · vite 的 module script 沒有被注入到註解裡", moduleAt >= 0);
  check("dist/index.html · 自救腳本排在 module script 之前(否則會跟載入失敗搶跑)",
    inlineAt >= 0 && moduleAt >= 0 && inlineAt < moduleAt, `inline@${inlineAt} module@${moduleAt}`);
  check("dist/index.html · 自救腳本在 head 區塊內", inlineAt >= 0 && inlineAt < stripped.indexOf("<body"));
}

let crashed: unknown = null;
try {
  distStaticCheck();
  await selfCheck();
  await staleHtmlCheck("once");
  await staleHtmlCheck("always");
  for (const c of CASES) await runCase(c);
} catch (e) {
  crashed = e;
  check("煙霧測試本身執行完成", false, String((e as Error)?.message ?? e));
}

cdp.close();
browser.kill();
server.close();

console.log(`\n結果:${pass} 通過 / ${fail} 失敗`);
console.log(`截圖:${shotDir}`);
if (crashed) console.error(crashed);
process.exit(fail > 0 ? 1 : 0);
