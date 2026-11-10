// Articulated skeleton built from the bone geometry of the atlas.
// Joint centres and axes are estimated from anatomical landmarks of each bone
// (sphere fits of the femoral/humeral heads, condyles, malleoli, styloids...).
// It is a didactic kinematic model: rigid segments, ideal joints, no forces.
import * as THREE from 'three';
import { sphereFit, filterPts, extremePt, centroid, rangeOf, median, smoothstep, clamp, DEG } from './kin-math.mjs';

const HAND = /metacarpal|of hand$|^(Capitate|Hamate|Lunate|Pisiform|Scaphoid|Trapezium|Trapezoid|Triquetrum) bone$/;
const FOOT = /metatarsal|^Sesamoid bones of foot$|^Calcaneus$|^Cuboid bone$|cuneiform bone$|^Navicular bone$/;
const TOES = /phalanx of .* finger of foot$/;
const FLOATING = /Hyoid|Thyroid cartilage|Cricoid|Arytenoid|Corniculate/;

/** Rigid segment that owns a skeletal structure, or null when it must be skinned as soft tissue. */
export function segmentOfBone(name) {
  const side = /\.[lr]$/.test(name) ? name.slice(-1) : '', base = side ? name.slice(0, -2) : name;
  const sided = id => side ? id + '.' + side : null;
  if (base === 'Femur') return sided('femur');
  if (base === 'Tibia' || base === 'Fibula') return sided('tibia');
  if (base === 'Patella') return sided('patella');
  if (base === 'Talus') return sided('talus');
  if (TOES.test(base)) return sided('toes');
  if (FOOT.test(base)) return sided('foot');
  if (base === 'Humerus') return sided('humerus');
  if (base === 'Ulna') return sided('ulna');
  if (base === 'Radius') return sided('radius');
  if (base === 'Clavicle') return sided('clavicle');
  if (base === 'Scapula') return sided('scapula');
  if (HAND.test(base)) return sided('hand');
  if (/^(Hip bone|Sacrum|Coccyx)$/.test(base)) return 'pelvis';
  let m = /^Vertebra L(\d)$/.exec(base); if (m) return 'L' + m[1];
  if (/^Vertebra T\d+$|rib$|^Costal cartilage|sternum$|^Xiphoid/.test(base)) return 'thorax';
  m = /^Vertebra C(\d)$/.exec(base); if (m) return 'C' + m[1];
  if (base === 'Axis (C2)') return 'C2';
  if (base === 'Atlas (C1)') return 'C1';
  if (FLOATING.test(base)) return null;
  return 'skull';
}

// Share of the regional range of motion taken by each intervertebral level
// (child segment -> flexion/extension, lateral bending, axial rotation).
// Proportions after White & Panjabi, Clinical Biomechanics of the Spine.
export const SPINE_SHARE = {
  lumbar: { thorax: [12, 8, 2], L1: [12, 6, 2], L2: [14, 6, 2], L3: [15, 8, 2], L4: [16, 6, 2], L5: [17, 3, 1] },
  cervical: { skull: [25, 5, 5], C1: [20, 5, 40], C2: [10, 10, 3], C3: [15, 11, 7], C4: [20, 11, 7], C5: [20, 8, 7], C6: [17, 7, 6], C7: [9, 4, 2] }
};
const AXIAL = ['pelvis', 'L5', 'L4', 'L3', 'L2', 'L1', 'thorax', 'C7', 'C6', 'C5', 'C4', 'C3', 'C2', 'C1', 'skull'];
const DISC = { L5: 'L5-S1', L4: 'L4-L5', L3: 'L3-L4', L2: 'L2-L3', L1: 'L1-L2', thorax: 'T12-L1', C7: 'C7-T1', C6: 'C6-C7', C5: 'C5-C6', C4: 'C4-C5', C3: 'C3-C4', C2: 'C2-C3' };
const LOWER_VERTEBRA = { thorax: 'Vertebra T12', C2: 'Axis (C2)', C1: 'Atlas (C1)' };

const V = a => new THREE.Vector3(a[0], a[1], a[2]);
const _axisX = new THREE.Vector3(1, 0, 0), _axisY = new THREE.Vector3(0, 1, 0);
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4(), _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3();

