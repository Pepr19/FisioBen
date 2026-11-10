// Soft-tissue binding for the kinematic rig.
// Every structure is attached to the bones it touches (and to those lying on the
// skeletal path between them); each vertex follows the nearby bones with weights
// derived from distance fields of the bone surfaces. Poses are blended with dual
// quaternions, which keeps the volume around joints better than linear blending.
// It is geometry, not physiology: no contraction, sliding or collisions.
import * as THREE from 'three';
import { matrixToDualQuat } from './kin-math.mjs';
import { principalAxis } from './rig.mjs';
import { installDualQuatSkinning, DualQuatSkeleton } from './gpu-skin.mjs';

const REACH = .25;           // bones farther than this from a structure are not considered
const CONTACT = .012;        // a structure closer than this to a bone is considered attached to it
const POWER = 4, SOFT = .004, FLOOR = .03, MAX_INFLUENCES = 4;

// Half of the 26-neighbourhood: offsets that precede a cell in scan order.
const NB = [1,0,0, -1,1,0, 0,1,0, 1,1,0, -1,-1,1, 0,-1,1, 1,-1,1, -1,0,1, 0,0,1, 1,0,1, -1,1,1, 0,1,1, 1,1,1];

/** Distance field of the bone surfaces of one segment, sampled on a regular grid. */
export class BoneField {
  constructor(meshes, margin = .1) {
    const pts = new Float32Array(sampleSurfaces(meshes, .006)), box = new THREE.Box3();
    for (let i = 0; i < pts.length; i += 3) box.expandByPoint(_v.set(pts[i], pts[i+1], pts[i+2]));
    this.surface = box.clone();
    box.expandByScalar(margin);
    const size = box.getSize(new THREE.Vector3());
    const h = Math.max(.007, Math.cbrt(size.x * size.y * size.z / 160000));
    const nx = Math.max(2, Math.ceil(size.x / h) + 1), ny = Math.max(2, Math.ceil(size.y / h) + 1), nz = Math.max(2, Math.ceil(size.z / h) + 1);
    this.min = box.min.clone(); this.h = h; this.nx = nx; this.ny = ny; this.nz = nz;
    this.max = new THREE.Vector3(box.min.x + (nx - 1) * h, box.min.y + (ny - 1) * h, box.min.z + (nz - 1) * h);
    // Work on a grid padded by one cell so that neighbour lookups never need bounds checks.
    const px = nx + 2, py = ny + 2, pxy = px * py, total = px * py * (nz + 2);
    const nearest = new Int32Array(total).fill(-1), d2 = new Float32Array(total).fill(1e9);
    const ox = box.min.x - h, oy = box.min.y - h, oz = box.min.z - h;
    for (let k = 0; k < pts.length; k += 3) {
      const gx = Math.floor((pts[k] - ox) / h), gy = Math.floor((pts[k+1] - oy) / h), gz = Math.floor((pts[k+2] - oz) / h);
      for (let c = 0; c < 8; c++) {
        const ix = gx + (c & 1), iy = gy + ((c >> 1) & 1), iz = gz + ((c >> 2) & 1);
        if (ix < 1 || iy < 1 || iz < 1 || ix > nx || iy > ny || iz > nz) continue;
        const cell = ix + iy * px + iz * pxy, dx = pts[k] - (ox + ix * h), dy = pts[k+1] - (oy + iy * h), dz = pts[k+2] - (oz + iz * h), d = dx*dx + dy*dy + dz*dz;
        if (d < d2[cell]) { d2[cell] = d; nearest[cell] = k; }
      }
    }
    // Sequential Euclidean propagation of the nearest surface sample: each sweep looks at the
    // 13 neighbours already visited in that direction.
    const offsets = new Int32Array(13);
    for (let n = 0; n < 13; n++) offsets[n] = NB[n*3] + NB[n*3+1] * px + NB[n*3+2] * pxy;
    for (let pass = 0; pass < 2; pass++) {
      const dir = pass ? -1 : 1;
      for (let a = 0; a < nz; a++) { const iz = dir > 0 ? a + 1 : nz - a, cz = oz + iz * h;
        for (let b = 0; b < ny; b++) { const iy = dir > 0 ? b + 1 : ny - b, cy = oy + iy * h;
          for (let c = 0; c < nx; c++) { const ix = dir > 0 ? c + 1 : nx - c, cell = ix + iy * px + iz * pxy, cx = ox + ix * h;
            let best = d2[cell], bk = nearest[cell];
            for (let n = 0; n < 13; n++) {
              const k = nearest[cell - dir * offsets[n]];
              if (k < 0 || k === bk) continue;
              const dx = pts[k] - cx, dy = pts[k+1] - cy, dz = pts[k+2] - cz, d = dx*dx + dy*dy + dz*dz;
              if (d < best) { best = d; bk = k; }
            }
            d2[cell] = best; nearest[cell] = bk;
          } } }
    }
    const dist = this.dist = new Float32Array(nx * ny * nz);
    for (let iz = 0; iz < nz; iz++) for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) dist[ix + iy * nx + iz * nx * ny] = Math.sqrt(d2[ix + 1 + (iy + 1) * px + (iz + 1) * pxy]);
  }
  /** Distance from a world point to the bone surface (trilinear; conservative outside the grid). */
  sample(x, y, z) {
    const { min, max, h, nx, ny, dist } = this;
    let outside = 0, t;
    if (x < min.x) { t = min.x - x; outside += t * t; x = min.x; } else if (x > max.x) { t = x - max.x; outside += t * t; x = max.x; }
    if (y < min.y) { t = min.y - y; outside += t * t; y = min.y; } else if (y > max.y) { t = y - max.y; outside += t * t; y = max.y; }
    if (z < min.z) { t = min.z - z; outside += t * t; z = min.z; } else if (z > max.z) { t = z - max.z; outside += t * t; z = max.z; }
    let fx = (x - min.x) / h, fy = (y - min.y) / h, fz = (z - min.z) / h;
    let ix = Math.min(nx - 2, fx | 0), iy = Math.min(ny - 2, fy | 0), iz = Math.min(this.nz - 2, fz | 0);
    fx -= ix; fy -= iy; fz -= iz;
    const sxy = nx * ny, a = ix + iy * nx + iz * sxy, b = a + sxy;
    const c00 = dist[a] + (dist[a + 1] - dist[a]) * fx, c10 = dist[a + nx] + (dist[a + nx + 1] - dist[a + nx]) * fx;
    const c01 = dist[b] + (dist[b + 1] - dist[b]) * fx, c11 = dist[b + nx] + (dist[b + nx + 1] - dist[b + nx]) * fx;
    const c0 = c00 + (c10 - c00) * fy, c1 = c01 + (c11 - c01) * fy, d = c0 + (c1 - c0) * fz;
    return outside ? d + Math.sqrt(outside) : d;
  }
}

