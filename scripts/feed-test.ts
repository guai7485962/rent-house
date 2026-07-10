/**
 * 動態 Feed(設計檢討 §3)驗證:
 * 彙整規則(minor 不進/notable+major 進/日記/房東介入/系統通知)/ 排序 /
 * FEED_CAP / 未讀計數與已讀標記 / feedSeenMs 存檔往返
 */

// 先掛假 localStorage 再載入 store(node 沒有 localStorage)
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => {
    mem[k] = v;
  },
  removeItem: (k: string) => {
    delete mem[k];
  },
};

const { state, buildFeed, feedUnreadCount, markFeedSeen, FEED_CAP, exportSave, initGame, stopGame } =
  await import("../src/store");
const { pushSocialLog, notify, fmt } = await import("../src/sim/gameState");
const { hourlyTick } = await import("../src/sim/tick");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean) {
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}`);
  }
}

// --- 1. 彙整與排序 ---
// 用非 live tick(模板日記同步落地);live 模式日記走 async AI,測試等不到
for (let i = 0; i < 30; i++) hourlyTick(false); // 跨一個午夜 → 當日觀察 + 各種日誌
const feed = buildFeed();
check("快轉 30 小時後 Feed 非空", feed.length > 0);
check("依時間新到舊排序", feed.every((e, i) => i === 0 || feed[i - 1].gameMs >= e.gameMs));
check("含當日觀察(kind=diary)", feed.some((e) => e.kind === "diary"));
check("租客條目都帶名字與房號", feed.filter((e) => e.tenantId).every((e) => !!e.tenantName && !!e.roomNo));

// --- 2. 彙整規則:minor 不進、notable 進、decisionNote/notice 各自成類 ---
const chen = state.runtimes["tenant_chen_engineer"];
pushSocialLog(chen, "FEED測試_流水帳", "minor");
pushSocialLog(chen, "FEED測試_大事", "notable");
chen.log.push({
  gameMs: state.gameMs,
  timeLabel: fmt(state.gameMs),
  text: "",
  visualState: chen.tenant.visualState,
  importance: "notable",
  decisionNote: "FEED測試_房東介入",
});
notify("FEED測試_系統公告");
const feed2 = buildFeed();
check("minor 日誌不進 Feed", !feed2.some((e) => e.text.includes("FEED測試_流水帳")));
check("notable 日誌進 Feed(kind=event)", feed2.some((e) => e.kind === "event" && e.text === "FEED測試_大事"));
check("decisionNote → kind=decision", feed2.some((e) => e.kind === "decision" && e.text === "FEED測試_房東介入"));
check("通知 → kind=notice(無租客歸屬)", feed2.some((e) => e.kind === "notice" && e.text === "FEED測試_系統公告" && !e.tenantId));

// --- 3. 未讀計數與已讀標記 ---
check("初始(feedSeenMs=0)全部未讀", feedUnreadCount() === feed2.length);
markFeedSeen();
check("markFeedSeen 後未讀歸零", feedUnreadCount() === 0);
chen.log.push({
  gameMs: state.gameMs + 1, // 晚於已讀點的新動態
  timeLabel: fmt(state.gameMs + 1),
  text: "FEED測試_已讀後的新動態",
  visualState: chen.tenant.visualState,
  importance: "major",
});
check("已讀後湧入的新動態計為未讀", feedUnreadCount() === 1);

// --- 4. FEED_CAP 收斂 ---
for (let i = 0; i < FEED_CAP + 20; i++) pushSocialLog(chen, `FEED測試_灌水${i}`, "notable");
check(`Feed 最多 ${FEED_CAP} 則`, buildFeed().length === FEED_CAP);

// --- 5. feedSeenMs 存檔往返 ---
const seenVal = state.feedSeenMs;
const json = exportSave();
check("feedSeenMs 有入存檔", !!json && JSON.parse(json!).feedSeenMs === seenVal);
state.feedSeenMs = 0; // 弄髒 → 從存檔重載應還原
initGame();
stopGame();
check("重載後 feedSeenMs 還原", state.feedSeenMs === seenVal);

console.log(`\n=== 結果:${pass} 通過 / ${fail} 失敗 ===`);
if (fail > 0) process.exit(1);
