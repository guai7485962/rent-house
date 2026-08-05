/**
 * 《房東監視中》(AI Landlord Observer) — 核心資料結構
 * Phase 1:系統底層定義
 *
 * 設計原則:
 * 1. AI 只輸出「狀態標籤」,前端讀取標籤切換圖層 —— 不依賴即時生成圖像。
 * 2. 所有 AI 回傳內容必須嚴格符合 AIEventResponse,由 API 的
 *    structured output (JSON Schema) 強制保證格式。
 * 3. 數值變化一律用「增量 (delta)」而非絕對值,防止 AI 覆寫遊戲經濟。
 */

// ---------------------------------------------------------------------------
// 視覺狀態標籤 (Visual State Tags)
// ---------------------------------------------------------------------------

/**
 * 租客可能出現的視覺狀態。前端為每個狀態準備對應立繪/動畫圖層。
 * ⚠️ 刻意控制在 15 種以內以壓低美術成本;新增狀態 = 新增美術資源,
 *    必須同步更新此列表與 AI prompt 中的允許清單。
 */
export const TENANT_VISUAL_STATES = [
  "idle",               // 發呆/站立(預設)
  "sleeping_on_bed",    // 床上睡覺
  "sleeping_on_couch",  // 沙發上睡死(加班暗示)
  "working_at_desk",    // 在桌前工作/打電腦
  "gaming",             // 打電動
  "streaming",          // 開直播(實況主專用姿勢)
  "eating",             // 吃東西
  "cooking",            // 下廚
  "playing_with_cat",   // 逗貓
  "crying",             // 情緒崩潰
  "pacing",             // 焦慮踱步
  "away",               // 不在房間(上班/外出)
  "showering",          // 浴室(顯示浴室門關+蒸氣)
  "using_toilet",       // 使用馬桶(坐姿+隱私演出)
  "washing_at_sink",    // 在洗手台刷牙/洗臉
  "taking_bath",        // 在浴缸泡澡
  "waiting_for_bathroom", // 浴室設備有人使用,在門外排隊
  "cleaning",           // 打掃
  "talking_on_phone",   // 講電話
  // ─ 由家具目錄解鎖的新狀態(sprite 待與房間細看一起補) ─
  "watching_tv",        // 看電視(電視/遊戲主機)
  "eating_at_table",    // 在餐桌用餐(交誼廳)
  "reading",            // 看書(書架)
  "painting",           // 畫畫(畫架)
  "using_appliance",    // 使用家電(咖啡機/洗衣機)
  // ─ 一樓寵物咖啡廳(CAFE-20) ─
  // ⚠️ 本案唯一新增的 visualState。不寫進 data/routines.json 的每日作息表——
  //    寫進去就會從第 1 天天天觸發、閘門形同虛設。改由 sim/routine.ts 的
  //    `cafeSitHourForDay()` 決定性插入(同 bathroomActivityForDay/laundryHourForDay 的先例)。
  "at_cafe",            // 下樓坐一樓咖啡廳
] as const;

export type TenantVisualState = (typeof TENANT_VISUAL_STATES)[number];

/**
 * 房間內「非租客」的視覺小物件狀態(疊加圖層,可同時多個)。
 * 例:貓在桌上、外送袋堆積、垃圾滿出來。
 */
export const ROOM_PROP_STATES = [
  "cat_on_table",
  "cat_sleeping_on_couch",
  "cat_hiding",
  "delivery_boxes_piled",
  "trash_overflow",
  "laundry_piled",
  "lights_off",
  "curtains_closed",
  "mic_setup_active",   // 直播麥克風亮燈
  "screen_glow",        // 深夜螢幕光
] as const;

export type RoomPropState = (typeof ROOM_PROP_STATES)[number];

// ---------------------------------------------------------------------------
// 標籤系統 (Tag System)
// ---------------------------------------------------------------------------

