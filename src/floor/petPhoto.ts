/**
 * 送養紀錄的**像素合照**:寵物 + 新飼主,畫在一張有相框的小圖裡。
 *
 * 為什麼是「畫」不是「存圖」:照片**不進存檔**。存檔只留新飼主的姓名與外觀
 * (`PetHomeEntry.adopterName` / `adopterAppearance`,兩個都選填),沒有那些欄位時
 * 由 `entry.id` 決定性推導 ⇒ 舊的送養紀錄打開也有照片,而且每次打開都長一樣。
 * 把 PNG 塞進 localStorage 只會把存檔撐爆,而且沒有任何好處。
 *
 * 人的部分直接沿用既有的 11px 角色骨架(`CHAR_STAND` + `drawAppearanceOverlay`),
 * 所以合照裡的人和樓層上走動的人是同一套美術;貓狗則是本檔專屬的**正面坐姿**
 * ——樓層上那組是走路循環的側面,拿來當合照會怪。顏色一律讀 `petPalettes`,
 * 之後 append 新花色照片會自動跟上。
 */
import type { Appearance, PetKind } from "../types";
import { drawSprite, shade, BASE_PAL, CHAR_STAND, type Palette } from "../pixel/sprites";
import { drawAppearanceOverlay, HAIR_COLORS, SHIRT_COLORS, PANTS_COLORS, SKIN_TONES, ALL_HAIR_STYLES, ALL_ACCESSORIES, sanitizeAppearanceColors } from "../pixel/parts";
import { CAT_PALS, DOG_PALS, CALICO_PATCH_A, CALICO_PATCH_B } from "./petPalettes";

type Ctx = CanvasRenderingContext2D;

/** 照片的邏輯像素尺寸(顯示時整數倍放大,維持像素銳利) */
export const PET_PHOTO_W = 72;
export const PET_PHOTO_H = 56;

/** FNV-1a 32-bit:與咖啡廳線、劇情弧同一套決定性雜湊,零 RNG。 */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const pickBy = <T>(arr: readonly T[], seed: string): T => arr[hash(seed) % arr.length];

/**
 * 沒有存到新飼主外觀時(舊紀錄、或「通過審核的新家庭」這種沒有具體人物的去向),
 * 由 id 決定性生一位。走 `sanitizeAppearanceColors` ⇒ 髮色/膚色對比等既有規則照樣成立。
 */
export function derivedAdopterAppearance(seed: string): Appearance {
  return sanitizeAppearanceColors({
    hairStyle: pickBy(ALL_HAIR_STYLES, `${seed}|hairstyle`),
    hairColor: pickBy(HAIR_COLORS, `${seed}|haircolor`),
    shirt: pickBy(SHIRT_COLORS, `${seed}|shirt`),
    pants: pickBy(PANTS_COLORS, `${seed}|pants`),
    skin: pickBy(SKIN_TONES, `${seed}|skin`),
    // 四成的人戴配件,和 randomAppearance() 的比例一致(只是這裡是決定性的)
    accessory: hash(`${seed}|acc`) % 10 < 4
      ? pickBy(ALL_ACCESSORIES.filter((a) => a !== "none"), `${seed}|acckind`)
      : "none",
  });
}

/** 這張照片畫什麼:全部由送養紀錄推導,不讀任何全域狀態 ⇒ 純函式、好測。 */
export interface PetPhotoSpec {
  /** 決定性種子(用送養紀錄的 id) */
  seed: string;
  kind: PetKind;
  /** `pet.color` 索引;超出範圍會退回第一個花色 */
  color: number;
  appearance: Appearance;
}

const px = (ctx: Ctx, x: number, y: number, w: number, h: number, color: string) => {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
};

