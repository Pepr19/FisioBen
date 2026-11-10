// Anatomical zones for isolation. A zone starts from the muscles whose card names that region
// and adds the bones, ligaments, nerves and other tissues lying in the same volume.
// Boxes are duck-typed ({min:{x,y,z},max:{x,y,z}}) so the logic can be tested without WebGL.
const sided = name => /\.[lr]$/.test(name) ? name.slice(-2) : '';
const volume = b => Math.max(0, b.max.x - b.min.x) * Math.max(0, b.max.y - b.min.y) * Math.max(0, b.max.z - b.min.z);
const union = (a, b) => a ? { min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y), z: Math.min(a.min.z, b.min.z) }, max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y), z: Math.max(a.max.z, b.max.z) } } : { min: { ...b.min }, max: { ...b.max } };
/** Fraction of box `a` that lies inside box `b` (thin boxes are padded so flat structures still count). */
export function overlapFraction(a, b, pad = .004) {
  const lo = k => Math.max(a.min[k] - pad, b.min[k] - pad), hi = k => Math.min(a.max[k] + pad, b.max[k] + pad);
  let inside = 1, whole = 1;
  for (const k of ['x', 'y', 'z']) { inside *= Math.max(0, hi(k) - lo(k)); whole *= a.max[k] - a.min[k] + 2 * pad; }
  return whole > 0 ? inside / whole : 0;
}
const usable = e => e.box && e.meshes?.length;

/** Boxes of the card muscles of a region, kept separate per side so a paired region does not span the midline. */
export function regionBoxes(entries, getCard, region, suffix = null) {
  const boxes = { '.r': null, '.l': null, '': null }, members = [];
  for (const e of entries) {
    if (!usable(e) || getCard(e)?.region !== region) continue;
    const s = sided(e.name); if (suffix && s && s !== suffix) continue;
    boxes[s] = union(boxes[s], e.box); members.push(e);
  }
  return { boxes: Object.entries(boxes).filter(([, b]) => b).map(([s, box]) => ({ side: s, box })), members };
}

/** Ids of every loaded structure belonging to the zone, or null when the region has no geometry. */
export function regionMembers(entries, getCard, region, suffix = null) {
  const list = [...entries], { boxes, members } = regionBoxes(list, getCard, region, suffix);
  if (!members.length) return null;
  const out = new Set(members.map(e => e.id));
  for (const e of list) {
    if (out.has(e.id) || !usable(e) || getCard(e)) continue;   // a muscle with a card belongs to its own region
    const s = sided(e.name); if (suffix && s && s !== suffix) continue;
    if (boxes.some(({ side, box }) => (!s || !side || s === side) && overlapFraction(e.box, box) >= .5)) out.add(e.id);
  }
  return out;
}

/** Region of a structure: its card, otherwise the region whose muscles surround it best. */
export function regionOf(entry, entries, getCard, suffix = null) {
  const card = getCard(entry); if (card) return card.region;
  if (!usable(entry)) return null;
  const list = [...entries], regions = new Set(); for (const e of list) { const c = getCard(e); if (c) regions.add(c.region); }
  let best = null, bestScore = 0, bestVolume = Infinity;
  for (const region of regions) for (const { side, box } of regionBoxes(list, getCard, region, suffix).boxes) {
    const s = sided(entry.name); if (s && side && s !== side) continue;
    const score = overlapFraction(entry.box, box), v = volume(box);
    if (score >= .5 && (score > bestScore + .05 || (Math.abs(score - bestScore) <= .05 && v < bestVolume))) { best = region; bestScore = score; bestVolume = v; }
  }
  return best;
}
