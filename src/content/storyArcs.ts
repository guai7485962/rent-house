/**
 * 劇情弧的**本地種子目錄**(純資料檔,零 sim import,只吃型別)。
 *
 * 為什麼要有這一份:在此之前劇情弧的主題 100% 由 AI 生成(`sanitizeArcUpdate` 只負責消毒),
 * 所以離線、免費額度用完、或走模板 fallback 的玩家**永遠不會有連載**——
 * 跟月度事件鏈當初的問題同一類。本檔讓本地規則也能開弧、推進、收束。
 *
 * 分工:AI 有額度時仍由 AI 主導(`rt.arc` 非空時本地引擎完全不動手);
 * 沒額度時由 `src/sim/localArc.ts` 依這份目錄決定性推進。挑鏈/推進/收束的邏輯一律在該檔,
 * 本檔只放文本 —— 之後補劇情 = 只改這裡,sim 測試與 balance 快照都不會被碰到。
 *
 * 🔴 硬性約束:
 * - `id` 會進存檔(`arc.seedId`),既有種子的 id 一個字都不能改;只能 append 新的
 * - `theme` ≤ 14 字(對齊 `sanitizeArcUpdate` 對 AI 的同一道上限,兩條路徑產出的弧才等價)
 * - `stages` 長度 2~6(= `maxStage`,對齊 `sanitizeArcUpdate` 的 `int(r.maxStage, 2, 6, 3)`)
 * - 文本不得寫死租客姓名、金額或日期——那些由 sim 端帶入或根本不提
 * - 觸發條件只用「職業字串」與「核心標籤 id」,兩者都空 = 任何人都可能抽到
 */
import type { GrowthTagId } from "../sim/growth";
import type { ArcTone } from "../sim/arcs";

export interface ArcSeedStage {
  /** 寫進 `arc.summary`:下一天餵回 AI 當前情提要,也顯示在房客頁 */
  summary: string;
  /** 這一步的社群日誌(📖 進 Feed) */
  line: string;
  /** 情緒方向 → `ARC_TONE_PULSE` 的固定小幅脈衝;null = 不推數值 */
  tone: ArcTone | null;
}

export interface StoryArcSeed {
  id: string;
  theme: string;
  /** 職業命中任一即可(空 = 不限職業) */
  occupations?: readonly string[];
  /** 核心標籤 id 命中任一即可(空 = 不限標籤) */
  tags?: readonly string[];
  stages: readonly ArcSeedStage[];
  conclude: { line: string; tone: ArcTone; growthTag: GrowthTagId };
}