/** 固化核心性格標籤 —— 入住時決定,遊戲中不變 */
export interface CoreTag {
  id: string;           // 例 "introvert"
  label: string;        // 例 "[社恐]"
  /** 給 AI 的行為指引,會注入 prompt */
  behaviorHint: string; // 例 "避免與房東正面接觸,包裹堆在門口三天才拿"
}

/** 動態累積記憶標籤 —— 由劇情事件與房東抉擇產生/移除 */
export interface MemoryTag {
  id: string;           // 例 "stray_cat_adopted"
  label: string;        // 例 "[偷養浪貓]"
  behaviorHint: string;
  /** 遊戲內時間戳,用於劇情連貫(例:失戀第 3 天 vs 第 30 天寫法不同) */
  acquiredAt: string;   // ISO 8601
  /** 來源:AI 劇情產生 / 房東抉擇 / 系統事件 */
  source: "ai_event" | "landlord_decision" | "system";
  /**
   * 記憶強度 0~1(生命週期):每日依標籤語意衰減,數值漂移乘上它,
   * 歸零自動淡忘移除。缺欄位(舊存檔)視為 1。持續狀態類(養貓/同居)不衰減。
   */
  intensity?: number;
}

// ---------------------------------------------------------------------------
// 房間環境屬性 (Room Environment)
// ---------------------------------------------------------------------------

/** 家具累積出的房間屬性軸 —— 用來吸引對應偏好的租客 */
export const ROOM_ATTRIBUTES = [
  "tech",        // 科技感
  "cozy",        // 療癒感
  "noise",       // 噪音(可為負面)
  "soundproof",  // 隔音
  "storage",     // 收納
  "style",       // 品味/美感
] as const;

export type RoomAttribute = (typeof ROOM_ATTRIBUTES)[number];

export interface RoomState {
  id: string;
  /** 各屬性累積值(由擺放的家具加總) */
  attributes: Partial<Record<RoomAttribute, number>>;
  /** 0~100,受租客習性與事件影響 */
  cleanliness: number;
  /** 目前擺放的家具 id 列表 */
  furnitureIds: string[];
  /** 目前疊加的視覺小物件 */
  activeProps: RoomPropState[];
}

// ---------------------------------------------------------------------------
// 租客 (Tenant)
// ---------------------------------------------------------------------------

export type Gender = "male" | "female" | "nonbinary";

/** 髮型部件(§9-1 部件化外觀) */
export type HairStyle = "short" | "long" | "ponytail" | "spiky" | "bob";
/** 配件部件 */
export type AccessoryKind = "none" | "glasses" | "round_glasses" | "cap" | "bow" | "headphones";

/**
 * 部件化外觀(§9-1):髮型 × 髮色 × 衣著 × 膚色 × 配件的可組合圖層。
 * 動態入住的租客隨機生成;沒有此欄位的舊角色退回原本的配色池(存檔相容)。
 */
export interface Appearance {
  hairStyle: HairStyle;
  hairColor: string;
  shirt: string;
  pants: string;
  skin: string;
  accessory: AccessoryKind;
}

/** 咖啡廳顧客只帶畫面與意圖所需的輕量資料，不是 TenantRuntime。 */
export type CafeGuestIntent = "coffee" | "adopt" | "rent";

/**
 * 這位顧客實際點的東西(重設計 P2)。
 *
 * 🔴 這個欄位就是「合流」本身:`cafeHourlyPass()` 每做一次結帳,就生一位帶著這份
 * 訂單的可見顧客。畫面上泡泡顯示的品項、浮字顯示的金額,都直接讀這裡,
 * **不是另外算一份**。`null` 只出現在舊存檔或測試手捏的顧客。
 */
