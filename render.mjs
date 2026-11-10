// Rendering quality for the atlas: studio lighting, tissue materials, ambient
// occlusion, selection outline and the "ghost" context used by isolation.
// Everything is local code on top of Three.js core (no extra dependencies).
import * as THREE from 'three';
import { SKIN_PARS, SKIN_POSITION, SKIN_POSITION_NORMAL } from './kinematics/gpu-skin.mjs';

/** Object layers: what each render pass draws. */
export const LAYER = { TISSUE: 0, OUTLINE: 1, GHOST: 2, OVERLAY: 3, BACKDROP: 4 };
// Translucent tissues are composed from the inside of the body outwards.
const TISSUE_ORDER = ['skeletal', 'joints', 'nervous', 'other', 'tendon', 'muscular', 'fascia'];

/** Surface response per tissue layer. Colours stay in layers.mjs; this adds how light behaves on them. */
export const tissueLook = {
  muscular: { roughness: .56, envMapIntensity: .75 },
  tendon: { roughness: .38, envMapIntensity: 1 },
  skeletal: { roughness: .7, envMapIntensity: .55 },
  nervous: { roughness: .48, envMapIntensity: .8 },
  joints: { roughness: .34, envMapIntensity: 1 },
  fascia: { roughness: .5, envMapIntensity: .8 },
  other: { roughness: .6, envMapIntensity: .6 }
};

/** Soft-box studio rendered once into a prefiltered environment map. */
function studioEnvironment(renderer) {
  const env = new THREE.Scene(), geo = new THREE.BoxGeometry(1, 1, 1);
  const panel = (color, strength, position, scale) => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(strength), side: THREE.DoubleSide }));
    m.position.set(...position); m.scale.set(...scale); env.add(m);
  };
  const room = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color('#aab4b8').multiplyScalar(.55), side: THREE.BackSide }));
  room.scale.set(12, 9, 12); room.position.y = 3; env.add(room);
  panel('#ffffff', 9, [0, 7.3, 1.5], [7, .1, 6]);          // ceiling soft box
  panel('#fff1e0', 6.5, [4.5, 3.2, 4.2], [.1, 4, 4]);        // warm key, front right
  panel('#dfeaff', 3.2, [-5.6, 2.6, 1], [.1, 4.5, 6]);       // cool fill, left
  panel('#ffffff', 4.5, [0, 3.2, -5.8], [6, 3.5, .1]);       // rim from behind
  panel('#8d8478', .9, [0, -1.4, 0], [12, .1, 12]);          // warm floor bounce
  const pmrem = new THREE.PMREMGenerator(renderer), target = pmrem.fromScene(env, .035);
  pmrem.dispose(); geo.dispose(); env.traverse(o => o.material?.dispose());
  return target.texture;
}

/** Lights + environment. Returns the objects so the caller can tune or dispose them. */
export function createStudio(renderer, scene) {
  scene.environment = studioEnvironment(renderer);
  scene.environmentIntensity = .5;
  const key = new THREE.DirectionalLight('#fff3e6', 1.9); key.position.set(2.2, 3.4, 4);
  const rim = new THREE.DirectionalLight('#dce9ff', 1.25); rim.position.set(-2.8, 2.2, -3.6);
  const fill = new THREE.HemisphereLight('#f4f7fb', '#5a5148', .42);
  scene.add(key, rim, fill);
  return { key, rim, fill };
}

/** Translucent rim-lit material for the anatomical context around an isolated structure. */
export function createGhostMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.FrontSide,
    uniforms: { color: { value: new THREE.Color('#5d7c88') }, base: { value: .014 }, rim: { value: .2 } },
    vertexShader: SKIN_PARS + '\nvarying vec3 vN; varying vec3 vV; void main(){ ' + SKIN_POSITION_NORMAL + '\n vec4 mv = modelViewMatrix * vec4(transformed, 1.); vN = normalize(normalMatrix * objectNormal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform vec3 color; uniform float base; uniform float rim; varying vec3 vN; varying vec3 vV; void main(){ float f = 1. - abs(dot(normalize(vN), normalize(vV))); gl_FragColor = vec4(color, base + rim * f * f * f); }'
  });
}

