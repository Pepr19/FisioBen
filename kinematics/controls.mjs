// Clinical-level controls (flexion, abduction...) and their translation into
// the joint coordinates of the rig, including the coupled motions that make a
// movement look and measure like the real one.
import { smoothstep, clamp, DEG, periodicCurve, solveLinear } from './kin-math.mjs';
import { SPINE_SHARE } from './rig.mjs';

// Ranges are indicative reference values (AAOS, Joint Motion: Method of Measuring and Recording;
// Kapandji, The Physiology of the Joints). They are not therapeutic targets.
export const JOINTS = [
  { id: 'shoulder', name: 'Spalla', sided: true, segments: ['clavicle', 'scapula', 'humerus'], view: [-1.2, .35, 2],
    controls: [
      { id: 'flex', neg: 'Estensione', pos: 'Flessione', min: -50, max: 180, up: ['deltoid-anterior', 'pectoralis-clavicular', 'coracobrachialis', 'biceps-short'], down: ['latissimus', 'teres-major', 'deltoid-posterior', 'triceps-long'] },
      { id: 'abd', neg: 'Adduzione', pos: 'Abduzione', min: -10, max: 180, up: ['deltoid-middle', 'supraspinatus', 'serratus-anterior', 'trapezius-upper', 'trapezius-lower'], down: ['pectoralis-sternal', 'latissimus', 'teres-major'] },
      { id: 'rot', neg: 'Rotazione esterna', pos: 'Rotazione interna', min: -90, max: 70, up: ['subscapularis', 'pectoralis-sternal', 'latissimus', 'teres-major'], down: ['infraspinatus', 'teres-minor', 'deltoid-posterior'] }
    ],
    note: 'Ritmo scapolo-omerale: dopo i primi 30° la scapola contribuisce con circa 1° ogni 2° gleno-omerali; la clavicola si eleva e ruota posteriormente. Nell’abduzione oltre 90° l’omero ruota esternamente.' },
  { id: 'elbow', name: 'Gomito', sided: true, segments: ['humerus', 'ulna', 'radius'], view: [-1.7, .1, 2],
    controls: [{ id: 'flex', neg: 'Estensione', pos: 'Flessione', min: 0, max: 145, up: ['brachialis', 'biceps-long', 'biceps-short', 'brachioradialis'], down: ['triceps-long', 'triceps-lateral', 'triceps-medial', 'anconeus'] }],
    note: 'Asse obliquo attraverso troclea e capitello, ricavato dagli epicondili: da qui nasce il valgismo fisiologico in estensione.' },
  { id: 'forearm', name: 'Avambraccio', sided: true, segments: ['ulna', 'radius', 'hand'], view: [-1.2, .1, 2.2],
    controls: [{ id: 'pron', neg: 'Supinazione', pos: 'Pronazione', min: 0, max: 160, zero: 85, up: ['pronator-teres', 'pronator-quadratus'], down: ['supinator', 'biceps-long', 'biceps-short'] }],
    note: 'Il radio ruota attorno all’ulna lungo l’asse capitello radiale–testa dell’ulna e trascina la mano. La posizione anatomica del modello è in supinazione: il valore clinico parte dalla posizione intermedia (pollice in alto).' },
  { id: 'wrist', name: 'Polso', sided: true, segments: ['radius', 'hand'], view: [-1.5, 0, 2],
    controls: [
      { id: 'flex', neg: 'Estensione', pos: 'Flessione', min: -70, max: 80, up: ['fcr', 'fcu', 'palmaris'], down: ['ecrl', 'ecrb', 'ecu'] },
      { id: 'dev', neg: 'Deviazione ulnare', pos: 'Deviazione radiale', min: -30, max: 20, up: ['fcr', 'ecrl', 'ecrb', 'apl'], down: ['fcu', 'ecu'] }
    ],
    note: 'Movimento complessivo radio-carpico e medio-carpico attorno alla testa del capitato.' },
  { id: 'hip', name: 'Anca', sided: true, segments: ['femur'], view: [-1.4, .15, 2],
    controls: [
      { id: 'flex', neg: 'Estensione', pos: 'Flessione', min: -20, max: 120, up: ['psoas', 'iliacus', 'rectus-femoris', 'sartorius', 'tfl'], down: ['gluteus-max', 'biceps-femoris-long', 'semitendinosus', 'semimembranosus'] },
      { id: 'abd', neg: 'Adduzione', pos: 'Abduzione', min: -30, max: 45, up: ['gluteus-med', 'gluteus-min', 'tfl'], down: ['adductor-longus', 'adductor-brevis', 'adductor-magnus', 'gracilis', 'pectineus'] },
      { id: 'rot', neg: 'Rotazione esterna', pos: 'Rotazione interna', min: -45, max: 45, up: ['gluteus-min', 'gluteus-med', 'tfl'], down: ['piriformis', 'obturator-internus', 'obturator-externus', 'gemellus-superior', 'gemellus-inferior', 'quadratus-femoris', 'gluteus-max'] }
    ],
    note: 'Enartrosi centrata sulla testa del femore (sfera adattata alla geometria). La rotazione avviene attorno all’asse meccanico testa–ginocchio.' },
  { id: 'knee', name: 'Ginocchio', sided: true, segments: ['femur', 'tibia', 'patella'], view: [-1.6, .05, 1.6],
    controls: [
      { id: 'flex', neg: 'Estensione', pos: 'Flessione', min: 0, max: 140, up: ['biceps-femoris-long', 'biceps-femoris-short', 'semitendinosus', 'semimembranosus', 'gastrocnemius-medial', 'gastrocnemius-lateral'], down: ['rectus-femoris', 'vastus-lateralis', 'vastus-medialis', 'vastus-intermedius'] },
      { id: 'rot', neg: 'Rotazione esterna', pos: 'Rotazione interna', min: -30, max: 20, up: ['popliteus', 'semitendinosus', 'semimembranosus', 'sartorius', 'gracilis'], down: ['biceps-femoris-long', 'biceps-femoris-short'] }
    ],
    note: 'Asse di flessione attraverso i centri dei condili posteriori. Avvitamento automatico: la tibia ruota internamente di circa 12° nei primi 25° di flessione. La rotazione volontaria è possibile solo a ginocchio flesso. La rotula segue il legamento rotuleo, di lunghezza costante, entrando nella gola trocleare.' },
  { id: 'ankle', name: 'Caviglia e piede', sided: true, segments: ['tibia', 'talus', 'foot', 'toes'], view: [-1.6, .25, 1.6],
    controls: [
      { id: 'flex', neg: 'Flessione plantare', pos: 'Dorsiflessione', min: -50, max: 20, up: ['tibialis-anterior', 'edl', 'ehl', 'fibularis-tertius'], down: ['gastrocnemius-medial', 'gastrocnemius-lateral', 'soleus', 'tibialis-posterior', 'fhl', 'fdl'] },
      { id: 'inv', neg: 'Eversione', pos: 'Inversione', min: -15, max: 35, up: ['tibialis-posterior', 'tibialis-anterior'], down: ['fibularis-longus', 'fibularis-brevis', 'fibularis-tertius'] },
      { id: 'toes', neg: 'Flessione delle dita', pos: 'Estensione delle dita', min: -35, max: 65, up: ['edl', 'ehl'], down: ['fhl', 'fdl'] }
    ],
    note: 'Tibio-tarsica: asse obliquo fra gli apici dei malleoli. Sotto-astragalica: asse di Henke/Inman, inclinato di 42° sull’orizzontale e 23° medialmente. Metatarso-falangee: asse trasversale fra le teste del primo e del quinto metatarso, con le dita mosse in blocco.' },
  { id: 'cervical', name: 'Colonna cervicale', sided: false, segments: ['C7', 'C6', 'C5', 'C4', 'C3', 'C2', 'C1', 'skull'], view: [-1.5, .15, 1.8],
    controls: [
      { id: 'flex', neg: 'Estensione', pos: 'Flessione', min: -60, max: 50, up: ['sternocleidomastoid', 'longus-colli', 'longus-capitis', 'scalene-anterior'], down: ['splenius-capitis', 'splenius-colli', 'semispinalis', 'trapezius-upper'] },
      { id: 'lat', neg: 'Inclinazione sinistra', pos: 'Inclinazione destra', min: -45, max: 45, up: ['scalene-anterior', 'scalene-middle', 'scalene-posterior', 'sternocleidomastoid', 'levator-scapulae'], down: [] },
      { id: 'rot', neg: 'Rotazione sinistra', pos: 'Rotazione destra', min: -80, max: 80, up: ['splenius-capitis', 'obliquus-capitis-inferior', 'sternocleidomastoid'], down: [] }
    ],
    note: 'Movimento distribuito su otto livelli con le proporzioni di White e Panjabi: circa metà della rotazione avviene fra atlante ed epistrofeo. Nel tratto C2–C7 l’inclinazione laterale si accompagna a rotazione dallo stesso lato.' },
  { id: 'lumbar', name: 'Colonna lombare', sided: false, segments: ['L5', 'L4', 'L3', 'L2', 'L1', 'thorax'], view: [-1.6, .1, 2.2],
    controls: [
      { id: 'flex', neg: 'Estensione', pos: 'Flessione', min: -25, max: 60, up: ['rectus-abdominis', 'external-oblique', 'internal-oblique', 'psoas'], down: ['iliocostalis', 'longissimus', 'spinalis', 'multifidus'] },
      { id: 'lat', neg: 'Inclinazione sinistra', pos: 'Inclinazione destra', min: -30, max: 30, up: ['quadratus-lumborum', 'external-oblique', 'internal-oblique', 'iliocostalis'], down: [] },
      { id: 'rot', neg: 'Rotazione sinistra', pos: 'Rotazione destra', min: -10, max: 10, up: ['external-oblique', 'internal-oblique', 'multifidus', 'rotatores'], down: [] }
    ],
    note: 'Sei livelli da T12–L1 a L5–S1. Il torace è trattato come blocco rigido: la rotazione rappresentata è la sola quota lombare, piccola per l’orientamento sagittale delle faccette.' }
];