export interface CafeGuestOrder {
  itemId: string;
  itemName: string;
  /** 售價。`served` 時 = 實際進帳金額;`refused` 時 = 他原本想付的錢(泡泡顯示用)。 */
  price: number;
  /** 菜單三條線,泡泡用它決定畫咖啡杯/可頌/肉球。 */
  track: "coffee" | "bakery" | "pet";
  /** true = 料齊、已收錢;false = 缺料、$0。 */
  served: boolean;
  /** `served === false` 時缺的那項原料名稱;否則空字串。 */
  missing: string;
  /** true = 沒有空席,點完直接走(設計文件 §4.6)。 */
  takeaway: boolean;
  /**
   * 🔴 A 批:true = 這位顧客**排到放棄**,從頭到尾沒結過帳($0、沒扣原料)。
   *
   * 由 `cafeHourlyPass()` 在結帳迴圈裡決定(決定性、離線一致),渲染層 `guestAgents`
   * 只負責把他演出來:走進門 → 站進人龍 → 等超過 `GUEST_ABANDON_SECONDS` → 走出去。
   * 舊存檔沒有這欄 ⇒ `undefined`,一律視為 false。
   */
  abandoned?: boolean;
}

export interface CafeGuest {
  id: string;
  name: string;
  appearance: Appearance;
  intent: CafeGuestIntent;
  arrivedMs: number;
  /** 內用 1～3 個遊戲小時;外帶/撲空只停留很短(點完就走)。 */
  leavesMs: number;
  /** 他坐的那張**真椅子**的格(來自 `placements`);`null` = 外帶,不佔席。 */
  seatTile: import("./floor/pathfind").Tile | null;
  /** P2:他點了什麼、付了多少。舊存檔沒有這欄 ⇒ `null`。 */
  order: CafeGuestOrder | null;
}

/** 進行中的咖啡廳研發(CAFE-16 才會實際寫入;本期只保留欄位)。 */
export interface CafeResearch {
  id: string;
  /** 開始研發的遊戲日序號(gameDayIndex) */
  startedDay: number;
  /** 需要幾個遊戲日完成 */
  days: number;
  /** 已投入的金額(一次性,不可退) */
  invested: number;
}

/** 咖啡廳日結紀錄(CAFE-13 才會實際寫入;本期只保留欄位)。 */
export interface CafeDayRecord {
  /** gameDayIndex 的日序號 */
  day: number;
  guests: number;
  revenue: number;
  cost: number;
  net: number;
}

/**
 * 單一遊戲日的逐品項銷售紀錄(重設計 P1)。
 *
 * 由 `cafeHourlyPass()` 逐位顧客累加、`cafeDailyPass()` 讀來寫 `history`。
 * P3 的「過去 7 日銷售排行」直接讀這個陣列,不需要再回頭解析日誌。
 */
export interface CafeSalesDay {
  /** gameDayIndex 的日序號 */
  day: number;
  /** 品項 id → 當日賣出份數 */
  sold: Record<string, number>;
  /** 品項 id → 當日因缺料被拒的次數 */
  missed: Record<string, number>;
  /** 當日營收 = Σ 實際賣出品項的售價 */
  revenue: number;
  /** 當日耗掉的原料進貨價值(毛利用;不是當日進貨支出) */
  ingredientCost: number;
  /** 成功結帳人次 */
  served: number;
  /** 缺料撲空人次 */
  refused: number;
  /** 已被日結收走(避免同一天的營業成績被寫進兩筆 history) */
  settled: boolean;
  /**
   * P3:當日開店前(09:00)的進貨已經扣過款。
   *
   * 這支旗標就是「一天只進一次貨」的唯一保證——比照 `settled` 的作法把冪等性
   * 記在**存檔裡的當日紀錄**上,而不是模組層變數,離線補進度、重讀存檔、
   * 同一小時被呼叫兩次都不會重複扣款。
   */
  restocked: boolean;
  /** P3:當日開店前實際扣掉的進貨金額(日結寫 history 的 cost 時要加回來)。 */
  restockCost: number;
  /**
   * 🔴 A 批:當日排到放棄的人次(選填;舊存檔沒有 ⇒ `sanitizeCafeState` 補 0)。
   *
   * 只是紀錄與敘事素材,**不進任何金流算式**——放棄的人從來沒被收過錢。
   */
  abandoned?: number;
}