/** 相紙底色與暖色漸層:讓它看起來是「一張照片」而不是遊戲畫面的一角。 */
function drawBackdrop(ctx: Ctx, seed: string) {
  // 三種背景輪替:午後窗邊 / 客廳暖燈 / 陽台黃昏
  const variants = [
    { sky: "#cfe3f2", wall: "#e8dcc8", floor: "#c19a6b" },
    { sky: "#f3dfc4", wall: "#e6d3bb", floor: "#a9784f" },
    { sky: "#f6cfa8", wall: "#e9d6bd", floor: "#b8875a" },
  ];
  const v = variants[hash(`${seed}|bg`) % variants.length];
  px(ctx, 0, 0, PET_PHOTO_W, PET_PHOTO_H, v.wall);
  // 窗
  const wx = hash(`${seed}|win`) % 2 === 0 ? 6 : PET_PHOTO_W - 26;
  px(ctx, wx, 8, 20, 16, "#8a7a63");
  px(ctx, wx + 1, 9, 18, 14, v.sky);
  px(ctx, wx + 10, 9, 1, 14, "#8a7a63");
  px(ctx, wx + 1, 15, 18, 1, "#8a7a63");
  // 地板
  px(ctx, 0, PET_PHOTO_H - 14, PET_PHOTO_W, 14, v.floor);
  px(ctx, 0, PET_PHOTO_H - 14, PET_PHOTO_W, 1, "#00000022");
}

/** 白色相框 + 右下角的折角,讓卡片上一眼看得出這是照片。 */
function drawFrame(ctx: Ctx) {
  ctx.strokeStyle = "#f7f2e6";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, PET_PHOTO_W - 2, PET_PHOTO_H - 2);
  ctx.strokeStyle = "#00000033";
  ctx.lineWidth = 1;
  ctx.strokeRect(2.5, 2.5, PET_PHOTO_W - 5, PET_PHOTO_H - 5);
}

/** 正面坐姿的貓(合照專用;和樓層上那組側面走路的是不同張圖)。 */
function drawSittingCat(ctx: Ctx, x: number, y: number, color: number) {
  const pal = CAT_PALS[color] ?? CAT_PALS[0];
  const patchA = pal.patchA ?? CALICO_PATCH_A;
  const patchB = pal.patchB ?? CALICO_PATCH_B;
  // 身體(梯形)
  px(ctx, x + 2, y + 7, 8, 7, pal.body);
  px(ctx, x + 1, y + 10, 10, 4, pal.body);
  px(ctx, x + 3, y + 10, 6, 4, pal.belly);
  // 尾巴繞到身側
  px(ctx, x + 10, y + 11, 4, 2, pal.dark);
  px(ctx, x + 13, y + 9, 2, 3, pal.dark);
  // 頭
  px(ctx, x + 2, y + 1, 8, 7, pal.body);
  px(ctx, x + 3, y + 5, 6, 3, pal.belly);
  // 耳朵
  px(ctx, x + 2, y, 2, 2, pal.dark);
  px(ctx, x + 8, y, 2, 2, pal.dark);
  if (pal.patch) {
    // 三花/虎斑:頭頂與背上的補丁
    px(ctx, x + 2, y + 1, 3, 2, patchA);
    px(ctx, x + 7, y + 1, 3, 2, patchB);
    px(ctx, x + 2, y + 7, 3, 3, pal.tabby ? patchA : patchB);
    if (pal.tabby) {
      px(ctx, x + 5, y, 2, 1, patchB);
      px(ctx, x + 8, y + 8, 2, 2, patchB);
    }
  }
  // 眼睛與鼻子
  px(ctx, x + 3, y + 3, 2, 2, pal.eye);
  px(ctx, x + 7, y + 3, 2, 2, pal.eye);
  px(ctx, x + 5, y + 5, 2, 1, pal.nose ?? "#c9707f");
  // 前腳
  px(ctx, x + 2, y + 13, 2, 2, pal.belly);
  px(ctx, x + 8, y + 13, 2, 2, pal.belly);
}