const _quat = [0, 0, 0, 1];
const _box = new THREE.Box3(), _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
/** World-space samples of mesh surfaces: vertices plus points inside large triangles. */
function sampleSurfaces(meshes, spacing) {
  const out = [];
  for (const mesh of meshes) {
    const g = mesh.geometry, p = g.attributes.position, m = mesh.matrixWorld, world = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) { _v.fromBufferAttribute(p, i).applyMatrix4(m); world[i*3] = _v.x; world[i*3+1] = _v.y; world[i*3+2] = _v.z; out.push(_v.x, _v.y, _v.z); }
    const index = g.index?.array, count = index ? index.length : p.count;
    for (let t = 0; t < count; t += 3) {
      const ia = (index ? index[t] : t) * 3, ib = (index ? index[t+1] : t + 1) * 3, ic = (index ? index[t+2] : t + 2) * 3;
      _a.set(world[ia], world[ia+1], world[ia+2]); _b.set(world[ib], world[ib+1], world[ib+2]); _c.set(world[ic], world[ic+1], world[ic+2]);
      const longest = Math.max(_a.distanceTo(_b), _b.distanceTo(_c), _c.distanceTo(_a)), n = Math.min(12, Math.ceil(longest / spacing));
      if (n < 2) continue;
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
        if ((i === 0 && j === 0) || (i === n && j === 0) || (i === 0 && j === n)) continue;
        const u = i / n, w = j / n, r = 1 - u - w;
        out.push(_a.x * r + _b.x * u + _c.x * w, _a.y * r + _b.y * u + _c.y * w, _a.z * r + _b.z * u + _c.z * w);
      }
    }
  }
  return out;
}

const sideOf = name => /\.[lr]$/.test(name) ? name.slice(-1) : '';
const RIGID_NAME = [
  // Menisci and their tibial attachments move with the tibial plateau.
  [/^(Lateral|Medial) meniscus|meniscotibial ligament|^Transverse ligament of knee/, 'tibia'],
  [/^Acetabular labrum|^Transverse acetabular ligament|^Triradiate cartilage/, 'pelvis'],
  [/^Glenoid labrum/, 'scapula'],
  [/^Annular ligament of radius/, 'ulna']
];

