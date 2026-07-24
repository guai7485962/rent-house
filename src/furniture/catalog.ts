/**
 * 家具目錄(單一資料來源 / Single Source of Truth)
 *
 * 經濟層、tile 渲染、AI 敘事、尋路 —— 全部引用同一份 CATALOG。
 * 新增一件家具 = 往下面陣列 append 一個 FurnitureDef。
 *
 * 外觀有兩種寫法:
 *   sprite: { kind: "bed" }      → 交給 render.ts 的專屬繪圖(精緻,適合主力家具)
 *   sprite: { recipe: [...] }    → 純資料的「零件清單」,零程式即可新增(適合 AI/簡單家具)
 */
import type { RoomAttribute, TenantVisualState } from "../types";

export type FurnCategory =
  | "sleep"
  | "work"
  | "av"
  | "seating"
  | "kitchen"
  | "storage"
  | "ambiance"
  | "utility";

/** 擺放位置:房內 / 交誼廳 / 牆面(牆面家具不在地板格上,由房間細看呈現) */
export type Placement = "room" | "communal" | "wall";

/**
 * 品質層級(選配):budget=平價入門(便宜、低屬性,給手頭緊的早期玩家)、
 * standard=標準、premium=精品(貴、高屬性)。純標示用,不影響任何模擬數值——
 * 舒適度/招租星等仍只看 attributes,tier 只是商店/資訊卡的一眼分級。
 */
export type FurnTier = "budget" | "standard" | "premium";

/** 零件清單的單一零件(座標相對於家具左上角,單位:px) */
export interface SpritePart {
  shape: "block" | "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  /** block 專用:頂面高光厚度 */
  top?: number;
}

export type SpriteSpec = { kind: FurnKind } | { recipe: SpritePart[] };

/** 有專屬繪圖函式的家具類型(render.ts) */
export type FurnKind =
  | "bed"
  | "desk"
  | "mic_desk"
  | "tv"
  | "chair"
  | "beanbag"
  | "bookshelf"
  | "wardrobe"
  | "dresser"
  | "cat_tower"
  | "dog_bed"
  | "chew_toy"
  | "pee_pad"
  | "plant"
  | "lamp"
  | "aroma"
  | "easel"
  | "sofa"
  | "dining_table"
  | "coffee_machine"
  | "bar"
  | "washer"
  | "stove"
  | "counter"
  | "fridge"
  | "table"
  | "rug"
  | "mat"
  | "toilet"
  | "sink"
  | "bathtub"
  | "shower"
  | "drying_rack"
  | "laundry_basket"
  | "robot_vacuum";

export interface FurnitureDef {
  id: string;
  name: string;
  category: FurnCategory;
  placement: Placement;
  /** 品質層級(選配;純標示,不影響模擬)。同型家具用它區分平價/標準/精品版。 */
  tier?: FurnTier;
  price: number;
  /** 佔用格數(walkable=false) */
  footprint: { w: number; h: number };
  /** 使用時的站立點,相對家具左上角的格偏移(walkable=true) */
  interact: { dc: number; dr: number };
  /** 對房間屬性的加成 */
  attributes: Partial<Record<RoomAttribute, number>>;
  /**
   * 清潔力(選配):自動打掃型家具(掃地機器人)墊高房間「常保整潔」的自然回歸目標
   * (cleanlinessBaseline),不是瞬間清潔——符合「慢變環境品質、不需照顧」的定位。
   */
  cleanPower?: number;
  /** 適合的性格標籤(租客帶這些標籤時會偏好此家具) */
  fitsTags: string[];
  /** 解鎖的可觀察狀態 */
  unlocksStates: TenantVisualState[];
  /** 是否為交誼廳的跨租客社交碰撞點 */
  social: boolean;
  /** 商店與家具資訊卡顯示的特殊機制說明 */
  effectHint?: string;
  /** 給後台 AI 的敘事鉤子 */
  promptHints: string[];
  /** 外觀 */
  sprite: SpriteSpec;
}