/** Soft contact shadow under the feet. */
export function createGroundShadow() {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
    fragmentShader: 'varying vec2 vUv; void main(){ vec2 p = (vUv - .5) * 2.; float r = length(p * vec2(1., 1.25)); float a = smoothstep(1., .12, r); gl_FragColor = vec4(.09, .13, .15, a * a * .26); }'
  }));
  mesh.rotation.x = -Math.PI / 2; mesh.renderOrder = -1; mesh.raycast = () => {}; mesh.layers.set(LAYER.BACKDROP);
  return mesh;
}

/**
 * Draws the scene in ordered passes on the current render target:
 * backdrop and ghosted context, opaque tissues, then every translucent tissue layer as a clean
 * shell (depth first, colour only on the nearest surface), and finally the overlays.
 * materials: every tissue material in use; clean=false blends translucent tissues in one pass.
 */
export function renderLayered(renderer, scene, camera, { materials = [], clean = true } = {}) {
  const mask = camera.layers.mask, auto = renderer.autoClear;
  renderer.autoClear = false; renderer.clear();
  try {
    camera.layers.set(LAYER.BACKDROP); camera.layers.enable(LAYER.GHOST); renderer.render(scene, camera);
    camera.layers.set(LAYER.TISSUE);
    const groups = new Map();
    if (clean) for (const m of materials) if (m.visible && m.transparent) { const k = m.userData.layer; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
    if (!groups.size) renderer.render(scene, camera);
    else {
      const shown = []; for (const m of materials) if (m.visible) shown.push(m);
      try {
        for (const list of groups.values()) for (const m of list) m.visible = false;
        renderer.render(scene, camera);
        for (const m of shown) m.visible = false;
        for (const layer of TISSUE_ORDER) {
          const list = groups.get(layer); if (!list) continue;
          for (const m of list) { m.visible = true; m.colorWrite = false; m.depthWrite = true; }
          renderer.render(scene, camera);
          for (const m of list) { m.colorWrite = true; m.depthWrite = false; m.depthFunc = THREE.LessEqualDepth; }
          renderer.render(scene, camera);
          for (const m of list) m.visible = false;
        }
      } finally {
        for (const m of shown) m.visible = true;
        for (const list of groups.values()) for (const m of list) { m.colorWrite = true; m.depthWrite = false; }
      }
    }
    camera.layers.set(LAYER.OVERLAY); renderer.render(scene, camera);
  } finally { camera.layers.mask = mask; renderer.autoClear = auto; }
}

/**
 * Picking by colour: the pixel under the pointer is rendered with one flat colour per mesh.
 * Unlike ray casting it follows meshes deformed in the vertex shader and costs one draw of the scene.
 */
export class Picker {
  constructor(renderer) {
    this.renderer = renderer; this.meshes = [null]; this.buffer = new Uint8Array(4);
    this.target = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });
    this.target.texture.minFilter = this.target.texture.magFilter = THREE.NearestFilter;
    this.material = new THREE.ShaderMaterial({
      uniforms: { pid: { value: new THREE.Vector3() } }, blending: THREE.NoBlending, side: THREE.DoubleSide,
      vertexShader: SKIN_PARS + '\nvoid main(){ ' + SKIN_POSITION + '\n gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.); }',
      fragmentShader: 'uniform vec3 pid; void main(){ gl_FragColor = vec4(pid, 1.); }'
    });
    this._clear = new THREE.Color();
  }
  /** Give a mesh its colour id. */
  register(mesh) {
    const id = this.meshes.length, material = this.material, pid = material.uniforms.pid.value;
    this.meshes.push(mesh);
    mesh.onBeforeRender = (renderer, scene, camera, geometry, used) => {
      if (used !== material) return;
      pid.set((id & 255) / 255, ((id >> 8) & 255) / 255, ((id >> 16) & 255) / 255); material.uniformsNeedUpdate = true;
    };
  }
  /** x, y in CSS pixels from the top-left corner of a canvas of width x height CSS pixels. Returns the mesh or null. */
  pick(scene, camera, x, y, width, height) {
    const r = this.renderer, previous = r.getRenderTarget(), alpha = r.getClearAlpha(), view = camera.view ? { ...camera.view } : null, mask = camera.layers.mask;
    r.getClearColor(this._clear);
    // The camera may already look through an off-centre window (safe area of the interface).
    const on = !!view?.enabled, ox = on ? view.offsetX : 0, oy = on ? view.offsetY : 0;
    camera.setViewOffset(on ? view.fullWidth : width, on ? view.fullHeight : height, ox + x, oy + y, 1, 1); camera.layers.set(LAYER.TISSUE);
    const over = scene.overrideMaterial; scene.overrideMaterial = this.material;
    try {
      r.setRenderTarget(this.target); r.setClearColor(0x000000, 0); r.clear(); r.render(scene, camera);
      r.readRenderTargetPixels(this.target, 0, 0, 1, 1, this.buffer);
    } finally {
      scene.overrideMaterial = over; camera.layers.mask = mask;
      if (view?.enabled) camera.setViewOffset(view.fullWidth, view.fullHeight, view.offsetX, view.offsetY, view.width, view.height); else camera.clearViewOffset();
      r.setRenderTarget(previous); r.setClearColor(this._clear, alpha);
    }
    const b = this.buffer;
    return this.meshes[b[0] | (b[1] << 8) | (b[2] << 16)] || null;
  }
  dispose() { this.target.dispose(); this.material.dispose(); }
}

