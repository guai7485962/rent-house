/** 樓層名字標籤的輕量碰撞排版；座標皆為 canvas 邏輯像素。 */
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

interface TagRect { left: number; right: number; top: number; bottom: number }

const OFFSETS = [
  [0, 0], [-20, -9], [20, -9], [-20, -19], [20, -19],
  [0, -29], [-38, -29], [38, -29], [0, -40],
] as const;

/**
 * 依序嘗試左右錯位與向上堆疊，避免相鄰角色的膠囊標籤彼此遮住。
 * 估算寬度刻意稍寬，中文名、emoji 與手機字型仍保有間距。
 */
export function layoutFloorTags(tags: FloorTagAnchor[], width: number, height: number): FloorTagPlacement[] {
  const placed: TagRect[] = [];
  return tags.map((tag) => {
    const tagWidth = Math.max(tag.kind === "pet" ? 28 : 24, 10 + Array.from(tag.name).length * 7);
    const tagHeight = 9;
    let bestX = tag.x;
    let bestY = tag.y;
    for (const [dx, dy] of OFFSETS) {
      const x = Math.max(tagWidth / 2, Math.min(width - tagWidth / 2, tag.x + dx));
      const y = Math.max(tagHeight, Math.min(height, tag.y + dy));
      const rect = { left: x - tagWidth / 2, right: x + tagWidth / 2, top: y - tagHeight, bottom: y };
      if (!placed.some((p) => rect.left < p.right + 2 && rect.right > p.left - 2 && rect.top < p.bottom + 2 && rect.bottom > p.top - 2)) {
        bestX = x;
        bestY = y;
        break;
      }
    }
    placed.push({ left: bestX - tagWidth / 2, right: bestX + tagWidth / 2, top: bestY - tagHeight, bottom: bestY });
    return { ...tag, drawX: bestX, drawY: bestY };
  });
}