// Attachments (origin and insertion) of the muscles that cross the shoulder girdle and the hip.
// There several bones lie close together, and proximity alone would tie, for instance, the
// subscapularis to the ribs it glides on. Limb segments take the side of the structure.
const SPINE_L = ['L5', 'L4', 'L3', 'L2', 'L1'], SPINE_C = ['C7', 'C6', 'C5', 'C4', 'C3', 'C2', 'C1'];
// Broad muscles running from the trunk to the humerus: when the arm is raised they stay taut between
// their attachments instead of rotating with the joint, so their vertices are blended linearly.
const STRETCH = /^Latissimus dorsi|pectoralis major/, STRETCH_FLAG = 128;
const ATTACH = [
  [/^Latissimus dorsi/, ['pelvis', ...SPINE_L, 'thorax', 'humerus']],
  [/^Clavicular head of pectoralis major/, ['clavicle', 'humerus']],
  [/pectoralis major/, ['thorax', 'humerus']],
  [/^Pectoralis minor|^Serratus anterior|^Rhomboid major|^(Ascending|Transverse) part of trapezius/, ['thorax', 'scapula']],
  [/^Rhomboid minor/, ['C7', 'thorax', 'scapula']],
  [/^Subclavius/, ['thorax', 'clavicle']],
  [/^Descending part of trapezius/, ['skull', ...SPINE_C, 'thorax', 'clavicle', 'scapula']],
  [/^Levator scapulae/, ['C1', 'C2', 'C3', 'C4', 'scapula']],
  [/^Clavicular part of deltoid/, ['clavicle', 'humerus']],
  [/^(Acromial|Scapular spinal) part of deltoid|^(Supraspinatus|Infraspinatus|Subscapularis|Teres minor|Teres major|Coracobrachialis) muscle/, ['scapula', 'humerus']],
  [/^Psoas major/, ['thorax', ...SPINE_L, 'pelvis', 'femur']],
  [/^(Iliacus|Gluteus (maximus|medius|minimus)|Piriformis|(Superior|Inferior) gemellus|Quadratus femoris|Pectineus) muscle|^Obturator (internus|externus)|^Adductor (brevis|longus|magnus)|^\(Adductor minimus\)|^Tensor fasciae latae/, ['pelvis', 'femur']],
  [/^(Sartorius|Gracilis|Semitendinosus|Semimembranosus) muscle|^Long head of biceps femoris|^Iliotibial tract/, ['pelvis', 'femur', 'tibia']]
];

export class SkinBinder {
  /**
   * gpu: deform the skinned meshes in the vertex shader (the meshes are flagged as skinned and read
   * the pose from a small texture). Without it the vertices are recomputed on the CPU, which keeps
   * the binder usable without WebGL (tests) and as a fallback.
   */
  constructor(rig, entries, { gpu = false } = {}) {
    this.rig = rig; this.entries = entries; this.gpu = gpu; this.skeleton = null;
    if (gpu) { installDualQuatSkinning(); this.skeleton = new DualQuatSkeleton(rig.order.length); }
    this.fields = new Map(); this.bindings = new Map(); this.records = new Map();
    this.dq = new Float64Array(rig.order.length * 8);
    this.segBox = new Map();
    for (const seg of rig.order) {
      const box = new THREE.Box3();
      for (const id of seg.bones) entries.get(id).meshes.forEach(m => box.expandByObject(m));
      this.segBox.set(seg.id, box);
    }
    this.fieldMs = 0; this.weightMs = 0;
  }
  field(segId) {
    let f = this.fields.get(segId);
    if (!f) {
      const t = performance.now(), seg = this.rig.segments.get(segId), meshes = seg.bones.flatMap(id => this.entries.get(id).meshes);
      f = new BoneField(meshes, /\./.test(segId) ? .1 : .15); this.fields.set(segId, f); this.fieldMs += performance.now() - t;
    }
    return f;
  }

  /** Which segments a structure follows. Returns { rigid: segId } or { segments: [segId...] }. */
  binding(entry) {
    let b = this.bindings.get(entry.id); if (b) return b;
    const rig = this.rig, side = sideOf(entry.name), bone = rig.boneSegment.get(entry.id);
    if (bone) b = { rigid: bone };
    else {
      const base = side ? entry.name.slice(0, -2) : entry.name;
      const forced = RIGID_NAME.find(([re]) => re.test(base));
      if (forced && side) b = { rigid: forced[1] + '.' + side }; else if (forced && !/\./.test(forced[1]) && rig.segments.has(forced[1])) b = { rigid: forced[1] };
      const known = !b && side && entry.sys === 'muscular' && ATTACH.find(([re]) => re.test(base));
      if (known) {
        const segments = known[1].map(id => rig.segments.has(id) ? id : id + '.' + side).filter(id => rig.segments.get(id)?.bones.length);
        if (segments.length > 1) b = { segments, stretch: STRETCH.test(base) };
      }
    }
    if (!b) b = this.#classify(entry, side);
    this.bindings.set(entry.id, b); return b;
  }