// Functional movements: time curves for several joints at once (degrees over one cycle).
// Gait curves follow the classic sagittal-plane pattern of level walking (Perry, Gait Analysis;
// Winter, Biomechanics and Motor Control of Human Movement). Keys are [fraction of the cycle, degrees].
const GAIT = {
  hip: [[0, 30], [.12, 22], [.3, 0], [.5, -10], [.62, 0], [.75, 25], [.87, 33]],
  knee: [[0, 5], [.13, 18], [.27, 8], [.4, 4], [.5, 10], [.62, 40], [.73, 62], [.86, 30], [.97, 2]],
  ankle: [[0, 0], [.07, -7], [.2, 3], [.45, 11], [.55, 2], [.63, -18], [.74, -5], [.86, 1]],
  toes: [[0, 12], [.1, 0], [.4, 2], [.5, 22], [.6, 52], [.68, 14], [.8, 6]],
  shoulder: [[0, -12], [.25, 0], [.5, 18], [.75, 4]],
  elbow: [[0, 8], [.5, 24]]
};
const wave = t => (1 - Math.cos(t * 2 * Math.PI)) / 2;
const both = (out, key, value) => { out[key.replace('*', 'r')] = value; out[key.replace('*', 'l')] = value; };
// plant: segment of both feet that stays on the ground; the pelvis and the hips are then solved (closed chain).
// ground: 'treadmill' keeps the lowest point of the feet at floor level while the pelvis stays in place.
export const GESTURES = [
  { id: 'squat', name: 'Squat', duration: 4.5, plant: 'foot', view: [-1.6, .15, 2.4],
    series: [['Anca', 'hip.r.flex'], ['Ginocchio', 'knee.r.flex'], ['Caviglia', 'ankle.r.flex']],
    note: 'Catena cinetica chiusa: i piedi restano in appoggio. Ginocchio, caviglia e inclinazione del bacino sono imposti; flessione, abduzione e rotazione dell’anca e l’altezza del bacino sono calcolate perché entrambi i piedi restino fermi a terra.',
    pose(t) {
      const d = wave(t), out = {};
      both(out, 'knee.*.flex', 112 * d); both(out, 'ankle.*.flex', 27 * d); both(out, 'shoulder.*.flex', 82 * d); both(out, 'elbow.*.flex', 6 * d);
      out['pelvis.tilt'] = 24 * d; out['lumbar.flex'] = 8 * d; out['cervical.flex'] = -22 * d;
      return out;
    } },
  { id: 'gait', name: 'Cammino', duration: 1.2, ground: 'treadmill', view: [-2, .12, 1.4],
    series: [['Anca', 'hip.r.flex'], ['Ginocchio', 'knee.r.flex'], ['Caviglia', 'ankle.r.flex']],
    marks: [[.62, 'distacco']],
    note: 'Ciclo del passo dell’arto destro su tappeto: curve sagittali tipiche di anca, ginocchio, caviglia e dita, rotazione del bacino e oscillazione delle braccia. Contatto iniziale a 0%, distacco delle dita a circa 62%. Il bacino sale e scende seguendo l’appoggio dei piedi.',
    pose(t) {
      const out = {}, yaw = 4 * Math.cos(t * 2 * Math.PI);
      for (const [s, phase, turn] of [['r', t, -1], ['l', t + .5, 1]]) {
        out['hip.' + s + '.flex'] = periodicCurve(GAIT.hip, phase); out['knee.' + s + '.flex'] = periodicCurve(GAIT.knee, phase);
        out['ankle.' + s + '.flex'] = periodicCurve(GAIT.ankle, phase); out['ankle.' + s + '.toes'] = periodicCurve(GAIT.toes, phase);
        // The feet keep pointing forwards while the pelvis rotates.
        out['hip.' + s + '.rot'] = turn * yaw;
        out['shoulder.' + s + '.flex'] = periodicCurve(GAIT.shoulder, phase); out['elbow.' + s + '.flex'] = periodicCurve(GAIT.elbow, phase);
      }
      out['pelvis.yaw'] = yaw; out['lumbar.rot'] = 5.5 * Math.cos(t * 2 * Math.PI);
      return out;
    } },
  { id: 'heel-raise', name: 'Sollevamento sugli avampiedi', duration: 3.5, plant: 'toes', view: [-1.8, .12, 1.5],
    series: [['Caviglia', 'ankle.r.flex'], ['Dita (MTF)', 'ankle.r.toes']],
    note: 'Catena cinetica chiusa sull’avampiede: la flessione plantare della caviglia solleva il tallone mentre le dita, ferme a terra, si estendono alle metatarso-falangee.',
    pose(t) {
      const d = wave(t), out = {};
      both(out, 'ankle.*.flex', -38 * d); both(out, 'ankle.*.toes', 38 * d);
      return out;
    } },
  { id: 'forward-bend', name: 'Flessione del tronco in avanti', duration: 5, plant: 'foot', view: [-1.8, .1, 1.7],
    series: [['Anca', 'hip.r.flex'], ['Lombare', 'lumbar.flex'], ['Bacino', 'pelvis.tilt']],
    note: 'Ritmo lombo-pelvico: la colonna lombare si flette per prima, poi il bacino ruota in avanti sulle teste femorali. I piedi restano in appoggio e il bacino arretra per mantenere l’equilibrio.',
    pose(t) {
      const d = wave(t), out = {};
      out['lumbar.flex'] = 52 * smoothstep(0, .65, d); out['pelvis.tilt'] = 62 * smoothstep(.2, 1, d); out['cervical.flex'] = 18 * d;
      both(out, 'ankle.*.flex', -6 * d); both(out, 'shoulder.*.flex', 62 * smoothstep(.15, 1, d));
      return out;
    } },
  { id: 'reach', name: 'Elevazione del braccio', duration: 5, view: [-.9, .3, 2.2],
    series: [['Elevazione', i => i['shoulder.r'].elevation], ['Gleno-omerale', i => i['shoulder.r'].glenohumeral], ['Scapolo-toracica', i => i['shoulder.r'].scapular]],
    note: 'Elevazione nel piano scapolare fino a 170°, con ritmo scapolo-omerale e rotazione esterna obbligata.',
    pose(t) {
      const d = wave(t);
      return { 'shoulder.r.abd': 150 * d, 'shoulder.r.flex': 75 * d, 'elbow.r.flex': 10 * d };
    } }
];

