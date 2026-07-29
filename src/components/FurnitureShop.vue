<script setup lang="ts">
import { computed, ref } from "vue";
import { CATALOG, type FurnCategory } from "../furniture/catalog";
import { tierChipText, tierOf } from "../furniture/tier";
import { INTERACTIONS } from "../sim/interactions";
import { state, startPlacing } from "../store";

/** 這件家具會解鎖哪些互動(§10-6 地點條件即玩法 → 商店裡就是賣點) */
const INTERACTION_NAME: Record<string, string> = {
  cuddle_tv: "窩著看劇", lazy_morning: "賴床", night_intimacy: "🔞 親密夜晚",
  loveseat_cuddle: "戀人依偎", private_dinner: "雙人約會晚餐", pillow_talk: "帷幔枕邊話",
  loveseat_after_dark: "🔞 沙發私密時光", canopy_private_night: "🔞 帷幔私密夜晚",
  game_night: "開黑打電動", share_earbuds: "共用耳機",
};
function unlocks(defId: string): string[] {
  return INTERACTIONS.filter((d) => d.requiresFurniture?.includes(defId))
    .map((d) => INTERACTION_NAME[d.id])
    .filter((n): n is string => !!n);
}

const emit = defineEmits<{ close: [] }>();

const CAT_LABEL: Record<FurnCategory, string> = {
  sleep: "睡眠", work: "工作", av: "影音", seating: "座椅",
  kitchen: "餐廚", storage: "收納", ambiance: "氛圍", utility: "機能",
};
const ATTR_LABEL: Record<string, string> = {
  tech: "科技", cozy: "療癒", noise: "噪音", soundproof: "隔音", storage: "收納", style: "品味",
};
/**
 * 只賣可放地板的家具(牆面家具略過),依類別分組。
 *
 * **非賣品(`price <= 0`)不上架**:商店是「花錢換東西」的地方,沒有標價的東西本來就
 * 不該出現在貨架上。目前唯一符合的是 5 件畢業生紀念物(`memorial_*`,price 0)——
 * 它們的設定是「畢業生離開時留在原房間的禮物」,在商店花 $0 買得到本身就違反設定;
 * 而且自從 tier 接上舒適度後,每件免費 +0.5,塞滿就能零成本把 `tierPart` 拉到上限,
 * 直接推翻「花更多錢買更好的家具」這個前提。
 *
 * 判準用 `price <= 0`(非賣品)而不是 `id.startsWith("memorial_")`:
 * `FurnitureDef` 上**沒有** memorial 欄位(那面旗標掛在 `Placement` 上,由畢業流程寫入),
 * 所以 def 層唯一能用的訊號就是價格;而且「非賣品不上架」是關於商店的通則,
 * 未來若再有其他贈品/獎勵型家具也會自動擋掉,比綁 id 前綴穩健。
 * `data-catalog-test.ts` 有斷言釘住「被擋掉的正好是那 5 件紀念物」,
 * 日後若出現「應該可購買的 $0 家具」會直接紅燈,強迫做一次明確決定。
 *
 * ⚠️ 只擋**購買入口**:紀念物本身的 tier fallback(standard、+0.5)與已擺放的紀念物
 * 完全不受影響——畢業生留下的紀念物給舒適度加分是對玩家的正當回饋,是設計意圖不是漏洞。
 */
const groups = computed(() => {
  const byCat = new Map<FurnCategory, typeof CATALOG>();
  for (const d of CATALOG) {
    if (d.placement === "wall") continue;
    if (d.price <= 0) continue; // 非賣品(畢業生紀念物)
    if (!byCat.has(d.category)) byCat.set(d.category, []);
    byCat.get(d.category)!.push(d);
  }
  return [...byCat.entries()].map(([cat, items]) => ({ cat, label: CAT_LABEL[cat], items }));
});