  #classify(entry, side) {
    const rig = this.rig, box = new THREE.Box3(); entry.meshes.forEach(m => box.expandByObject(m));
    const samples = [], total = entry.meshes.reduce((s, m) => s + m.geometry.attributes.position.count, 0), stride = Math.max(1, Math.floor(total / 500));
    for (const m of entry.meshes) { const p = m.geometry.attributes.position; for (let i = 0; i < p.count; i += stride) { _v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld); samples.push(_v.x, _v.y, _v.z); } }
    const n = samples.length / 3;
    if (!n) return { rigid: 'pelvis' };
    const candidates = rig.order.filter(seg => seg.bones.length && (!side || !/\.[lr]$/.test(seg.id) || seg.id.endsWith('.' + side)));
    const reach = box.clone().expandByScalar(REACH), near = candidates.filter(seg => this.segBox.get(seg.id).intersectsBox(reach));
    const pool = near.length ? near : candidates;
    // Ends of the structure along its main direction: origin and insertion usually sit there.
    const { axis, center } = principalAxis(samples), proj = new Float32Array(n);
    for (let i = 0; i < n; i++) proj[i] = (samples[i*3] - center.x) * axis.x + (samples[i*3+1] - center.y) * axis.y + (samples[i*3+2] - center.z) * axis.z;
    const sorted = Array.from(proj).sort((p, q) => p - q), lo = sorted[Math.floor(n * .08)], hi = sorted[Math.floor(n * .92)];
    const contact = new Set(); let bestAll = null, bestAllD = Infinity; const ends = [[null, Infinity], [null, Infinity]];
    for (const seg of pool) {
      const f = this.field(seg.id); let min = Infinity, sumLo = 0, nLo = 0, sumHi = 0, nHi = 0;
      for (let i = 0; i < n; i++) {
        const d = f.sample(samples[i*3], samples[i*3+1], samples[i*3+2]);
        if (d < min) min = d;
        if (proj[i] <= lo) { sumLo += d; nLo++; } else if (proj[i] >= hi) { sumHi += d; nHi++; }
      }
      if (min < CONTACT) contact.add(seg.id);
      if (min < bestAllD) { bestAllD = min; bestAll = seg.id; }
      if (nLo && sumLo / nLo < ends[0][1]) ends[0] = [seg.id, sumLo / nLo];
      if (nHi && sumHi / nHi < ends[1][1]) ends[1] = [seg.id, sumHi / nHi];
    }
    contact.add(bestAll); for (const [id] of ends) if (id) contact.add(id);
    const ids = [...contact], all = new Set(ids);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) for (const id of rig.path(ids[i], ids[j])) all.add(id);
    // Bones without geometry on the path (none today) would have no field: keep only usable segments.
    const segments = [...all].filter(id => rig.segments.get(id).bones.length);
    return segments.length === 1 ? { rigid: segments[0] } : { segments };
  }

  /** Per-mesh deformation record (created on first use). */
  record(mesh, entry) {
    let rec = this.records.get(mesh); if (rec) return rec;
    const b = this.binding(entry), rig = this.rig;
    mesh.updateWorldMatrix(true, false);
    rec = { mesh, entry, stamp: '', restWorld: mesh.matrixWorld.clone(), restLocal: mesh.matrix.clone(), auto: mesh.matrixAutoUpdate, culled: mesh.frustumCulled };
    rec.parentInverse = mesh.parent ? mesh.parent.matrixWorld.clone().invert() : new THREE.Matrix4();
    if (b.rigid) { rec.rigid = rig.segments.get(b.rigid); rec.segs = [rec.rigid]; }
    else this.#weights(rec, b.segments.map(id => rig.segments.get(id)), !!b.stretch);
    this.records.set(mesh, rec); return rec;
  }

  #weights(rec, segs, stretch = false) {
    const t0 = performance.now(), mesh = rec.mesh, original = mesh.geometry, pos = original.attributes.position, norm = original.attributes.normal, count = pos.count;
    const gpu = this.gpu, world = gpu ? null : new Float32Array(count * 3), normals = !gpu && norm ? new Float32Array(count * 3) : null;
    const index = new Uint8Array(count * MAX_INFLUENCES), weight = new Float32Array(count * MAX_INFLUENCES);
    const fields = segs.map(s => this.field(s.id)), ns = segs.length, d = new Float64Array(ns), w = new Float64Array(ns);
    const normalWorld = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld), used = new Uint8Array(ns);
    let single = -1, mixed = false;
    for (let i = 0; i < count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld); const x = _v.x, y = _v.y, z = _v.z;
      if (world) { world[i*3] = x; world[i*3+1] = y; world[i*3+2] = z; }
      if (normals) { _v.fromBufferAttribute(norm, i).applyMatrix3(normalWorld).normalize(); normals[i*3] = _v.x; normals[i*3+1] = _v.y; normals[i*3+2] = _v.z; }
      let dmin = Infinity;
      for (let s = 0; s < ns; s++) { d[s] = fields[s].sample(x, y, z); if (d[s] < dmin) dmin = d[s]; }
      let sum = 0;
      for (let s = 0; s < ns; s++) { const r = (SOFT + dmin) / (SOFT + d[s]), r2 = r * r; w[s] = Math.max(0, (POWER === 4 ? r2 * r2 : Math.pow(r, POWER)) - FLOOR); sum += w[s]; }
      // Keep the strongest influences.
      let kept = 0, keptSum = 0;
      for (let k = 0; k < MAX_INFLUENCES; k++) {
        let best = -1, bw = 0; for (let s = 0; s < ns; s++) if (w[s] > bw) { bw = w[s]; best = s; }
        if (best < 0) break;
        index[i*MAX_INFLUENCES + k] = best; weight[i*MAX_INFLUENCES + k] = bw; keptSum += bw; w[best] = 0; kept++; used[best] = 1;
      }
      for (let k = 0; k < kept; k++) weight[i*MAX_INFLUENCES + k] /= keptSum;
      const first = index[i*MAX_INFLUENCES];
      if (kept > 1 && weight[i*MAX_INFLUENCES + 1] > .002) mixed = true;
      if (single === -1) single = first; else if (single !== first) mixed = true;
    }
    this.weightMs += performance.now() - t0;
    if (!mixed) { rec.rigid = segs[single]; rec.segs = [rec.rigid]; return; }
    // Store rig-wide segment indices; keep the list of segments actually used for change tracking.
    const map = new Uint8Array(ns); rec.segs = [];
    for (let s = 0; s < ns; s++) if (used[s]) { map[s] = segs[s].index; rec.segs.push(segs[s]); }
    for (let i = 0; i < index.length; i++) index[i] = weight[i] > 0 ? map[index[i]] : map[index[i - i % MAX_INFLUENCES]];
    if (stretch) { rec.stretch = true; for (let i = 0; i < index.length; i += MAX_INFLUENCES) index[i] |= STRETCH_FLAG; }
    // The deformed mesh uses its own geometry object. On the GPU it shares every buffer with the
    // original and only adds the skin attributes; on the CPU positions and normals are copies.
    const geometry = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(original.attributes)) geometry.setAttribute(name, !gpu && (name === 'position' || name === 'normal') ? attr.clone() : attr);
    if (original.index) geometry.setIndex(original.index);
    original.groups.forEach(g => geometry.addGroup(g.start, g.count, g.materialIndex));
    if (gpu) {
      geometry.setAttribute('skinIndex', new THREE.BufferAttribute(index, MAX_INFLUENCES));
      geometry.setAttribute('skinWeight', new THREE.BufferAttribute(weight, MAX_INFLUENCES));
      geometry.boundingBox = original.boundingBox; geometry.boundingSphere = original.boundingSphere;
    } else { geometry.attributes.position.setUsage(THREE.DynamicDrawUsage); geometry.attributes.normal?.setUsage(THREE.DynamicDrawUsage); }
    Object.assign(rec, { original, geometry, world, normals, index, weight, inverse: mesh.matrixWorld.clone().invert(), toLocalNormal: new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld.clone().invert()) });
    this.#sampleBounds(rec, pos);
  }

  /** Cheap test: can this structure be attached to any of the wanted segments at all? */
  #near(entry, wanted) {
    if (this.bindings.has(entry.id)) return true;
    const bone = this.rig.boneSegment.get(entry.id); if (bone) return wanted.has(bone);
    const side = sideOf(entry.name);
    if (!entry.box) { entry.box = new THREE.Box3(); entry.meshes.forEach(m => entry.box.expandByObject(m)); }
    const reach = _box.copy(entry.box).expandByScalar(REACH);
    for (const id of wanted) { if (side && /\.[lr]$/.test(id) && !id.endsWith('.' + side)) continue; if (this.segBox.get(id).intersectsBox(reach)) return true; }
    return false;
  }
  #follows(entry, wanted) {
    if (!this.#near(entry, wanted)) return false;
    const b = this.binding(entry);
    return b.rigid ? wanted.has(b.rigid) : b.segments.some(id => wanted.has(id));
  }

  /** Bind every loaded structure that follows one of the given segments (all segments when omitted). */
  prepare(segmentIds = null, filter = null) {
    const wanted = new Set(segmentIds || this.rig.order.map(s => s.id)), out = [];
    for (const entry of this.entries.values()) {
      if (!entry.meshes.length || (filter && !filter(entry)) || !this.#follows(entry, wanted)) continue;
      for (const mesh of entry.meshes) out.push(this.record(mesh, entry));
    }
    return out;
  }

  /** Structure ids that follow at least one of the segments. */
  structuresOf(segmentIds) {
    const wanted = new Set(segmentIds), out = new Set();
    for (const entry of this.entries.values()) if (entry.meshes.length && this.#follows(entry, wanted)) out.add(entry.id);
    return out;
  }

  #updateDualQuats() {
    const order = this.rig.order;
    for (let i = 0; i < order.length; i++) matrixToDualQuat(order[i].delta.elements, this.dq, i * 8);
    this.dqRevision = this.rig.revision;
  }
  /** Dual quaternions must describe the pose the rig was last solved for, also before the first apply(). */
  #syncPose() { if (this.dqRevision !== this.rig.revision) this.#updateDualQuats(); }

  /** Apply the current rig pose to the bound meshes. shouldUpdate(mesh) lets the caller skip hidden ones. */
  apply(shouldUpdate = null) {
    this.#updateDualQuats();
    if (this.skeleton) this.skeleton.set(this.dq);
    let moved = 0;
    for (const rec of this.records.values()) {
      if (rec.onGpu) continue;                       // follows the pose texture, nothing to recompute
      let stamp = ''; for (const s of rec.segs) stamp += s.version + ',';
      if (stamp === rec.stamp) continue;
      if (!rec.rigid && this.gpu) { this.#attachGpu(rec); moved++; continue; }
      if (shouldUpdate && !shouldUpdate(rec.mesh)) continue;
      rec.stamp = stamp; moved++;
      if (rec.rigid) this.#applyRigid(rec); else this.#applySkin(rec);
    }
    return moved;
  }

  /** Flag a mesh as skinned: from now on the vertex shader places it according to the pose texture. */
  #attachGpu(rec) {
    const mesh = rec.mesh;
    mesh.geometry = rec.geometry; mesh.frustumCulled = false;
    mesh.isSkinnedMesh = true; mesh.skeleton = this.skeleton; mesh.bindMode = 'attached';
    mesh.bindMatrix = rec.restWorld; mesh.bindMatrixInverse = rec.inverse;
    rec.onGpu = true;
  }

  /** A few rest-pose vertices per skinned mesh, enough to bound it in any pose. */
  #sampleBounds(rec, pos) {
    const n = Math.min(pos.count, 96), stride = Math.max(1, Math.floor(pos.count / n)), pts = [], ids = [];
    for (let i = 0; i < pos.count; i += stride) { _v.fromBufferAttribute(pos, i).applyMatrix4(rec.restWorld); pts.push(_v.x, _v.y, _v.z); ids.push(i); }
    rec.boundPts = new Float32Array(pts); rec.boundIds = new Uint32Array(ids);
  }
  /** Expand `box` by the current (posed) extent of a mesh. */
  expandBox(mesh, box) {
    const rec = this.records.get(mesh);
    if (!rec || rec.rigid) return box.expandByObject(mesh);
    this.#syncPose();
    const p = rec.boundPts;
    for (let k = 0; k < rec.boundIds.length; k++) box.expandByPoint(this.posedPoint(rec, p[k*3], p[k*3+1], p[k*3+2], rec.boundIds[k], _v));
    return box;
  }

  #applyRigid(rec) {
    const mesh = rec.mesh;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.multiplyMatrices(rec.parentInverse, rec.rigid.delta).multiply(rec.restWorld);
    mesh.matrixWorld.multiplyMatrices(rec.rigid.delta, rec.restWorld);
    mesh.matrixWorldNeedsUpdate = false;
  }

  #applySkin(rec) {
    const { mesh, geometry, world, normals } = rec;
    if (mesh.geometry !== geometry) { mesh.geometry = geometry; mesh.frustumCulled = false; }
    const p = geometry.attributes.position.array, n = normals ? geometry.attributes.normal.array : null, count = world.length / 3;
    const inv = rec.inverse.elements, nl = rec.toLocalNormal.elements, q = _quat;
    for (let i = 0; i < count; i++) {
      const j = i * 3; this.posedPoint(rec, world[j], world[j+1], world[j+2], i, _v, q);
      const X = _v.x, Y = _v.y, Z = _v.z;
      p[j] = inv[0] * X + inv[4] * Y + inv[8] * Z + inv[12]; p[j+1] = inv[1] * X + inv[5] * Y + inv[9] * Z + inv[13]; p[j+2] = inv[2] * X + inv[6] * Y + inv[10] * Z + inv[14];
      if (n) {
        // Normals turn with the blended rotation.
        const rx = q[0], ry = q[1], rz = q[2], rw = q[3], x = normals[j], y = normals[j+1], z = normals[j+2];
        const cx = ry * z - rz * y, cy = rz * x - rx * z, cz = rx * y - ry * x;
        const NX = x + 2 * (rw * cx + ry * cz - rz * cy), NY = y + 2 * (rw * cy + rz * cx - rx * cz), NZ = z + 2 * (rw * cz + rx * cy - ry * cx);
        const lx = nl[0] * NX + nl[3] * NY + nl[6] * NZ, ly = nl[1] * NX + nl[4] * NY + nl[7] * NZ, lz = nl[2] * NX + nl[5] * NY + nl[8] * NZ, l = 1 / (Math.sqrt(lx*lx + ly*ly + lz*lz) || 1);
        n[j] = lx * l; n[j+1] = ly * l; n[j+2] = lz * l;
      }
    }
    geometry.attributes.position.needsUpdate = true; if (n) geometry.attributes.normal.needsUpdate = true;
    geometry.boundingBox = null; geometry.boundingSphere = null;
  }

  /**
   * Posed world position of vertex i of a record (the same blend the vertex shader computes).
   * rot, when given, receives the blended unit rotation quaternion [x, y, z, w].
   */
  posedPoint(rec, restX, restY, restZ, i, out, rot = null) {
    if (rec.rigid) return out.set(restX, restY, restZ).applyMatrix4(rec.rigid.delta);
    const { index, weight } = rec, dq = this.dq, M = MAX_INFLUENCES, b = i * M;
    let o = (index[b] & 127) * 8, w = weight[b];
    const r0x = dq[o], r0y = dq[o+1], r0z = dq[o+2], r0w = dq[o+3];
    let rx = r0x * w, ry = r0y * w, rz = r0z * w, rw = r0w * w, dx = dq[o+4] * w, dy = dq[o+5] * w, dz = dq[o+6] * w, dw = dq[o+7] * w;
    for (let k = 1; k < M; k++) {
      w = weight[b + k]; if (w === 0) break; o = (index[b + k] & 127) * 8;
      if (r0x * dq[o] + r0y * dq[o+1] + r0z * dq[o+2] + r0w * dq[o+3] < 0) w = -w;
      rx += dq[o] * w; ry += dq[o+1] * w; rz += dq[o+2] * w; rw += dq[o+3] * w; dx += dq[o+4] * w; dy += dq[o+5] * w; dz += dq[o+6] * w; dw += dq[o+7] * w;
    }
    const len = 1 / Math.sqrt(rx*rx + ry*ry + rz*rz + rw*rw);
    rx *= len; ry *= len; rz *= len; rw *= len; dx *= len; dy *= len; dz *= len; dw *= len;
    if (rot) { rot[0] = rx; rot[1] = ry; rot[2] = rz; rot[3] = rw; }
    if (rec.stretch) {
      // Linear blend of the positions given by each bone.
      let X = 0, Y = 0, Z = 0;
      for (let k = 0; k < M; k++) {
        w = weight[b + k]; if (w === 0) break; o = (index[b + k] & 127) * 8;
        const qx = dq[o], qy = dq[o+1], qz = dq[o+2], qw = dq[o+3], ex = dq[o+4], ey = dq[o+5], ez = dq[o+6], ew = dq[o+7];
        const cx = qy * restZ - qz * restY, cy = qz * restX - qx * restZ, cz = qx * restY - qy * restX;
        X += w * (restX + 2 * (qw * cx + qy * cz - qz * cy) + 2 * (-ew * qx + ex * qw - ey * qz + ez * qy));
        Y += w * (restY + 2 * (qw * cy + qz * cx - qx * cz) + 2 * (-ew * qy + ex * qz + ey * qw - ez * qx));
        Z += w * (restZ + 2 * (qw * cz + qx * cy - qy * cx) + 2 * (-ew * qz - ex * qy + ey * qx + ez * qw));
      }
      return out.set(X, Y, Z);
    }
    const tx = 2 * (-dw * rx + dx * rw - dy * rz + dz * ry), ty = 2 * (-dw * ry + dx * rz + dy * rw - dz * rx), tz = 2 * (-dw * rz - dx * ry + dy * rx + dz * rw);
    const cx = ry * restZ - rz * restY, cy = rz * restX - rx * restZ, cz = rx * restY - ry * restX;
    return out.set(restX + 2 * (rw * cx + ry * cz - rz * cy) + tx, restY + 2 * (rw * cy + rz * cx - rx * cz) + ty, restZ + 2 * (rw * cz + rx * cy - ry * cx) + tz);
  }

  /**
   * Length probe of a structure: centroids of slices along its main direction form a polyline
   * whose length is followed through the movement. A geometric estimate of the path length.
   */
  probe(entry, slices = 9) {
    if (entry.probe !== undefined) return entry.probe;
    const recs = entry.meshes.map(m => this.record(m, entry)), pts = [], refs = [];
    const total = entry.meshes.reduce((s, m) => s + m.geometry.attributes.position.count, 0), stride = Math.max(1, Math.floor(total / 360));
    for (const rec of recs) {
      const g = rec.original || rec.mesh.geometry, p = g.attributes.position;
      for (let i = 0; i < p.count; i += stride) {
        if (rec.world) pts.push(rec.world[i*3], rec.world[i*3+1], rec.world[i*3+2]);
        else { _v.fromBufferAttribute(p, i).applyMatrix4(rec.restWorld); pts.push(_v.x, _v.y, _v.z); }
        refs.push(rec, i);
      }
    }
    const n = pts.length / 3; if (n < slices * 3) return (entry.probe = null);
    const { axis, center } = principalAxis(pts), proj = new Float32Array(n); let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { proj[i] = (pts[i*3] - center.x) * axis.x + (pts[i*3+1] - center.y) * axis.y + (pts[i*3+2] - center.z) * axis.z; lo = Math.min(lo, proj[i]); hi = Math.max(hi, proj[i]); }
    const bin = new Uint8Array(n); for (let i = 0; i < n; i++) bin[i] = Math.min(slices - 1, Math.floor((proj[i] - lo) / (hi - lo || 1) * slices));
    const probe = { pts: new Float32Array(pts), refs, bin, slices, sums: new Float64Array(slices * 4) };
    probe.rest = this.#polyline(probe, false);
    return (entry.probe = probe.rest > .01 ? probe : null);
  }
  #polyline(probe, posed) {
    const { pts, refs, bin, slices, sums } = probe; sums.fill(0);
    for (let i = 0; i < bin.length; i++) {
      let x = pts[i*3], y = pts[i*3+1], z = pts[i*3+2];
      if (posed) { this.posedPoint(refs[i*2], x, y, z, refs[i*2+1], _v); x = _v.x; y = _v.y; z = _v.z; }
      const b = bin[i] * 4; sums[b] += x; sums[b+1] += y; sums[b+2] += z; sums[b+3]++;
    }
    let length = 0, px = 0, py = 0, pz = 0, have = false;
    for (let s = 0; s < slices; s++) {
      const c = sums[s*4+3]; if (!c) continue;
      const x = sums[s*4] / c, y = sums[s*4+1] / c, z = sums[s*4+2] / c;
      if (have) length += Math.hypot(x - px, y - py, z - pz);
      px = x; py = y; pz = z; have = true;
    }
    return length;
  }
  /** Current length / rest length of a structure (1 = unchanged), or null when it cannot be measured. */
  lengthRatio(entry) {
    const probe = this.probe(entry); if (!probe) return null;
    this.#syncPose();
    return this.#polyline(probe, true) / probe.rest;
  }

  /** Restore the original geometry and transforms of every mesh. */
  dispose() {
    for (const rec of this.records.values()) {
      const mesh = rec.mesh;
      if (rec.geometry) {
        if (mesh.geometry === rec.geometry) mesh.geometry = rec.original;
        // A GPU geometry shares its buffers with the original: only its own skin attributes may be released.
        if (!this.gpu) rec.geometry.dispose();
        if (rec.onGpu) { mesh.isSkinnedMesh = false; delete mesh.skeleton; delete mesh.bindMatrix; delete mesh.bindMatrixInverse; delete mesh.bindMode; }
        mesh.frustumCulled = rec.culled;
      }
      mesh.matrix.copy(rec.restLocal); mesh.matrixAutoUpdate = rec.auto; mesh.matrixWorld.copy(rec.restWorld);
    }
    for (const e of this.entries.values()) delete e.probe;
    this.records.clear(); this.skeleton?.dispose();
  }
}
