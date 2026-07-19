<script setup lang="ts">
import { computed } from "vue";
import { listRelationships, relationshipProgressHint } from "../sim/social";
import { feudActive } from "../sim/conflicts";
import { state, cohabitingPartnerId } from "../store";

const emit = defineEmits<{ close: [] }>();

const name = (id: string) => state.runtimes[id]?.tenant.name ?? "已搬走";

/** 姓名後的性別小符號;資料缺漏顯示紅色「?」(debug 用,正常資料不該出現) */
const genderMark = (id: string): { sym: string; cls: string } => {
  const g = state.runtimes[id]?.tenant.gender;
  if (g === "male") return { sym: "♂", cls: "g-m" };
  if (g === "female") return { sym: "♀", cls: "g-f" };
  if (g === "nonbinary") return { sym: "⚧", cls: "g-nb" };
  return { sym: "?", cls: "g-miss" };
};

const rels = computed(() =>
  listRelationships((id) => state.runtimes[id]?.tenant)
    .filter((r) => state.runtimes[r.aId] && state.runtimes[r.bId]),
);

/** 這一「對」是否真的同居中；共用模擬層的一對一判定，避免 UI 與規則分歧。 */
const isCohabit = (r: { aId: string; bId: string }) => cohabitingPartnerId(r.aId) === r.bId;

const progressHint = (r: { aId: string; bId: string; value: number; romantic: boolean }): string => {
  const a = state.runtimes[r.aId]?.tenant;
  const b = state.runtimes[r.bId]?.tenant;
  return a && b ? relationshipProgressHint(r, a, b) : "";
};

const bestFriendLabels = new Set(["閨密", "哥們", "摯友"]);

/** 分組:情侶(置頂)/ 曖昧 / 摯友 / 朋友 / 認識中 */
const groups = computed(() => {
  const all = rels.value;
  return [
    { title: "❤️ 情侶", rows: all.filter((r) => r.romantic) },
    { title: "💕 曖昧", rows: all.filter((r) => !r.romantic && r.label === "曖昧") },
    { title: "🌟 摯友", rows: all.filter((r) => !r.romantic && bestFriendLabels.has(r.label)) },
    { title: "🤝 朋友", rows: all.filter((r) => !r.romantic && r.value >= 35 && r.value < 75) },
    { title: "👋 認識中", rows: all.filter((r) => !r.romantic && r.value < 35) },
  ].filter((g) => g.rows.length > 0);
});
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="panel">
      <header class="head">
        <div class="ttl">💞 鄰居關係</div>
        <button class="x" @click="emit('close')">✕</button>
      </header>

      <div v-if="rels.length === 0" class="empty">
        鄰居們還不熟。讓他們在交誼廳多碰面(佈置沙發/電視/餐桌),關係就會開始發展。
      </div>

      <div v-else class="list">
        <template v-for="g in groups" :key="g.title">
          <div class="grp">{{ g.title }}</div>
          <div v-for="r in g.rows" :key="r.aId + r.bId" class="row" :class="{ love: r.romantic }">
            <span class="pair">
              {{ name(r.aId) }}<span class="gsym" :class="genderMark(r.aId).cls">{{ genderMark(r.aId).sym }}</span>
              <span class="amp">×</span>
              {{ name(r.bId) }}<span class="gsym" :class="genderMark(r.bId).cls">{{ genderMark(r.bId).sym }}</span>
              <span v-if="isCohabit(r)" class="cohab">🏠 同居中</span>
              <span v-if="feudActive(r.aId, r.bId)" class="feud">❄️ 冷戰中</span>
            </span>
            <span class="tier">{{ r.label }} <b class="val">{{ r.value }}</b></span>
            <div class="bar"><div :style="{ width: r.value + '%' }"></div></div>
            <p class="next">{{ progressHint(r) }}</p>
          </div>
        </template>
      </div>

      <p class="foot">關係由個性是否合拍決定;不走戀愛線的高好感朋友會成為閨密、哥們或摯友。具戀愛可能且互有好感才會曖昧、交往與同居。</p>
    </div>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; z-index: 120; background: rgba(8,7,12,0.72); backdrop-filter: blur(3px); display: flex; align-items: flex-end; justify-content: center; }
.panel { width: 100%; max-width: 430px; max-height: 82vh; background: var(--panel-2); border: 1px solid var(--line); border-radius: 16px 16px 0 0; display: flex; flex-direction: column; animation: up 0.25s ease-out; }
@keyframes up { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.head { display: flex; align-items: center; padding: 14px 16px 10px; border-bottom: 1px solid var(--line); }
.ttl { font-weight: 700; font-size: 15px; }
.x { margin-left: auto; background: none; color: var(--text-dim); font-size: 16px; }
.empty { padding: 24px 18px; color: var(--text-dim); font-size: 13px; line-height: 1.7; text-align: center; }
.list { overflow-y: auto; padding: 10px 16px; display: flex; flex-direction: column; gap: 10px; }
.grp { font-size: 11.5px; color: var(--text-dim); margin-top: 4px; letter-spacing: 1px; }
.cohab { font-size: 10.5px; color: #f0a8c6; border: 1px solid #d9548a; border-radius: 999px; padding: 1px 7px; margin-left: 6px; vertical-align: 1px; }
.feud { font-size: 10.5px; color: #9fc4e8; border: 1px solid #4a7aa8; border-radius: 999px; padding: 1px 7px; margin-left: 6px; vertical-align: 1px; }
.val { font-size: 11px; color: var(--text-dim); font-weight: 600; margin-left: 3px; font-variant-numeric: tabular-nums; }
.row { display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; align-items: center; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
.row.love { border-color: #d9548a; background: rgba(217,84,138,0.08); }
.pair { font-size: 13.5px; font-weight: 600; }
.gsym { font-size: 10px; font-weight: 700; margin-left: 1px; vertical-align: 2px; }
.g-m { color: #9ec5e8; }
.g-f { color: #f0a8c6; }
.g-nb { color: #c9b3ea; }
.g-miss { color: #ff6b6b; }
.amp { color: var(--text-dim); margin: 0 2px; }
.tier { font-size: 12px; color: var(--accent); text-align: right; }
.bar { grid-column: 1 / -1; height: 6px; background: #17151f; border-radius: 4px; overflow: hidden; }
.bar > div { height: 100%; background: linear-gradient(90deg, var(--accent-2), #d9548a); border-radius: 4px; transition: width 0.5s; }
.next { grid-column: 1 / -1; margin: 2px 0 0; color: var(--text-dim); font-size: 11px; line-height: 1.55; }
.foot { font-size: 11.5px; color: var(--text-dim); padding: 8px 16px 16px; line-height: 1.6; }
</style>