/** 正面坐姿的狗。 */
function drawSittingDog(ctx: Ctx, x: number, y: number, color: number) {
  const pal = DOG_PALS[color] ?? DOG_PALS[0];
  px(ctx, x + 2, y + 7, 9, 8, pal.body);
  px(ctx, x + 4, y + 10, 5, 5, pal.light);
  // 尾巴
  px(ctx, x + 11, y + 10, 4, 2, pal.dark);
  // 頭
  px(ctx, x + 2, y + 1, 9, 7, pal.body);
  // 垂耳
  px(ctx, x + 1, y + 1, 2, 5, pal.dark);
  px(ctx, x + 10, y + 1, 2, 5, pal.dark);
  // 口鼻
  px(ctx, x + 4, y + 5, 5, 3, pal.light);
  px(ctx, x + 6, y + 6, 2, 1, "#2c2630");
  if (pal.patch) px(ctx, x + 2, y + 1, 4, 3, pal.dark);
  // 眼睛
  px(ctx, x + 3, y + 3, 2, 2, pal.eye);
  px(ctx, x + 8, y + 3, 2, 2, pal.eye);
  // 前腳
  px(ctx, x + 2, y + 14, 2, 2, pal.light);
  px(ctx, x + 9, y + 14, 2, 2, pal.light);
}

/** 新飼主的人物調色盤:逐鍵比照 `floorScene.guestPalette()`,合照裡的人才跟樓層上的一致。 */
function adopterPalette(ap: Appearance): Palette {
  return {
    ...BASE_PAL,
    h: ap.hairColor,
    H: shade(ap.hairColor, 26),
    F: ap.skin,
    f: shade(ap.skin, -16),
    t: ap.shirt,
    T: shade(ap.shirt, 20),
    j: shade(ap.shirt, -22),
    d: ap.pants,
    D: shade(ap.pants, -22),
  };
}

/**
 * 畫一張合照。`ctx` 的座標系必須已經縮放到「1 單位 = 1 邏輯像素」
 * (呼叫端用 `ctx.scale(k, k)` 放大;`imageSmoothingEnabled = false` 保持銳利)。
 */
export function drawPetPhoto(ctx: Ctx, spec: PetPhotoSpec) {
  ctx.clearRect(0, 0, PET_PHOTO_W, PET_PHOTO_H);
  drawBackdrop(ctx, spec.seed);

  const groundY = PET_PHOTO_H - 14;
  // 人站左邊、寵物坐右邊(或反過來),兩者都踩在同一條地板線上
  const personLeft = hash(`${spec.seed}|side`) % 2 === 0;
  const personX = personLeft ? 16 : PET_PHOTO_W - 27;
  const petX = personLeft ? PET_PHOTO_W - 26 : 10;

  // 影子
  ctx.fillStyle = "#00000026";
  ctx.beginPath();
  ctx.ellipse(personX + 5, groundY + 9, 7, 2.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(petX + 6, groundY + 9, 7, 2.5, 0, 0, Math.PI * 2);
  ctx.fill();

  const personY = groundY - 12;
  drawSprite(ctx, CHAR_STAND, personX, personY, adopterPalette(spec.appearance));
  drawAppearanceOverlay(ctx, spec.appearance, personX, personY, "front");

  const petY = groundY - 7;
  if (spec.kind === "dog") drawSittingDog(ctx, petX, petY, spec.color);
  else drawSittingCat(ctx, petX, petY, spec.color);

  // 兩人之間的小愛心 —— 這張照片要傳達的就是這件事。
  // 取「兩個身體的中心」而不是兩個繪製原點,否則會偏向比較窄的那一邊。
  const hx = Math.round(((personX + 5) + (petX + 6)) / 2) - 2;
  const hy = groundY - 20;
  px(ctx, hx, hy + 1, 2, 2, "#e8687f");
  px(ctx, hx + 3, hy + 1, 2, 2, "#e8687f");
  px(ctx, hx + 1, hy + 2, 3, 2, "#e8687f");
  px(ctx, hx + 2, hy + 4, 1, 1, "#e8687f");

  drawFrame(ctx);
}

/** 從送養紀錄組出畫圖用的 spec(沒存到外觀時決定性推導一位)。 */
export function photoSpecFromHome(entry: {
  id: string; kind: PetKind; color: number; adopterAppearance?: Appearance;
}): PetPhotoSpec {
  return {
    seed: entry.id,
    kind: entry.kind ?? "cat",
    color: Number.isFinite(entry.color) ? entry.color : 0,
    appearance: entry.adopterAppearance ?? derivedAdopterAppearance(entry.id),
  };
}
