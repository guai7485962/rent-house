/** A rectangular camera window in floor-scene pixels. */
export interface FloorViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloorViewportContext {
  imageSmoothingEnabled: boolean;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
}

/** Build a viewport for any rectangular part of the composed floor. */
export function viewportRect(x: number, y: number, width: number, height: number): FloorViewportRect {
  return { x, y, width, height };
}

export const clampViewportOrigin = (value: number, max: number) => Math.min(Math.max(value, 0), max);

/** Center a viewport on a floor point while keeping its full rectangle in bounds. */
export function centeredViewportRect(
  targetX: number,
  targetY: number,
  width: number,
  height: number,
  floorWidth: number,
  floorHeight: number,
): FloorViewportRect {
  return viewportRect(
    clampViewportOrigin(targetX - width / 2, floorWidth - width),
    clampViewportOrigin(targetY - height / 2, floorHeight - height),
    width,
    height,
  );
}

/**
 * Render the composed floor through a scaled viewport.
 *
 * The translation deliberately rounds after scaling. PixelDollhouse has always
 * used this order, and changing it would make a moving camera shimmer between
 * physical pixels.
 */
export function renderFloorViewport(
  ctx: FloorViewportContext,
  rect: FloorViewportRect,
  scale: number,
  renderFloor: () => void,
): void {
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(scale, 0, 0, scale, -Math.round(rect.x * scale), -Math.round(rect.y * scale));
  renderFloor();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
