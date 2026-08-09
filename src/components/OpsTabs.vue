<script lang="ts">
/**
 * 2026-08-09:「💰 收支」與「☕ 寵物咖啡廳營運」合併成同一顆入口按鈕(使用者要求),
 * 兩個面板改用這條共用的分頁列互切。
 *
 * 為什麼是共用元件而不是各自寫一條:分頁文案與樣式只有一份,兩邊不會走鐘;
 * 兩個面板的內容、狀態與既有測試都不必動,只換掉各自的 header。
 */
export type OpsTab = "finance" | "cafe";

/** 分頁文案的唯一出處。 */
export const OPS_TABS: readonly { id: OpsTab; label: string }[] = [
  { id: "finance", label: "💰 收支" },
  { id: "cafe", label: "☕ 咖啡廳" },
];
</script>

<script setup lang="ts">
const props = defineProps<{ active: OpsTab }>();
const emit = defineEmits<{ select: [tab: OpsTab]; close: [] }>();

/** 上面那個 `<script>` 區塊是模組層(型別與常數要 export 出去),這裡取來給樣板用。 */
const tabs = OPS_TABS;

function pick(tab: OpsTab) {
  if (tab !== props.active) emit("select", tab);
}
</script>

<template>
  <header class="ops-head">
    <div class="ops-tabs" role="tablist" aria-label="營運分頁">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="ops-tab"
        :class="{ on: t.id === active }"
        role="tab"
        :aria-selected="t.id === active"
        @click="pick(t.id)"
      >{{ t.label }}</button>
    </div>
    <button class="ops-x" aria-label="關閉面板" @click="emit('close')">✕</button>
  </header>
</template>

<style scoped>
.ops-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 14px 10px;
  border-bottom: 1px solid var(--line);
  background: linear-gradient(135deg, rgba(207, 139, 91, 0.14), rgba(91, 126, 96, 0.1));
}
.ops-tabs { display: flex; gap: 6px; }
.ops-tab {
  min-height: 34px;
  padding: 7px 13px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel);
  color: var(--text-dim);
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
}
.ops-tab.on {
  border-color: var(--accent);
  background: rgba(255, 180, 94, 0.16);
  color: #ffe6c2;
}
.ops-x { margin-left: auto; background: none; color: var(--text-dim); font-size: 17px; padding: 8px; }
</style>
