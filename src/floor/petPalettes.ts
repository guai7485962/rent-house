/**
 * 寵物花色的**唯一出處**。2026-08-10 從 `floorScene.ts` 原封不動搬出來
 * ——送養紀錄的像素照片(`petPhoto.ts`)也要用同一組顏色,不能讓兩邊各寫一份:
 * 之後 append 新花色時,照片才會跟著有新顏色,而不是靜靜地畫成橘貓。
 *
 * 🔴 **既有花色的順序與色碼不可動** —— `pet.color` 是存進存檔的索引。新花色一律 append 到尾端。
 */

export interface CatPal {
  body: string; dark: string; belly: string; eye: string; patch: boolean;
  /**
   * `patchA` / `patchB` 是三花那兩塊補丁的顏色,以前寫死在 drawCat 裡;
   * 抽成選填欄位、預設值就是原本的常數 ⇒ 三花逐像素不變,新花色才換得掉補丁顏色。
   * `tabby` / `nose` 只有店貓有,既有四色完全不進那幾行。
   */
  patchA?: string; patchB?: string; tabby?: boolean; nose?: string;
}

export const CAT_PALS: CatPal[] = [
  { body: "#e0913f", dark: "#b46c22", belly: "#f6cb9e", eye: "#26232f", patch: false }, // 橘貓
  { body: "#413e4e", dark: "#2b2937", belly: "#8d89a0", eye: "#ffd23e", patch: false }, // 黑貓
  { body: "#eae5da", dark: "#c6bfb0", belly: "#faf7f0", eye: "#26232f", patch: false }, // 白貓
  { body: "#eae5da", dark: "#c6bfb0", belly: "#faf7f0", eye: "#26232f", patch: true }, // 三花
  // 店貓「辣椒」:白底 + 頭/背/尾的棕灰虎斑塊 + 白胸白襪 + 綠眼 + 粉鼻(參照使用者的貓)
  {
    body: "#f7f2e9", dark: "#9c8768", belly: "#fffdf7", eye: "#63ad5c", patch: true,
    patchA: "#a68f6d", patchB: "#7f6c52", tabby: true, nose: "#f0a1ad",
  },
];

/** 三花原本寫死的補丁色;抽成常數只為了讓新花色能覆寫,既有像素一個不動。 */
export const CALICO_PATCH_A = "#cd7f32";
export const CALICO_PATCH_B = "#413e4e";

export interface DogPal {
  body: string; dark: string; light: string; eye: string; patch: boolean;
}

export const DOG_PALS: DogPal[] = [
  { body: "#c9823d", dark: "#8d4f27", light: "#f0c18b", eye: "#26232f", patch: false }, // 柴色
  { body: "#3c3842", dark: "#24212a", light: "#8d7a72", eye: "#f3ca52", patch: false }, // 黑犬
  { body: "#eee4d2", dark: "#a7653f", light: "#fff6e7", eye: "#26232f", patch: true },  // 白棕
  { body: "#8b9199", dark: "#5d6269", light: "#d5d8da", eye: "#26232f", patch: false }, // 灰犬
];