export const CATALOG: FurnitureDef[] = [
  // =========================================================================
  // 房內個人家具
  // =========================================================================
  {
    id: "gaming_desk",
    tier: "premium",
    name: "電競桌(多螢幕)",
    category: "work",
    placement: "room",
    price: 28000,
    footprint: { w: 2, h: 1 },
    interact: { dc: 0, dr: 2 },
    attributes: { tech: 9, noise: 2, style: 3 },
    fitsTags: ["工作狂", "夜貓子"],
    unlocksStates: ["working_at_desk", "gaming"],
    social: false,
    promptHints: ["凌晨還亮著的螢幕光", "連續工作超過 10 小時趴在桌上睡著"],
    sprite: { kind: "desk" },
  },
  {
    id: "mic_desk",
    tier: "premium",
    name: "直播設備台",
    category: "work",
    placement: "room",
    price: 24000,
    footprint: { w: 2, h: 1 },
    interact: { dc: 1, dr: 2 },
    attributes: { tech: 7, style: 4 },
    fitsTags: ["高度自律", "聲音敏感"],
    unlocksStates: ["streaming"],
    social: false,
    promptHints: ["REC 紅燈亮起", "被噪音打斷直播"],
    sprite: { kind: "mic_desk" },
  },
  {
    id: "tv_console",
    tier: "standard",
    name: "電視 + 遊戲主機",
    category: "av",
    placement: "room",
    price: 12000,
    footprint: { w: 2, h: 1 },
    interact: { dc: 0, dr: 2 },
    attributes: { tech: 5, cozy: 3 },
    fitsTags: ["宅", "夜貓子"],
    unlocksStates: ["watching_tv", "gaming"],
    social: false,
    promptHints: ["追劇追到天亮", "打電動打到罵髒話"],
    sprite: { kind: "tv" },
  },
  {
    id: "single_bed",
    tier: "budget",
    name: "單人床",
    category: "sleep",
    placement: "room",
    price: 6000,
    footprint: { w: 2, h: 2 },
    interact: { dc: 2, dr: 1 },
    attributes: {},
    fitsTags: [],
    unlocksStates: ["sleeping_on_bed"],
    social: false,
    promptHints: ["賴床到中午"],
    sprite: { kind: "bed" },
  },
  {
    id: "double_bed",
    tier: "standard",
    name: "雙人床",
    category: "sleep",
    placement: "room",
    price: 14000,
    footprint: { w: 3, h: 2 },
    interact: { dc: 3, dr: 1 },
    attributes: { cozy: 6, style: 3 },
    fitsTags: [],
    unlocksStates: ["sleeping_on_bed"],
    social: false,
    promptHints: ["兩個人賴著不肯起床的早晨", "換了大床之後睡得特別沉"],
    sprite: { kind: "bed" },
  },
  {
    id: "canopy_bed",
    tier: "premium",
    name: "帷幔雙人床",
    category: "sleep",
    placement: "room",
    price: 22000,
    footprint: { w: 3, h: 2 },
    interact: { dc: 3, dr: 1 },
    attributes: { cozy: 9, style: 7 },
    fitsTags: ["浪漫", "夜貓子"],
    unlocksStates: ["sleeping_on_bed"],
    social: false,
    promptHints: ["拉上帷幔說枕邊話", "不想被打擾的兩人世界"],
    sprite: { kind: "bed" },
  },
  {
    id: "wood_chair",
    tier: "budget",
    name: "木質單椅",
    category: "seating",
    placement: "room",
    price: 2200,
    footprint: { w: 1, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: { cozy: 2, style: 2 },
    fitsTags: ["高度自律", "文青"],
    unlocksStates: ["idle", "reading"],
    social: false,
    promptHints: ["坐在窗邊放空", "把椅子轉向最舒服的角度"],
    sprite: { kind: "chair" },
  },
  {
    id: "beanbag",
    tier: "budget",
    name: "懶骨頭",
    category: "seating",
    placement: "room",
    price: 3500,
    footprint: { w: 1, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: { cozy: 4 },
    fitsTags: ["宅"],
    unlocksStates: ["idle"],
    social: false,
    promptHints: ["整個人陷進去不想動"],
    sprite: { kind: "beanbag" },
  },
  {
    id: "loveseat",
    tier: "premium",
    name: "戀人雙人沙發",
    category: "seating",
    placement: "room",
    price: 9800,
    footprint: { w: 2, h: 1 },
    interact: { dc: 1, dr: 1 },
    attributes: { cozy: 7, style: 5 },
    fitsTags: ["浪漫", "宅"],
    unlocksStates: ["idle"],
    social: false,
    promptHints: ["兩個人剛好靠在一起的距離", "深夜只留一盞暖燈"],
    sprite: { kind: "sofa" },
  },
  {
    id: "romantic_table",
    tier: "premium",
    name: "雙人約會餐桌",
    category: "kitchen",
    placement: "room",
    price: 7600,
    footprint: { w: 2, h: 2 },
    interact: { dc: 2, dr: 1 },
    attributes: { cozy: 5, style: 6 },
    fitsTags: ["浪漫", "美食家"],
    unlocksStates: ["eating_at_table"],
    social: false,
    promptHints: ["兩人份的燭光晚餐", "把普通晚餐過成約會"],
    sprite: { kind: "dining_table" },
  },
  {
    id: "bookshelf",
    tier: "standard",
    name: "高書架",
    category: "storage",
    placement: "room",
    price: 8000,
    footprint: { w: 1, h: 2 },
    interact: { dc: 1, dr: 1 },
    attributes: { storage: 6, style: 3 },
    fitsTags: ["高度自律", "文青"],
    unlocksStates: ["reading"],
    social: false,
    promptHints: ["翻書聲 ASMR", "睡前看半小時紙本書"],
    sprite: { kind: "bookshelf" },
  },
  {
    id: "wardrobe",
    tier: "standard",
    name: "衣櫃",
    category: "storage",
    placement: "room",
    price: 7000,
    footprint: { w: 1, h: 2 },
    interact: { dc: 1, dr: 1 },
    attributes: { storage: 8 },
    fitsTags: [],
    unlocksStates: [],
    social: false,
    promptHints: ["翻遍衣櫃找不到要穿的"],
    sprite: { kind: "wardrobe" },
  },
  {
    id: "dresser",
    tier: "budget",
    name: "抽屜櫃",
    category: "storage",
    placement: "room",
    price: 4000,
    footprint: { w: 1, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: { storage: 4 },
    fitsTags: [],
    unlocksStates: [],
    social: false,
    promptHints: [],
    sprite: { kind: "dresser" },
  },
  {
    id: "cat_tower",
    tier: "standard",
    name: "貓跳台",
    category: "ambiance",
    placement: "room",
    price: 5000,
    footprint: { w: 1, h: 2 },
    interact: { dc: 1, dr: 1 },
    attributes: { cozy: 6 },
    fitsTags: ["偷養浪貓", "光明正大養貓"],
    unlocksStates: ["playing_with_cat"],
    social: false,
    effectHint: "貓咪破壞機率 -70%",
    promptHints: ["貓佔領跳台頂端", "貓抓痕成為查房破綻"],
    sprite: { kind: "cat_tower" },
  },
  {
    id: "litter_box",
    tier: "budget",
    name: "貓砂盆",
    category: "utility",
    placement: "room",
    price: 1200,
    footprint: { w: 1, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: {},
    fitsTags: ["偷養浪貓", "光明正大養貓"],
    unlocksStates: [],
    social: false,
    effectHint: "貓咪如廁意外 -85%",
    promptHints: ["貓砂盆藏在角落", "剷屎官的日常"],
    sprite: {
      recipe: [
        { shape: "rect", x: 3, y: 9, w: 10, h: 5, color: "#5f636b" }, // 盆身
        { shape: "rect", x: 3, y: 8, w: 10, h: 1, color: "#787d86" }, // 盆緣高光
        { shape: "rect", x: 4, y: 9, w: 8, h: 3, color: "#d8cdb4" }, // 貓砂
      ],
    },
  },
  {
    id: "dog_bed",
    tier: "standard",
    name: "狗狗睡墊",
    category: "sleep",
    placement: "room",
    price: 2600,
    footprint: { w: 2, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: { cozy: 5 },
    fitsTags: ["喜歡狗", "喜歡寵物"],
    unlocksStates: [],
    social: false,
    promptHints: ["狗狗把睡墊踩成一個剛好的窩", "半夜傳來安心的小呼聲"],
    sprite: { kind: "dog_bed" },
  },
  {
    id: "chew_toy",
    tier: "budget",
    name: "耐咬玩具",
    category: "ambiance",
    placement: "room",
    price: 900,
    footprint: { w: 1, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: { cozy: 1 },
    fitsTags: ["喜歡狗", "喜歡寵物"],
    unlocksStates: [],
    social: false,
    effectHint: "狗狗破壞機率 -75%",
    promptHints: ["耐咬玩具成功救下桌腳", "狗狗叼著玩具到處找人玩"],
    sprite: { kind: "chew_toy" },
  },
  {
    id: "pee_pad",
    tier: "budget",
    name: "寵物尿墊",
    category: "utility",
    placement: "room",
    price: 600,
    footprint: { w: 1, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: {},
    fitsTags: ["喜歡狗", "喜歡寵物"],
    unlocksStates: [],
    social: false,
    effectHint: "狗狗如廁意外 -85%",
    promptHints: ["狗狗乖乖走到尿墊上", "記得定時更換尿墊"],
    sprite: { kind: "pee_pad" },
  },
  {
    id: "plant",
    tier: "budget",
    name: "觀葉盆栽",
    category: "ambiance",
    placement: "room",
    price: 1500,
    footprint: { w: 1, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: { cozy: 3, style: 3 },
    fitsTags: ["文青"],
    unlocksStates: [],
    social: false,
    promptHints: ["對著植物說話", "忘記澆水枯掉一半"],
    sprite: { kind: "plant" },
  },
  {
    id: "floor_lamp",
    tier: "standard",
    name: "落地燈",
    category: "ambiance",
    placement: "room",
    price: 2500,
    footprint: { w: 1, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: { cozy: 4, style: 3 },
    fitsTags: ["文青", "夜貓子"],
    unlocksStates: [],
    social: false,
    promptHints: ["只開一盞暖燈的深夜"],
    sprite: { kind: "lamp" },
  },
  {
    id: "aroma",
    tier: "standard",
    name: "香氛擴香機",
    category: "ambiance",
    placement: "room",
    price: 2000,
    footprint: { w: 1, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: { cozy: 4 },
    fitsTags: ["高度自律", "療癒"],
    unlocksStates: [],
    social: false,
    promptHints: ["直播前的儀式:點香氛"],
    sprite: { kind: "aroma" },
  },
  {
    id: "easel",
    tier: "standard",
    name: "畫架",
    category: "work",
    placement: "room",
    price: 4500,
    footprint: { w: 1, h: 1 },
    interact: { dc: 1, dr: 0 },
    attributes: { style: 6 },
    fitsTags: ["藝術型"],
    unlocksStates: ["painting"],
    social: false,
    promptHints: ["畫到一半卡住盯著空白發呆"],
    sprite: { kind: "easel" },
  },
  {
    id: "blackout_curtain",
    tier: "premium",
    name: "隔音遮光窗簾",
    category: "utility",
    placement: "wall",
    price: 3000,
    footprint: { w: 2, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: { soundproof: 6, cozy: 2 },
    fitsTags: ["夜貓子", "聲音敏感"],
    unlocksStates: [],
    social: false,
    promptHints: ["白天也拉得像深夜", "隔壁裝修聲仍穿透"],
    sprite: { recipe: [] }, // 牆面家具:由房間細看呈現,不畫在地板
  },

  // =========================================================================
  // 平價入門變體(budget tier):便宜、低屬性,給手頭緊的早期玩家先撐著。
  //   噪音是唯一的負屬性通道;這裡的「差」是「屬性低/便宜」而非負分。
  //   刻意不放進種子房(r301~r304),不影響 balance 快照。沿用既有 kind 繪圖。
  // =========================================================================
  {
    id: "folding_bed",
    tier: "budget",
    name: "折疊床",
    category: "sleep",
    placement: "room",
    price: 2800,
    footprint: { w: 2, h: 2 },
    interact: { dc: 2, dr: 1 },
    attributes: {},
    fitsTags: [],
    unlocksStates: ["sleeping_on_bed"],
    social: false,
    effectHint: "平價入門款 · 睡得著但不特別舒服",
    promptHints: ["折疊床睡久了腰有點痠", "省下來的錢先擺別的"],
    sprite: { kind: "bed" },
  },
  {
    id: "plastic_stool",
    tier: "budget",
    name: "塑膠椅凳",
    category: "seating",
    placement: "room",
    price: 400,
    footprint: { w: 1, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: {},
    fitsTags: [],
    unlocksStates: ["idle"],
    social: false,
    effectHint: "平價入門款 · 有得坐就好",
    promptHints: ["隨手拉過來的塑膠椅凳", "便宜堪用的過渡款"],
    sprite: { kind: "chair" },
  },
  {
    id: "bare_bulb",
    tier: "budget",
    name: "裸燈泡",
    category: "ambiance",
    placement: "room",
    price: 500,
    footprint: { w: 1, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: { cozy: 1 },
    fitsTags: [],
    unlocksStates: [],
    social: false,
    effectHint: "平價入門款 · 亮度夠但氣氛普通",
    promptHints: ["天花板垂下的一顆裸燈泡", "還沒錢換好看的燈"],
    sprite: { kind: "lamp" },
  },

  // =========================================================================
  // 自動清潔家具:墊高房間整潔基準(慢變,非瞬間清潔)
  // =========================================================================
  {
    id: "robot_vacuum",
    tier: "standard",
    name: "掃地機器人",
    category: "utility",
    placement: "room",
    price: 6000,
    footprint: { w: 1, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: {},
    cleanPower: 25, // 墊高整潔基準(cleanlinessBaseline),讓房間慢慢常保乾淨
    fitsTags: ["高度自律", "科技"],
    unlocksStates: [],
    social: false,
    effectHint: "每天自動打掃 · 房間常保整潔(整潔基準提高,慢慢維持乾淨)",
    promptHints: ["掃地機器人嗡嗡地繞著房間跑", "回到家地板總是乾乾淨淨"],
    sprite: { kind: "robot_vacuum" },
  },

  // =========================================================================
  // 畢業生紀念物(收藏層):圓夢畢業離開時自動留在其原房間。
  //   純裝飾(空 attributes → 不影響招租星等)、price 0、不可變賣(sellFurnitureAt 擋)、
  //   綁房間不綁租客(placements 獨立於 occupancy,空房招租後仍保留)。
  //   外觀走 recipe 程序繪圖(零件清單、零程式),不套 LimeZu 圖集。
  // =========================================================================
  {
    id: "memorial_poster",
    name: "簽名海報",
    category: "ambiance",
    placement: "room",
    price: 0,
    footprint: { w: 1, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: {},
    fitsTags: [],
    unlocksStates: [],
    social: false,
    effectHint: "登台圓夢畢業生的紀念物 · 不可變賣",
    promptHints: ["牆上那張簽名海報,是曾住這裡的人站上舞台的證明"],
    sprite: {
      recipe: [
        { shape: "rect", x: 3, y: 2, w: 10, h: 12, color: "#2c2f3a" }, // 相框
        { shape: "rect", x: 4, y: 3, w: 8, h: 10, color: "#e8d9b0" }, // 海報紙
        { shape: "rect", x: 5, y: 5, w: 6, h: 4, color: "#c98aa0" }, // 舞台剪影
        { shape: "rect", x: 5, y: 11, w: 6, h: 1, color: "#8a5a72" }, // 簽名
      ],
    },
  },
  {
    id: "memorial_sign",
    name: "小招牌",
    category: "ambiance",
    placement: "room",
    price: 0,
    footprint: { w: 1, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: {},
    fitsTags: [],
    unlocksStates: [],
    social: false,
    effectHint: "開店圓夢畢業生的紀念物 · 不可變賣",
    promptHints: ["那塊小招牌,是曾住這裡的人開了自己小店的起點"],
    sprite: {
      recipe: [
        { shape: "rect", x: 5, y: 2, w: 1, h: 3, color: "#5a3d26" }, // 吊桿左
        { shape: "rect", x: 10, y: 2, w: 1, h: 3, color: "#5a3d26" }, // 吊桿右
        { shape: "rect", x: 3, y: 5, w: 10, h: 8, color: "#3f6d5a" }, // 招牌板
        { shape: "rect", x: 3, y: 5, w: 10, h: 1, color: "#4f7d6a" }, // 高光
        { shape: "rect", x: 5, y: 7, w: 6, h: 1, color: "#e8d9b0" }, // 字
        { shape: "rect", x: 5, y: 9, w: 4, h: 1, color: "#e8d9b0" },
      ],
    },
  },
  {
    id: "memorial_cert",
    name: "裱框證書",
    category: "ambiance",
    placement: "room",
    price: 0,
    footprint: { w: 1, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: {},
    fitsTags: [],
    unlocksStates: [],
    social: false,
    effectHint: "論文圓夢畢業生的紀念物 · 不可變賣",
    promptHints: ["牆上裱框的證書,是曾住這裡的人熬過論文、順利畢業的印記"],
    sprite: {
      recipe: [
        { shape: "rect", x: 2, y: 3, w: 12, h: 10, color: "#8a6a2f" }, // 金框
        { shape: "rect", x: 3, y: 4, w: 10, h: 8, color: "#f3ecd8" }, // 證書紙
        { shape: "rect", x: 5, y: 6, w: 6, h: 1, color: "#8a94b0" }, // 字
        { shape: "rect", x: 5, y: 8, w: 6, h: 1, color: "#8a94b0" },
        { shape: "rect", x: 9, y: 10, w: 3, h: 2, color: "#c9536a" }, // 鋼印
      ],
    },
  },
  {
    id: "memorial_book",
    name: "簽名書",
    category: "ambiance",
    placement: "room",
    price: 0,
    footprint: { w: 1, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: {},
    fitsTags: [],
    unlocksStates: [],
    social: false,
    effectHint: "代表作圓夢畢業生的紀念物 · 不可變賣",
    promptHints: ["架上那本簽名書,是曾住這裡的人完成代表作後留下的一冊"],
    sprite: {
      recipe: [
        { shape: "rect", x: 4, y: 5, w: 9, h: 9, color: "#6d4a7a" }, // 書封
        { shape: "rect", x: 4, y: 5, w: 2, h: 9, color: "#523a5e" }, // 書脊
        { shape: "rect", x: 7, y: 7, w: 5, h: 1, color: "#e8d9b0" }, // 書名
        { shape: "rect", x: 7, y: 11, w: 4, h: 1, color: "#c9a86a" }, // 燙金簽名
      ],
    },
  },
  {
    id: "memorial_frame",
    name: "全家福相框",
    category: "ambiance",
    placement: "room",
    price: 0,
    footprint: { w: 1, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: {},
    fitsTags: [],
    unlocksStates: [],
    social: false,
    effectHint: "安居圓滿搬離的模範房客留下的紀念物 · 不可變賣",
    promptHints: ["桌上那張全家福,是曾把這裡住成家的人,留下的一段安穩時光"],
    sprite: {
      recipe: [
        { shape: "rect", x: 2, y: 3, w: 12, h: 10, color: "#8a5a3a" }, // 木相框
        { shape: "rect", x: 3, y: 4, w: 10, h: 8, color: "#b98a5a" }, // 框內襯
        { shape: "rect", x: 4, y: 5, w: 8, h: 6, color: "#dfeaf2" }, // 相片底
        { shape: "rect", x: 5, y: 7, w: 2, h: 3, color: "#c98aa0" }, // 家人一
        { shape: "rect", x: 7, y: 6, w: 2, h: 4, color: "#7aa0c9" }, // 家人二
        { shape: "rect", x: 9, y: 7, w: 2, h: 3, color: "#8ac9a0" }, // 家人三(孩子/寵物)
        { shape: "rect", x: 6, y: 13, w: 4, h: 1, color: "#6d4630" }, // 相框立架
      ],
    },
  },

  // =========================================================================
  // 交誼廳共用家具(社交碰撞點 ★)
  // =========================================================================
  {
    id: "lounge_tv",
    tier: "premium",
    name: "大電視",
    category: "av",
    placement: "communal",
    price: 18000,
    footprint: { w: 2, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: { tech: 4, cozy: 3 },
    fitsTags: [],
    unlocksStates: ["watching_tv"],
    social: true,
    promptHints: ["兩個租客搶遙控器", "深夜一起追劇的沉默"],
    sprite: { kind: "tv" },
  },
  {
    id: "dining_table",
    tier: "standard",
    name: "四人餐桌",
    category: "kitchen",
    placement: "communal",
    price: 9000,
    footprint: { w: 2, h: 2 },
    interact: { dc: 2, dr: 1 },
    attributes: { cozy: 3, style: 2 },
    fitsTags: [],
    unlocksStates: ["eating_at_table"],
    social: true,
    promptHints: ["深夜共餐的沉默", "誰偷吃了別人的宵夜"],
    sprite: { kind: "dining_table" },
  },
  {
    id: "coffee_machine",
    tier: "standard",
    name: "咖啡機",
    category: "kitchen",
    placement: "communal",
    price: 6000,
    footprint: { w: 1, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: { tech: 2, cozy: 2 },
    fitsTags: [],
    unlocksStates: ["using_appliance"],
    social: true,
    promptHints: ["早晨動線:兩人在咖啡機前的起床氣偶遇"],
    sprite: { kind: "coffee_machine" },
  },
  {
    id: "bar_counter",
    tier: "premium",
    name: "吧台 + 高腳椅",
    category: "kitchen",
    placement: "communal",
    price: 11000,
    footprint: { w: 2, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: { style: 4, cozy: 2 },
    fitsTags: [],
    unlocksStates: ["eating_at_table"],
    social: true,
    promptHints: ["喝一杯之後微醺吐真言"],
    sprite: { kind: "bar" },
  },
  {
    id: "lounge_console",
    tier: "standard",
    name: "體感遊戲機",
    category: "av",
    placement: "communal",
    price: 10000,
    footprint: { w: 2, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: { tech: 4, noise: 2 },
    fitsTags: [],
    unlocksStates: ["gaming"],
    social: true,
    promptHints: ["揪團連線", "社恐被硬拉下海"],
    sprite: { kind: "tv" },
  },
  {
    id: "washing_machine",
    tier: "standard",
    name: "共用洗衣機",
    category: "utility",
    placement: "communal",
    price: 8000,
    footprint: { w: 1, h: 1 },
    interact: { dc: 0, dr: 1 },
    attributes: {},
    fitsTags: [],
    unlocksStates: ["using_appliance"],
    social: true,
    promptHints: ["誰的襪子混進我那籃", "忘了拿走的衣服堆在機器上"],
    sprite: { kind: "washer" },
  },
  {
    id: "shared_sofa",
    tier: "premium",
    name: "共用沙發",
    category: "seating",
    placement: "communal",
    price: 15500,
    footprint: { w: 3, h: 1 },
    interact: { dc: 1, dr: 1 },
    attributes: { cozy: 8, style: 4 },
    fitsTags: [],
    unlocksStates: ["idle"],
    social: true,
    promptHints: ["癱坐時撞見彼此的狼狽"],
    sprite: { kind: "sofa" },
  },

  // =========================================================================
  // 交誼廳基礎機能(既有)
  // =========================================================================
  { id: "stove", tier: "budget", name: "瓦斯爐", category: "kitchen", placement: "communal", price: 5000, footprint: { w: 1, h: 1 }, interact: { dc: 0, dr: 1 }, attributes: {}, fitsTags: [], unlocksStates: ["cooking"], social: true, promptHints: ["半夜煮泡麵的香味"], sprite: { kind: "stove" } },
  { id: "counter", tier: "budget", name: "流理臺", category: "kitchen", placement: "communal", price: 4000, footprint: { w: 2, h: 1 }, interact: { dc: 0, dr: 1 }, attributes: { storage: 2 }, fitsTags: [], unlocksStates: [], social: false, promptHints: [], sprite: { kind: "counter" } },
  { id: "fridge", tier: "standard", name: "冰箱", category: "kitchen", placement: "communal", price: 9000, footprint: { w: 1, h: 2 }, interact: { dc: 1, dr: 1 }, attributes: { storage: 4 }, fitsTags: [], unlocksStates: [], social: true, promptHints: ["貼在冰箱上的紙條戰爭"], sprite: { kind: "fridge" } },
  { id: "coffee_table", tier: "budget", name: "茶几", category: "seating", placement: "communal", price: 3000, footprint: { w: 1, h: 1 }, interact: { dc: 0, dr: 1 }, attributes: { style: 2 }, fitsTags: [], unlocksStates: [], social: false, promptHints: [], sprite: { kind: "table" } },
  { id: "lounge_rug", tier: "standard", name: "大地毯", category: "ambiance", placement: "communal", price: 4000, footprint: { w: 4, h: 3 }, interact: { dc: 0, dr: 0 }, attributes: { cozy: 3 }, fitsTags: [], unlocksStates: [], social: false, promptHints: [], sprite: { kind: "rug" } },
  { id: "entrance_mat", tier: "budget", name: "門口地墊", category: "utility", placement: "communal", price: 500, footprint: { w: 2, h: 1 }, interact: { dc: 0, dr: -1 }, attributes: {}, fitsTags: [], unlocksStates: [], social: false, promptHints: ["包裹代收/漏收的日常"], sprite: { kind: "mat" } },
  { id: "lounge_plant", tier: "budget", name: "角落盆栽", category: "ambiance", placement: "communal", price: 1500, footprint: { w: 1, h: 1 }, interact: { dc: 0, dr: 1 }, attributes: { cozy: 2, style: 2 }, fitsTags: [], unlocksStates: [], social: false, promptHints: [], sprite: { kind: "plant" } },

  // =========================================================================
  // 共用設施:廁所 + 浴室
  // =========================================================================
  { id: "bathtub", tier: "premium", name: "浴缸", category: "utility", placement: "communal", price: 12000, footprint: { w: 2, h: 1 }, interact: { dc: 0, dr: 1 }, attributes: { cozy: 3 }, fitsTags: [], unlocksStates: ["taking_bath"], social: true, promptHints: ["泡澡泡到睡著", "誰又忘了放掉水"], sprite: { kind: "bathtub" } },
  { id: "shower", tier: "standard", name: "淋浴間(玻璃隔間)", category: "utility", placement: "communal", price: 9000, footprint: { w: 2, h: 2 }, interact: { dc: 2, dr: 1 }, attributes: {}, fitsTags: [], unlocksStates: ["showering"], social: true, promptHints: ["淋浴間的歌聲", "熱水被用光了"], sprite: { kind: "shower" } },
  { id: "toilet", tier: "budget", name: "馬桶", category: "utility", placement: "communal", price: 5000, footprint: { w: 1, h: 1 }, interact: { dc: 0, dr: 1 }, attributes: {}, fitsTags: [], unlocksStates: ["using_toilet"], social: true, promptHints: ["半夜排隊等廁所"], sprite: { kind: "toilet" } },
  { id: "bath_sink", tier: "budget", name: "洗手台", category: "utility", placement: "communal", price: 3000, footprint: { w: 1, h: 1 }, interact: { dc: 0, dr: 1 }, attributes: {}, fitsTags: [], unlocksStates: ["washing_at_sink"], social: false, promptHints: ["對著鏡子發呆刷牙"], sprite: { kind: "sink" } },
  { id: "bath_plant", tier: "budget", name: "浴室小盆栽", category: "ambiance", placement: "communal", price: 1200, footprint: { w: 1, h: 1 }, interact: { dc: 0, dr: 1 }, attributes: { cozy: 2 }, fitsTags: [], unlocksStates: [], social: false, promptHints: [], sprite: { kind: "plant" } },

  // =========================================================================
  // 共用設施:洗衣晾衣間
  // =========================================================================
  { id: "laundry_washer", tier: "standard", name: "投幣洗衣機", category: "utility", placement: "communal", price: 8000, footprint: { w: 1, h: 1 }, interact: { dc: 0, dr: 1 }, attributes: {}, fitsTags: [], unlocksStates: ["using_appliance"], social: true, promptHints: ["搶最後一台空機", "洗到一半沒零錢"], sprite: { kind: "washer" } },
  { id: "drying_rack", tier: "budget", name: "曬衣架", category: "utility", placement: "communal", price: 2500, footprint: { w: 2, h: 1 }, interact: { dc: 0, dr: 1 }, attributes: {}, fitsTags: [], unlocksStates: [], social: true, promptHints: ["晾了三天沒收的衣服", "誰的衣服佔滿了整排"], sprite: { kind: "drying_rack" } },
  { id: "utility_sink", tier: "budget", name: "水槽", category: "utility", placement: "communal", price: 2000, footprint: { w: 1, h: 1 }, interact: { dc: 0, dr: 1 }, attributes: {}, fitsTags: [], unlocksStates: [], social: false, promptHints: ["手洗貼身衣物"], sprite: { kind: "sink" } },
  { id: "laundry_basket", tier: "budget", name: "洗衣籃", category: "utility", placement: "communal", price: 600, footprint: { w: 1, h: 1 }, interact: { dc: 0, dr: 1 }, attributes: {}, fitsTags: [], unlocksStates: [], social: false, promptHints: ["堆成小山的待洗衣物"], sprite: { kind: "laundry_basket" } },
];

const BY_ID = new Map(CATALOG.map((d) => [d.id, d]));

/** 未知 id 的替身家具(舊存檔可能帶到已改名/移除的家具):不擋路、不值錢、畫成小紙箱。
 *  getDef 絕不 throw——渲染與尋路每幀都會呼叫,一筆壞資料不能毀掉整個畫面。 */
const UNKNOWN_DEF: FurnitureDef = {
  id: "unknown",
  name: "不明雜物",
  category: "utility",
  placement: "room",
  price: 0,
  footprint: { w: 1, h: 1 },
  interact: { dc: 0, dr: 1 },
  attributes: {},
  fitsTags: [],
  unlocksStates: [],
  social: false,
  promptHints: [],
  sprite: { recipe: [{ shape: "block", x: 3, y: 6, w: 10, h: 8, color: "#8a7a5e", top: 2 }] },
};

const warned = new Set<string>();
export function getDef(id: string): FurnitureDef {
  const d = BY_ID.get(id);
  if (!d) {
    if (!warned.has(id)) {
      warned.add(id);
      console.warn(`[catalog] 查無家具 id「${id}」,以「不明雜物」替代(可能來自舊存檔)`);
    }
    return UNKNOWN_DEF;
  }
  return d;
}

export function hasDef(id: string): boolean {
  return BY_ID.has(id);
}