/**
 * 一樓寵物咖啡廳的單一 top-level 存檔 key(設計文件 §8)。
 *
 * 形狀一次定義完整,後續分期只填內容不改 schema:
 * CAFE-12 用 standingOrders/stock、CAFE-13 用 popularity/history、
 * CAFE-14 用 open/upgrades、CAFE-16 用 research/completed。
 * 重設計 P1 新增 `sales`(逐品項銷售紀錄) ⇒ SAVE_VERSION 8 → 9。
 */
export interface CafeState {
  /** 玩家花錢開張才 true;未開張時所有咖啡廳 pass 直接 return(零漂移的天然閘門) */
  open: boolean;
  /** 常備訂單:原料 id → 每日補到的常備量(CAFE-12) */
  standingOrders: Record<string, number>;
  /** 現有庫存:原料 id → 數量(CAFE-12) */
  stock: Record<string, number>;
  /** 進行中的研發(CAFE-16);null = 沒有在研發 */
  research: CafeResearch | null;
  /** 已完成的研發 id(CAFE-16) */
  completed: string[];
  /** 已購買的咖啡廳設備 id;刻意不進 placements,免得咖啡機被搬到三樓(CAFE-14) */
  upgrades: string[];
  /**
   * **額外**雇用的店員數(重設計 P4a,設計文件 §4.7 §4.9)。
   *
   * 🔴 不含開張費 $22,000 已經包含的**首位店員**——他的薪資記在 `CAFE_FIXED_COST`
   * 裡,所以吧台後永遠至少有一個人。這個欄位是「第二位起」的人數,
   * 每人每日 `CAFE_STAFF_WAGE`,由日結扣款。舊存檔沒有這個欄位 ⇒ 消毒時補 0。
   */
  extraStaff: number;
  /** 目前在店裡的顧客,cap CAFE_GUEST_CAP;不進 state.runtimes */
  guests: CafeGuest[];
  /** 人氣(CAFE-13 客流公式用) */
  popularity: number;
  /** 日結紀錄,最新在後,cap CAFE_HISTORY_CAP(CAFE-13) */
  history: CafeDayRecord[];
  /** 逐日逐品項銷售紀錄,最新在後,cap CAFE_SALES_CAP(重設計 P1;P3 的銷售排行讀這裡) */
  sales: CafeSalesDay[];
}

export interface Tenant {
  id: string;
  name: string;
  occupation: string;
  /** 一句話人物側寫,注入 prompt 用 */
  bio: string;

  /** 部件化外觀(動態租客隨機生成;種子租客用固定主題,無此欄位) */
  appearance?: Appearance;

  /** 是否為成年人(undefined = 是;內建角色皆成年)。未成年角色排除整條戀愛線(§10-0) */
  isAdult?: boolean;

  /** 性別與戀愛取向(決定鄰居間能否發展戀情) */
  gender?: Gender;
  /** 會被哪些性別吸引;空陣列=不對任何人動心 */
  attractedTo?: Gender[];

  coreTags: CoreTag[];
  memoryTags: MemoryTag[];
  /** 劇情弧收束後獲得的永久成長特質；id 與效果由 sim/growth.ts 白名單控制。 */
  growthTags?: import("./sim/growth").GrowthTagId[];

  /** 付租能力與行為 */
  finance: {
    monthlyRent: number;
    /** 0~100:100 = 永遠準時,低於 40 開始出現拖欠劇情 */
    paymentReliability: number;
    /** 目前積欠月數 */
    monthsOverdue: number;
  };

  /** 遊戲數值(0~100)。AI 只能透過 delta 修改 */
  stats: {
    mood: number;        // 心情(短期情緒;每小時朝性格基準回歸 = homeostasis)
    stress: number;      // 壓力(短期;同上)
    wellbeing: number;   // 身心健康(中期慢變:運動/衛生/睡眠↑、高壓/沒精力↓;過低→生病、心情基準下修)
    energy: number;      // 精力(資源:睡覺充、活動耗;過低→壓力基準上修)
    affinity: number;    // 對房東好感度(關係累積,不回歸)
  };

