<script setup lang="ts">
/**
 * 送養紀錄的像素合照。canvas 本身維持 72×56 的**邏輯解析度**,
 * 放大交給 CSS 的 `image-rendering: pixelated`(最近鄰)——這樣不論裝置 DPR 多少,
 * 像素都是硬邊的方塊,也不必為了高 DPI 重畫。
 */
import { onMounted, ref, watch } from "vue";
import { drawPetPhoto, photoSpecFromHome, PET_PHOTO_W, PET_PHOTO_H } from "../floor/petPhoto";
import type { PetHomeEntry } from "../types";

const props = withDefaults(defineProps<{ entry: PetHomeEntry; scale?: number }>(), { scale: 2 });

const canvas = ref<HTMLCanvasElement | null>(null);

function paint() {
  const ctx = canvas.value?.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  drawPetPhoto(ctx, photoSpecFromHome(props.entry));
}

onMounted(paint);
watch(() => props.entry.id, paint);
</script>

<template>
  <canvas
    ref="canvas"
    class="pet-photo"
    :width="PET_PHOTO_W"
    :height="PET_PHOTO_H"
    :style="{ width: `${PET_PHOTO_W * props.scale}px`, height: `${PET_PHOTO_H * props.scale}px` }"
    :aria-label="`${entry.name} 與新飼主${entry.adopterName ? ` ${entry.adopterName}` : ''}的合照`"
    role="img"
  ></canvas>
</template>

<style scoped>
.pet-photo {
  flex-shrink: 0;
  image-rendering: pixelated;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}
</style>