const QUAD_VERTEX = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }';
const AO_FRAGMENT = `
uniform sampler2D tDepth; uniform mat4 projInv; uniform float projScale; uniform vec2 resolution; uniform float radius; uniform float intensity;
varying vec2 vUv;
vec3 viewPos(vec2 uv){ float d = texture2D(tDepth, uv).x; vec4 v = projInv * vec4(uv * 2. - 1., d * 2. - 1., 1.); return v.xyz / v.w; }
void main(){
  float depth = texture2D(tDepth, vUv).x;
  if (depth >= .99999) { gl_FragColor = vec4(1.); return; }
  vec2 px = 1. / resolution; vec3 p = viewPos(vUv);
  vec3 pr = viewPos(vUv + vec2(px.x, 0.)), pl = viewPos(vUv - vec2(px.x, 0.)), pu = viewPos(vUv + vec2(0., px.y)), pd = viewPos(vUv - vec2(0., px.y));
  vec3 dx = abs(pr.z - p.z) < abs(p.z - pl.z) ? pr - p : p - pl;
  vec3 dy = abs(pu.z - p.z) < abs(p.z - pd.z) ? pu - p : p - pd;
  vec3 n = normalize(cross(dx, dy));
  float rPix = clamp(radius * projScale / -p.z, 2., 48.);
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(.06711056, .00583715))));
  float sum = 0.;
  for (int i = 0; i < 12; i++) {
    float fi = float(i), a = (fi + noise) * 2.3999632, r = sqrt((fi + .5) / 12.) * rPix;
    vec3 v = viewPos(vUv + vec2(cos(a), sin(a)) * r * px) - p;
    float vv = dot(v, v), vn = dot(v, n) - .0006 - .0012 * -p.z;
    sum += max(0., vn) / (vv + .00004) * smoothstep(radius * 2.2, radius * .9, sqrt(vv));
  }
  float ao = clamp(1. - intensity * radius * sum / 12., 0., 1.);
  gl_FragColor = vec4(ao, ao, ao, 1.);
}`;
const COMPOSITE_FRAGMENT = `
uniform sampler2D tColor; uniform sampler2D tAO; uniform sampler2D tMask; uniform sampler2D tDepth;
uniform vec2 aoTexel; uniform vec2 texel; uniform vec3 outlineColor; uniform float aoOn; uniform float outlineOn; uniform float near; uniform float far; uniform float outlineWidth;
varying vec2 vUv;
float viewZ(vec2 uv){ float d = texture2D(tDepth, uv).x; return near * far / (far - d * (far - near)); }
void main(){
  vec4 c = texture2D(tColor, vUv);
  float ao = 1.;
  if (aoOn > .5 && c.a > 0.) {
    float z0 = viewZ(vUv), sum = 0., wsum = 0.;
    for (int x = -2; x < 2; x++) for (int y = -2; y < 2; y++) {
      vec2 uv = vUv + (vec2(float(x), float(y)) + .5) * aoTexel;
      float w = 1. / (1. + abs(viewZ(uv) - z0) * 400.);
      sum += texture2D(tAO, uv).r * w; wsum += w;
    }
    ao = sum / wsum;
  }
  vec3 rgb = c.rgb / max(c.a, 1e-4) * ao;
  gl_FragColor = vec4(rgb, c.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  float alpha = c.a;
  if (outlineOn > .5) {
    float m = texture2D(tMask, vUv).r, mx = m, mn = m;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * .7853982; float s = texture2D(tMask, vUv + vec2(cos(a), sin(a)) * texel * outlineWidth).r;
      mx = max(mx, s); mn = min(mn, s);
    }
    float edge = clamp((mx - mn) * 1.6, 0., 1.);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, outlineColor, edge * .92);
    alpha = max(alpha, edge);
  }
  gl_FragColor = vec4(gl_FragColor.rgb * alpha, alpha);
}`;