function rotationAbout(axis, pivot, radians, out) {
  _q.setFromAxisAngle(axis, radians);
  out.makeRotationFromQuaternion(_q);
  _v.copy(pivot).applyMatrix4(out);
  out.setPosition(pivot.x - _v.x, pivot.y - _v.y, pivot.z - _v.z);
  return out;
}

export class SkeletonRig {
  constructor(entries) {
    this.entries = entries;
    this.segments = new Map();
    this.order = [];
    this.landmarks = {};
    this.root = new THREE.Matrix4();
    this.boneSegment = new Map();
    for (const e of entries.values()) {
      if (e.sys !== 'skeletal' || !e.meshes.length) continue;
      const seg = segmentOfBone(e.name);
      if (seg) this.boneSegment.set(e.id, seg);
    }
    this.#axial();
    for (const side of ['r', 'l']) { this.#arm(side); this.#leg(side); }
    for (const [id, segId] of this.boneSegment) this.segments.get(segId)?.bones.push(id);
    this.order.forEach((s, i) => { s.index = i; });
    this.solve({});
  }

  #add(id, parent, dofs = [], extra = {}) {
    const seg = { id, parent, dofs, bones: [], delta: new THREE.Matrix4(), local: new THREE.Matrix4(), version: 0, ...extra };
    for (const d of dofs) d.id = id + ':' + d.name;
    this.segments.set(id, seg); this.order.push(seg); return seg;
  }