  /** 入住偏好:與 RoomState.attributes 匹配計算吸引力 */
  preferences: Partial<Record<RoomAttribute, number>>;

  /** 當前視覺狀態(前端讀這個畫圖) */
  visualState: TenantVisualState;

  /**
   * 近期劇情摘要(50~150 字)。每次 AI 生成後由 AI 回寫更新,
   * 下次生成時注入 prompt —— 這是跨批次劇情連貫性的關鍵。
   */
  recentSummary: string;
}

// ---------------------------------------------------------------------------
// 家具 (Furniture)
// ---------------------------------------------------------------------------

export interface Furniture {
  id: string;
  name: string;
  description: string;
  price: number;
  /** 對房間屬性的加成(可為負,例:電競桌 noise +10) */
  attributes: Partial<Record<RoomAttribute, number>>;
  /** 擺放格位類型,前端佈局用 */
  slot: "floor_large" | "floor_small" | "wall" | "desk" | "ceiling";
  /** 前端圖層資源 id */
  visualLayerId: string;
  /**
   * 專屬互動解鎖:租客帶有指定標籤時,AI 才被允許生成
   * 這件家具的專屬劇情(例:有 [偷養浪貓] 才會出現「貓抓爛沙發」)。
   */
  unlockInteractions: FurnitureInteraction[];
}

export interface FurnitureInteraction {
  id: string;
  /** 需要租客具備的標籤 id(core 或 memory 皆可),OR 邏輯 */
  requiredTagIds: string[];
  /** 給 AI 的劇情素材提示 */
  promptHint: string;
  /** 觸發時建議的視覺狀態 */
  suggestedVisualState?: TenantVisualState;
  suggestedProps?: RoomPropState[];
}

// ---------------------------------------------------------------------------
// AI 回傳介面 (AIEventResponse) —— AI 必須嚴格遵守
// ---------------------------------------------------------------------------

/** 單條觀察日誌 */
export interface ObservationLog {
  /** 遊戲內時間 "HH:mm" */
  time: string;
  /** 日誌正文,監視器旁白視角,繁體中文,30~80 字 */
  text: string;
  /** 這條日誌發生時租客的視覺狀態(前端可做時間軸回放) */
  visualState: TenantVisualState;
  /** minor: 日常 / notable: 值得注意 / major: 劇情轉折 */
  importance: "minor" | "notable" | "major";
}

/** 突發抉擇事件(需要房東做決定) */
export interface DecisionEvent {
  id: string;
  title: string;        // 例 "牆壁裡傳來貓叫聲?"
  description: string;  // 事件描述,80~150 字
  choices: DecisionChoice[]; // 固定 2~3 個選項
}

export interface DecisionChoice {
  id: string;           // 例 "confront" | "ignore" | "leave_cat_food"
  label: string;        // 按鈕文字,10 字以內
  /** 給玩家的後果暗示(模糊即可,保留懸念) */
  hint: string;
}

/** 數值增量:AI 只能給 -20 ~ +20 的變化量 */
export interface StatDeltas {
  mood?: number;
  stress?: number;
  affinity?: number;
  cleanliness?: number; // 作用於房間
  energy?: number;      // 精力(睡覺+、工作/直播-)
  wellbeing?: number;   // 身心健康(洗澡/打掃/運動+)
}

/** 標籤變更 */
export interface MemoryTagChange {
  add: Array<{
    id: string;
    label: string;
    behaviorHint: string;
  }>;
  /** 要移除的 memory tag id */
  remove: string[];
}

/**
 * ✦ AI 引擎每次生成的完整回傳 ✦
 * 後端呼叫 Claude API 時以 output_config.format (JSON Schema)
 * 強制此結構 —— 見 prompts/ai-engine-prompt.md
 */