export const STORY_ARC_SEEDS: readonly StoryArcSeed[] = [
  {
    id: "arc_seed_stray_at_door",
    theme: "門口那隻貓",
    stages: [
      { summary: "門口出現一隻不肯走的貓,他開始偷偷放水。", line: "📖 門口蹲了一隻貓,他假裝沒看見,回頭卻放了一小碟水。", tone: null },
      { summary: "貓每天都來,他開始查該怎麼照顧。", line: "📖 那隻貓天天報到。他晚上查了半小時「浪貓怎麼照顧」。", tone: "up" },
      { summary: "貓消失了兩天,他心神不寧。", line: "📖 貓兩天沒出現。他上下樓時都會多看一眼那個角落。", tone: "tense" },
    ],
    conclude: {
      line: "📕 貓回來了,還帶著另一隻。他蹲下來笑了很久,決定去買一個真正的碗。",
      tone: "up",
      growthTag: "hopeful",
    },
  },
  {
    id: "arc_seed_late_night_letter",
    theme: "深夜寫的那封信",
    tags: ["night_owl", "late_return"],
    stages: [
      { summary: "他在深夜寫了一封一直沒寄出的信。", line: "📖 凌晨三點,他寫了一封信,寫完卻沒有寄。", tone: "tense" },
      { summary: "那封信被反覆改寫。", line: "📖 那封信被改了第四次。有些話刪掉又補回來。", tone: null },
      { summary: "他終於決定要面對這件事。", line: "📖 他把信摺好放進外套口袋,像是下了什麼決心。", tone: "tense" },
    ],
    conclude: {
      line: "📕 信寄出去了。他回家後睡了十個小時,醒來時房間的空氣好像鬆了。",
      tone: "tense",
      growthTag: "lets_go",
    },
  },
  {
    id: "arc_seed_wall_between",
    theme: "牆的另一邊",
    tags: ["sound_sensitive", "noisy", "perfectionist"],
    stages: [
      { summary: "隔壁的聲音成了他每天的心結。", line: "📖 隔壁又傳來聲音。他盯著天花板,沒有敲牆。", tone: "tense" },
      { summary: "他在紙上寫了想說的話,又揉掉。", line: "📖 他寫了一張紙條要貼隔壁門口,寫完自己讀了一次,揉掉了。", tone: "down" },
      { summary: "電梯裡遇到本人,兩人都尷尬地點了頭。", line: "📖 電梯裡遇到隔壁的人。兩人點頭,誰也沒提那件事。", tone: null },
      { summary: "他決定直接開口。", line: "📖 他敲了隔壁的門,手心有點濕。", tone: "tense" },
    ],
    conclude: {
      line: "📕 話說開了,對方比想像中好講話。兩人約好時段,回房時他覺得整棟樓都安靜了一點。",
      tone: "tense",
      growthTag: "asks_for_help",
    },
  },
  {
    id: "arc_seed_first_customer",
    theme: "記得的第一位客人",
    occupations: ["咖啡師", "甜點師", "調酒師", "花藝師", "獨立書店店員"],
    stages: [
      { summary: "有位客人每週固定出現,點一樣的東西。", line: "📖 那位客人又來了,還是同一份、同一個位子。", tone: null },
      { summary: "他們開始交談,他知道了對方的故事。", line: "📖 今天多聊了兩句。原來對方每週來,是為了紀念一個人。", tone: "up" },
      { summary: "客人有一陣子沒出現。", line: "📖 那位客人三週沒來了。他還是照著習慣留了位子。", tone: "down" },
    ],
    conclude: {
      line: "📕 客人回來了,說搬家了但還是想再來一次。他把那份東西做得比平常更用心。",
      tone: "up",
      growthTag: "more_confident",
    },
  },
  {
    id: "arc_seed_deadline_week",
    theme: "截稿的那一週",
    occupations: ["漫畫家", "推理小說家", "自由接案設計師", "ASMR 實況主", "婚禮攝影師"],
    stages: [
      { summary: "進度落後,他開始壓縮睡眠。", line: "📖 進度落後了。他把鬧鐘往前調了兩小時。", tone: "tense" },
      { summary: "做出來的東西他自己都不滿意。", line: "📖 做到一半全部推翻重來。他坐在椅子上盯著螢幕很久。", tone: "down" },
      { summary: "有人在他撐不住時遞了東西過來。", line: "📖 門口放著一杯還溫的東西,沒有署名。他愣了一下。", tone: "up" },
      { summary: "最後一天,他決定就這樣交出去。", line: "📖 他按下送出,沒有再檢查第五次。", tone: "tense" },
    ],
    conclude: {
      line: "📕 交出去了,回應比預期好。他睡了很久,醒來第一件事是把桌子整個擦乾淨。",
      tone: "tense",
      growthTag: "resilient",
    },
  },
  {
    id: "arc_seed_dawn_after_shift",
    theme: "下班時的天亮",
    tags: ["late_return", "early_bird"],
    stages: [
      { summary: "他開始注意到下班路上的天色。", line: "📖 收工時天正在亮。他站在路口多看了一會兒。", tone: null },
      { summary: "他開始用手機拍每天的天空。", line: "📖 他拍了第七張天亮的照片,存在一個沒給人看過的相簿。", tone: "up" },
      { summary: "有人問起那些照片。", line: "📖 有人瞄到他手機裡那疊天空,問他在拍什麼。他難得多說了幾句。", tone: "up" },
    ],
    conclude: {
      line: "📕 他把其中一張洗出來貼在牆上。那是他第一次覺得,這些沒人看見的清晨是值得的。",
      tone: "up",
      growthTag: "grounded",
    },
  },
  {
    id: "arc_seed_old_photo",
    theme: "抽屜裡的舊照片",
    stages: [
      { summary: "整理房間時翻出一張舊照片。", line: "📖 整理抽屜時翻出一張舊照片。他看了很久才放回去。", tone: null },
      { summary: "那張照片被拿出來又放回去好幾次。", line: "📖 那張照片今天又被拿出來了。他沒有說話。", tone: "down" },
      { summary: "他開始想聯絡照片裡的人。", line: "📖 他把那個號碼翻出來,存進手機,還沒有按下去。", tone: "tense" },
    ],
    conclude: {
      line: "📕 他們通了電話,講了一個多小時。掛掉之後他把照片擺到桌上,不再收回抽屜。",
      tone: "up",
      growthTag: "lets_go",
    },
  },
  {
    id: "arc_seed_almost_dead_plant",
    theme: "差點養死的那盆",
    stages: [
      { summary: "他接手了一盆快枯掉的植物。", line: "📖 他把那盆快枯掉的植物搬進房間,說再試試看。", tone: null },
      { summary: "植物沒有起色,他開始懷疑自己。", line: "📖 那盆植物又掉了三片葉子。他把它移到窗邊。", tone: "down" },
      { summary: "冒出了一片新葉。", line: "📖 新葉子冒出來了。他拍了照,傳給了誰。", tone: "up" },
    ],
    conclude: {
      line: "📕 那盆植物活過來了,長得比剛來時還好。他開始認真研究要不要再養一盆。",
      tone: "up",
      growthTag: "patient",
    },
  },
  {
    id: "arc_seed_borrowed_umbrella",
    theme: "借出去的那把傘",
    stages: [
      { summary: "他把傘借給了樓裡的某個人。", line: "📖 下大雨,他把自己的傘塞給了在門口猶豫的鄰居。", tone: "up" },
      { summary: "傘一直沒還,他也沒開口要。", line: "📖 傘一直沒還回來。他淋著小雨走進大門,什麼也沒說。", tone: null },
      { summary: "對方帶著一把新的傘出現。", line: "📖 門口掛著一把新傘,還有一張紙條。他站在那裡讀了兩次。", tone: "up" },
    ],
    conclude: {
      line: "📕 那把傘後來變成兩個人共用的東西。誰要出門,誰就拿走——這棟樓好像多了一點什麼。",
      tone: "up",
      growthTag: "hopeful",
    },
  },
  {
    id: "arc_seed_exam_countdown",
    theme: "牆上倒數的紙",
    occupations: ["研究生", "獸醫助理", "補習班英文老師", "電競系學生", "後端工程師"],
    stages: [
      { summary: "他在牆上貼了一張倒數。", line: "📖 牆上多了一張倒數的紙,數字用麥克筆寫得很大。", tone: "tense" },
      { summary: "倒數過半,他的作息開始亂。", line: "📖 倒數剩一半。他今天又是啃著麵包坐回桌前。", tone: "down" },
      { summary: "有人提醒他要休息。", line: "📖 有人在走廊上叫住他,要他去吃頓正常的飯。他愣了一下,笑了。", tone: "up" },
      { summary: "最後一天,他把那張紙撕了下來。", line: "📖 他把牆上那張紙撕下來,對摺,收進抽屜。", tone: "tense" },
    ],
    conclude: {
      line: "📕 結果出來了。無論數字如何,他知道自己確實撐完了整段——這件事沒有人能拿走。",
      tone: "tense",
      growthTag: "more_confident",
    },
  },
];