/**
 * Scene -> multisampled HDR target -> ambient occlusion -> composite with selection outline.
 * If anything is unsupported the caller falls back to plain rendering (see `ok`).
 */
export class Pipeline {
  constructor(renderer) {
    this.renderer = renderer; this.ok = renderer.capabilities.isWebGL2;
    this.ao = true; this.width = 0; this.height = 0;
    // HDR target when the device can multisample half-float buffers; otherwise an 8-bit multisampled one.
    const gl = renderer.getContext(), counts = format => { try { return [...(gl.getInternalformatParameter(gl.RENDERBUFFER, format, gl.SAMPLES) || [])]; } catch { return []; } };
    const floatOk = renderer.extensions.has('EXT_color_buffer_half_float') || renderer.extensions.has('EXT_color_buffer_float');
    const pick = list => list.filter(n => n <= 4).sort((a, b) => b - a)[0] || 0;
    const halfSamples = floatOk && this.ok ? pick(counts(gl.RGBA16F)) : 0, half = floatOk && halfSamples >= 2;
    const samples = half ? halfSamples : Math.min(4, renderer.capabilities.maxSamples || 0);
    this.color = new THREE.WebGLRenderTarget(4, 4, { samples, type: half ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: true });
    if (!half) this.color.texture.colorSpace = THREE.SRGBColorSpace;
    this.color.depthTexture = new THREE.DepthTexture(4, 4);
    this.aoTarget = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: false });
    this.mask = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: false });
    for (const t of [this.aoTarget, this.mask]) { t.texture.minFilter = t.texture.magFilter = THREE.LinearFilter; }
    this.maskMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false, depthWrite: false, toneMapped: false });
    this.maskCamera = new THREE.PerspectiveCamera();
    this.quadScene = new THREE.Scene(); this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); this.quad.frustumCulled = false; this.quadScene.add(this.quad);
    this.aoMaterial = new THREE.ShaderMaterial({ depthTest: false, depthWrite: false, toneMapped: false, vertexShader: QUAD_VERTEX, fragmentShader: AO_FRAGMENT,
      uniforms: { tDepth: { value: this.color.depthTexture }, projInv: { value: new THREE.Matrix4() }, projScale: { value: 1 }, resolution: { value: new THREE.Vector2() }, radius: { value: .016 }, intensity: { value: 1.15 } } });
    this.compositeMaterial = new THREE.ShaderMaterial({ depthTest: false, depthWrite: false, blending: THREE.NoBlending, vertexShader: QUAD_VERTEX, fragmentShader: COMPOSITE_FRAGMENT,
      uniforms: { tColor: { value: this.color.texture }, tAO: { value: this.aoTarget.texture }, tMask: { value: this.mask.texture }, tDepth: { value: this.color.depthTexture },
        aoTexel: { value: new THREE.Vector2() }, texel: { value: new THREE.Vector2() }, outlineColor: { value: new THREE.Color('#12d6a8') }, aoOn: { value: 1 }, outlineOn: { value: 0 }, near: { value: .01 }, far: { value: 50 }, outlineWidth: { value: 2 } } });
    this._clear = new THREE.Color();
  }
  setSize(width, height, pixelRatio) {
    const w = Math.max(2, Math.floor(width * pixelRatio)), h = Math.max(2, Math.floor(height * pixelRatio));
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h; this.pixelRatio = pixelRatio;
    this.color.setSize(w, h);
    const aw = Math.max(2, w >> 1), ah = Math.max(2, h >> 1);
    this.aoTarget.setSize(aw, ah); this.mask.setSize(w, h);
    this.aoMaterial.uniforms.resolution.value.set(aw, ah);
    this.compositeMaterial.uniforms.aoTexel.value.set(1 / aw, 1 / ah);
    this.compositeMaterial.uniforms.texel.value.set(1 / w, 1 / h);
    this.compositeMaterial.uniforms.outlineWidth.value = Math.max(1.4, 1.5 * pixelRatio);
  }
  /** Check once that the device accepts the render targets; otherwise the caller renders directly. */
  validate() {
    if (!this.ok) return false;
    const r = this.renderer, gl = r.getContext(), previous = r.getRenderTarget();
    try {
      for (const target of [this.color, this.aoTarget, this.mask]) {
        r.setRenderTarget(target);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { this.ok = false; break; }
      }
    } catch { this.ok = false; }
    r.setRenderTarget(previous);
    return this.ok;
  }
  /** outlined: true when some meshes are on the outline layer. */
  render(scene, camera, { outlined = false, ao = this.ao, materials = [], clean = true } = {}) {
    const r = this.renderer, previous = r.getRenderTarget(), alpha = r.getClearAlpha(); r.getClearColor(this._clear);
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.color); renderLayered(r, scene, camera, { materials, clean });
    const cu = this.compositeMaterial.uniforms;
    if (ao) {
      const u = this.aoMaterial.uniforms;
      u.projInv.value.copy(camera.projectionMatrixInverse); u.projScale.value = camera.projectionMatrix.elements[5] * .5 * this.aoTarget.height;
      this.quad.material = this.aoMaterial; r.setRenderTarget(this.aoTarget); r.render(this.quadScene, this.quadCamera);
    }
    if (outlined) {
      const mc = this.maskCamera; mc.copy(camera, false); mc.layers.set(LAYER.OUTLINE);
      mc.matrixWorld.copy(camera.matrixWorld); mc.matrixWorldInverse.copy(camera.matrixWorldInverse); mc.matrixWorldAutoUpdate = false;
      const env = scene.environment, over = scene.overrideMaterial; scene.overrideMaterial = this.maskMaterial;
      r.setRenderTarget(this.mask); r.clear(); r.render(scene, mc); scene.overrideMaterial = over; scene.environment = env;
    }
    cu.aoOn.value = ao ? 1 : 0; cu.outlineOn.value = outlined ? 1 : 0; cu.near.value = camera.near; cu.far.value = camera.far;
    this.quad.material = this.compositeMaterial; r.setRenderTarget(previous); r.setClearColor(this._clear, alpha);
    r.render(this.quadScene, this.quadCamera);
  }
  dispose() { for (const t of [this.color, this.aoTarget, this.mask]) t.dispose(); this.aoMaterial.dispose(); this.compositeMaterial.dispose(); this.maskMaterial.dispose(); }
}