  /** World vertices of a bone as a flat array; left bones are mirrored so both sides share one code path. */
  #cloud(name, side = '') {
    const e = this.entries.get('skeletal::' + name + (side ? '.' + side : ''));
    if (!e?.meshes.length) throw new Error('Osso non disponibile: ' + name);
    const out = [], v = new THREE.Vector3(), flip = side === 'l' ? -1 : 1;
    for (const m of e.meshes) {
      const p = m.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld); out.push(v.x * flip, v.y, v.z); }
    }
    return out;
  }
  #box(id) {
    const e = this.entries.get(id); if (!e?.meshes.length) return null;
    const b = new THREE.Box3(); e.meshes.forEach(m => b.expandByObject(m)); return b;
  }

  #axial() {
    this.#add('pelvis', null);
    const pivots = {};
    for (const seg of AXIAL.slice(1)) {
      const atlas = this.#box('skeletal::Atlas (C1)');
      if (!atlas) throw new Error('Colonna non disponibile');
      if (seg === 'skull') { // atlanto-occipital joint: over the lateral masses of the atlas
        pivots[seg] = new THREE.Vector3(0, atlas.max.y, (atlas.min.z + atlas.max.z) / 2 + .006); continue;
      }
      if (seg === 'C1') { // atlanto-axial joint: the dens, just behind the anterior arch
        pivots[seg] = new THREE.Vector3(0, (atlas.min.y + atlas.max.y) / 2, atlas.max.z - .012); continue;
      }
      const disc = this.#box('joints::Intervertebral disc ' + DISC[seg]);
      if (disc) { pivots[seg] = disc.getCenter(new THREE.Vector3()).setX(0); continue; }
      // Without the joint model: inferior endplate of the vertebral body.
      const lower = this.#box('skeletal::' + (LOWER_VERTEBRA[seg] || 'Vertebra ' + seg));
      if (!lower) throw new Error('Colonna non disponibile');
      pivots[seg] = new THREE.Vector3(0, lower.min.y + .006, lower.max.z - (lower.max.z - lower.min.z) * .28);
    }
    const X = new THREE.Vector3(1, 0, 0);
    for (let i = 1; i < AXIAL.length; i++) {
      const seg = AXIAL[i], below = pivots[AXIAL[Math.max(1, i - 1)]], above = pivots[AXIAL[Math.min(AXIAL.length - 1, i + 1)]];
      const up = above.clone().sub(below).setX(0).normalize(), pivot = pivots[seg];
      const ap = new THREE.Vector3().crossVectors(X, up).normalize();
      // flexion (+), right lateral bending (+), right rotation (+)
      this.#add(seg, AXIAL[i - 1], [
        { name: 'flex', axis: X.clone(), pivot, sign: 1 },
        { name: 'lat', axis: ap, pivot, sign: 1 },
        { name: 'rot', axis: up.clone().negate(), pivot, sign: 1 }
      ]);
    }
    this.landmarks.spine = pivots;
  }

  #arm(side) {
    const flip = side === 'l' ? -1 : 1, sign = flip;
    const P = a => new THREE.Vector3(a[0] * flip, a[1], a[2]), A = v => new THREE.Vector3(v.x * flip, v.y, v.z).normalize();
    const cl = this.#cloud('Clavicle', side), sc = this.#cloud('Scapula', side), hu = this.#cloud('Humerus', side);
    const ul = this.#cloud('Ulna', side), ra = this.#cloud('Radius', side), cap = this.#cloud('Capitate bone', side);
    const [clMin, clMax] = rangeOf(cl, 0);
    const sternal = V(centroid(filterPts(cl, x => x > clMax - .012))), acromial = V(centroid(filterPts(cl, x => x < clMin + .012)));
    const clavAxis = acromial.clone().sub(sternal).normalize();
    // Scapular plane: direction of least variance of the blade.
    const normal = leastVarianceAxis(sc); if (normal.z > 0) normal.negate();
    const [huBot, huTop] = rangeOf(hu, 1);
    const top = filterPts(hu, (x, y) => y > huTop - .045), mx = median(top, 0);
    const fit = sphereFit(filterPts(top, x => x > mx));
    const gh = fit && fit.r > .015 && fit.r < .035 ? V(fit.c) : V(centroid(top));
    const distal = filterPts(hu, (x, y) => y < huBot + .05);
    const medEpi = V(extremePt(distal, x => x)), latEpi = V(extremePt(distal, x => -x));
    const elbow = V(centroid(filterPts(hu, (x, y) => y < huBot + .022)));
    const elbowAxis = latEpi.clone().sub(medEpi).normalize();
    const [raBot, raTop] = rangeOf(ra, 1), [ulBot] = rangeOf(ul, 1);
    const radialHead = V(centroid(filterPts(ra, (x, y) => y > raTop - .012))), ulnarHead = V(centroid(filterPts(ul, (x, y) => y < ulBot + .015)));
    const forearmAxis = radialHead.clone().sub(ulnarHead).normalize();
    const radialStyloid = V(extremePt(ra, (x, y) => -y)), ulnarStyloid = V(extremePt(ul, (x, y) => -y));
    const wrist = V(centroid(cap)), wristFlex = radialStyloid.clone().sub(ulnarStyloid).normalize();
    const handDown = wrist.clone().sub(elbow).normalize();
    const wristDev = new THREE.Vector3().crossVectors(wristFlex, handDown).normalize(); if (wristDev.z > 0) wristDev.negate();
    const humeralAxis = gh.clone().sub(elbow).normalize();
    const up = new THREE.Vector3(0, 1, 0), lateral = new THREE.Vector3(-1, 0, 0), back = new THREE.Vector3(0, 0, -1);
    const s = n => n + '.' + side;
    this.#add(s('clavicle'), 'thorax', [
      { name: 'protract', axis: A(up), pivot: P(sternal.toArray()), sign },
      { name: 'elevate', axis: A(back), pivot: P(sternal.toArray()), sign },
      { name: 'roll', axis: A(clavAxis), pivot: P(sternal.toArray()), sign }
    ]);
    this.#add(s('scapula'), s('clavicle'), [
      { name: 'upward', axis: A(normal), pivot: P(acromial.toArray()), sign },
      { name: 'internal', axis: A(up), pivot: P(acromial.toArray()), sign },
      { name: 'tilt', axis: A(lateral), pivot: P(acromial.toArray()), sign }
    ]);
    // The humerus is oriented with respect to the thorax, while its head follows the glenoid.
    this.#add(s('humerus'), s('scapula'), [
      { name: 'flex', axis: A(lateral), pivot: P(gh.toArray()), sign },
      { name: 'abd', axis: A(back), pivot: P(gh.toArray()), sign },
      { name: 'rot', axis: A(humeralAxis), pivot: P(gh.toArray()), sign }
    ], { orient: 'thorax', center: P(gh.toArray()) });
    this.#add(s('ulna'), s('humerus'), [{ name: 'flex', axis: A(elbowAxis), pivot: P(elbow.toArray()), sign }]);
    this.#add(s('radius'), s('ulna'), [{ name: 'pron', axis: A(forearmAxis), pivot: P(radialHead.toArray()), sign }]);
    this.#add(s('hand'), s('radius'), [
      { name: 'flex', axis: A(wristFlex), pivot: P(wrist.toArray()), sign },
      { name: 'dev', axis: A(wristDev), pivot: P(wrist.toArray()), sign }
    ]);
    this.landmarks[s('arm')] = { sternoclavicular: P(sternal.toArray()), acromioclavicular: P(acromial.toArray()), glenohumeral: P(gh.toArray()), elbow: P(elbow.toArray()), radialHead: P(radialHead.toArray()), wrist: P(wrist.toArray()), headRadius: fit?.r };
  }

  #leg(side) {
    const flip = side === 'l' ? -1 : 1, sign = flip;
    const P = a => new THREE.Vector3(a[0] * flip, a[1], a[2]), A = v => new THREE.Vector3(v.x * flip, v.y, v.z).normalize();
    const fe = this.#cloud('Femur', side), ti = this.#cloud('Tibia', side), fi = this.#cloud('Fibula', side);
    const ta = this.#cloud('Talus', side), ca = this.#cloud('Calcaneus', side), mt = this.#cloud('Second metatarsal bone', side), pa = this.#cloud('Patella', side);
    const [feBot, feTop] = rangeOf(fe, 1);
    const top = filterPts(fe, (x, y) => y > feTop - .06), mx = median(top, 0);
    const fit = sphereFit(filterPts(top, x => x > mx));
    const hip = fit && fit.r > .015 && fit.r < .035 ? V(fit.c) : V(extremePt(top, x => x));
    const distal = filterPts(fe, (x, y) => y < feBot + .045), dc = centroid(distal);
    const posterior = filterPts(distal, (x, y, z) => z < dc[2] + .002), px = median(posterior, 0);
    const fm = sphereFit(filterPts(posterior, x => x > px)), fl = sphereFit(filterPts(posterior, x => x <= px));
    const good = f => f && f.r > .014 && f.r < .04;
    const medC = good(fm) ? V(fm.c) : V(extremePt(distal, x => x)), latC = good(fl) ? V(fl.c) : V(extremePt(distal, x => -x));
    const kneeAxis = medC.clone().sub(latC).normalize(), knee = medC.clone().add(latC).multiplyScalar(.5);
    const condyleRadius = good(fm) && good(fl) ? (fm.r + fl.r) / 2 : .025;
    const [tiBot, tiTop] = rangeOf(ti, 1);
    const plateau = V(centroid(filterPts(ti, (x, y) => y > tiTop - .012))), tibiaDistal = V(centroid(filterPts(ti, (x, y) => y < tiBot + .02)));
    const tibialAxis = plateau.clone().sub(tibiaDistal).normalize();
    // Axial rotation of the knee pivots on the medial compartment.
    const rotPivot = plateau.clone(); rotPivot.x = medC.x;
    const tuberosity = V(extremePt(filterPts(ti, (x, y) => y < tiTop - .025 && y > tiTop - .06), (x, y, z) => z));
    const patella = V(centroid(pa));
    const medMal = V(extremePt(ti, (x, y) => -y)), latMal = V(extremePt(fi, (x, y) => -y));
    const ankleAxis = latMal.clone().sub(medMal).normalize(), ankle = medMal.clone().add(latMal).multiplyScalar(.5);
    const talusC = V(centroid(ta)); ankle.y = Math.max(ankle.y, talusC.y);
    const heel = V(extremePt(ca, (x, y, z) => -z)), forefoot = V(centroid(mt));
    // Metatarsophalangeal joints: transverse axis through the heads of the first and fifth metatarsals.
    const m1 = this.#cloud('First metatarsal bone', side), m5 = this.#cloud('Fifth metatarsal bone', side), hallux = this.#cloud('Distal phalanx of first finger of foot', side);
    const headOf = pts => { const [, front] = rangeOf(pts, 2); return filterPts(pts, (x, y, z) => z > front - .014); };
    const h1 = headOf(m1), h5 = headOf(m5), head1 = V(centroid(h1)), head5 = V(centroid(h5));
    const toeAxis = head5.clone().sub(head1).normalize(), toePivot = head1.clone().add(head5).multiplyScalar(.5);
    // Points of the skeleton that carry the foot on the ground.
    const lowest = pts => V(extremePt(pts, (x, y) => -y));
    const contact = { heel: lowest(ca), ball1: lowest(h1), ball5: lowest(h5), toe: lowest(hallux) };
    const footAxis = forefoot.clone().sub(heel).setY(0).normalize();
    // Subtalar axis (Inman): 42 degrees above the horizontal, 23 degrees medial to the long axis of the foot.
    const medial = new THREE.Vector3(1, 0, 0);
    const horiz = footAxis.clone().multiplyScalar(Math.cos(23 * DEG)).addScaledVector(medial, Math.sin(23 * DEG)).normalize();
    const subtalarAxis = horiz.multiplyScalar(Math.cos(42 * DEG)).add(new THREE.Vector3(0, Math.sin(42 * DEG), 0)).normalize();
    const subtalar = talusC.clone().add(V(centroid(ca))).multiplyScalar(.5);
    const femoralAxis = hip.clone().sub(knee).normalize();
    const lateral = new THREE.Vector3(-1, 0, 0), back = new THREE.Vector3(0, 0, -1);
    const s = n => n + '.' + side;
    this.#add(s('femur'), 'pelvis', [
      { name: 'flex', axis: A(lateral), pivot: P(hip.toArray()), sign },
      { name: 'abd', axis: A(back), pivot: P(hip.toArray()), sign },
      { name: 'rot', axis: A(femoralAxis), pivot: P(hip.toArray()), sign }
    ]);
    this.#add(s('tibia'), s('femur'), [
      { name: 'flex', axis: A(kneeAxis), pivot: P(knee.toArray()), sign },
      { name: 'rot', axis: A(tibialAxis), pivot: P(rotPivot.toArray()), sign }
    ]);
    const r0 = distanceToLine(patella, knee, kneeAxis);
    this.#add(s('patella'), s('tibia'), [{ name: 'glide', axis: A(kneeAxis), pivot: P(tuberosity.toArray()), sign }], {
      // The patella stays in the femoral groove: it follows knee flexion, not the axial rotation of the tibia.
      parentDofs: ['flex'],
      track: { center: P(patella.toArray()), knee: P(knee.toArray()), axis: A(kneeAxis), rest: r0, deep: Math.max(r0 - .008, Math.min(r0, condyleRadius + .011)) }
    });
    this.#add(s('talus'), s('tibia'), [{ name: 'flex', axis: A(ankleAxis), pivot: P(ankle.toArray()), sign }]);
    this.#add(s('foot'), s('talus'), [{ name: 'inv', axis: A(subtalarAxis), pivot: P(subtalar.toArray()), sign }]);
    this.#add(s('toes'), s('foot'), [{ name: 'flex', axis: A(toeAxis), pivot: P(toePivot.toArray()), sign }]);
    this.landmarks[s('leg')] = { hip: P(hip.toArray()), knee: P(knee.toArray()), ankle: P(ankle.toArray()), subtalar: P(subtalar.toArray()), tuberosity: P(tuberosity.toArray()), patella: P(patella.toArray()), headRadius: fit?.r, condyleRadius,
      toePivot: P(toePivot.toArray()), contact: { heel: ['foot', P(contact.heel.toArray())], ball1: ['foot', P(contact.ball1.toArray())], ball5: ['foot', P(contact.ball5.toArray())], toe: ['toes', P(contact.toe.toArray())] } };
  }

  dof(id) { const [seg, name] = id.split(':'); return this.segments.get(seg)?.dofs.find(d => d.name === name); }

  /** Transform of a segment relative to its parent, expressed in rest-pose world coordinates. */
  #localTransform(seg, q, out, only = null) {
    out.identity();
    for (const d of seg.dofs) {
      const deg = q[d.id]; if (!deg || (only && !only.includes(d.name))) continue;
      out.multiply(rotationAbout(d.axis, d.pivot, deg * DEG * d.sign, _m1));
    }
    return out;
  }

  /**
   * q: { 'segment:dof': degrees }. Computes for every segment the rigid transform that maps
   * rest-pose world coordinates to posed world coordinates.
   * anchor: optional segment kept fixed in space (closed kinetic chain, e.g. a planted foot).
   */
  solve(q, { anchor = null, only = null } = {}) {
    for (const seg of this.order) {
      // `only`: evaluate a single kinematic chain (used by the closed-chain solver, many times per frame).
      if (only && !only.has(seg.id)) continue;
      let parent = seg.parent ? this.segments.get(seg.parent).delta : this.root;
      if (seg.track) q = this.#trackPatella(seg, q);
      if (seg.parentDofs) {
        const p = this.segments.get(seg.parent), grand = p.parent ? this.segments.get(p.parent).delta : this.root;
        parent = _m3.multiplyMatrices(grand, this.#localTransform(p, q, _m4, seg.parentDofs));
      }
      this.#localTransform(seg, q, seg.local);
      const before = seg.delta.elements, prev = _m2.copy(seg.delta);
      if (seg.orient) {
        // Orientation given relative to another segment; position follows the parent joint.
        const ref = this.segments.get(seg.orient).delta, c = _v.copy(seg.center).applyMatrix4(parent);
        const cx = c.x, cy = c.y, cz = c.z;
        seg.delta.extractRotation(ref).multiply(_m1.extractRotation(seg.local));
        _v.copy(seg.center).applyMatrix4(seg.delta);
        seg.delta.setPosition(cx - _v.x, cy - _v.y, cz - _v.z);
      } else seg.delta.multiplyMatrices(parent, seg.local);
      const pe = prev.elements; let same = true;
      for (let i = 0; i < 16; i++) if (Math.abs(pe[i] - before[i]) > 1e-9) { same = false; break; }
      if (!same) seg.version++;
    }
    if (anchor) {
      const inv = new THREE.Matrix4().copy(this.segments.get(anchor).delta).invert();
      for (const seg of this.order) { seg.delta.premultiply(inv); seg.version++; }
    }
    this.pose = q; this.revision = (this.revision || 0) + 1;
    return this;
  }

  /**
   * Placement of the pelvis in space: vertical and fore-aft shift (metres), anterior tilt and
   * rotation to the left (degrees) about the midpoint between the hip joints. Identity when omitted.
   */
  setRoot({ y = 0, z = 0, tilt = 0, yaw = 0 } = {}) {
    const r = this.landmarks['leg.r']?.hip, l = this.landmarks['leg.l']?.hip, c = r && l ? r.clone().add(l).multiplyScalar(.5) : new THREE.Vector3();
    this.root.identity();
    if (yaw) this.root.multiply(rotationAbout(_axisY, c, yaw * DEG, _m1));
    if (tilt) this.root.multiply(rotationAbout(_axisX, c, tilt * DEG, _m1));
    this.root.elements[13] += y; this.root.elements[14] += z;
    return this;
  }
  /** Height of the lowest contact point of the feet above its standing height (metres). */
  footClearance(sides = ['r', 'l']) {
    let min = Infinity;
    for (const s of sides) for (const [seg, rest] of Object.values(this.landmarks['leg.' + s].contact)) min = Math.min(min, _v.copy(rest).applyMatrix4(this.segments.get(seg + '.' + s).delta).y - rest.y);
    return min;
  }

  /** Patella: fixed-length patellar ligament hinged on the tibial tuberosity, sliding into the trochlear groove. */
  #trackPatella(seg, q) {
    const tibia = this.segments.get(seg.parent), t = seg.track, d = seg.dofs[0];
    const flexion = Math.abs(q[tibia.id + ':flex'] || 0);
    const target = t.rest - (t.rest - t.deep) * smoothstep(10, 100, flexion);
    this.#localTransform(tibia, q, _m2, seg.parentDofs);
    const local = new THREE.Matrix4().copy(_m2), p = new THREE.Vector3(), rot = new THREE.Matrix4();
    const dist = deg => { rotationAbout(d.axis, d.pivot, deg * DEG * d.sign, rot); p.copy(t.center).applyMatrix4(rot).applyMatrix4(local); return distanceToLine(p, t.knee, t.axis); };
    let lo = -35, hi = 35, best = 0, err = Infinity;
    for (let step = 0; step < 4; step++) {
      const n = 14, span = (hi - lo) / n;
      for (let i = 0; i <= n; i++) { const a = lo + span * i, e = Math.abs(dist(a) - target); if (e < err - 1e-9 || (Math.abs(e - err) <= 1e-9 && Math.abs(a) < Math.abs(best))) { err = e; best = a; } }
      lo = best - span; hi = best + span;
    }
    if (flexion < 1e-6) best = 0;
    return { ...q, [d.id]: best };
  }

  /** Current world position of a rest-pose point attached to a segment. */
  point(segId, rest, out = new THREE.Vector3()) { return out.copy(rest).applyMatrix4(this.segments.get(segId).delta); }
  /** Current world direction of a dof axis (already includes the side sign). */
  axisWorld(dofId, out = new THREE.Vector3()) {
    const [segId] = dofId.split(':'), seg = this.segments.get(segId), d = this.dof(dofId);
    const parent = seg.parent ? this.segments.get(seg.parent).delta : this.root;
    // Axes are carried by the rotations listed before them (joint coordinate system).
    const m = new THREE.Matrix4().copy(parent);
    if (seg.orient) m.extractRotation(this.segments.get(seg.orient).delta); else m.extractRotation(m);
    for (const other of seg.dofs) {
      if (other === d) break;
      const deg = this.pose?.[other.id]; if (deg) m.multiply(new THREE.Matrix4().makeRotationAxis(other.axis, deg * DEG * other.sign));
    }
    return out.copy(d.axis).multiplyScalar(d.sign).transformDirection(m);
  }
  pivotWorld(dofId, out = new THREE.Vector3()) {
    const [segId] = dofId.split(':'), seg = this.segments.get(segId), d = this.dof(dofId);
    if (seg.orient) return out.copy(seg.center).applyMatrix4(this.segments.get(seg.parent).delta);
    return out.copy(d.pivot).applyMatrix4(seg.delta);
  }
  /** Segments on the tree path between two segments (inclusive). */
  path(a, b) {
    const up = id => { const out = []; for (let s = this.segments.get(id); s; s = s.parent ? this.segments.get(s.parent) : null) out.push(s.id); return out; };
    const pa = up(a), pb = up(b), setB = new Set(pb), out = [];
    let common = null; for (const id of pa) { out.push(id); if (setB.has(id)) { common = id; break; } }
    for (const id of pb) { if (id === common) break; out.push(id); }
    return out;
  }
  descendants(id) {
    const out = new Set([id]);
    for (const seg of this.order) if (seg.parent && out.has(seg.parent)) out.add(seg.id);
    return out;
  }
}

