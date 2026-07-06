/**
 * 假 AI 劇本引擎 (Mock AI Engine)
 * Phase 2 用手寫的 AIEventResponse 序列模擬雲端生成,
 * 讓前端 UI 在不接 API 的情況下完整跑過核心循環:
 *   掛機推進 → 讀日誌 → 遇到抉擇 → 選擇影響後續批次
 *
 * Phase 3 時,把 getMockBatch() 換成真正的 Claude API 呼叫即可,
 * 介面完全相同(都回傳 AIEventResponse)。
 */
import type { AIEventResponse } from "../types";

/** decisions: 該租客歷來的抉擇 choiceId 序列(舊 → 新) */
export function getMockBatch(
  tenantId: string,
  batchIndex: number,
  decisions: string[],
): AIEventResponse | null {
  const script = SCRIPTS[tenantId];
  if (!script) return null;
  const entry = script[batchIndex];
  if (!entry) return null;
  return typeof entry === "function" ? entry(decisions) : entry;
}

type BatchEntry =
  | AIEventResponse
  | ((decisions: string[]) => AIEventResponse);

const SCRIPTS: Record<string, BatchEntry[]> = {
  // =========================================================================
  // 301 陳家豪 — 工程師與橘貓 Bug
  // =========================================================================
  tenant_chen_engineer: [
    // ---- 批次 0:深夜救火之夜 ----
    {
      logs: [
        {
          time: "22:47",
          text: "目標回巢,比昨天早了四小時。進門沒開大燈,直接癱進沙發。橘貓 Bug 從紙箱堆後方現身,踩過他的臉表達不滿。",
          visualState: "sleeping_on_couch",
          importance: "minor",
        },
        {
          time: "23:30",
          text: "驚醒。看了手機之後發出本監視器錄到過的最長嘆息——deploy 好像出事了。移動到電競桌前,RGB 燈被切成慘白色。",
          visualState: "working_at_desk",
          importance: "notable",
        },
        {
          time: "01:52",
          text: "Bug 跳上桌面,精準踩過鍵盤後坐在主螢幕正前方。目標沒有把牠移開,而是隔著貓看副螢幕繼續打字。人類的適應力值得記錄。",
          visualState: "working_at_desk",
          importance: "minor",
        },
        {
          time: "03:20",
          text: "修好了。目標高舉雙手無聲歡呼,隨即抱起 Bug 原地轉了兩圈。貓掙脫後在沙發抱枕上狠狠磨了兩下爪子。",
          visualState: "playing_with_cat",
          importance: "notable",
        },
        {
          time: "03:55",
          text: "目標和衣倒回沙發,一隻鞋還掛在腳上。Bug 在他胸口踩奶後盤成一團。房間燈全暗,只剩螢幕待機光。",
          visualState: "sleeping_on_couch",
          importance: "minor",
        },
      ],
      finalVisualState: "sleeping_on_couch",
      roomProps: ["delivery_boxes_piled", "cat_sleeping_on_couch", "lights_off"],
      statDeltas: { mood: 6, stress: -8, cleanliness: -3 },
      memoryTagChanges: { add: [], remove: [] },
      pendingEvent: null,
      updatedSummary:
        "加班期第 13 天,但深夜修復了 deploy 事故,情緒回升。連續兩晚睡在沙發上。沙發抱枕出現了新的貓抓痕——查房時最明顯的破綻。外送盒仍在堆積。",
    },
    // ---- 批次 1:鄰居聽到了貓叫 ----
    {
      logs: [
        {
          time: "05:12",
          text: "Bug 開始凌晨巡邏,把桌上的螺絲起子撥到地上,聲音在深夜格外響亮。目標毫無反應,睡得像被拔掉電源。",
          visualState: "sleeping_on_couch",
          importance: "minor",
        },
        {
          time: "08:40",
          text: "鬧鐘響了四次。第五次他終於起身,坐在沙發邊緣盯著地板整整三分鐘,像在等系統開機。",
          visualState: "idle",
          importance: "minor",
        },
        {
          time: "09:15",
          text: "出門上班。在門口停下,回頭對貓比了一個「噓」的手勢。Bug 的回應是當著他的面伸了個懶腰。",
          visualState: "away",
          importance: "minor",
        },
        {
          time: "09:50",
          text: "302 的住戶在走廊攔住了你。她語氣客氣但明確:凌晨好像聽到 301 傳出貓叫聲,而且不只一次了。",
          visualState: "away",
          importance: "major",
        },
      ],
      finalVisualState: "away",
      roomProps: ["delivery_boxes_piled", "trash_overflow", "cat_on_table"],
      statDeltas: { cleanliness: -2 },
      memoryTagChanges: { add: [], remove: [] },
      pendingEvent: {
        id: "evt_cat_noise",
        title: "301 傳出貓叫聲?",
        description:
          "鄰居向你反映凌晨多次聽到 301 房傳出貓叫。租約明文禁止養寵物。回想起來,陳家豪最近確實可疑:紙箱變多、垃圾裡出現過不明的小袋子、包裹上有寵物用品店的膠帶。",
        choices: [
          {
            id: "inspect",
            label: "突擊查房",
            hint: "直接掌握真相,但可能撕破臉",
          },
          {
            id: "message",
            label: "傳訊息旁敲側擊",
            hint: "給他一個自首的機會",
          },
          {
            id: "ignore",
            label: "裝作沒聽到",
            hint: "維持現狀,但破綻遲早再現",
          },
        ],
      },
      updatedSummary:
        "貓的存在已被鄰居的耳朵捕捉到,房東接到了第一次反映。陳家豪本人毫不知情,照常上班。房間裡:垃圾滿出、外送盒堆積,Bug 白天獨自佔領全屋。",
    },
    // ---- 批次 2:依房東抉擇分歧 ----
    (decisions) => {
      const choice = decisions[decisions.length - 1];
      if (choice === "inspect") {
        return {
          logs: [
            {
              time: "14:05",
              text: "你以「檢查水管」名義進入 301。浴室門縫探出一顆橘色的頭,與你四目相接。牠沒有逃,反而喵了一聲,像是在打招呼。",
              visualState: "away",
              importance: "major",
            },
            {
              time: "18:30",
              text: "目標回家,發現玄關的鞋被移動過,臉色瞬間慘白。他抱著貓在房間中央站了很久,一動也不動。",
              visualState: "pacing",
              importance: "notable",
            },
            {
              time: "21:10",
              text: "你收到一則很長的訊息:道歉、撿到貓的完整經過、願意負擔清潔費,最後是一句「能不能讓 Bug 留下來,拜託」。",
              visualState: "talking_on_phone",
              importance: "major",
            },
          ],
          finalVisualState: "pacing",
          roomProps: ["delivery_boxes_piled", "cat_hiding"],
          statDeltas: { stress: 15, affinity: -5 },
          memoryTagChanges: {
            add: [
              {
                id: "cat_discovered",
                label: "[貓被發現]",
                behaviorHint:
                  "偷養的事實已攤在陽光下,去留取決於房東的裁決。等待期間高度焦慮,對房東的一舉一動過度解讀。",
              },
            ],
            remove: [],
          },
          pendingEvent: {
            id: "evt_cat_verdict",
            title: "Bug 的去留",
            description:
              "貓的存在已經確認,陳家豪全盤托出並提出請求。他是個安靜的租客,繳租紀錄尚可,只是最近有點狼狽。你的決定會寫進這段租約關係的歷史。",
            choices: [
              { id: "allow", label: "默許牠留下", hint: "好感大增,但開了先例" },
              { id: "allowRent", label: "同意,但加租 500", hint: "雙方各退一步" },
              { id: "evict", label: "要求把貓送走", hint: "合約至上,後果難料" },
            ],
          },
          updatedSummary:
            "查房揭穿了一切。陳家豪已自首並請求讓貓留下,正在等待房東的最終裁決,焦慮值逼近上限。Bug 本人對此毫不知情,躲在浴室裡玩水滴。",
        };
      }
      if (choice === "message") {
        return {
          logs: [
            {
              time: "12:40",
              text: "你傳了訊息:「最近有住戶反映晚上聽到貓叫,你那邊有聽到嗎?」已讀。三分鐘後才回:「可能是外面的浪貓吧」。打字時間遠超過這句話的長度。",
              visualState: "away",
              importance: "major",
            },
            {
              time: "18:55",
              text: "目標回家後的第一件事:把貓砂盆搬進浴室,用毛巾塞住門縫。Bug 對新住所表達了強烈抗議,抗議聲又被他慌張地摀住。",
              visualState: "pacing",
              importance: "notable",
            },
            {
              time: "23:20",
              text: "深夜,他抱著貓坐在沙發上滑租屋網站。手指在「可養寵物」的篩選條件上停留了很久,最後還是關掉了頁面。",
              visualState: "idle",
              importance: "major",
            },
          ],
          finalVisualState: "idle",
          roomProps: ["cat_hiding", "lights_off", "delivery_boxes_piled"],
          statDeltas: { stress: 12, affinity: -8, mood: -6 },
          memoryTagChanges: {
            add: [
              {
                id: "fear_of_discovery",
                label: "[提心吊膽]",
                behaviorHint:
                  "確信房東起了疑心。開始執行藏貓作戰:貓限居浴室、深夜才敢倒貓砂、聽到走廊腳步聲就僵住。長期下去壓力會持續累積。",
              },
            ],
            remove: [],
          },
          pendingEvent: null,
          updatedSummary:
            "旁敲側擊的訊息讓他進入一級戒備:撒了謊、把貓藏進浴室、甚至開始瀏覽可養寵物的租屋。貓與人的生活品質同步下降。這場貓捉老鼠(字面意義)才剛開始。",
        };
      }
      // ignore
      return {
        logs: [
          {
            time: "13:15",
            text: "Bug 獨自在家的第 14 天,已完全掌握這個房間:上午睡窗邊,下午睡沙發,傍晚在門口迎接。牠比租客更像這裡的主人。",
            visualState: "away",
            importance: "minor",
          },
          {
            time: "19:02",
            text: "目標回家,今天走路有風——他的專案上了公司新聞稿。手上提著一罐高級貓罐頭和一手啤酒。",
            visualState: "eating",
            importance: "notable",
          },
          {
            time: "22:45",
            text: "他舉著啤酒對貓致詞:「敬我們——沒被發現。」Bug 面無表情地吃罐頭,對這份自信不予置評。",
            visualState: "playing_with_cat",
            importance: "notable",
          },
        ],
        finalVisualState: "playing_with_cat",
        roomProps: ["cat_on_table", "screen_glow"],
        statDeltas: { mood: 10, stress: -6, cleanliness: -2 },
        memoryTagChanges: { add: [], remove: [] },
        pendingEvent: null,
        updatedSummary:
          "房東選擇沉默,人貓同居進入黃金期:專案成功、貓咪安穩。但鄰居的耳朵還在,垃圾裡的貓砂袋越來越多——這份平靜是借來的。",
      };
    },
    // ---- 批次 3:結局批次(依累積抉擇收尾)----
    (decisions) => {
      if (decisions.includes("allow")) {
        return {
          logs: [
            {
              time: "10:20",
              text: "你的回覆送達:「牠可以留下,把房間顧好就行。」監視器拍到目標盯著手機,原地跳了一下,又假裝什麼都沒發生。",
              visualState: "idle",
              importance: "major",
            },
            {
              time: "14:00",
              text: "他出門了一趟,回來時扛著一座 1.8 公尺高的貓跳台。組裝過程中被 Bug 監工,錯誤率因此提升 40%。",
              visualState: "cleaning",
              importance: "notable",
            },
            {
              time: "21:30",
              text: "房間被徹底打掃了一遍,外送盒清空,垃圾全倒。他傳來一張 Bug 坐在跳台頂端的照片,附言:「新室友向房東問好」。",
              visualState: "playing_with_cat",
              importance: "notable",
            },
          ],
          finalVisualState: "playing_with_cat",
          roomProps: ["cat_on_table"],
          statDeltas: { mood: 18, stress: -15, affinity: 20, cleanliness: 15 },
          memoryTagChanges: {
            add: [
              {
                id: "cat_approved",
                label: "[光明正大養貓]",
                behaviorHint:
                  "貓已合法化。對房東抱有強烈感激,繳租會更準時,主動維護房間。偶爾傳貓照給房東。",
              },
            ],
            remove: ["near_breakdown", "cat_discovered"],
          },
          pendingEvent: null,
          updatedSummary:
            "Bug 正式成為 301 的合法住戶。陳家豪的感激轉化為行動力:大掃除、貓跳台、主動報備。這對房客關係進入蜜月期——只要別讓其他租客也知道有先例就好。",
        };
      }
      if (decisions.includes("allowRent")) {
        return {
          logs: [
            {
              time: "10:20",
              text: "你的條件送達:「貓可以留,月租加 500。」回覆在 11 秒內到達:「好!謝謝房東!!」——像是怕你反悔。",
              visualState: "talking_on_phone",
              importance: "major",
            },
            {
              time: "19:40",
              text: "他下班回家,對著貓宣布:「你現在是月租 500 的貓了,要有自覺。」Bug 打了個哈欠。",
              visualState: "playing_with_cat",
              importance: "notable",
            },
            {
              time: "23:05",
              text: "恢復日常:電競桌前工作,貓在腿上。比起上週,他的肩膀明顯放鬆了——秘密的重量原來有 500 元這麼重。",
              visualState: "working_at_desk",
              importance: "minor",
            },
          ],
          finalVisualState: "working_at_desk",
          roomProps: ["cat_sleeping_on_couch", "screen_glow"],
          statDeltas: { mood: 10, stress: -12, affinity: 10, cleanliness: 4 },
          memoryTagChanges: {
            add: [
              {
                id: "cat_taxed",
                label: "[繳貓稅中]",
                behaviorHint:
                  "月租 +500 換來光明正大。對交易結果滿意,但會半開玩笑地在繳租訊息裡寫「本月貓稅已含」。",
              },
            ],
            remove: ["near_breakdown", "cat_discovered"],
          },
          pendingEvent: null,
          updatedSummary:
            "貓稅協議達成:+500/月,Bug 合法居留。陳家豪如釋重負,生活節奏回穩。租金收入上升,而且他大概是全城最不敢遲繳的租客了。",
        };
      }
      if (decisions.includes("evict")) {
        return {
          logs: [
            {
              time: "10:20",
              text: "你的決定送達:「約定就是約定,貓必須送走。」已讀之後,沒有回覆。",
              visualState: "idle",
              importance: "major",
            },
            {
              time: "20:15",
              text: "同事開車來接走了 Bug。目標把貓跳台的購物頁面關掉,站在突然安靜下來的房間中央。監視器首次拍到他哭。",
              visualState: "crying",
              importance: "major",
            },
            {
              time: "23:50",
              text: "他坐在電競桌前,螢幕開著但手沒有動。沙發上的抓痕還在。他傳來一則訊息:「貓送走了。另外,租約到期後我不續約了。」",
              visualState: "idle",
              importance: "major",
            },
          ],
          finalVisualState: "idle",
          roomProps: ["lights_off"],
          statDeltas: { mood: -20, stress: 10, affinity: -20, cleanliness: 2 },
          memoryTagChanges: {
            add: [
              {
                id: "lost_cat",
                label: "[失去 Bug]",
                behaviorHint:
                  "貓被送走了。情緒低落,對房間失去感情,已決定不續約。加班變得更晚——家裡沒有等他的東西了。",
              },
            ],
            remove: ["stray_cat_adopted", "cat_discovered"],
          },
          pendingEvent: null,
          updatedSummary:
            "合約贏了,關係輸了。Bug 被送走,陳家豪決定租約到期後搬離。房間恢復了「合規」,也失去了故事。空租期的風險正在倒數。",
        };
      }
      // message / ignore 路線的收尾
      if (decisions.includes("message")) {
        return {
          logs: [
            {
              time: "07:30",
              text: "藏貓作戰第三天。他起床的第一件事是檢查浴室隔音,Bug 的不滿已經升級為絕食抗議(維持了 20 分鐘)。",
              visualState: "pacing",
              importance: "notable",
            },
            {
              time: "21:00",
              text: "他在紙箱上寫字:「隔音棉 x4」。人和貓都在適應這種偷偷摸摸的生活,但看起來都不太開心。",
              visualState: "idle",
              importance: "notable",
            },
          ],
          finalVisualState: "idle",
          roomProps: ["cat_hiding", "delivery_boxes_piled", "curtains_closed"],
          statDeltas: { stress: 6, mood: -4 },
          memoryTagChanges: { add: [], remove: [] },
          pendingEvent: null,
          updatedSummary:
            "藏貓生活常態化:隔音棉、深夜倒貓砂、永遠拉上的窗簾。壓力在緩慢累積,這個平衡遲早會被打破——下次貓叫聲、或下次查房。",
        };
      }
      // ignore
      return {
        logs: [
          {
            time: "11:00",
            text: "週末。目標睡到中午,起床後和貓對坐吃早午餐,一人一貓各吃各的,氣氛像老夫老妻。",
            visualState: "eating",
            importance: "minor",
          },
          {
            time: "16:30",
            text: "他難得打了一下午電動,Bug 睡在主機上(那裡最暖)。房間亂度回升,但心情曲線很漂亮。",
            visualState: "gaming",
            importance: "minor",
          },
        ],
        finalVisualState: "gaming",
        roomProps: ["cat_on_table", "trash_overflow", "screen_glow"],
        statDeltas: { mood: 8, stress: -8, cleanliness: -4 },
        memoryTagChanges: { add: [], remove: [] },
        pendingEvent: null,
        updatedSummary:
          "被默許(本人不知情)的人貓生活進入穩定期。加班潮退去,心情回穩。唯一的隱患:鄰居的耳朵、和越來越大膽的貓。",
      };
    },
  ],

  // =========================================================================
  // 302 林小婕 — ASMR 實況主與裝修噪音
  // =========================================================================
  tenant_lin_asmr: [
    // ---- 批次 0:被電鑽入侵的直播夜 ----
    {
      logs: [
        {
          time: "23:40",
          text: "直播前儀式啟動:擦拭麥克風、泡白毫烏龍、對著鏡子做嗓音熱身。每個步驟的順序與昨天分毫不差,像一套精密的開機程序。",
          visualState: "idle",
          importance: "minor",
        },
        {
          time: "00:05",
          text: "準時開播,今晚主題是「雨聲與翻書聲」。彈幕安靜地滾動,一萬人在螢幕另一端一起屏住呼吸。",
          visualState: "streaming",
          importance: "minor",
        },
        {
          time: "03:12",
          text: "直播中斷了 40 秒——隔壁棟的裝修隊不知為何凌晨施工,電鑽聲穿透了兩面牆。她對著鏡頭維持微笑,握著茶杯的指節發白。",
          visualState: "streaming",
          importance: "major",
        },
        {
          time: "03:50",
          text: "提前下播。她在筆記本寫下第三條「噪音紀錄」,這次的字跡明顯比前兩條用力。",
          visualState: "idle",
          importance: "notable",
        },
      ],
      finalVisualState: "idle",
      roomProps: ["mic_setup_active", "curtains_closed", "screen_glow"],
      statDeltas: { stress: 10, mood: -6 },
      memoryTagChanges: { add: [], remove: [] },
      pendingEvent: null,
      updatedSummary:
        "隔壁棟裝修噪音第三次入侵直播,今晚被迫提前下播。筆記本上的噪音紀錄已有三條,她正在猶豫要不要聯絡房東。頻道破萬的好心情正在被電鑽一格一格磨掉。",
    },
    // ---- 批次 1:極有禮貌的求助訊息 ----
    {
      logs: [
        {
          time: "06:10",
          text: "就寢程序:耳塞、眼罩、白噪音機三重防護。對一個以聲音為業的人來說,睡眠是需要工程手段保護的資產。",
          visualState: "sleeping_on_bed",
          importance: "minor",
        },
        {
          time: "08:30",
          text: "電鑽聲再度響起。她坐起來,摘下耳塞,盯著牆壁的方向看了很久——那不是憤怒,更像是在測量方位。",
          visualState: "idle",
          importance: "notable",
        },
        {
          time: "09:45",
          text: "你收到一則措辭極有禮貌的長訊息:一份精確到分鐘的噪音時間表、對睡眠與收入影響的說明,結尾是「想請問房東能否協助處理,謝謝您」。",
          visualState: "talking_on_phone",
          importance: "major",
        },
      ],
      finalVisualState: "sleeping_on_bed",
      roomProps: ["curtains_closed"],
      statDeltas: { stress: 8, mood: -4 },
      memoryTagChanges: { add: [], remove: [] },
      pendingEvent: {
        id: "evt_noise_help",
        title: "302 的噪音求助",
        description:
          "林小婕是模範租客:繳租永遠提前、房間一塵不染、從不惹事。這是她入住以來第一次開口請求協助——隔壁棟的裝修噪音正在破壞她的睡眠與直播事業。她甚至附上了完整的噪音時間紀錄表。",
        choices: [
          {
            id: "negotiate",
            label: "出面協調施工時段",
            hint: "花時間,但治本",
          },
          {
            id: "curtain",
            label: "送一組隔音窗簾",
            hint: "快速表達誠意",
          },
          {
            id: "ignore",
            label: "已讀不回",
            hint: "她會自己想辦法——大概吧",
          },
        ],
      },
      updatedSummary:
        "她鼓起勇氣向房東發出了第一次求助(附噪音數據表)。對高度自律的她來說,開口本身就是大事。房東的回應方式將直接定義這段租賃關係。",
    },
    // ---- 批次 2:依房東抉擇分歧 ----
    (decisions) => {
      const choice = decisions[decisions.length - 1];
      if (choice === "negotiate") {
        return {
          logs: [
            {
              time: "15:30",
              text: "你聯絡了施工方與對面大樓管委會,約定 22:00 後與 10:00 前不施工。整個過程花了三通電話與一次現場拜訪。",
              visualState: "sleeping_on_bed",
              importance: "major",
            },
            {
              time: "17:20",
              text: "她收到協調結果,回覆了一整排感謝貼圖——與她平常克制的訊息風格判若兩人。",
              visualState: "talking_on_phone",
              importance: "notable",
            },
            {
              time: "00:10",
              text: "今晚直播開場,她對著一萬名觀眾說:「最近的噪音問題解決了,要特別感謝一位很好的房東。」你被寫進了 ASMR 的歷史。",
              visualState: "streaming",
              importance: "notable",
            },
          ],
          finalVisualState: "streaming",
          roomProps: ["mic_setup_active", "curtains_closed", "screen_glow"],
          statDeltas: { stress: -14, mood: 12, affinity: 20 },
          memoryTagChanges: {
            add: [
              {
                id: "trusts_landlord",
                label: "[信任房東]",
                behaviorHint:
                  "房東用行動解決了她的求助,信任度大幅上升。未來有問題會直接、及早反映,續約意願極高,甚至會向同行推薦這裡。",
              },
            ],
            remove: [],
          },
          pendingEvent: null,
          updatedSummary:
            "噪音問題被房東出面根治,她在直播中公開致謝。信任關係建立,這位模範租客的續約幾乎是確定的了。她已恢復完整的直播作息。",
        };
      }
      if (choice === "curtain") {
        return {
          logs: [
            {
              time: "14:40",
              text: "隔音窗簾送達 302。她研究了半小時安裝說明,自己搬椅子裝好了——過程行雲流水,顯然不是第一次自己動手。",
              visualState: "cleaning",
              importance: "notable",
            },
            {
              time: "16:00",
              text: "她對著窗簾做了一次拍手測試,歪著頭聽回聲,在筆記本寫下「中頻改善,低頻仍穿透」。",
              visualState: "idle",
              importance: "minor",
            },
            {
              time: "20:30",
              text: "你收到訊息:「謝謝房東!有改善一些!」措辭真誠。但監視器注意到,噪音紀錄表並沒有被收起來,只是換了一頁。",
              visualState: "talking_on_phone",
              importance: "notable",
            },
          ],
          finalVisualState: "idle",
          roomProps: ["curtains_closed", "mic_setup_active"],
          statDeltas: { stress: -5, mood: 4, affinity: 10 },
          memoryTagChanges: { add: [], remove: [] },
          pendingEvent: null,
          updatedSummary:
            "隔音窗簾緩解了部分噪音,她對房東的誠意心存感激。但低頻震動仍在,紀錄表還在更新——問題被降級,沒有被解決。若裝修持續,求助可能升級。",
        };
      }
      // ignore
      return {
        logs: [
          {
            time: "12:00",
            text: "訊息顯示「已讀」已超過 24 小時。她盯著那兩個字看了十秒,把手機螢幕朝下扣在桌上。",
            visualState: "idle",
            importance: "major",
          },
          {
            time: "15:40",
            text: "她戴著耳機出門,回來時提著兩大袋隔音棉與一捲膠帶。自力救濟計畫啟動。",
            visualState: "cleaning",
            importance: "notable",
          },
          {
            time: "02:30",
            text: "下播後,監視器拍到她的瀏覽紀錄停在租屋網站。搜尋條件:「頂樓、邊間、可報稅」。她把三個物件加入了收藏。",
            visualState: "idle",
            importance: "major",
          },
        ],
        finalVisualState: "idle",
        roomProps: ["curtains_closed", "mic_setup_active", "delivery_boxes_piled"],
        statDeltas: { stress: 6, mood: -8, affinity: -18 },
        memoryTagChanges: {
          add: [
            {
              id: "considering_moving",
              label: "[考慮搬家]",
              behaviorHint:
                "房東的沉默讓她收回了信任。開始物色新租屋處,對現居所的投入(佈置、維護)會逐漸減少。繳租依然準時——她的離開會毫無徵兆。",
            },
          ],
          remove: [],
        },
        pendingEvent: null,
        updatedSummary:
          "求助石沉大海。她不吵不鬧,默默開始自力救濟與物色新居。最可怕的租客流失就是這種:安靜、體面、不可挽回。租屋收藏清單:3 筆。",
      };
    },
    // ---- 批次 3:設備升級日(頻道破萬的後續)----
    (decisions) => {
      const moving = decisions.includes("ignore");
      return {
        logs: [
          {
            time: "13:20",
            text: "一個半人高的包裹送達:新的電容麥克風與防震架,第一筆業配收入的具體形狀。她簽收時的表情像在領獎。",
            visualState: "idle",
            importance: "notable",
          },
          {
            time: "16:45",
            text: "她把電競桌改造成雙麥克風直播台:量尺寸、走線、測試燈光角度。工程持續了三小時,精確得像在佈置手術室。",
            visualState: "streaming",
            importance: "notable",
          },
          moving
            ? {
                time: "01:15",
                text: "新麥克風的首播非常成功。下播後她環顧這個被自己佈置得完美的房間,輕聲說了一句:「搬家的話,這些線要重拉了呢。」",
                visualState: "idle",
                importance: "major",
              }
            : {
                time: "01:15",
                text: "新麥克風的首播非常成功,同接人數創了新高。下播後她拍了一張直播台的照片設成手機桌布——這個房間正在變成她事業的一部分。",
                visualState: "idle",
                importance: "notable",
              },
        ],
        finalVisualState: "sleeping_on_bed",
        roomProps: ["mic_setup_active", "curtains_closed", "delivery_boxes_piled"],
        statDeltas: { mood: 10, stress: -4 },
        memoryTagChanges: { add: [], remove: [] },
        pendingEvent: null,
        updatedSummary: moving
          ? "設備升級完成,事業蒸蒸日上——但搬家的念頭沒有消失,只是被工作暫時蓋過。新設備讓搬家成本變高,這也許是留住她的最後緩衝期。"
          : "設備升級完成,直播事業進入新階段。房間已深度綁定她的工作流程,搬家成本極高——只要噪音問題不復發,她會是長期租客。",
      };
    },
  ],
};

/** 各租客的劇本長度(播完後 UI 顯示「劇本結束」) */
export function getScriptLength(tenantId: string): number {
  return SCRIPTS[tenantId]?.length ?? 0;
}