export const controlKey = (joint, side, control) => joint + (side ? '.' + side : '') + '.' + control;
export function clampControl(joint, controlId, value) {
  const c = JOINTS.find(j => j.id === joint)?.controls.find(x => x.id === controlId);
  return c ? clamp(Number.isFinite(value) ? value : 0, c.min, c.max) : 0;
}

/** Derived quantities worth showing to a student (degrees). */
export function shoulderRhythm(flex, abd) {
  const elevation = Math.acos(clamp(Math.cos(flex * DEG) * Math.cos(abd * DEG), -1, 1)) / DEG;
  // Setting phase: the first 30 degrees are almost purely glenohumeral, then about 2:1.
  const scapular = flex < 0 && abd <= 0 ? 0 : clamp(.4 * (elevation - 30), 0, 60);
  return { elevation, scapular, glenohumeral: elevation - scapular };
}
/** Automatic tibial internal rotation while the knee unlocks (screw-home mechanism). */
export const screwHome = flex => 12 * smoothstep(0, 25, flex);
/** Voluntary tibial rotation is only free once the collateral ligaments slacken in flexion. */
export const kneeRotationFreedom = flex => smoothstep(5, 60, flex);

/**
 * state: { 'shoulder.r.flex': degrees, 'lumbar.rot': degrees, ... } -> rig coordinates.
 * offsets: rest-pose offsets from restOffsets(), so that coupled motions depend on anatomical angles.
 * Returns { q, info } where info holds derived values for the interface.
 */
