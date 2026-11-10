// Small numeric helpers shared by the kinematic rig and the skinning code.
// Everything works on plain arrays so that it can be tested without WebGL.

/** Algebraic least-squares sphere through a flat xyz array. */
export function sphereFit(pts) {
  const n = pts.length / 3, A = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]], b = [0,0,0,0];
  for (let i = 0; i < n; i++) {
    const x = pts[i*3], y = pts[i*3+1], z = pts[i*3+2], r = [x, y, z, 1], q = x*x + y*y + z*z;
    for (let a = 0; a < 4; a++) { b[a] += r[a] * q; for (let c = 0; c < 4; c++) A[a][c] += r[a] * r[c]; }
  }
  const M = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < 4; i++) {
    let p = i; for (let j = i + 1; j < 4; j++) if (Math.abs(M[j][i]) > Math.abs(M[p][i])) p = j;
    [M[i], M[p]] = [M[p], M[i]];
    if (Math.abs(M[i][i]) < 1e-14) return null;
    for (let j = 0; j < 4; j++) if (j !== i) { const k = M[j][i] / M[i][i]; for (let c = i; c < 5; c++) M[j][c] -= k * M[i][c]; }
  }
  const s = M.map((r, i) => r[4] / r[i]), c = [s[0]/2, s[1]/2, s[2]/2];
  const r2 = s[3] + c[0]*c[0] + c[1]*c[1] + c[2]*c[2];
  return r2 > 0 ? { c, r: Math.sqrt(r2) } : null;
}

export const filterPts = (pts, fn) => { const o = []; for (let i = 0; i < pts.length; i += 3) if (fn(pts[i], pts[i+1], pts[i+2])) o.push(pts[i], pts[i+1], pts[i+2]); return o; };
export const extremePt = (pts, fn) => { let best = -Infinity, bi = 0; for (let i = 0; i < pts.length; i += 3) { const s = fn(pts[i], pts[i+1], pts[i+2]); if (s > best) { best = s; bi = i; } } return [pts[bi], pts[bi+1], pts[bi+2]]; };
export const centroid = pts => { let x = 0, y = 0, z = 0; const n = pts.length / 3 || 1; for (let i = 0; i < pts.length; i += 3) { x += pts[i]; y += pts[i+1]; z += pts[i+2]; } return [x/n, y/n, z/n]; };
export const rangeOf = (pts, k) => { let lo = Infinity, hi = -Infinity; for (let i = k; i < pts.length; i += 3) { if (pts[i] < lo) lo = pts[i]; if (pts[i] > hi) hi = pts[i]; } return [lo, hi]; };
export const median = (pts, k) => { const a = []; for (let i = k; i < pts.length; i += 3) a.push(pts[i]); a.sort((p, q) => p - q); return a[a.length >> 1] ?? 0; };

export const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const DEG = Math.PI / 180;

/** Piecewise cubic (Catmull-Rom, periodic) through [phase, value] keys, phase in 0..1. */
export function periodicCurve(keys, phase) {
  const n = keys.length, p = ((phase % 1) + 1) % 1;
  let i = 0; while (i < n && keys[i][0] <= p) i++;
  const k = j => { const m = ((j % n) + n) % n, wrap = Math.floor(j / n); return [keys[m][0] + wrap, keys[m][1]]; };
  const p0 = k(i - 2), p1 = k(i - 1), p2 = k(i), p3 = k(i + 1);
  const t = (p - p1[0]) / (p2[0] - p1[0] || 1);
  const m1 = (p2[1] - p0[1]) / (p2[0] - p0[0] || 1) * (p2[0] - p1[0]), m2 = (p3[1] - p1[1]) / (p3[0] - p1[0] || 1) * (p2[0] - p1[0]);
  const t2 = t * t, t3 = t2 * t;
  return (2*t3 - 3*t2 + 1) * p1[1] + (t3 - 2*t2 + t) * m1 + (-2*t3 + 3*t2) * p2[1] + (t3 - t2) * m2;
}

/** Rigid 4x4 (column-major, as THREE.Matrix4.elements) to dual quaternion [rx,ry,rz,rw, dx,dy,dz,dw]. */
export function matrixToDualQuat(e, out, o = 0) {
  const m11 = e[0], m12 = e[4], m13 = e[8], m21 = e[1], m22 = e[5], m23 = e[9], m31 = e[2], m32 = e[6], m33 = e[10];
  const tr = m11 + m22 + m33; let x, y, z, w;
  if (tr > 0) { const s = .5 / Math.sqrt(tr + 1); w = .25 / s; x = (m32 - m23) * s; y = (m13 - m31) * s; z = (m21 - m12) * s; }
  else if (m11 > m22 && m11 > m33) { const s = 2 * Math.sqrt(1 + m11 - m22 - m33); w = (m32 - m23) / s; x = .25 * s; y = (m12 + m21) / s; z = (m13 + m31) / s; }
  else if (m22 > m33) { const s = 2 * Math.sqrt(1 + m22 - m11 - m33); w = (m13 - m31) / s; x = (m12 + m21) / s; y = .25 * s; z = (m23 + m32) / s; }
  else { const s = 2 * Math.sqrt(1 + m33 - m11 - m22); w = (m21 - m12) / s; x = (m13 + m31) / s; y = (m23 + m32) / s; z = .25 * s; }
  const tx = e[12], ty = e[13], tz = e[14];
  out[o] = x; out[o+1] = y; out[o+2] = z; out[o+3] = w;
  out[o+4] = .5 * (tx * w + ty * z - tz * y);
  out[o+5] = .5 * (-tx * z + ty * w + tz * x);
  out[o+6] = .5 * (tx * y - ty * x + tz * w);
  out[o+7] = -.5 * (tx * x + ty * y + tz * z);
  return out;
}

/** Solve A x = b by Gaussian elimination with partial pivoting (A: array of rows). Returns null when singular. */
export function solveLinear(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let p = i; for (let j = i + 1; j < n; j++) if (Math.abs(M[j][i]) > Math.abs(M[p][i])) p = j;
    if (Math.abs(M[p][i]) < 1e-14) return null;
    [M[i], M[p]] = [M[p], M[i]];
    for (let j = i + 1; j < n; j++) { const k = M[j][i] / M[i][i]; for (let c = i; c <= n; c++) M[j][c] -= k * M[i][c]; }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) { let sum = M[i][n]; for (let c = i + 1; c < n; c++) sum -= M[i][c] * x[c]; x[i] = sum / M[i][i]; }
  return x;
}
