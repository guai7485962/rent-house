<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { state, exportSave, exportDebugLog, importSave, clearSave } from "../store";

/** 備份狀態提醒:iOS Safari 對 7 天未造訪的網站可能清掉 localStorage → 鼓勵定期匯出 */
const backup = computed(() => {
  if (!state.lastBackupMs) return { text: "⚠️ 你還沒備份過存檔。建議匯出保存,以免瀏覽器清資料時進度消失。", tone: "warn" };
  const days = Math.floor((Date.now() - state.lastBackupMs) / (24 * 3600 * 1000));
  const ago = days <= 0 ? "今天" : `${days} 天前`;
  if (days >= 7) return { text: `⚠️ 上次備份是 ${ago},建議再匯出一次(iOS 可能清掉久未造訪網站的存檔)。`, tone: "warn" };
  return { text: `✅ 上次備份:${ago}。`, tone: "ok" };
});

function toggleAdult() {
  state.adultMode = !state.adultMode;
}

const emit = defineEmits<{ close: [] }>();

const confirmReset = ref(false); // 二次確認:第一下變紅、第二下才真的清檔
const importText = ref("");
const showImport = ref(false);
const exportText = ref(""); // 剪貼簿不可用時的手動複製 fallback
const debugText = ref("");
const debugArea = ref<HTMLTextAreaElement | null>(null);
const note = ref("");

/** 部分 WebView 的 Clipboard Promise 會卡住不 resolve/reject；逾時後必須繼續走手動備援。 */
async function copyByClipboard(text: string, timeoutMs = 1200): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false;
  try {
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("clipboard timeout")), timeoutMs)),
    ]);
    return true;
  } catch {
    return false;
  }
}

function onReset() {
  if (!confirmReset.value) {
    confirmReset.value = true;
    note.value = "再按一次就會刪除存檔、從頭開始(無法復原)!";
    return;
  }
  clearSave();
  location.reload();
}

async function onExport() {
  const json = exportSave();
  if (!json) {
    note.value = "讀不到存檔(localStorage 不可用)。";
    return;
  }
  if (await copyByClipboard(json)) {
    exportText.value = "";
    note.value = "✅ 存檔已複製到剪貼簿,貼到記事本保存吧。";
  } else {
    exportText.value = json;
    note.value = "剪貼簿不可用,請手動全選複製下面的文字。";
  }
}

async function onDebugExport() {
  debugText.value = exportDebugLog();
  await nextTick();
  if (await copyByClipboard(debugText.value)) {
    note.value = "✅ 除錯 Log 已複製；下方也保留全文，方便先檢查再貼給開發者。";
    return;
  }
  // Clipboard API 在非 HTTPS、iOS 權限拒絕或逾時時不可用；沿用 NBA 的傳統複製備援。
  debugArea.value?.focus();
  debugArea.value?.select();
  try {
    if (document.execCommand("copy")) {
      note.value = "✅ 除錯 Log 已複製；下方也保留全文。";
      return;
    }
  } catch {
    // 最後仍保留 readonly textarea，讓玩家長按／全選手動複製。
  }
  note.value = "無法自動複製，請在下方文字框長按或全選後手動複製。";
}