/** Eased camera move; any new flight or user gesture cancels the previous one. */
export class CameraFlight {
  constructor(camera, controls, onFrame) { this.camera = camera; this.controls = controls; this.onFrame = onFrame; this.frame = 0; controls.addEventListener('start', () => this.cancel()); }
  cancel() { cancelAnimationFrame(this.frame); this.frame = 0; }
  to(target, position, duration = 520) {
    this.cancel();
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const t0 = performance.now(), fromT = this.controls.target.clone(), fromP = this.camera.position.clone();
    // Interpolate the orbit offset on a sphere so the model stays framed during the move.
    const o0 = fromP.clone().sub(fromT), o1 = position.clone().sub(target), r0 = o0.length(), r1 = o1.length();
    const q = new THREE.Quaternion().setFromUnitVectors(o0.clone().normalize(), o1.clone().normalize()), id = new THREE.Quaternion(), qi = new THREE.Quaternion();
    const step = now => {
      const k = reduce || duration <= 0 ? 1 : Math.min(1, (now - t0) / duration), e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      this.controls.target.lerpVectors(fromT, target, e);
      qi.slerpQuaternions(id, q, e);
      this.camera.position.copy(o0).normalize().applyQuaternion(qi).multiplyScalar(r0 + (r1 - r0) * e).add(this.controls.target);
      this.controls.update(); this.onFrame();
      this.frame = k < 1 ? requestAnimationFrame(step) : 0;
    };
    step(t0);
  }
}