function distanceToLine(p, origin, dir) {
  const v = new THREE.Vector3().subVectors(p, origin), along = v.dot(dir);
  return Math.sqrt(Math.max(0, v.lengthSq() - along * along));
}

/** Smallest-eigenvalue direction of a point cloud covariance (power iteration on the inverse-shifted matrix). */
export function leastVarianceAxis(pts) {
  const c = centroid(pts), n = pts.length / 3; let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i] - c[0], y = pts[i+1] - c[1], z = pts[i+2] - c[2];
    xx += x*x; xy += x*y; xz += x*z; yy += y*y; yz += y*z; zz += z*z;
  }
  xx /= n; xy /= n; xz /= n; yy /= n; yz /= n; zz /= n;
  const tr = xx + yy + zz, v = new THREE.Vector3(.3, .2, .93).normalize();
  // Iterate with (tr*I - C): its dominant eigenvector is the least-variance axis of C.
  for (let k = 0; k < 200; k++) {
    const x = (tr - xx) * v.x - xy * v.y - xz * v.z, y = -xy * v.x + (tr - yy) * v.y - yz * v.z, z = -xz * v.x - yz * v.y + (tr - zz) * v.z;
    v.set(x, y, z).normalize();
  }
  return v;
}
/** Largest-variance direction of a point cloud. */
export function principalAxis(pts) {
  const c = centroid(pts), n = pts.length / 3; let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i] - c[0], y = pts[i+1] - c[1], z = pts[i+2] - c[2];
    xx += x*x; xy += x*y; xz += x*z; yy += y*y; yz += y*z; zz += z*z;
  }
  const v = new THREE.Vector3(.31, .9, .29).normalize();
  for (let k = 0; k < 60; k++) v.set(xx * v.x + xy * v.y + xz * v.z, xy * v.x + yy * v.y + yz * v.z, xz * v.x + yz * v.y + zz * v.z).normalize();
  return { axis: v, center: V(c) };
}
export { clamp };