export interface AIEventResponse {
  /** 這段掛機時間內的觀察日誌,按時間排序,3~6 條 */
  logs: ObservationLog[];
  /** 生成結束時租客的最終視覺狀態(前端主畫面顯示用) */
  finalVisualState: TenantVisualState;
  /** 房間疊加小物件(完整替換 activeProps) */
  roomProps: RoomPropState[];
  /** 數值增量 */
  statDeltas: StatDeltas;
  /** 記憶標籤變更 */
  memoryTagChanges: MemoryTagChange;
  /** 突發抉擇事件;無事件時為 null(大多數批次應為 null) */
  pendingEvent: DecisionEvent | null;
  /** 回寫 Tenant.recentSummary 的新摘要(50~150 字) */
  updatedSummary: string;
}

// ---------------------------------------------------------------------------
// 房東抉擇的結果回傳(玩家做出選擇後,下一批生成的輸入)
// ---------------------------------------------------------------------------

export interface LandlordDecision {
  eventId: string;
  choiceId: string;
  decidedAt: string; // ISO 8601 遊戲內時間
}

// ---------------------------------------------------------------------------
// 寵物系統:租客養的貓或狗,會在樓層遊走、引發事件
// ---------------------------------------------------------------------------

export type PetKind = "cat" | "dog";
export type HousePetPlacement = "permanent" | "foster" | "partner_foster";
export type PetRehomingDestination = "former_owner" | "adopter";

export type PetPairAction =
  | "chase" | "groom" | "nap" | "territory" | "mischief"
  | "fetch" | "sniff"
  | "greet" | "avoid";

export interface Pet {
  name: string;
  kind: PetKind;
  /** 花色索引:貓=橘/黑/白/三花;狗=柴/黑/白棕/灰 */
  color: number;
  ownerId: string;
  /** 這個遊戲小時寵物待的區域(r301/lounge…;渲染層讓牠走過去遊蕩) */
  hangout: string;
  /** 寵物互動中的另一隻寵物(record key)。 */
  pairWith?: string;
  /** 當前雙寵物演出,供樓層 agent 同步追逐、靠近、退避或一起睡。 */
  pairAction?: PetPairAction;
  pairUntilMs?: number;
  sinceMs: number;
  /** 僅樓寵物使用；舊存檔缺省視為 permanent。一般租客寵物不需要此欄位。 */
  housePlacement?: HousePetPlacement;
  /** 中途媒合完成的遊戲時間；到期後移入幸福新家名冊。 */
  rehomingAtMs?: number;
  /** 退場方向：原主人安頓後接回，或通過審核的新家庭。 */
  rehomingDestination?: PetRehomingDestination;
  /** 原飼主顯示名；轉樓寵物時留下，供日後團圓文案使用。 */
  formerOwnerName?: string;
  /**
   * 店貓標記（咖啡廳的「辣椒」）。刻意**不重用** `housePlacement` 的三個值——
   * 那三個值在送養／中途媒合流程裡都有語意，硬塞會讓店貓被算進永久名額或被送養。
   * 店貓不屬於任何租客也不屬於公寓寵物名冊：不佔 `PERMANENT_HOUSE_PET_LIMIT`、
   * 所有送養路徑都擋掉，只跟著咖啡廳開張而存在。舊存檔沒有此欄位 → 一律非店貓。
   */
  shopCat?: boolean;
}

/** 樓寵物完成媒合後留下的幸福新家紀錄。 */
export interface PetHomeEntry {
  id: string;
  name: string;
  kind: PetKind;
  color: number;
  leftMs: number;
  daysTogether: number;
  destination: string;
  note: string;
}

// ---------------------------------------------------------------------------
// 傳承:歷任房客名冊(退租的人留下的一筆紀錄,供懷舊翻閱)
// ---------------------------------------------------------------------------

