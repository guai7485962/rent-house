import type { FurnitureDef } from "./catalog";

export type FurnitureRotation = 0 | 90 | 180 | 270;

export function normalizeRotation(value: unknown): FurnitureRotation {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value / 90) * 90 : 0;
  return (((n % 360) + 360) % 360) as FurnitureRotation;
}

export function nextRotation(rotation: FurnitureRotation): FurnitureRotation {
  return normalizeRotation(rotation + 90);
}

/** 旋轉後實際佔用的格數；90°/270° 交換寬高。 */
export function rotatedFootprint(def: Pick<FurnitureDef, "footprint">, rotation: FurnitureRotation) {
  return rotation === 90 || rotation === 270
    ? { w: def.footprint.h, h: def.footprint.w }
    : { ...def.footprint };
}

/** 將相對原始左上角的格座標順時針旋轉；互動點在家具外時也同樣成立。 */
export function rotateGridOffset(
  point: { dc: number; dr: number },
  footprint: { w: number; h: number },
  rotation: FurnitureRotation,
): { dc: number; dr: number } {
  if (rotation === 90) return { dc: footprint.h - 1 - point.dr, dr: point.dc };
  if (rotation === 180) return { dc: footprint.w - 1 - point.dc, dr: footprint.h - 1 - point.dr };
  if (rotation === 270) return { dc: point.dr, dr: footprint.w - 1 - point.dc };
  return { ...point };
}

/** 原始水平／垂直軸旋轉後的方向，用於沿家具邊緣排出兩個互動點。 */
export function rotateGridVector(dc: number, dr: number, rotation: FurnitureRotation) {
  if (rotation === 90) return { dc: -dr, dr: dc };
  if (rotation === 180) return { dc: -dc, dr: -dr };
  if (rotation === 270) return { dc: dr, dr: -dc };
  return { dc, dr };
}
