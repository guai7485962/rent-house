import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";
import { notify } from "./sim/gameState";
import { preloadLimezuFurnitureAtlas } from "./art/limezu";

// 美術檔不阻塞 Vue 啟動；尚未載好或載入失敗時家具渲染器會自動走既有程序繪圖。
void preloadLimezuFurnitureAtlas();

// 全域錯誤回報:任何未捕捉錯誤都變成看得見的通知(留存於 🔔 歷史,方便玩家截圖回報)。
// 同一訊息只報一次,避免每幀重複洗版。
const reported = new Set<string>();
function reportError(msg: string) {
  const key = msg.slice(0, 120);
  if (reported.has(key)) return;
  reported.add(key);
  try {
    notify(`⚠️ 畫面發生錯誤(請截圖回報):${key}`);
  } catch {
    /* notify 本身壞了就只剩 console */
  }
  console.error("[global]", msg);
}
window.addEventListener("error", (e) => reportError(e.message || String(e.error)));
window.addEventListener("unhandledrejection", (e) => reportError(String(e.reason?.message ?? e.reason)));

const app = createApp(App);
// Vue 元件層級錯誤(setup/render/watch):預設只進 console,元件會無聲消失——改成看得見
app.config.errorHandler = (err, _instance, info) => {
  reportError(`${(err as Error)?.message ?? err}(${info})`);
};
app.mount("#app");