function onImport() {
  const raw = importText.value.trim();
  if (!raw) {
    note.value = "請先貼上存檔內容。";
    return;
  }
  if (importSave(raw)) {
    location.reload();
  } else {
    note.value = "❌ 這不是有效的存檔(格式或版本不對),沒有動你目前的進度。";
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="panel">
      <header class="head">
        <div class="ttl">⚙️ 設定 / 存檔</div>
        <button class="x" @click="emit('close')">✕</button>
      </header>

      <div class="body">
        <section class="sec">
          <div class="sec-ttl">備份與轉移</div>
          <p class="desc">存檔存在這個瀏覽器裡;換裝置或清瀏覽器資料前,先匯出保存。</p>
          <div class="backup-status" :class="backup.tone">{{ backup.text }}</div>
          <div class="row">
            <button class="btn" @click="onExport">📋 匯出存檔</button>
            <button class="btn" @click="showImport = !showImport">📥 匯入存檔</button>
          </div>
          <textarea
            v-if="exportText"
            class="ta"
            readonly
            :value="exportText"
            @focus="($event.target as HTMLTextAreaElement).select()"
          ></textarea>
          <template v-if="showImport">
            <textarea v-model="importText" class="ta" placeholder="把之前匯出的存檔 JSON 貼在這裡"></textarea>
            <button class="btn full" @click="onImport">確認匯入(會蓋掉目前進度並重新載入)</button>
          </template>
        </section>

        <section class="sec">
          <div class="sec-ttl">🛠️ 除錯 Log</div>
          <p class="desc">
            產生當下完整遊戲狀態，包含現役房客的 tags／logs、全樓狀態，以及功能推出後離開房客的 tags／logs 快照。
            這份資料只會在你按下按鈕後顯示並複製，不會自動上傳。
          </p>
          <button class="btn full" @click="onDebugExport">📋 產生並複製除錯 Log</button>
          <textarea
            v-if="debugText"
            ref="debugArea"
            class="ta debug-ta"
            readonly
            :value="debugText"
            aria-label="除錯 Log 全文"
            @focus="($event.target as HTMLTextAreaElement).select()"
          ></textarea>
        </section>

        <section class="sec">
          <div class="sec-ttl">🔞 成人內容(18+)</div>
          <p class="desc">
            開啟後,<b>成年情侶</b>之間會出現含蓄的親密互動(一起洗澡、共度夜晚等,畫面僅以霧氣/關燈暗示)。
            未成年角色無論此開關狀態,都不會有任何戀愛與親密內容。
          </p>
          <button class="btn full" :class="{ adulton: state.adultMode }" @click="toggleAdult">
            {{ state.adultMode ? "✅ 已開啟(點擊關閉)" : "🔒 已關閉(我已滿 18 歲,點擊開啟)" }}
          </button>
        </section>

        <section class="sec">
          <div class="sec-ttl">危險區</div>
          <p class="desc">刪除存檔、回到全新開局:家具、租客、關係、帳目全部歸零。</p>
          <button class="btn danger full" :class="{ armed: confirmReset }" @click="onReset">
            {{ confirmReset ? "⚠️ 確定刪除,重新開始!" : "🗑️ 重新開始" }}
          </button>
        </section>

        <section class="sec">
          <div class="sec-ttl">美術素材</div>
          <p class="desc">
            <a href="https://limezu.itch.io/moderninteriors" target="_blank" rel="noopener noreferrer">
              Modern Interiors by LimeZu
            </a>
          </p>
        </section>

        <p v-if="note" class="note" aria-live="polite">{{ note }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; z-index: 125; background: rgba(8,7,12,0.72); backdrop-filter: blur(3px); display: flex; align-items: flex-end; justify-content: center; }
.panel { width: 100%; max-width: 430px; max-height: 84vh; background: var(--panel-2); border: 1px solid var(--line); border-radius: 16px 16px 0 0; display: flex; flex-direction: column; animation: up 0.25s ease-out; }
@keyframes up { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.head { display: flex; align-items: center; padding: 14px 16px 10px; border-bottom: 1px solid var(--line); }
.ttl { font-weight: 700; font-size: 15px; }
.x { margin-left: auto; background: none; color: var(--text-dim); font-size: 16px; }

.body { overflow-y: auto; padding: 12px 16px 20px; display: flex; flex-direction: column; gap: 14px; }
.backup-status { font-size: 11.5px; line-height: 1.5; border-radius: 8px; padding: 7px 10px; margin-bottom: 8px; border: 1px solid var(--line); }
.backup-status.warn { color: #ffd6a3; background: rgba(255, 180, 90, 0.08); border-color: rgba(255, 180, 90, 0.3); }
.backup-status.ok { color: var(--text-dim); }
.sec { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.sec-ttl { font-size: 12px; font-weight: 700; color: var(--text-dim); }
.desc { font-size: 12px; color: var(--text-dim); line-height: 1.6; }
.desc a { color: var(--accent); }
.row { display: flex; gap: 8px; }
.btn { flex: 1; background: var(--panel-2); border: 1px solid var(--line); color: var(--text); border-radius: 10px; padding: 10px 0; font-size: 13px; }
.btn:hover { border-color: var(--accent-2); }
.btn.full { width: 100%; }
.btn.danger { border-color: var(--bad); color: #ff9aa8; }
.btn.adulton { border-color: #d9548a; color: #f0a8c6; background: rgba(217,84,138,0.12); }
.btn.danger.armed { background: rgba(232,101,122,0.2); font-weight: 700; }
.ta { width: 100%; min-height: 90px; background: #0d0c12; border: 1px solid var(--line); border-radius: 8px; color: var(--text); font-size: 11px; padding: 8px; resize: vertical; font-family: monospace; }
.debug-ta { min-height: 180px; line-height: 1.45; }
.note { font-size: 12.5px; color: var(--accent); line-height: 1.6; text-align: center; }
</style>
