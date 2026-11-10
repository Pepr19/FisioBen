// Small line chart for the movement panel (angle over the cycle, muscle length over the range).
// Plain 2D canvas, no dependencies; drawn at the device pixel ratio.
export const SERIES_COLORS = ['#c2410c', '#1d6fb8', '#2f8f5b', '#7c4dbb'];

// Tick step: 1, 2 or 5 times a power of ten, at least as large as the requested spacing.
const nice = span => { const p = Math.pow(10, Math.floor(Math.log10(span))), f = span / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };

/**
 * curves: [{ label, values[], color? }] sampled evenly over x = [x0, x1].
 * cursor: current x; marks: [[x, text]]; format: value -> text; xFormat: x -> tick text.
 */
export function drawChart(canvas, { curves, x = [0, 1], cursor = null, marks = [], format = v => Math.round(v) + '°', xFormat = v => Math.round(v * 100) + '%', zero = true }) {
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 3), width = canvas.clientWidth || 280, height = canvas.clientHeight || 130;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
  const g = canvas.getContext('2d'); g.setTransform(ratio, 0, 0, ratio, 0, 0); g.clearRect(0, 0, width, height);
  let lo = Infinity, hi = -Infinity;
  for (const c of curves) for (const v of c.values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo)) return;
  if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
  const step = nice((hi - lo) / 4); lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const L = 36, R = 8, T = 8, B = 18, w = width - L - R, h = height - T - B;
  const X = v => L + (v - x[0]) / (x[1] - x[0]) * w, Y = v => T + (hi - v) / (hi - lo) * h;
  g.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif'; g.textBaseline = 'middle'; g.lineWidth = 1;
  for (let v = lo; v <= hi + step * .01; v += step) {
    g.strokeStyle = Math.abs(v) < step * .01 ? '#9fb3b1' : '#e3ebea'; g.beginPath(); g.moveTo(L, Math.round(Y(v)) + .5); g.lineTo(L + w, Math.round(Y(v)) + .5); g.stroke();
    g.fillStyle = '#6d8585'; g.textAlign = 'right'; g.fillText(format(v), L - 5, Y(v));
  }
  g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillStyle = '#6d8585';
  for (let k = 0; k <= 4; k++) { const v = x[0] + (x[1] - x[0]) * k / 4; g.textAlign = k === 0 ? 'left' : k === 4 ? 'right' : 'center'; g.fillText(xFormat(v), X(v), height - 4); }
  for (const [mx, text] of marks) {
    g.strokeStyle = '#b7c6c5'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(X(mx) + .5, T); g.lineTo(X(mx) + .5, T + h); g.stroke(); g.setLineDash([]);
    g.textAlign = 'center'; g.fillStyle = '#8a9c9c'; g.fillText(text, X(mx), T + 9);
  }
  curves.forEach((c, i) => {
    const n = c.values.length; if (n < 2) return;
    g.strokeStyle = c.color || SERIES_COLORS[i % SERIES_COLORS.length]; g.lineWidth = 1.8; g.lineJoin = 'round'; g.beginPath();
    c.values.forEach((v, k) => { const px = X(x[0] + (x[1] - x[0]) * k / (n - 1)), py = Y(v); if (k) g.lineTo(px, py); else g.moveTo(px, py); });
    g.stroke();
  });
  if (cursor != null) {
    const cx = X(Math.max(x[0], Math.min(x[1], cursor)));
    g.strokeStyle = '#233d42'; g.lineWidth = 1; g.beginPath(); g.moveTo(cx + .5, T); g.lineTo(cx + .5, T + h); g.stroke();
    curves.forEach((c, i) => {
      const n = c.values.length, f = (Math.max(x[0], Math.min(x[1], cursor)) - x[0]) / (x[1] - x[0]) * (n - 1), a = Math.floor(f), b = Math.min(n - 1, a + 1), v = c.values[a] + (c.values[b] - c.values[a]) * (f - a);
      g.fillStyle = c.color || SERIES_COLORS[i % SERIES_COLORS.length]; g.beginPath(); g.arc(cx, Y(v), 3.2, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 1.2; g.stroke();
    });
  }
}

/** Value of a sampled curve at x (linear interpolation). */
export function curveAt(values, x, range = [0, 1]) {
  const n = values.length, f = (Math.max(range[0], Math.min(range[1], x)) - range[0]) / (range[1] - range[0]) * (n - 1), a = Math.floor(f), b = Math.min(n - 1, a + 1);
  return values[a] + (values[b] - values[a]) * (f - a);
}