export function resolvePose(state, offsets = {}) {
  const q = {}, info = {}, get = k => state[k] || 0;
  for (const s of ['r', 'l']) {
    const F = get('shoulder.' + s + '.flex'), A = get('shoulder.' + s + '.abd'), R = get('shoulder.' + s + '.rot');
    const rhythm = shoulderRhythm(F, A + (offsets['shoulder.' + s + '.abd'] || 0)), st = rhythm.scapular, share = Math.abs(A) / (Math.abs(A) + Math.abs(F) || 1);
    q['clavicle.' + s + ':elevate'] = .42 * st;
    q['clavicle.' + s + ':roll'] = .5 * st;
    q['clavicle.' + s + ':protract'] = st * (.15 * (1 - share) - .3 * share);
    q['scapula.' + s + ':upward'] = st - .42 * st;
    q['scapula.' + s + ':internal'] = .12 * st * (1 - share);
    // Obligatory external rotation clears the greater tubercle under the acromion in abduction.
    const auto = -40 * smoothstep(45, 150, rhythm.elevation) * share;
    q['humerus.' + s + ':flex'] = F; q['humerus.' + s + ':abd'] = A; q['humerus.' + s + ':rot'] = R + auto;
    info['shoulder.' + s] = { ...rhythm, automaticRotation: auto };
    q['ulna.' + s + ':flex'] = get('elbow.' + s + '.flex');
    q['radius.' + s + ':pron'] = get('forearm.' + s + '.pron');
    q['hand.' + s + ':flex'] = get('wrist.' + s + '.flex'); q['hand.' + s + ':dev'] = get('wrist.' + s + '.dev');
    q['femur.' + s + ':flex'] = get('hip.' + s + '.flex'); q['femur.' + s + ':abd'] = get('hip.' + s + '.abd'); q['femur.' + s + ':rot'] = get('hip.' + s + '.rot');
    const K = get('knee.' + s + '.flex'), auto2 = screwHome(K), free = kneeRotationFreedom(K);
    q['tibia.' + s + ':flex'] = K; q['tibia.' + s + ':rot'] = auto2 + get('knee.' + s + '.rot') * free;
    info['knee.' + s] = { screwHome: auto2, rotationFreedom: free };
    q['talus.' + s + ':flex'] = get('ankle.' + s + '.flex'); q['foot.' + s + ':inv'] = get('ankle.' + s + '.inv'); q['toes.' + s + ':flex'] = get('ankle.' + s + '.toes');
  }
  for (const region of ['lumbar', 'cervical']) {
    const shares = SPINE_SHARE[region], sum = [0, 1, 2].map(i => Object.values(shares).reduce((a, v) => a + v[i], 0));
    const flex = get(region + '.flex'), lat = get(region + '.lat'), rot = get(region + '.rot');
    for (const [seg, w] of Object.entries(shares)) {
      q[seg + ':flex'] = flex * w[0] / sum[0];
      q[seg + ':lat'] = lat * w[1] / sum[1];
      // Coupled ipsilateral rotation during lateral bending of the lower cervical spine.
      const coupled = region === 'cervical' && /^C[2-7]$/.test(seg) ? .35 * lat * w[1] / sum[1] : 0;
      q[seg + ':rot'] = rot * w[2] / sum[2] + coupled;
    }
  }
  return { q, info };
}

