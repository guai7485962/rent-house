/** 房間噪音／隔音的共用判定：規則事件與 AI context 必須讀同一份結果。 */
import { roomAttributes } from "./placements";
import { roomOfTenant, type TenantRuntime } from "./gameState";
import { EVENT_SOUNDPROOFING_ID, grantRoomUpgrade, roomUpgradeIds } from "./upgrades";
import type { Tenant } from "../types";

export interface RoomAcoustics {
  roomId: string | null;
  noise: number;
  soundproof: number;
  /** 完整改建或噪音裁決的永久改善已完成；一般室內噪音抗議應被阻止。 */
  treated: boolean;
}

const NOISE_TAG_WEIGHT: Record<string, number> = {
  noisy: 8,
  night_owl: 6,
  gamer: 4,
  late_return: 3,
};

const NATURAL_CONFLICT_NOISY_TAGS = new Set(["noisy", "gamer"]);
const NATURAL_CONFLICT_QUIET_TAGS = new Set(["sound_sensitive", "perfectionist", "wfh"]);

const hasAnyTag = (tenant: Pick<Tenant, "coreTags">, ids: Set<string>) =>
  (tenant.coreTags ?? []).some((tag) => ids.has(tag.id));

export function roomAcousticsForTenant(tenantId: string): RoomAcoustics {
  const roomId = roomOfTenant(tenantId);
  if (!roomId) return { roomId: null, noise: 0, soundproof: 0, treated: false };
  const attrs = roomAttributes(roomId);
  const ids = roomUpgradeIds(roomId);
  return {
    roomId,
    noise: Math.max(0, attrs.noise ?? 0),
    soundproof: Math.max(0, attrs.soundproof ?? 0),
    treated: ids.includes("soundproof_reno") || ids.includes(EVENT_SOUNDPROOFING_ID),
  };
}

/**
 * 自然口角的噪音折抵比例。只看造成噪音的一方房間；局部工程 4 點折半，完整改建 8 點全抵。
 * 若兩人同時是噪音來源與安靜需求者，平均兩個來源房間，避免一間有隔音就掩蓋另一間。
 */
export function noiseConflictMitigation(
  a: Pick<Tenant, "id" | "coreTags">,
  b: Pick<Tenant, "id" | "coreTags">,
): number {
  const noisyA = hasAnyTag(a, NATURAL_CONFLICT_NOISY_TAGS);
  const noisyB = hasAnyTag(b, NATURAL_CONFLICT_NOISY_TAGS);
  const quietA = hasAnyTag(a, NATURAL_CONFLICT_QUIET_TAGS);
  const quietB = hasAnyTag(b, NATURAL_CONFLICT_QUIET_TAGS);
  const sourceIds: string[] = [];
  if (noisyA && quietB) sourceIds.push(a.id);
  if (noisyB && quietA) sourceIds.push(b.id);
  if (sourceIds.length === 0) return 0;
  const total = sourceIds.reduce((sum, tenantId) => {
    const room = roomAcousticsForTenant(tenantId);
    if (!room.roomId) return sum;
    return sum + Math.min(1, Math.max(0, room.soundproof / 8));
  }, 0);
  return total / sourceIds.length;
}

/**
 * 一般噪音公審資格：永久隔音工程直接阻止；家具隔音則抵銷住戶標籤與房內設備噪音。
 * 使用 max 而非疊加標籤，避免「夜貓+玩家」把同一種生活噪音重複計算。
 */
export function noiseComplaintEligible(rt: TenantRuntime): boolean {
  const traitNoise = Math.max(0, ...rt.tenant.coreTags.map((tag) => NOISE_TAG_WEIGHT[tag.id] ?? 0));
  if (traitNoise <= 0) return false;
  const room = roomAcousticsForTenant(rt.tenant.id);
  if (!room.roomId || room.treated) return false;
  return traitNoise + room.noise - room.soundproof > 0;
}

/** 噪音裁決的 $3,000 選項：在當事人房間留下永久、可存檔的局部隔音工程。 */
export function grantEventSoundproofing(tenantId: string): boolean {
  const roomId = roomOfTenant(tenantId);
  return !!roomId && grantRoomUpgrade(roomId, EVENT_SOUNDPROOFING_ID);
}
