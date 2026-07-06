import { buildBlocked, findPath } from "../src/floor/pathfind";
import { TENANT_SPOTS } from "../src/floor/map";
import { getPlacements } from "../src/sim/placements";
import { getDef } from "../src/furniture/catalog";

const PLACEMENTS = getPlacements();

const blocked = buildBlocked();
const chen = TENANT_SPOTS[0];

function toInteract(defId: string) {
  const p = PLACEMENTS.find((x) => x.defId === defId)!;
  const d = getDef(defId);
  return { c: p.c + d.interact.dc, r: p.r + d.interact.dr };
}

for (const id of ["stove", "toilet", "shower", "lounge_tv", "laundry_washer"]) {
  const path = findPath({ c: chen.c, r: chen.r }, toInteract(id), blocked);
  console.log(`陳家豪 → ${id}:`, path ? `路徑 ${path.length} 格` : "走不到");
}

let reach = 0,
  total = 0;
for (const p of PLACEMENTS) {
  const d = getDef(p.defId);
  const t = { c: p.c + d.interact.dc, r: p.r + d.interact.dr };
  total++;
  if (blocked[t.r]?.[t.c]) continue;
  if (findPath({ c: chen.c, r: chen.r }, t, blocked)) reach++;
}
console.log(`可抵達的家具互動點:${reach}/${total}`);