// Rig coordinate that represents each clinical control (used to draw joint axes).
const CONTROL_DOF = {
  'shoulder.flex': 'humerus:flex', 'shoulder.abd': 'humerus:abd', 'shoulder.rot': 'humerus:rot', 'elbow.flex': 'ulna:flex', 'forearm.pron': 'radius:pron',
  'wrist.flex': 'hand:flex', 'wrist.dev': 'hand:dev', 'hip.flex': 'femur:flex', 'hip.abd': 'femur:abd', 'hip.rot': 'femur:rot', 'knee.flex': 'tibia:flex', 'knee.rot': 'tibia:rot',
  'ankle.flex': 'talus:flex', 'ankle.inv': 'foot:inv', 'ankle.toes': 'toes:flex', 'cervical.flex': 'C4:flex', 'cervical.lat': 'C4:lat', 'cervical.rot': 'C1:rot', 'lumbar.flex': 'L3:flex', 'lumbar.lat': 'L3:lat', 'lumbar.rot': 'L3:rot'
};
export function dofFor(joint, control, side) {
  const [seg, name] = CONTROL_DOF[joint + '.' + control].split(':');
  return (JOINTS.find(j => j.id === joint).sided ? seg + '.' + side : seg) + ':' + name;
}
/** Segment ids of a joint for one side ('r' | 'l') or the midline. */
export function jointSegments(joint, side) {
  const j = JOINTS.find(x => x.id === joint);
  return j.segments.map(s => j.sided ? s + '.' + side : s);
}
/**
 * The atlas is not modelled exactly in the neutral-zero position: the arm hangs slightly
 * abducted and the elbow slightly flexed. These offsets (degrees) turn rig angles into anatomical ones.
 */
