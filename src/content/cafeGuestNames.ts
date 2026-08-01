/**
 * 咖啡廳顧客的獨立姓名池。
 *
 * 不可與 recruit.ts 的 NAME_IDENTITIES 共用：顧客不進租客 runtime，且同時出現在
 * 招租池與咖啡廳時仍必須能一眼分辨。新增只能 append，避免既有 seed 換名字。
 */
export const cafeGuestNames = [
  "方雨晴", "石育誠", "朱庭安", "江佩珊", "何宇辰", "呂心瑜",
  "宋子維", "杜婉庭", "沈嘉禾", "卓映彤", "邱語晨", "柯昱翔",
  "施佳穎", "紀柏宇", "胡芷寧", "范庭瑄", "唐以樂", "夏允恩",
  "孫奕帆", "徐若安", "高詠晴", "梁子謙", "莊可欣", "陸承澤",
  "傅宜蓁", "彭凱文", "游舒涵", "程皓然", "葉采薇", "廖沛辰",
  "趙家妤", "劉祐廷",
] as const;

export type CafeGuestName = (typeof cafeGuestNames)[number];