const note = ref("");
function buy(defId: string) {
  const res = startPlacing(defId);
  if (res.ok) {
    emit("close"); // 進入擺放模式,關閉商店讓玩家點地圖選位置
  } else {
    note.value = `買不了:${res.reason}`;
    window.setTimeout(() => (note.value = ""), 1800);
  }
}
function attrs(d: (typeof CATALOG)[number]) {
  return Object.entries(d.attributes).filter(([, v]) => v);
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="shop">
      <header class="shop-head">
        <div class="ttl">🛒 家具商店</div>
        <div class="money">💰 {{ state.money.toLocaleString() }}</div>
        <button class="x" @click="emit('close')">✕</button>
      </header>

      <div class="room-pick">選好家具後,回到地圖點一格擺放。</div>

      <div v-if="note" class="note">{{ note }}</div>

      <div class="list">
        <template v-for="g in groups" :key="g.cat">
          <div class="cat">{{ g.label }}</div>
          <div v-for="d in g.items" :key="d.id" class="item">
            <div class="info">
              <div class="name">
                {{ d.name }}
                <!-- 一律用 tierOf():未標 tier 的家具 fallback 成 standard 也**確實有 +0.5**,
                     若用 v-if="d.tier" 就會出現「有分卻沒標示」,玩家看不出 0.5 從哪來 -->
                <span class="tier" :class="tierOf(d)" title="品質層級:每件家具依此加房間舒適度">{{ tierChipText(tierOf(d)) }}</span>
              </div>
              <div class="chips">
                <span class="fp">{{ d.footprint.w }}×{{ d.footprint.h }}</span>
                <span v-for="[k, v] in attrs(d)" :key="k" class="a">{{ ATTR_LABEL[k] ?? k }}{{ v! > 0 ? "+" : "" }}{{ v }}</span>
                <span v-for="n in unlocks(d.id)" :key="n" class="u">💞 {{ n }}</span>
                <span v-if="d.effectHint" class="effect">🐾 {{ d.effectHint }}</span>
              </div>
            </div>
            <button class="buy" :disabled="state.money < d.price" @click="buy(d.id)">
              ${{ d.price.toLocaleString() }}
            </button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed; inset: 0; z-index: 120;
  background: rgba(8, 7, 12, 0.72); backdrop-filter: blur(3px);
  display: flex; align-items: flex-end; justify-content: center;
}
.shop {
  width: 100%; max-width: 430px; max-height: 82vh;
  background: var(--panel-2); border: 1px solid var(--line);
  border-radius: 16px 16px 0 0; display: flex; flex-direction: column;
  animation: up 0.25s ease-out;
}
@keyframes up { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

.shop-head {
  display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px;
  border-bottom: 1px solid var(--line);
}
.ttl { font-weight: 700; font-size: 15px; }
.money { margin-left: auto; font-size: 13px; color: var(--accent); font-variant-numeric: tabular-nums; }
.x { background: none; color: var(--text-dim); font-size: 16px; }

.room-pick { padding: 10px 16px 4px; font-size: 12.5px; color: var(--text-dim); }
.room-pick select {
  background: var(--panel); color: var(--text); border: 1px solid var(--line);
  border-radius: 8px; padding: 4px 8px; font-size: 12.5px; margin-left: 4px;
}
.note { margin: 4px 16px; font-size: 12px; color: var(--accent); }

.list { overflow-y: auto; padding: 6px 16px 20px; }
.cat { font-size: 11px; color: var(--text-dim); margin: 12px 0 4px; letter-spacing: 1px; }
.item {
  display: flex; align-items: center; gap: 10px;
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 10px; padding: 8px 12px; margin-bottom: 6px;
}
.info { flex: 1; min-width: 0; }
.name { font-size: 13.5px; }
.tier { font-size: 10px; margin-left: 6px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--line); vertical-align: middle; white-space: nowrap; }
.tier.budget { color: #9fb0c4; }
.tier.standard { color: #7fc6a8; border-color: #4f9b7d; }
.tier.premium { color: #f0c674; border-color: #c79a3a; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.fp { font-size: 10px; color: var(--text-dim); border: 1px solid var(--line); border-radius: 999px; padding: 0 6px; }
.a { font-size: 10px; color: var(--good); border: 1px solid var(--line); border-radius: 999px; padding: 0 6px; }
.u { font-size: 10px; color: #f0a8c6; border: 1px solid #d9548a; border-radius: 999px; padding: 0 6px; }
.effect { font-size: 10px; color: #9ddfc4; border: 1px solid #4f9b7d; border-radius: 999px; padding: 0 6px; }
.buy {
  background: linear-gradient(135deg, var(--accent), #ff9440); color: #2b1a05;
  font-weight: 700; font-size: 12.5px; border-radius: 8px; padding: 8px 12px; white-space: nowrap;
}
.buy:disabled { opacity: 0.4; cursor: not-allowed; filter: grayscale(0.5); }
</style>