export function restOffsets(rig) {
  const out = {};
  for (const s of ['r', 'l']) {
    const a = rig.landmarks['arm.' + s]; if (!a) continue;
    const upper = a.glenohumeral.clone().sub(a.elbow), fore = a.wrist.clone().sub(a.elbow);
    out['elbow.' + s + '.flex'] = Math.round(180 - upper.angleTo(fore) / DEG);
    out['shoulder.' + s + '.abd'] = Math.round(Math.atan2(Math.abs(a.elbow.x - a.glenohumeral.x), a.glenohumeral.y - a.elbow.y) / DEG);
  }
  return out;
}


/* ---------- Functional movements: placement of the pelvis and closed kinetic chains ---------- */
const LEG_CHAIN = new Set(['pelvis', 'femur.r', 'tibia.r', 'talus.r', 'foot.r', 'toes.r']);
const IK_KEYS = ['hip.*.flex', 'hip.*.abd', 'hip.*.rot', 'ankle.*.inv'];

/** How far the planted segment of the right foot is from its standing pose: [cm x3, rotation x3]. */
function plantError(rig, state, offsets, root, plant, out) {
  rig.setRoot(root).solve(resolvePose(state, offsets).q, { only: LEG_CHAIN });
  const e = rig.segments.get(plant + '.r').delta.elements, p = rig.landmarks['leg.r'].toePivot;
  out[0] = (e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12] - p.x) * 100;
  out[1] = (e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13] - p.y) * 100;
  out[2] = (e[2] * p.x + e[6] * p.y + e[10] * p.z + e[14] - p.z) * 100;
  // Small-angle rotation vector of the rotation part, scaled to centimetres at the forefoot.
  out[3] = (e[6] - e[9]) * 12.5; out[4] = (e[8] - e[2]) * 12.5; out[5] = (e[1] - e[4]) * 12.5;
  return out;
}

/**
 * Both feet planted, pelvis on the midline: hip flexion, abduction and rotation, subtalar inversion
 * and the height and fore-aft position of the pelvis follow from the given knee, ankle and pelvic
 * tilt (damped Newton iterations on the right leg; the left leg mirrors it).
 * memo keeps the previous solution so that consecutive frames converge in one or two steps.
 */
