/** 樓層名字標籤定位；座標皆為 canvas 邏輯像素。 */
export interface FloorTagAnchor {
  id: string;
  name: string;
  x: number;
  y: number;
  kind: "tenant" | "pet";
  color: string;
}

export interface FloorTagPlacement extends FloorTagAnchor {
  drawX: number;
  drawY: number;
}

/**
 * 名牌固定在角色錨點正上方，只在畫布邊緣做夾值。
 * 角色站位系統本身會避開重疊；這裡不再依鄰居位置左右挪動，避免走動時
 * 名牌突然換邊、看起來沒有跟在角色身上。
 */
export function layoutFloorTags(tags: FloorTagAnchor[], width: number, height: number): FloorTagPlacement[] {
  return tags.map((tag) => {
    const tagWidth = Math.max(tag.kind === "pet" ? 28 : 24, 10 + Array.from(tag.name).length * 7);
    const tagHeight = 9;
    const drawX = Math.max(tagWidth / 2, Math.min(width - tagWidth / 2, tag.x));
    const drawY = Math.max(tagHeight, Math.min(height, tag.y));
    return { ...tag, drawX, drawY };
  });
}