export interface AlumniEntry {
  name: string;
  occupation: string;
  /** 住了幾個遊戲日 */
  daysLived: number;
  /** 離開原因(退租理由/分手/驅逐…) */
  reason: string;
  /** 離開當下的遊戲時間 */
  leftMs: number;
  /** 一句代表性記憶(滾動摘要或最後的重要日誌) */
  memory: string;
  /** 離開者留給房東的告別信(模板生成,零 AI 成本):圓夢畢業/安居用專屬句庫,被迫/非圓滿
   *  離開依原因歸類挑語氣句庫。新存檔每位離開者必有;舊存檔早期非畢業條目 ?? undefined 相容。 */
  farewell?: string;
  /** 供玩家匯出除錯 Log 的離場快照。2026-07-23 前建立的舊名冊沒有此欄位。 */
  debugSnapshot?: {
    tenantId: string;
    roomNo: string;
    coreTags: CoreTag[];
    memoryTags: MemoryTag[];
    growthTags: NonNullable<Tenant["growthTags"]>;
    stats: Tenant["stats"];
    finance: Tenant["finance"];
    recentSummary: string;
    cleanliness: number;
    satisfaction: number;
    decisions: string[];
    log: import("./sim/gameState").LogEntry[];
  };
}

// ---------------------------------------------------------------------------
// 群體事件(有房東抉擇版,§C-7):一件事牽動 3+ 位租客,房東的選擇一次影響整群人
// ---------------------------------------------------------------------------

export interface GroupDelta {
  mood?: number;
  stress?: number;
  satisfaction?: number;
  affinity?: number;
}

export interface GroupChoice {
  id: string;
  label: string;
  hint: string;
  /** 房東花費(負)或收入(正) */
  money?: number;
  /** 對所有參與者的數值影響 */
  all?: GroupDelta;
  /** 只對 participantIds[0](如噪音事件的當事人)的額外影響 */
  first?: GroupDelta;
  /** 對其餘參與者的額外影響 */
  rest?: GroupDelta;
  /** 兩兩關係變化 */
  bond?: number;
  /** 選這個 → 清掉參與者的「被噪音困擾」記憶(隔音類選項) */
  clearsNoise?: boolean;
  /** 選這個 → 在 participantIds[0] 的房間留下永久噪音改善工程 */
  installsSoundproofing?: boolean;
}

export interface GroupEvent {
  id: string;
  title: string;
  description: string;
  /** 參與者 id;[0] 在部分事件是「當事人」(其餘為相關鄰居) */
  participantIds: string[];
  choices: GroupChoice[];
}

/** 每日社群事件先排到符合文案的時段，屆時才真正結算與演出。 */
export interface ScheduledCommunityEvent {
  eventId: string;
  participantIds: string[];
  dueGameMs: number;
}

// ---------------------------------------------------------------------------
// 月度全樓事件鏈(sim/floorChain.ts):3 條鏈 × 4 階段的跨日連鎖章節
// 型別放這裡(而非 floorChain.ts)是為了讓 gameState 能宣告狀態槽而不反向 import。
// ---------------------------------------------------------------------------

/** 章節鏈裡「已發生的一階段」紀錄(動態頁章節卡逐條列出) */
export interface FloorChainEntry {
  stage: number;
  title: string;
  text: string;
  gameMs: number;
  /** 這階段有房東抉擇時,拍板後補記選了什麼 */
  decision?: string;
  /** 補進度時被跳過的階段(只留標題,不套數值也不發個人日誌) */
  skipped?: boolean;
}

/** 進行中(或剛完結)的全樓章節鏈 */
export interface FloorChainState {
  chainId: string;
  /** 已推進到第幾話(1~4) */
  stage: number;
  /** 這條鏈起始的遊戲日 */
  startDay: number;
  /** 上次推進階段的遊戲日(推進節奏用) */
  lastAdvanceDay: number;
  /** 已發生的階段 */
  entries: FloorChainEntry[];
  /** 已完結(仍留著給動態頁顯示,直到下一條鏈開始) */
  done: boolean;
}

/** 事件鏈專屬的房東抉擇;結構相容 GroupEvent,可直接餵給 GroupDecisionModal */
export interface ChainEvent extends GroupEvent {
  chainId: string;
  stage: number;
}