export function plantFeet(rig, state, offsets, plant, memo = {}) {
  const x = memo.x ? memo.x.slice() : [0, 0, 0, 0, 0, 0], steps = [.4, .4, .4, .4, .002, .002];
  const tilt = state['pelvis.tilt'] || 0, work = { ...state };
  const put = v => { IK_KEYS.forEach((k, i) => { work[k.replace('*', 'r')] = v[i]; work[k.replace('*', 'l')] = v[i]; }); return { y: v[4], z: v[5], tilt }; };
  const r = new Float64Array(6), r1 = new Float64Array(6), J = Array.from({ length: 6 }, () => new Float64Array(6));
  let error = Infinity;
  for (let iter = 0; iter < 24; iter++) {
    plantError(rig, work, offsets, put(x), plant, r);
    error = Math.hypot(...r); if (error < 1e-4) break;
    for (let j = 0; j < 6; j++) {
      const keep = x[j]; x[j] = keep + steps[j]; plantError(rig, work, offsets, put(x), plant, r1); x[j] = keep;
      for (let i = 0; i < 6; i++) J[i][j] = (r1[i] - r[i]) / steps[j];
    }
    // Levenberg-Marquardt step: (JtJ + lambda I) dx = -Jt r
    const A = Array.from({ length: 6 }, (_, a) => Float64Array.from({ length: 6 }, (_, b) => { let sum = 0; for (let i = 0; i < 6; i++) sum += J[i][a] * J[i][b]; return sum + (a === b ? 1e-6 * (1 + sum) : 0); }));
    const g = Float64Array.from({ length: 6 }, (_, a) => { let sum = 0; for (let i = 0; i < 6; i++) sum -= J[i][a] * r[i]; return sum; });
    const dx = solveLinear(A, g); if (!dx) break;
    // Limit the step: angles in degrees, translations in metres.
    let scale = 1; for (let j = 0; j < 4; j++) scale = Math.min(scale, 25 / Math.max(25, Math.abs(dx[j]))); for (let j = 4; j < 6; j++) scale = Math.min(scale, .25 / Math.max(.25, Math.abs(dx[j])));
    for (let j = 0; j < 6; j++) x[j] += dx[j] * scale;
  }
  memo.x = x; memo.error = error;
  return { state: work, root: put(x), error };
}

/**
 * Pose of a functional movement at a phase of its cycle.
 * Returns { state, q, info, root }: state holds the clinical angles actually shown (solved ones included).
 */
export function solveGesture(rig, gesture, phase, offsets = {}, memo = {}) {
  let state = gesture.pose(phase), root = { tilt: state['pelvis.tilt'] || 0, yaw: state['pelvis.yaw'] || 0 };
  if (gesture.plant) {
    // Follow the solution continuously from the last solved phase (or from the standing pose, where it is
    // known exactly): a jump of the slider must not land on another branch of the closed chain.
    const from = memo.x && memo.phase != null ? memo.phase : 0, steps = Math.max(1, Math.ceil(Math.abs(phase - from) / .03));
    if (!memo.x) memo.x = [0, 0, 0, 0, 0, 0];
    for (let i = 1; i <= steps; i++) ({ state, root } = plantFeet(rig, gesture.pose(from + (phase - from) * i / steps), offsets, gesture.plant, memo));
    memo.phase = phase;
  }
  const { q, info } = resolvePose(state, offsets);
  rig.setRoot(root).solve(q);
  if (gesture.ground === 'treadmill') { root.y = (root.y || 0) - rig.footClearance(); rig.setRoot(root).solve(q); }
  info.root = root;
  return { state, q, info, root };
}

/** Values of the gesture series over one cycle, for the angle-time chart: [{ label, values[] }]. */
export function gestureCurves(rig, gesture, offsets = {}, samples = 48) {
  const curves = gesture.series.map(([label]) => ({ label, values: [] })), memo = {};
  for (let i = 0; i <= samples; i++) {
    const { state, info } = solveGesture(rig, gesture, i / samples, offsets, memo);
    gesture.series.forEach(([, key], k) => curves[k].values.push(typeof key === 'function' ? key(info) : (state[key] || 0) + (offsets[key] || 0)));
  }
  return curves;
}
