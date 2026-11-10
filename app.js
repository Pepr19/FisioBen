import {searchCatalog,searchLayer} from './catalog-search.mjs';
import {restoreModel,captureModel,saveModel,cachedModels} from './model-cache.mjs';
import { modelsForLayers } from './loading-plan.mjs';
import { applyMaterialOpacity } from './material-opacity.mjs';
import { layerNames, layerColors, defaultOpacities, presets, materialLayer } from './layers.mjs?v=8';
import { movements } from './movements-data.mjs';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { cleanName, createCardIndex, cardFor } from './anatomy.mjs';
import { tissueLook, createStudio, createGhostMaterial, createGroundShadow, Pipeline, CameraFlight, Picker, renderLayered, LAYER } from './render.mjs';
import { SkeletonRig } from './kinematics/rig.mjs';
import { SkinBinder } from './kinematics/skin.mjs';
import { JOINTS, GESTURES, resolvePose, restOffsets, dofFor, jointSegments, solveGesture, gestureCurves } from './kinematics/controls.mjs';
import { drawChart, curveAt, SERIES_COLORS } from './kinematics/chart.mjs';
import { regionMembers, regionOf } from './regions.mjs';

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const sysNames = { muscular: 'Muscoli e fasce', skeletal: 'Scheletro', joints: 'Articolazioni e legamenti', nervous: 'Sistema nervoso' };
const sysClasses = { muscular: 'muscle', skeletal: 'bone', joints: 'joint', nervous: 'nerve' };
const active = new Set(Object.keys(defaultOpacities).filter(k=>defaultOpacities[k]>0)), roots = new Map(), entries = new Map(), pending = new Map();
const hidden = new Set(), tissueMaterials = new Set();
let selected = null, dictionary = {}, lexicon = {}, allBox, timer, frame = 0;
// Isolation: a set of structure ids shown in full; the rest becomes a translucent context (or disappears).
let isolated = null, isolationLabel = '', showContext = true;
let renderer, scene, camera, controls, loader, viewReady = false, cardData, cardIndex = new Map();
let pipeline = null, flight = null, picker = null, ghostMaterial = null, groundShadow = null, highQuality = true;
let lastFrameTime = 0, frameCost = 16, refineTimer = 0;
const wrap = $('#canvas-wrap');
const layerOpacity = {...defaultOpacities};
let peeled = [];
let initialModelReady=false;
const failedModels=new Set();
const cacheWrites=new Map();
let warming=false;
const yieldToUI=()=>new Promise(resolve=>setTimeout(resolve,0));
const nextFrame=()=>new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
const getCard = e => cardFor(e, cardIndex);
const side = n => n.endsWith('.l') ? 'Sinistro' : n.endsWith('.r') ? 'Destro' : 'Mediano / non lateralizzato';
function label(e) {
  const card = getCard(e);
  if (card) return card.name;
  const b = cleanName(e.name), alias = dictionary[b.toLowerCase()] || dictionary[b.toLowerCase().replace(/ muscle$/, '')];
  return alias ? alias[0][0].toUpperCase() + alias[0].slice(1) : b;
}
function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function toast(text) {
  $('#toast').textContent = text; $('#toast').style.display = 'block';
  clearTimeout(timer); timer = setTimeout(() => $('#toast').style.display = 'none', 3300);
}

/* ---------- Rendering ---------- */
function renderFrame(full) {
  const sel = entries.get(selected), outlined = !!sel && sel.meshes.some(m => m.visible);
  // full: still image, with ambient occlusion and translucent tissues drawn as clean shells.
  if (pipeline?.ok && highQuality) {
    try { pipeline.render(scene, camera, { outlined, ao: full, materials: tissueMaterials, clean: full }); return; }
    catch (error) { console.warn('FisioBen: resa avanzata disattivata', error); pipeline.ok = false; }
  }
  renderer.setRenderTarget(null); renderLayered(renderer, scene, camera, { materials: tissueMaterials, clean: full && highQuality });
}
function draw() {
  if (!viewReady || frame) return;
  frame = requestAnimationFrame(now => {
    frame = 0; if (!viewReady) return;
    controls.update();
    // While frames arrive in a burst (orbiting, animation) measure their cost; on slow devices the
    // ambient occlusion pass is skipped during motion and restored on the still image.
    const gap = now - lastFrameTime; lastFrameTime = now;
    if (gap < 200) frameCost += (gap - frameCost) * .2;
    const light = gap < 200 && frameCost > 42;
    renderFrame(!light);
    clearTimeout(refineTimer);
    if (light) refineTimer = setTimeout(() => { if (viewReady && !frame) { lastFrameTime = 0; renderFrame(true); } }, 220);
  });
}
/**
 * The canvas fills the whole viewer, under the floating panels. The camera frames the model inside
 * the free area left by the interface (title, dock, open panel, selection bar) and the picture simply
 * continues beyond it, so the body is never cut by a hard edge.
 */
const inset = { left: 0, top: 0, right: 0, bottom: 0, frame: 0 }, canvasSize = { width: 0, height: 0 };
function freeArea(width, height) {
  const w = wrap.getBoundingClientRect(), narrow = matchMedia('(max-width:800px)').matches, out = { left: 0, top: narrow ? 84 : 92, right: 0, bottom: 0 };
  const shown = el => el && !el.hidden && el.getClientRects().length;
  // The selection bar comes and goes with every tap: it must not rescale the model, so it is only
  // taken into account when a structure is framed on purpose (see fit).
  let floor = w.bottom;
  if (shown($('.model-dock'))) floor = Math.min(floor, $('.model-dock').getBoundingClientRect().top);
  const panel = $$('.tool-panel').find(shown);
  if (panel) { const r = panel.getBoundingClientRect(); if (narrow || r.width > width * .7) floor = Math.min(floor, r.top); else out.left = Math.max(0, r.right - w.left + 10); }
  out.bottom = Math.max(0, w.bottom - floor + 8);
  // Never let the interface squeeze the framed area to nothing.
  if (width - out.left - out.right < 140) out.left = out.right = 0;
  if (height - out.top - out.bottom < 140) { out.top = Math.min(out.top, height * .15); out.bottom = Math.min(out.bottom, height * .3); }
  return out;
}
function applyInset() {
  const { width, height } = canvasSize; if (!width || !height) return;
  const fw = Math.max(1, width - inset.left - inset.right), fh = Math.max(1, height - inset.top - inset.bottom);
  camera.setViewOffset(fw, fh, -inset.left, -inset.top, width, height);
}
function resize(animate = false) {
  if (!viewReady) return;
  const { width, height } = wrap.getBoundingClientRect();
  if(!width||!height)return;
  const sized = width !== canvasSize.width || height !== canvasSize.height;
  if (sized) {
    canvasSize.width = width; canvasSize.height = height;
    // Up to 2x device pixels, capped so very large windows stay fluid.
    const ratio = Math.max(1, Math.min(devicePixelRatio || 1, highQuality ? 2 : 1.5, Math.sqrt(3.6e6 / (width * height))));
    if (ratio !== canvasSize.ratio) { canvasSize.ratio = ratio; renderer.setPixelRatio(ratio); }
    renderer.setSize(width, height, false); pipeline?.setSize(width, height, ratio);
  }
  const target = freeArea(width, height), from = { ...inset }; cancelAnimationFrame(inset.frame); inset.frame = 0;
  const still = ['left', 'top', 'right', 'bottom'].every(k => Math.abs(target[k] - from[k]) < .5);
  if (still || !animate || sized || matchMedia('(prefers-reduced-motion: reduce)').matches) { Object.assign(inset, target); applyInset(); draw(); return; }
  const t0 = performance.now(), step = now => {
    const k = Math.min(1, (now - t0) / 260), e = 1 - Math.pow(1 - k, 3);
    for (const key of ['left', 'top', 'right', 'bottom']) inset[key] = from[key] + (target[key] - from[key]) * e;
    applyInset(); draw(); inset.frame = k < 1 ? requestAnimationFrame(step) : 0;
  };
  inset.frame = requestAnimationFrame(step);
}
function fit(box, dir, animate = true, tighten = 1) {
  if (!viewReady || !box || box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  const v = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const d = dir ? dir.clone().normalize() : camera.position.clone().sub(controls.target).normalize();
  // Size of the box as seen from the viewing direction.
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0), d); if (right.lengthSq() < 1e-6) right.set(1,0,0); right.normalize();
  const up = new THREE.Vector3().crossVectors(d, right).normalize();
  const extent = a => Math.abs(a.x) * size.x + Math.abs(a.y) * size.y + Math.abs(a.z) * size.z;
  // Part of the free area hidden by the selection bar: frame above it.
  const bar = $('#selection-bar'), free = Math.max(1, canvasSize.height - inset.top - inset.bottom);
  const covered = bar && !bar.hidden && bar.getClientRects().length ? Math.min(.45, Math.max(0, (wrap.getBoundingClientRect().bottom - inset.bottom - bar.getBoundingClientRect().top + 10) / free)) : 0;
  const distance = Math.max(.12, (Math.max(extent(up) / (2 * v * (1 - covered)), extent(right) / (2 * v * camera.aspect)) * 1.14 + extent(d) / 2) * tighten);
  center.addScaledVector(up, -covered * v * distance);
  const position = center.clone().add(d.multiplyScalar(distance));
  if (animate && flight) flight.to(center, position);
  else { flight?.cancel(); controls.target.copy(center); camera.position.copy(position); controls.update(); draw(); }
}
function currentBox(ids) {
  const b = new THREE.Box3();
  for (const id of ids) entries.get(id)?.meshes.forEach(m => { if (m.visible) expandByMesh(b, m); });
  return b;
}
/** Current extent of a mesh, also when the movement panel has deformed it in the vertex shader. */
function expandByMesh(box, mesh) { return lab.binder ? lab.binder.expandBox(mesh, box) : box.expandByObject(mesh); }
function highlightMaterials(mesh) {
  return mesh.userData.highlight ||= mesh.userData.base.map(base => {
    const hi = base.clone(); hi.userData = {...base.userData}; tissueMaterials.add(hi);
    // The selection keeps the natural colour of the tissue: a slight lift in brightness plus the
    // outline drawn by the render pipeline mark it without hiding its shape.
    const own = base.userData.color || base.color;
    hi.color.copy(own).offsetHSL(0, .06, .05); hi.emissive.copy(own); hi.emissiveIntensity = .16;
    return hi;
  });
}
function refresh(updateList=true) {
  const lengthMode = lab.lengths && lab.rig;
  for (const e of entries.values()) {
    const shown = !hidden.has(e.id), inFocus = !isolated || isolated.has(e.id), isSelected = e.id === selected;
    for (const mesh of e.meshes) {
      const mats = isSelected ? highlightMaterials(mesh) : mesh.userData.base;
      let anyVisible = false;
      for (const mat of mats) {
        const layer = mat.userData.layer, on = active.has(layer);
        // A selected structure is always drawn solid, even inside a translucent layer.
        applyMaterialOpacity(mat, isSelected && on ? 1 : layerOpacity[layer], on);
        anyVisible ||= mat.visible;
      }
      mesh.layers.set(LAYER.TISSUE);
      if (!shown || !anyVisible) { mesh.visible = false; continue; }
      if (inFocus) { mesh.material = mesh.userData.wasArray ? mats : mats[0]; mesh.visible = true; if (isSelected) mesh.layers.enable(LAYER.OUTLINE); }
      // The context is drawn in its own pass, before the structures in focus: it never veils them.
      else if (showContext) { mesh.material = ghostMaterial; mesh.visible = true; mesh.layers.set(LAYER.GHOST); }
      else mesh.visible = false;
    }
  }
  if (groundShadow) groundShadow.visible = !isolated;
  applyPose();
  if (lengthMode || lab.lengthsDirty) updateLengthColors();
  draw(); if(updateList)renderList(); syncSelectionButtons();
}
function syncSelectionButtons() {
  const canAct = viewReady && !!entries.get(selected)?.meshes.length;
  $('#undo-peel').disabled = !peeled.length;
  ['#focus', '#isolate', '#isolate-zone', '#hide'].forEach(s => $(s).disabled = !canAct);
  const own = !!isolated && isolated.size === 1 && isolated.has(selected);
  $('#isolate').textContent = own ? 'Mostra tutto' : 'Isola';
  $('#isolation-status').hidden = !isolated;
  $('#isolation-label').textContent = isolated ? isolationLabel : '';
  $('#context').setAttribute('aria-pressed', String(showContext));
}
function setIsolation(ids, text = '') {
  isolated = ids && ids.size ? ids : null; isolationLabel = isolated ? text : '';
  if (!isolated && lab.focus) { lab.focus = false; $('#motion-focus').checked = false; }
}
function renderList() {
  if($('#catalog').hidden)return;
  const options = { query: $('#search').value.trim(), region: $('#region').value, onlyCards: $('#only-cards').checked };
  $('#isolate-region').hidden = !options.region;
  const filtered = searchCatalog(entries.values(),options,getCard,label,
    e=>dictionary[cleanName(e.name).toLowerCase()]||[],e=>lexicon[cleanName(e.name)]?.la||'');
  $('#result-count').textContent = filtered.length;
  const list = $('#results'); list.replaceChildren();
  if (!filtered.length) {
    list.append(node('p', 'Nessun risultato. Cambia ricerca o azzera i filtri.', 'no-results'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const e of filtered) {
    const card = getCard(e), b = node('button', '', 'result' + (e.id === selected ? ' selected' : '') + (hidden.has(e.id) ? ' hidden-structure' : ''));
    b.setAttribute('aria-label', label(e) + ', ' + side(e.name) + (card?.models.length > 1 ? ', ' + cleanName(e.name) : ''));
    b.setAttribute('aria-pressed', String(e.id === selected));
    const name = node('span', label(e));
    if (card) name.append(node('em', card.region + ' · Scheda' + (card.models.length > 1 ? ' di insieme' : '')));
    b.append(node('i', '', 'dot ' + sysClasses[e.sys]), name, node('small', e.name.endsWith('.l') ? 'SX' : e.name.endsWith('.r') ? 'DX' : ''));
    b.onclick = () => {
      chooseSearchResult(e);
    };
    frag.append(b);
  }
  list.append(frag);
}
function chooseSearchResult(e){
  // Keep the current isolation only when the chosen structure already belongs to it.
  if(isolated&&!isolated.has(e.id))setIsolation(null);
  hidden.delete(e.id);
  const layer=searchLayer(e);if(layer){active.add(layer);if(!layerOpacity[layer])layerOpacity[layer]=1;}
  syncSystems();select(e.id);setPanel(null);
  $('#view-title').textContent=label(e);
  if(viewReady)fitEntry(e.id);
}
function renderCard(e) {
  const panel = $('#muscle-card'), card = getCard(e); panel.replaceChildren();
  if (!card) {
    const box = node('div', '', 'unavailable-card');
    box.append(node('h3', e.sys === 'muscular' ? 'Scheda non disponibile per questa struttura' : 'Struttura non muscolare'));
    box.append(node('p', 'Dati di origine, inserzione, azione e innervazione non disponibili.'));
    panel.append(box); return;
  }
  const status = node('div', '', 'card-status');
  status.append(node('span', 'SCHEDA ANATOMICA'), node('span', card.region, 'card-region')); panel.append(status);
  if (card.models.length > 1) {
    panel.append(node('p', 'Scheda di gruppo · selezione: ' + cleanName(e.name), 'group-note'));
    const group = node('details', '', 'group-parts'); group.append(node('summary', 'Porzioni incluse nella scheda (' + card.models.length + ')'));
    for (const name of card.models) {
      const baseName = cleanName(e.name), sameSide = e.name.endsWith('.l') ? '.l' : e.name.endsWith('.r') ? '.r' : '';
      const candidate = [...entries.values()].find(x => x.sys === 'muscular' && x.name === name + sameSide) || [...entries.values()].find(x => x.sys === 'muscular' && cleanName(x.name) === cleanName(name));
      const b = node('button', cleanName(name) + (cleanName(name) === baseName ? ' · selezionata' : ''));
      b.disabled = !candidate || candidate.id === selected;
      b.onclick = () => chooseSearchResult(candidate);
      group.append(b);
    }
    panel.append(group);
  }
  for (const [key, title] of [['origin','ORIGINE'], ['insertion','INSERZIONE'], ['actions','AZIONI E FUNZIONE'], ['innervation','INNERVAZIONE']]) {
    const section = node('section', '', 'anatomy-field' + (key === 'actions' ? ' action' : ''));
    section.append(node('h3', title), node('p', card[key])); panel.append(section);
  }
  // Joints of the 3D movement panel in which this muscle is a prime mover.
  const moves = [];
  for (const joint of JOINTS) for (const c of joint.controls) {
    if (c.up.includes(card.id)) moves.push([joint, c, c.pos]);
    if (c.down.includes(card.id)) moves.push([joint, c, c.neg]);
  }
  if (moves.length) {
    const box = node('div', '', 'card-moves'); box.append(node('h3', 'PROVA IN MOVIMENTO 3D'));
    for (const [joint, c, name] of moves) {
      const b = node('button', name + ' · ' + joint.name);
      b.onclick = () => openMotion(joint.id, c.id, e.name.endsWith('.l') ? 'l' : 'r');
      box.append(b);
    }
    panel.append(box);
  }
  const sources = node('div', '', 'card-sources');
  const disclosure = node('details'); disclosure.append(node('summary', 'Riferimenti e limiti della scheda'));
  for (const id of card.sourceIds) {
    const source = cardData.sources[id], a = node('a', source.title + ' ↗');
    a.href = source.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; disclosure.append(a);
  }
  disclosure.append(node('p', 'Sintesi didattica in italiano di fatti anatomici, 23 ottobre 2026. Non è una traduzione integrale della fonte. Le azioni dipendono dalla posizione articolare; non sono rappresentate tutte le varianti né tutte le radici spinali. Da sottoporre a revisione specialistica.', 'review-note'));
  sources.append(disclosure); panel.append(sources);
  for (const movement of movements.filter(m => [...m.up, ...m.down].includes(card.id))) {
    const a = node('a', 'Schema 2D · ' + movement.name + ' ↗', 'card-motion-link');
    a.href = './movements.html#' + movement.id; panel.append(a);
  }
}
function select(id) {
  const e = entries.get(id); selected = e ? id : null;
  $('#empty').hidden = !!e; $('#selected').hidden = !e; $('#selection-bar').hidden=!e; document.body.classList.toggle('has-selection',!!e); $('#selection-label').textContent=e?label(e)+' · '+side(e.name):'';
  if (e) {
    $('#selected-name').textContent = label(e);
    $('#selected-latin').textContent = lexicon[cleanName(e.name)]?.la || '';
    $('#selected-original').textContent = e.name; $('#selected-side').textContent = side(e.name);
    $('#selected-system').textContent = sysNames[e.sys];
    renderCard(e);
  }
  refresh(); updateMotionReadout();
  if (lab.rig && !$('#motion-panel').hidden) updateLengthCurve();
}
async function fitEntry(id) {
  const e = entries.get(id); if (!e || !viewReady) return;
  try {
    await load(e.sys); if (selected !== id) return;
    const b = new THREE.Box3(); e.meshes.forEach(m => expandByMesh(b, m)); fit(b);
    $('#view-title').textContent = label(e); syncSelectionButtons();
  } catch (error) { console.error(error); toast('Modello non disponibile. La scheda resta consultabile.'); }
}
function home() {
  fit(allBox, new THREE.Vector3(0,0,1)); $('#view-title').textContent = isolated ? isolationLabel : 'Corpo intero';
  $$('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === 'front'));
}
let dracoType = 'wasm';
function makeLoader(type = 'wasm') {
  dracoType = type;
  const draco = new DRACOLoader(); draco.setDecoderPath('./vendor/three/examples/jsm/libs/draco/gltf/'); draco.setWorkerLimit(2);
  if (type === 'js') draco.setDecoderConfig({ type: 'js' });
  loader = new GLTFLoader(); loader.setDRACOLoader(draco);
}
async function load(sys) {
  if (roots.has(sys) || !viewReady) return;
  if (pending.has(sys)) return pending.get(sys);
  const promise = (async () => {
    let root=await restoreModel(sys),snapshot=null;
    if(!root){
      const progress = evt => { $('#load-text').textContent = sysNames[sys] + ' · ' + (evt.total ? Math.round(evt.loaded / evt.total * 100) + '%' : 'caricamento…'); };
      let gltf;
      try { gltf = await loader.loadAsync('./models/' + sys + '.glb', progress); }
      catch (error) {
        // Some hosts forbid WebAssembly: decode once more with the plain JavaScript decoder.
        if (dracoType === 'js') throw error;
        console.warn('FisioBen: decoder WebAssembly non disponibile, uso il decoder JavaScript', error); makeLoader('js');
        gltf = await loader.loadAsync('./models/' + sys + '.glb', progress);
      }
      root=gltf.scene;snapshot=captureModel(root);
    }
    root.updateMatrixWorld(true);
    const tagged = []; root.traverse(n => { if (n.userData.za_name) tagged.push(n); });
    // Preserve world transforms; structure visibility must not hide nested structures.
    tagged.forEach(n => root.attach(n));
    root.updateMatrixWorld(true);
    const materials = new Map();
    const meshes=[];root.traverse(m=>{if(m.isMesh)meshes.push(m);});
    for(let meshIndex=0;meshIndex<meshes.length;meshIndex++){
      if(meshIndex%32===0)await yieldToUI();
      const m=meshes[meshIndex];
      let owner = m; while (owner && !owner.userData.za_name) owner = owner.parent;
      const name = owner?.userData.za_name; if (!name) continue;
      const id = sys + '::' + name, entry = entries.get(id); if (!entry) continue;
      const originals = Array.isArray(m.material) ? m.material : [m.material];
      m.userData.wasArray = Array.isArray(m.material);
      m.userData.base = originals.map(original => {
        const layer = materialLayer(sys, original.name || (sys==='nervous'?'Nerve':name));
        const key = original.uuid + '::' + layer + (layer==='muscular'?'::'+name:'');
        let base = materials.get(key);
        if (!base) {
          base = original.clone(); base.name = original.name; base.userData = {layer};
          const look = tissueLook[layer] || tissueLook.other;
          base.roughness = look.roughness; base.metalness = 0; base.envMapIntensity = look.envMapIntensity; base.color.set(layerColors[layer]);
          // Small differences reveal borders while keeping the whole musculature red.
          if (layer==='muscular') {
            const hash=[...name.replace(/\.[lr]$/,'')].reduce((h,c)=>(h*31+c.charCodeAt(0))>>>0,0);
            base.color.offsetHSL(((hash%7)-3)*.004,((hash%5)-2)*.012,((hash%9)-4)*.011);
          }
          base.userData.color = base.color.clone();
          materials.set(key,base); tissueMaterials.add(base);
        }
        return base;
      });
      m.userData.id = id; m.material = m.userData.wasArray ? m.userData.base : m.userData.base[0]; picker?.register(m);
      if(!m.geometry.boundingBox)m.geometry.computeBoundingBox(); if(!m.geometry.boundingSphere)m.geometry.computeBoundingSphere(); entry.meshes.push(m);
      // Rest-pose bounds of the structure, used for zones and for the kinematic binding.
      (entry.box ||= new THREE.Box3()).expandByObject(m);
    }
    scene.add(root); roots.set(sys, root); failedModels.delete(sys);
    lab.rebind = true; refresh();
    if(snapshot){
      // Write after the first frame; UI work must not wait for persistent storage.
      const write=new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0))).then(()=>saveModel(sys,snapshot));
      cacheWrites.set(sys,write);write.then(updateCacheLabel);
    }else updateCacheLabel();
  })();
  pending.set(sys, promise);updateLoadStatus();try { await promise; } catch(error){failedModels.add(sys);throw error;} finally { pending.delete(sys);updateLoadStatus(); }
}
function setViewerControls(enabled) {
  $$('.view-controls button, .zoom-controls button').forEach(b => b.disabled = !enabled);
  $$('[data-layer-opacity]').forEach(input=>input.disabled=!enabled); syncSelectionButtons();
}
function showTextMode(error) {
  console.warn('FisioBen: viewer unavailable:', error.message);
  pauseMotion(); $('#open-motion').disabled=true;$('#preload-atlas').disabled=true; $('#limb-availability').textContent='Movimento non disponibile senza vista 3D';
  viewReady = false; $('#loading').hidden = true; $('#viewer-unavailable').hidden = false;
  document.body.classList.add('only-text'); $('.live-badge').replaceChildren(node('i'), document.createTextNode('Catalogo testuale'));
  $('#viewer-error-message').textContent = error.message.includes('WebGL') ? 'Puoi consultare le schede da Cerca.' : 'Caricamento non riuscito. Riprova o apri Cerca.';
  setViewerControls(false); renderList();
}
/** Structure under the pointer. Nearly invisible tissues are not pickable: the tap goes through them. */
function pick(event) {
  const rect = renderer.domElement.getBoundingClientRect(), faint = [];
  for (const m of tissueMaterials) if (m.visible && m.opacity <= .08) { m.visible = false; faint.push(m); }
  try { return picker.pick(scene, camera, event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height); }
  finally { for (const m of faint) m.visible = true; }
}
async function initViewer() {
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = .98;
    wrap.append(renderer.domElement); scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(30, 1, .02, 40);
    camera.position.set(0, .85, 3.7); controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0, .85, 0);
    controls.enableDamping = true; controls.dampingFactor = .09; controls.minDistance = .06; controls.maxDistance = 8;
    controls.rotateSpeed = .85; controls.zoomToCursor = true;
    controls.addEventListener('change', draw);
    createStudio(renderer, scene);
    ghostMaterial = createGhostMaterial();
    groundShadow = createGroundShadow(); scene.add(groundShadow);
    flight = new CameraFlight(camera, controls, draw); picker = new Picker(renderer);
    camera.layers.enableAll();
    try {
      pipeline = new Pipeline(renderer); pipeline.validate();
      // A shader that fails to compile on some GPU must not leave the atlas blank.
      renderer.debug.onShaderError = (gl, program, vs, fs) => { console.warn('FisioBen: shader non supportato, resa standard', gl.getProgramInfoLog(program), gl.getShaderInfoLog(fs) || '', gl.getShaderInfoLog(vs) || ''); if (pipeline) pipeline.ok = false; draw(); };
    } catch (error) { console.warn('FisioBen: resa avanzata non disponibile', error); pipeline = null; }
    makeLoader(); viewReady = true; setViewerControls(true);
    new ResizeObserver(() => resize()).observe(wrap); resize();
    let down, lastTap = 0;
    renderer.domElement.addEventListener('pointerdown', e => { down = {x:e.clientX, y:e.clientY, t:Date.now()}; });
    renderer.domElement.addEventListener('pointerup', e => {
      if (!down || Math.hypot(e.clientX-down.x,e.clientY-down.y)>7 || Date.now()-down.t>700) return;
      down = null;
      const hit = pick(e); if (!hit) return;
      const id = hit.userData.id, again = id === selected && Date.now() - lastTap < 420; lastTap = Date.now();
      if (again) fitEntry(id); else select(id);
    });
    renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); showTextMode(new Error('WebGL interrotto')); });
    await load('muscular');
    allBox=new THREE.Box3().setFromObject(roots.get('muscular'));
    groundShadow.position.set(0, allBox.min.y - .002, .01); groundShadow.scale.set(.74, .46, 1); lab.ground = allBox.min.y;
    fit(allBox, new THREE.Vector3(0,0,1), false);
    $('#loading').hidden=true;initialModelReady=true;
    $('#open-motion').disabled=false;$('#preload-atlas').disabled=false;
    if(selected)fitEntry(selected);
    // Paint the first model before decoding additional requested systems.
    await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,0)));
    requestLayers();

  } catch (error) { showTextMode(error); }
}
async function init() {
  setViewerControls(false);
  try {
    const data = await Promise.all(['synonyms.it', 'lexicon', 'muscle-cards', 'catalog'].map(name => fetch('./data/' + name + '.json?v=4').then(r => {
      if (!r.ok) throw new Error('Catalogo non disponibile'); return r.json();
    })));
    [dictionary, lexicon, cardData] = data; cardIndex = createCardIndex(cardData);
    data[3].forEach(e => entries.set(e.id, { ...e, meshes: [] }));
    const regions = [...new Set(cardData.cards.map(c => c.region))].sort((a,b)=>a.localeCompare(b,'it'));
    for (const region of regions) { const o = node('option', region); o.value = region; $('#region').append(o); }
    $('#coverage').textContent = cardData.meta.cardCount + ' schede · ' + cardData.meta.matchedStructureCount + ' strutture collegate (lati inclusi)';
    renderLayerControls(); $('#structure-total').textContent=entries.size+' strutture · 4 modelli anatomici';
    buildMotionPanel();
    renderList(); selectLinkedCard(); await initViewer();
  } catch (error) {
    console.error(error);
    $('#loading').hidden = false; $('#loading').replaceChildren(node('strong', 'Impossibile caricare il catalogo'), node('small', 'Verifica la connessione e ricarica la pagina.'));
    const b = node('button','Riprova','error-button'); b.onclick=()=>location.reload(); $('#loading').append(b);
  }
}
function selectLinkedCard() {
  const cardId = new URLSearchParams(location.hash.slice(1)).get('muscle');
  if (!cardId) return;
  const entry = [...entries.values()].find(e => getCard(e)?.id === cardId);
  if (entry) { chooseSearchResult(entry);
    setPanel('detail-panel');
  }
}
window.addEventListener('hashchange',selectLinkedCard);
function syncSystems() {
  $$('[data-layer-toggle]').forEach(input => input.checked=active.has(input.dataset.layerToggle));
  $$('[data-layer-opacity]').forEach(input=>{input.value=Math.round(layerOpacity[input.dataset.layerOpacity]*100); $('#opacity-'+input.dataset.layerOpacity).value=input.value+'%';});
}
function renderLayerControls() {
  const container=$('#layers'); container.replaceChildren();
  for(const [layer,title] of Object.entries(layerNames)) {
    const row=node('div','','layer-row'), labelEl=node('label'), input=node('input');
    input.type='checkbox';input.dataset.layerToggle=layer;input.checked=active.has(layer);
    const dot=node('i','','dot');dot.style.background=layerColors[layer];
    labelEl.append(input,dot,document.createTextNode(title));
    const count=[...entries.values()].filter(e=>e.layers.includes(layer)).length;
    labelEl.append(node('small',String(count)));row.append(labelEl);
    const range=node('input');range.type='range';range.min=0;range.max=100;range.step=1;
    range.dataset.layerOpacity=layer;range.value=layerOpacity[layer]*100;
    range.setAttribute('aria-label','Opacità '+title.toLowerCase());range.disabled=!viewReady;
    const out=node('output',range.value+'%');out.id='opacity-'+layer;
    input.onchange=()=>{
      if(input.checked){active.add(layer);if(!layerOpacity[layer])layerOpacity[layer]=1;}else active.delete(layer);
      syncSystems();refresh();requestLayers();
    };
    range.oninput=()=>{const was=active.has(layer);layerOpacity[layer]=Number(range.value)/100;if(layerOpacity[layer]>0)active.add(layer);else active.delete(layer);syncSystems();refresh(was!==active.has(layer));requestLayers();};
    row.append(range,out);container.append(row);
  }
}
function applyPreset(name) {
  const settings=presets[name];if(!settings)return;
  $('#search').value='';$('#region').value='';$('#only-cards').checked=false;
  active.clear();for(const [layer,value] of Object.entries(settings)){layerOpacity[layer]=value;if(value>0)active.add(layer);}
  hidden.clear();peeled=[];setIsolation(null);select(null);syncSystems();
  $$('[data-preset]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.preset===name)));
  requestLayers();

}
$$('[data-preset]').forEach(b=>b.onclick=()=>applyPreset(b.dataset.preset));
$('#search').oninput=renderList; $('#region').onchange=renderList; $('#only-cards').onchange=renderList;
$('#reset-filters').onclick=()=>{ $('#search').value=''; $('#region').value=''; $('#only-cards').checked=false; renderList(); };
function findRegion(region) { $('#region').value=region; $('#only-cards').checked=true; $('#search').value=''; active.add('muscular'); layerOpacity.muscular=1; syncSystems(); refresh(); setPanel('catalog'); }
$$('[data-region]').forEach(b=>b.onclick=()=>findRegion(b.dataset.region));
$$('[data-query]').forEach(b=>b.onclick=()=>{ $('#search').value=b.dataset.query; $('#region').value=''; active.add('muscular'); layerOpacity.muscular=1; syncSystems(); refresh(); setPanel('catalog'); $('#search').focus({preventScroll:true}); });

/* ---------- Isolation of a structure or of a whole zone ---------- */
function isolateZone(region, suffix) {
  const ids = regionMembers(entries.values(), getCard, region, suffix);
  if (!ids || !ids.size) { toast('Zona non disponibile nel modello caricato.'); return false; }
  const text = 'Zona · ' + region + (suffix === '.r' ? ' destra' : suffix === '.l' ? ' sinistra' : '');
  setIsolation(ids, text); refresh();
  const box = currentBox(ids); if (!box.isEmpty()) fit(box);
  $('#view-title').textContent = text; return true;
}
$('#focus').onclick=()=>fitEntry(selected);
$('#isolate').onclick=()=>{
  if(!selected)return;
  const own=!!isolated&&isolated.size===1&&isolated.has(selected);
  if(own){setIsolation(null);refresh();home();return;}
  setIsolation(new Set([selected]),label(entries.get(selected)));refresh();fitEntry(selected);
};
$('#isolate-zone').onclick=()=>{
  const e=entries.get(selected);if(!e)return;
  const suffix=/\.[lr]$/.test(e.name)?e.name.slice(-2):null;
  const region=regionOf(e,entries.values(),getCard,suffix);
  if(!region){toast('Zona non determinabile per questa struttura.');return;}
  isolateZone(region,suffix);
};
$('#isolate-region').onclick=()=>{const region=$('#region').value;if(!region)return;active.add('muscular');if(!layerOpacity.muscular)layerOpacity.muscular=1;syncSystems();if(isolateZone(region,null))setPanel(null);};
$('#context').onclick=()=>{showContext=!showContext;refresh(false);};
$('#show-all').onclick=()=>{setIsolation(null);refresh();home();};
$('#hide').onclick=()=>{if(!selected)return;hidden.add(selected);peeled.push(selected);if(isolated?.has(selected)&&isolated.size===1)setIsolation(null);select(null);toast('Struttura rimossa dalla vista · Annulla per ripristinarla');};
$('#undo-peel').onclick=()=>{const id=peeled.pop();if(id){hidden.delete(id);refresh();toast('Ultima struttura ripristinata');}};
$('#clear').onclick=()=>{if(isolated&&isolated.size===1&&isolated.has(selected))setIsolation(null);select(null);};
$('#restore').onclick=()=>{resetMotion();applyPreset('muscles');$('#search').value='';$('#region').value='';$('#only-cards').checked=false;select(null);home();toast('Vista muscolare ripristinata');};
$('#home').onclick=home; $('#retry-view').onclick=()=>location.reload();
for(const [selector,factor] of [['#zoom-in',.8],['#zoom-out',1.25]])$(selector).onclick=()=>{if(!viewReady)return;const d=camera.position.clone().sub(controls.target);d.setLength(THREE.MathUtils.clamp(d.length()*factor,controls.minDistance,controls.maxDistance));flight.to(controls.target.clone(),controls.target.clone().add(d),220);};
$$('[data-view]').forEach(b=>b.onclick=()=>{if(!viewReady)return;const distance=camera.position.distanceTo(controls.target),dirs={front:[0,0,1],back:[0,0,-1],side:[1,0,0]};flight.to(controls.target.clone(),controls.target.clone().add(new THREE.Vector3(...dirs[b.dataset.view]).multiplyScalar(distance)),600);$$('[data-view]').forEach(x=>x.classList.toggle('active',x===b));});
$('#quality').onclick=()=>{highQuality=!highQuality;$('#quality').textContent='Qualità grafica: '+(highQuality?'alta':'standard');resize();draw();};

/* ---------- 3D movement: articulated skeleton, coupled joints, soft tissues ---------- */
const lab = { rig: null, binder: null, preparing: null, state: {}, joint: 'knee', gesture: null, side: 'r', control: null, playing: false, speed: 1,
  phase: 0, frame: 0, last: 0, axes: true, lengths: false, lengthsDirty: false, focus: false, offsets: {}, moved: new Set(), rebind: false, info: {}, helpers: null, direction: {},
  memo: {}, chart: null, ground: 0 };
const AXIS_COLORS = ['#e5484d', '#2f9e44', '#3b6fd9'];
const fmt = v => Math.round(v) + '°';
const sides = () => lab.side === 'both' ? ['r', 'l'] : [lab.side];
const currentJoint = () => JOINTS.find(j => j.id === lab.joint);
const stateKey = (joint, s, control) => joint.id + (joint.sided ? '.' + s : '') + '.' + control.id;
const offsetOf = key => lab.offsets[key] || 0;

function buildMotionPanel() {
  const select = $('#motion-joint');
  const g1 = node('optgroup'); g1.label = 'Articolazioni';
  for (const j of JOINTS) { const o = node('option', j.name); o.value = j.id; g1.append(o); }
  const g2 = node('optgroup'); g2.label = 'Gesti funzionali';
  for (const g of GESTURES) { const o = node('option', g.name); o.value = 'gesture:' + g.id; g2.append(o); }
  select.append(g1, g2); select.value = lab.joint;
  select.onchange = () => { const v = select.value; pauseMotion(); if (v.startsWith('gesture:')) setGesture(v.slice(8)); else setJoint(v); };
  $$('#motion-side button').forEach(b => b.onclick = () => { lab.side = b.dataset.side; pauseMotion(); renderMotionControls(); updateFocus(); frameJoint(); poseLab(); });
  $('#motion-play').onclick = () => lab.playing ? pauseMotion() : playMotion();
  $('#motion-reset').onclick = () => { resetMotion(); renderMotionControls(); };
  $('#motion-speed').onchange = e => { lab.speed = Number(e.target.value) || 1; };
  $('#motion-axes').onchange = e => { lab.axes = e.target.checked; updateHelpers(); draw(); };
  $('#motion-lengths').onchange = e => { lab.lengths = e.target.checked; lab.lengthsDirty = true; $('#motion-legend').hidden = !lab.lengths; refresh(false); updateMotionReadout(); };
  $('#motion-focus').onchange = e => { lab.focus = e.target.checked; updateFocus(); if (lab.focus) frameJoint(); };
  renderMotionControls();
}
function setJoint(id) {
  lab.gesture = null; lab.joint = id; lab.control = null; lab.phase = 0; lab.chart = null;
  renderMotionControls(); updateFocus(); frameJoint(); poseLab();
}
function setGesture(id) {
  lab.gesture = GESTURES.find(g => g.id === id); lab.phase = 0; lab.state = {}; lab.memo = {}; lab.chart = null;
  if (lab.focus) { lab.focus = false; $('#motion-focus').checked = false; setIsolation(null); refresh(); }
  renderMotionControls(); $('#view-title').textContent = lab.gesture.name;
  if (lab.rig) {
    // Curves of the whole cycle for the chart, and the space swept by the body for the framing.
    lab.chart = { kind: 'gesture', curves: gestureCurves(lab.rig, lab.gesture, lab.offsets), x: [0, 1], marks: lab.gesture.marks || [] };
    const box = new THREE.Box3(), part = new THREE.Box3();
    for (const t of [0, .2, .35, .5, .65, .8]) {
      solveGesture(lab.rig, lab.gesture, t, lab.offsets, {});
      for (const seg of lab.rig.order) { const b = lab.binder.segBox.get(seg.id); if (!b.isEmpty()) box.union(part.copy(b).applyMatrix4(seg.delta)); }
    }
    lab.memo = {}; renderChartLegend(); poseLab();
    if (viewReady && !box.isEmpty()) fit(box.expandByScalar(.02), new THREE.Vector3(...lab.gesture.view), true, .88);
  }
}
function renderMotionControls() {
  const box = $('#motion-controls'); box.replaceChildren();
  const joint = currentJoint(), gesture = lab.gesture;
  $('#motion-side').hidden = !!gesture || !joint.sided;
  $$('#motion-side button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.side === lab.side)));
  $('#motion-note').textContent = gesture ? gesture.note : joint.note;
  $('#motion-focus').closest('label').hidden = !!gesture;
  if (gesture) {
    const row = node('div', '', 'motion-control'), head = node('div', '', 'motion-control-head');
    const out = node('output', Math.round(lab.phase * 100) + '%'); out.id = 'motion-phase-out';
    head.append(node('span', 'Fase del gesto'), out);
    const range = node('input'); range.type = 'range'; range.min = 0; range.max = 100; range.step = 1; range.value = Math.round(lab.phase * 100); range.id = 'motion-phase';
    range.setAttribute('aria-label', 'Fase del gesto ' + gesture.name);
    range.oninput = () => { pauseMotion(); lab.phase = Number(range.value) / 100; out.value = range.value + '%'; poseLab(); };
    row.append(head, range); box.append(row); renderMuscleChips(); renderChartLegend(); return;
  }
  if (!lab.control || !joint.controls.some(c => c.id === lab.control)) lab.control = joint.controls[0].id;
  joint.controls.forEach((control, index) => {
    const s = sides()[0], key = stateKey(joint, s, control), offset = offsetOf(key);
    const row = node('div', '', 'motion-control'), head = node('div', '', 'motion-control-head'), name = node('label');
    const radio = node('input'); radio.type = 'radio'; radio.name = 'motion-active'; radio.value = control.id; radio.checked = control.id === lab.control;
    radio.title = 'Movimento animato da Avvia'; radio.onchange = () => { lab.control = control.id; pauseMotion(); renderMuscleChips(); updateLengthCurve(); updateHelpers(); draw(); };
    const swatch = node('i', '', 'axis-dot'); swatch.style.background = AXIS_COLORS[index % 3];
    name.append(radio, swatch, document.createTextNode(control.pos + ' / ' + control.neg));
    const out = node('output'); out.dataset.out = control.id;
    head.append(name, out);
    const range = node('input'); range.type = 'range'; range.min = control.min; range.max = control.max; range.step = 1; range.dataset.control = control.id;
    range.value = Math.round((lab.state[key] || 0) + offset);
    range.setAttribute('aria-label', joint.name + ': ' + control.pos + ' e ' + control.neg);
    range.oninput = () => { pauseMotion(); if (lab.control !== control.id) { lab.control = control.id; radio.checked = true; updateLengthCurve(); } setControl(control, Number(range.value)); };
    const zero = control.zero || 0, scale = node('div', '', 'motion-scale');
    scale.append(node('span', control.neg + ' ' + Math.abs(control.min - zero) + '°'), node('span', control.pos + ' ' + Math.abs(control.max - zero) + '°'));
    row.append(head, range, scale); box.append(row);
  });
  syncMotionOutputs(); renderMuscleChips(); updateLengthCurve();
}
function controlText(control, anatomical) {
  const v = Math.round(anatomical - (control.zero || 0));
  return v === 0 ? '0°' : (v > 0 ? control.pos : control.neg) + ' ' + Math.abs(v) + '°';
}
function syncMotionOutputs() {
  if (lab.gesture) { const r = $('#motion-phase'); if (r) { r.value = Math.round(lab.phase * 100); $('#motion-phase-out').value = r.value + '%'; } return; }
  const joint = currentJoint(), s = sides()[0];
  for (const control of joint.controls) {
    const key = stateKey(joint, s, control), value = (lab.state[key] || 0) + offsetOf(key);
    const out = $('[data-out="' + control.id + '"]'), range = $('[data-control="' + control.id + '"]');
    if (out) out.value = controlText(control, value); if (range && document.activeElement !== range) range.value = Math.round(value);
  }
}
function setControl(control, anatomical) {
  const joint = currentJoint(), firstKey = stateKey(joint, joint.sided ? sides()[0] : '', control);
  const previous = lab.direction[control.id + ':v'] ?? (lab.state[firstKey] || 0) + offsetOf(firstKey);
  for (const s of joint.sided ? sides() : ['']) { const key = stateKey(joint, s, control); lab.state[key] = anatomical - offsetOf(key); }
  // Which muscle group produces the motion depends on its direction.
  if (anatomical !== previous) { const dir = anatomical > previous ? 'up' : 'down'; if (lab.direction[control.id] !== dir) { lab.direction[control.id] = dir; renderMuscleChips(); } }
  lab.direction[control.id + ':v'] = anatomical;
  poseLab();
}
function renderMuscleChips() {
  const box = $('#motion-muscles'); box.replaceChildren();
  if (lab.gesture) return;
  const joint = currentJoint(), control = joint.controls.find(c => c.id === lab.control); if (!control) return;
  const dir = lab.direction[control.id] || 'up', ids = control[dir].length ? control[dir] : control.up;
  if (!ids.length) return;
  const sideWord = dir === 'up' || !control.down.length ? control.pos : control.neg;
  box.append(node('span', 'Motori principali · ' + sideWord.toLowerCase(), 'chips-title'));
  const s = sides()[0], lateral = !control.down.length && joint.sided === false;
  for (const id of ids) {
    const card = cardData?.cards.find(c => c.id === id); if (!card) continue;
    const b = node('button', card.name, 'chip');
    b.onclick = () => {
      // Midline joints with left/right motions: the mover lies on the side of the motion.
      const want = lateral ? (dir === 'up' ? '.r' : '.l') : '.' + s;
      const all = [...entries.values()].filter(e => getCard(e)?.id === id);
      const e = all.find(x => x.name.endsWith(want)) || all[0];
      if (!e) return; hidden.delete(e.id); const layer = searchLayer(e); if (layer) { active.add(layer); if (!layerOpacity[layer]) layerOpacity[layer] = 1; }
      if (isolated && !isolated.has(e.id)) setIsolation(null);
      syncSystems(); select(e.id);
    };
    box.append(b);
  }
}
async function ensureLab() {
  if (lab.rig) return true;
  if (!viewReady) return false;
  if (!lab.preparing) lab.preparing = (async () => {
    $('#motion-loading').hidden = false; $('#motion-body').classList.add('is-loading');
    try {
      const t0 = performance.now();
      for (const sys of ['muscular', 'skeletal', 'joints']) await load(sys);
      await nextFrame(); const t1 = performance.now();
      lab.rig = new SkeletonRig(entries); lab.binder = new SkinBinder(lab.rig, entries, { gpu: renderer.capabilities.isWebGL2 }); lab.offsets = restOffsets(lab.rig);
      buildHelpers(); renderMotionControls(); lab.timing = { models: Math.round(t1 - t0), rig: Math.round(performance.now() - t1) }; return true;
    } catch (error) { console.error(error); toast('Impossibile preparare il movimento. Riprova.'); return false; }
    finally { $('#motion-loading').hidden = true; $('#motion-body').classList.remove('is-loading'); lab.preparing = null; }
  })();
  return lab.preparing;
}
async function openMotion(jointId, controlId, s) {
  setPanel('motion-panel');
  if (!await ensureLab()) return;
  lab.gesture = null; lab.joint = jointId; lab.control = controlId; if (s && currentJoint().sided) lab.side = s;
  $('#motion-joint').value = jointId; renderMotionControls(); updateFocus(); frameJoint(); poseLab();
}
function poseLab() {
  if (!lab.rig) return;
  if (lab.gesture) { const solved = solveGesture(lab.rig, lab.gesture, lab.phase, lab.offsets, lab.memo); lab.info = solved.info; lab.shown = solved.state; }
  else { const { q, info } = resolvePose(lab.state, lab.offsets); lab.info = info; lab.shown = lab.state; lab.rig.setRoot().solve(q); }
  let grew = false;
  for (const seg of lab.rig.order) if (seg.version > 0 && !lab.moved.has(seg.id)) { lab.moved.add(seg.id); grew = true; }
  if (grew || lab.rebind) { lab.binder.prepare([...lab.moved]); lab.rebind = false; }
  applyPose(); updateHelpers();
  if (lab.lengths) updateLengthColors();
  syncMotionOutputs(); updateMotionReadout(); updateChart(); draw();
}
/* Charts: joint angles over the cycle of a gesture, or estimated length of the selected muscle over the range of a joint. */
function renderChartLegend() {
  const box = $('#motion-chart-legend'); box.replaceChildren();
  if (!lab.chart) return;
  lab.chart.curves.forEach((c, i) => { const item = node('span'), dot = node('i'); dot.style.background = c.color || SERIES_COLORS[i % SERIES_COLORS.length]; const value = node('b'); value.dataset.series = i; item.append(dot, document.createTextNode(c.label + ' '), value); box.append(item); });
}
function updateChart() {
  const wrapEl = $('#motion-chart-box'), chart = lab.chart, show = !!chart && !!lab.rig && !$('#motion-panel').hidden;
  wrapEl.hidden = !show; if (!show) return;
  let cursor = lab.phase;
  if (chart.kind === 'length') { const joint = currentJoint(), c = joint.controls.find(x => x.id === chart.control), key = stateKey(joint, joint.sided ? sides()[0] : '', c); cursor = (lab.state[key] || 0) + offsetOf(key); }
  $('#motion-chart-title').textContent = chart.kind === 'length' ? 'Lunghezza stimata · ' + chart.title : 'Angoli nel ciclo · lato destro';
  drawChart($('#motion-chart'), { curves: chart.curves, x: chart.x, cursor, marks: chart.marks || [], format: chart.format, xFormat: chart.xFormat, zero: true });
  $$('#motion-chart-legend [data-series]').forEach(el => { const c = chart.curves[Number(el.dataset.series)]; el.textContent = (chart.format || fmt)(curveAt(c.values, cursor, chart.x)); });
}
/** Estimated length of the selected muscle along the range of the active control of the joint. */
function updateLengthCurve() {
  if (lab.gesture || !lab.rig) return;
  const e = entries.get(selected), joint = currentJoint(), control = joint.controls.find(c => c.id === lab.control);
  const was = lab.chart; lab.chart = null;
  if (e && e.sys === 'muscular' && e.meshes.length && control && getCard(e)) {
    // The muscle must be bound to the skeleton even if this joint has not moved it yet.
    for (const mesh of e.meshes) lab.binder.record(mesh, e);
    const samples = 28, values = [], state = { ...lab.state }, list = joint.sided ? sides() : [''];
    for (let i = 0; i <= samples; i++) {
      const angle = control.min + (control.max - control.min) * i / samples;
      for (const s of list) { const key = stateKey(joint, s, control); state[key] = angle - offsetOf(key); }
      lab.rig.setRoot().solve(resolvePose(state, lab.offsets).q);
      values.push(((lab.binder.lengthRatio(e) ?? 1) - 1) * 100);
    }
    const zero = control.zero || 0;
    lab.chart = { kind: 'length', control: control.id, title: label(e), curves: [{ label: 'Variazione', values, color: '#b4233c' }], x: [control.min, control.max],
      format: v => (v > 0 ? '+' : '') + (Math.abs(v) < 9.95 ? v.toFixed(1).replace('.', ',') : Math.round(v)) + '%', xFormat: v => Math.round(v - zero) + '°' };
    // Back to the pose on screen.
    lab.rig.setRoot().solve(resolvePose(lab.state, lab.offsets).q);
  }
  if (lab.chart || was) { renderChartLegend(); updateChart(); }
}
/** Push the current skeleton pose to the meshes that are on screen. */
function applyPose() {
  if (!lab.rig || !lab.moved.size) return;
  if (lab.rebind) { lab.binder.prepare([...lab.moved]); lab.rebind = false; }
  lab.binder.apply(mesh => mesh.visible);
}
function resetMotion() {
  pauseMotion(); lab.state = {}; lab.phase = 0; lab.direction = {}; lab.memo = {};
  if (lab.gesture) { lab.gesture = null; lab.chart = null; $('#motion-joint').value = lab.joint; }
  if (lab.focus) { lab.focus = false; $('#motion-focus').checked = false; setIsolation(null); refresh(); }
  poseLab(); if (lab.rig) renderMotionControls();
}
function pauseMotion() {
  lab.playing = false; cancelAnimationFrame(lab.frame); lab.frame = 0;
  $('#motion-play').textContent = '▶ Avvia'; $('#motion-play').setAttribute('aria-pressed', 'false');
}
function playMotion() {
  if (!lab.rig || lab.playing) return;
  lab.playing = true; lab.last = 0;
  $('#motion-play').textContent = 'Ⅱ Pausa'; $('#motion-play').setAttribute('aria-pressed', 'true');
  const joint = currentJoint(), control = joint.controls.find(c => c.id === lab.control);
  let span = 1, cycle = lab.gesture ? lab.gesture.duration : 4;
  if (!lab.gesture) {
    // Resume the sweep from the current angle instead of jumping to one end of the range.
    const key = stateKey(joint, sides()[0], control), value = (lab.state[key] || 0) + offsetOf(key);
    span = control.max - control.min; cycle = Math.max(2.6, Math.min(7, span / 40));
    const rising = lab.direction[control.id] !== 'down', k = Math.acos(1 - 2 * Math.max(0, Math.min(1, (value - control.min) / span))) / (2 * Math.PI);
    lab.phase = rising ? k : 1 - k;
  }
  const step = now => {
    if (!lab.playing) return;
    const dt = lab.last ? Math.min(.1, (now - lab.last) / 1000) : 0; lab.last = now;
    lab.phase = (lab.phase + dt * lab.speed / cycle) % 1;
    if (lab.gesture) poseLab();
    else setControl(control, control.min + span * (1 - Math.cos(lab.phase * 2 * Math.PI)) / 2);
    lab.frame = requestAnimationFrame(step);
  };
  lab.frame = requestAnimationFrame(step);
}
function updateFocus() {
  if (!lab.focus || !lab.rig || lab.gesture) return;
  const joint = currentJoint(), segs = (joint.sided ? sides() : ['']).flatMap(s => jointSegments(joint.id, s));
  // Structures of the joint region: everything attached to its segments.
  setIsolation(lab.binder.structuresOf(segs), 'Regione · ' + joint.name); lab.focus = true; $('#motion-focus').checked = true;
  $('#view-title').textContent = 'Regione · ' + joint.name; refresh();
}
function frameJoint() {
  if (!lab.rig || !viewReady || lab.gesture) return;
  const joint = currentJoint(), box = new THREE.Box3();
  for (const s of joint.sided ? sides() : ['']) for (const id of jointSegments(joint.id, s)) box.union(lab.binder.segBox.get(id));
  if (box.isEmpty()) return;
  box.expandByScalar(joint.sided ? .09 : .14);
  const dir = new THREE.Vector3(...joint.view); if (joint.sided && lab.side === 'l') dir.x *= -1; if (joint.sided && lab.side === 'both') dir.set(0, .15, 1);
  fit(box, dir);
  if (!lab.focus) $('#view-title').textContent = joint.name + (joint.sided ? ' · ' + ({ r: 'destra', l: 'sinistra', both: 'entrambi i lati' })[lab.side] : '');
}
function buildHelpers() {
  const group = lab.helpers = new THREE.Group(); group.renderOrder = 20; scene.add(group);
  group.userData.lines = [];
  for (let i = 0; i < 6; i++) {
    const mat = new THREE.LineBasicMaterial({ color: AXIS_COLORS[i % 3], depthTest: false, transparent: true, opacity: .95 });
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), mat);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(.0045, 12, 8), new THREE.MeshBasicMaterial({ color: AXIS_COLORS[i % 3], depthTest: false, transparent: true }));
    line.frustumCulled = dot.frustumCulled = false; line.renderOrder = dot.renderOrder = 20; line.raycast = dot.raycast = () => {};
    line.layers.set(LAYER.OVERLAY); dot.layers.set(LAYER.OVERLAY);
    group.add(line, dot); group.userData.lines.push({ line, dot });
  }
}
function updateHelpers() {
  if (!lab.helpers) return;
  const items = lab.helpers.userData.lines, joint = currentJoint(); let n = 0;
  if (lab.axes && !lab.gesture && !$('#motion-panel').hidden) {
    const pivot = new THREE.Vector3(), axis = new THREE.Vector3();
    for (const s of joint.sided ? sides() : ['']) joint.controls.forEach((control, index) => {
      if (n >= items.length) return;
      const id = dofFor(joint.id, control.id, s), { line, dot } = items[n++];
      lab.rig.pivotWorld(id, pivot); lab.rig.axisWorld(id, axis);
      const half = joint.sided ? .075 : .1, p = line.geometry.attributes.position;
      p.setXYZ(0, pivot.x - axis.x * half, pivot.y - axis.y * half, pivot.z - axis.z * half); p.setXYZ(1, pivot.x + axis.x * half, pivot.y + axis.y * half, pivot.z + axis.z * half); p.needsUpdate = true;
      line.material.color.set(AXIS_COLORS[index % 3]); dot.material.color.set(AXIS_COLORS[index % 3]);
      dot.position.copy(pivot); line.visible = dot.visible = true;
    });
  }
  for (let i = n; i < items.length; i++) items[i].line.visible = items[i].dot.visible = false;
}
const NEUTRAL = new THREE.Color('#cdbfb8'), SHORT = new THREE.Color('#d81f3c'), LONG = new THREE.Color('#2467d6');
/** Colour the muscle bellies by how much their path shortens or lengthens in the current pose. */
function updateLengthColors() {
  const on = lab.lengths && lab.rig; lab.lengthsDirty = false;
  for (const e of entries.values()) {
    if (e.sys !== 'muscular' || !e.meshes.length) continue;
    let ratio = null;
    if (on && e.meshes[0].visible && e.meshes.every(m => lab.binder.records.has(m))) ratio = lab.binder.lengthRatio(e);
    e.lengthRatio = ratio;
    const change = (ratio ?? 1) - 1, t = Math.min(1, Math.abs(change) / .15);
    for (const mesh of e.meshes) {
      for (const mat of mesh.userData.base) {
        if (mat.userData.layer !== 'muscular') continue;
        if (on) mat.color.copy(NEUTRAL).lerp(change < 0 ? SHORT : LONG, t); else mat.color.copy(mat.userData.color);
      }
      // The selected muscle shows its length too, slightly brighter than its neighbours.
      mesh.userData.highlight?.forEach((hi, i) => {
        if (hi.userData.layer !== 'muscular') return;
        const base = mesh.userData.base[i];
        if (on) { hi.color.copy(base.color).offsetHSL(0, .08, .03); hi.emissive.copy(base.color); }
        else { hi.color.copy(base.userData.color).offsetHSL(0, .06, .05); hi.emissive.copy(base.userData.color); }
      });
    }
  }
}
function updateMotionReadout() {
  const out = $('#motion-readout'); if (!out) return;
  const lines = [];
  if (lab.rig && !$('#motion-panel').hidden) {
    const s = sides()[0], joint = currentJoint(), get = k => (lab.shown?.[k] || 0);
    if (lab.gesture) {
      const id = lab.gesture.id, root = lab.info.root || {};
      if (id === 'reach') { const i = lab.info['shoulder.r']; lines.push('Elevazione ' + fmt(i.elevation) + ' = gleno-omerale ' + fmt(i.glenohumeral) + ' + scapolo-toracica ' + fmt(i.scapular)); if (i.automaticRotation < -.5) lines.push('Rotazione esterna automatica ' + fmt(-i.automaticRotation)); }
      if (id === 'gait') lines.push((lab.phase < .12 ? 'Risposta al carico' : lab.phase < .31 ? 'Appoggio intermedio' : lab.phase < .5 ? 'Appoggio terminale' : lab.phase < .62 ? 'Pre-oscillazione' : lab.phase < .75 ? 'Oscillazione iniziale' : lab.phase < .87 ? 'Oscillazione intermedia' : 'Oscillazione terminale') + ' · arto destro in ' + (lab.phase < .62 ? 'appoggio' : 'oscillazione'));
      if (lab.gesture.plant) {
        const cm = v => (v > 0 ? '+' : '') + Math.round(v * 100) + ' cm';
        lines.push('Bacino: altezza ' + cm(root.y || 0) + ' · avanti-dietro ' + cm(root.z || 0) + (root.tilt ? ' · antiversione ' + fmt(root.tilt) : ''));
        lines.push('Anca calcolata: abduzione ' + fmt(get('hip.r.abd')) + ' · rotazione ' + (get('hip.r.rot') < 0 ? 'esterna ' : 'interna ') + fmt(Math.abs(get('hip.r.rot'))));
      }
    } else if (joint.id === 'shoulder') {
      const i = lab.info['shoulder.' + s];
      lines.push('Elevazione ' + fmt(i.elevation) + ' = gleno-omerale ' + fmt(i.glenohumeral) + ' + scapolo-toracica ' + fmt(i.scapular));
      if (i.automaticRotation < -.5) lines.push('Rotazione esterna automatica ' + fmt(-i.automaticRotation));
    } else if (joint.id === 'knee') {
      const i = lab.info['knee.' + s];
      lines.push('Avvitamento: rotazione interna automatica ' + fmt(i.screwHome) + ' · rotazione volontaria disponibile ' + Math.round(i.rotationFreedom * 100) + '%');
      lines.push('Rotula: legamento rotuleo inclinato di ' + fmt(Math.abs(lab.rig.pose['patella.' + s + ':glide'] || 0)));
    } else if (joint.id === 'cervical' || joint.id === 'lumbar') {
      const names = joint.id === 'cervical' ? { skull: 'C0–C1', C1: 'C1–C2', C2: 'C2–C3', C3: 'C3–C4', C4: 'C4–C5', C5: 'C5–C6', C6: 'C6–C7', C7: 'C7–T1' } : { thorax: 'T12–L1', L1: 'L1–L2', L2: 'L2–L3', L3: 'L3–L4', L4: 'L4–L5', L5: 'L5–S1' };
      const dof = lab.control || 'flex';
      lines.push('Per livello · ' + Object.entries(names).map(([seg, name]) => name + ' ' + fmt(Math.abs(lab.rig.pose[seg + ':' + dof] || 0))).join(' · '));
    } else if (joint.id === 'forearm') lines.push('Dalla posizione anatomica (supinazione) il radio incrocia l’ulna.');
    const e = entries.get(selected);
    if (e && e.sys === 'muscular' && e.meshes.length && e.meshes.every(m => lab.binder.records.has(m))) {
      const ratio = lab.binder.lengthRatio(e);
      if (ratio != null) { const pct = (ratio - 1) * 100; lines.push(label(e) + ': lunghezza stimata ' + (pct > 0 ? '+' : '') + pct.toFixed(1).replace('.', ',') + '% ' + (Math.abs(pct) < .5 ? '(invariata)' : pct < 0 ? '(accorciato)' : '(allungato)')); }
    }
  }
  out.replaceChildren(...lines.map(t => node('span', t)));
}
document.addEventListener('visibilitychange',()=>{if(document.hidden)pauseMotion();});
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',e=>{if(e.matches)pauseMotion();});

function dialog(html){$('#info-content').innerHTML=html;$('#info').showModal()}
$('#help').onclick=()=>dialog('<h2>Comandi rapidi</h2><ul><li><b>Cerca:</b> nome, azione o nervo. Tocca il risultato per selezionarlo.</li><li><b>Strati:</b> mostra, nascondi o regola l’opacità di ogni tessuto.</li><li><b>Scheda:</b> origine, inserzione, azioni e innervazione della selezione.</li><li><b>Sul modello:</b> trascina per ruotare, pizzica per zoomare; due dita per spostare.</li><li><b>Selezione:</b> la struttura scelta è evidenziata da un contorno visibile anche in profondità. Inquadra, Isola, Zona e Nascondi; <b>Contesto</b> mostra o toglie il resto del corpo in trasparenza. Doppio tocco per inquadrare. ↶ annulla la rimozione; ↺ ripristina tutto.</li><li><b>Movimento:</b> scegli un’articolazione o un gesto funzionale (squat, cammino, sollevamento sugli avampiedi, flessione del tronco, elevazione del braccio), il lato e muovi i cursori. Il grafico mostra gli angoli nel ciclo del gesto oppure, con un muscolo selezionato, la sua lunghezza stimata lungo l’escursione dell’articolazione. Gli angoli sono riferiti alla posizione anatomica; <b>Assi</b> mostra gli assi di rotazione, <b>Lunghezze muscolari</b> colora i muscoli che si accorciano (rosso) o si allungano (blu).</li></ul><p>SX e DX indicano il lato anatomico. Il movimento usa uno scheletro articolato con centri e assi ricavati dalla geometria delle ossa e fa seguire i tessuti alle ossa vicine: è un modello cinematico, non simula forze, contrazione, scorrimento dei tendini o collisioni. Schede e movimenti sono didattici, non validati clinicamente. Fonti e licenze sono disponibili dal menu.</p>');
$('#credits').onclick=()=>dialog('<span class="eyebrow">FONTI E TRASPARENZA</span><h2>Le fonti di FisioBen.</h2><p>Fase 2: 203 schede in italiano, collegate a 452 strutture del modello, includendo i due lati. Le strutture non coperte sono indicate esplicitamente. <a href="./data/muscle-cards.json" download>Scarica il catalogo delle schede</a>. Le sintesi originali sono distribuite con <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">licenza CC BY 4.0</a>.</p><p>Modelli derivati da <b>BodyParts3D - The Database Center for Life Science - CC-BY-SA 2.1 Japan</b> e <b>Z-Anatomy - The open source atlas of anatomy - CC-BY-SA 4.0</b>.</p><p>Esportazione GLB e dati terminologici: <a href="https://github.com/nqwrc/3d-anatomy" target="_blank" rel="noopener">nqwrc / 3d-anatomy</a>. Questa versione conserva immutati i file muscolare, scheletrico, articolare e nervoso. Il movimento 3D articola lo scheletro e deforma copie delle geometrie dei tessuti a runtime; i file originali non sono modificati. Strati distinti secondo i materiali originali; fasce e borse nascoste nella vista muscolare per non coprire i muscoli. Nuova interfaccia, palette per tessuto e illuminazione; colorazione della selezione applicata nella vista. Conserviamo le attribuzioni e la licenza della raccolta, distribuita per uso non commerciale.</p><p><a href="./NOTICE" target="_blank">Attribuzioni complete</a> · <a href="./LICENSE" target="_blank">Licenza della raccolta</a> · <a href="./models/License.txt" target="_blank">Note originali dei modelli</a></p><p>Scarica i modelli: <a href="./models/muscular.glb" download>muscoli</a>, <a href="./models/nervous.glb" download>sistema nervoso</a>, <a href="./models/skeletal.glb" download>scheletro</a>, <a href="./models/joints.glb" download>articolazioni</a>. Rendering: <a href="./vendor/three/LICENSE" target="_blank">Three.js (MIT)</a>; decoder Draco (Apache 2.0).</p><p>Il prototipo è pensato per esplorazione didattica: comprende muscoli, tendini, ossa, sistema nervoso e tessuti articolari. Organi, vasi e sistema linfatico non sono inclusi. Il laboratorio della fase 3 offre schemi articolari 2D animati, con riferimento a <a href="https://openstax.org/books/anatomy-and-physiology-2e/pages/9-5-types-of-body-movements" target="_blank" rel="noopener">OpenStax §9.5</a>; resta disponibile dal menu. Il movimento 3D usa centri e assi articolari stimati dalla geometria ossea (sfere adattate alle teste di femore e omero, condili, malleoli), ampiezze di riferimento AAOS/Kapandji, ripartizione vertebrale secondo White e Panjabi e curve del cammino di tipo Perry/Winter. I tessuti seguono le ossa vicine con pesi geometrici: non simula forza, contrazione fisiologica, scorrimento tendineo o collisioni e non è validato biomeccanicamente. Le variazioni di lunghezza muscolare sono stime geometriche del percorso, non misure di attivazione. Le schede sono sintesi di fatti anatomici con riferimento alle tabelle universitarie UAMS, consultabili in ogni scheda. Non sono validate clinicamente. Le radici spinali non sono riportate sistematicamente. Per i gruppi la scheda è una sintesi di insieme; non comprende varianti anatomiche individuali.</p>');
$('.dialog-close').onclick=()=>$('#info').close();$('#info').onclick=e=>{if(e.target===$('#info'))$('#info').close()};
init();

const PANELS=['catalog','layers-panel','detail-panel','motion-panel'];
function setPanel(id){
 for(const key of PANELS)document.getElementById(key).hidden=key!==id;
 document.body.classList.toggle('panel-open',!!id);
 if(id==='catalog')renderList();
 document.querySelectorAll('[data-panel]').forEach(b=>b.setAttribute('aria-expanded',String(b.dataset.panel===id)));
 if(id!=='motion-panel')pauseMotion();
 resize(true);
 if(id==='motion-panel')ensureLab().then(ok=>{if(ok&&!$('#motion-panel').hidden){if(!lab.gesture){frameJoint();updateLengthCurve();}poseLab();}});
 else{updateHelpers();draw();}
}
document.querySelectorAll('[data-panel]').forEach(b=>b.onclick=()=>setPanel(document.getElementById(b.dataset.panel).hidden?b.dataset.panel:null));
document.querySelectorAll('[data-close-panel]').forEach(b=>b.onclick=()=>setPanel(null));
document.addEventListener('keydown',e=>{if(e.key==='Escape'){setPanel(null);pauseMotion();}});

function updateLoadStatus(){
 const status=$('#model-progress'),text=$('#model-progress-text');
 const names=[...pending.keys()].map(s=>sysNames[s]);
 status.hidden=!initialModelReady||(!names.length&&!failedModels.size);
 text.textContent=names.length?'Caricamento '+names.join(', ')+'…':'Caricamento incompleto';
 $('#retry-models').hidden=!failedModels.size;
}
async function requestLayers(){
 if(!initialModelReady||!viewReady)return;
 for(const sys of modelsForLayers(active)){
  if(failedModels.has(sys))continue;
  try{await load(sys);}catch(error){console.warn('Modello opzionale non caricato',sys,error);}
 }
 updateLoadStatus();
}
$('#retry-models').onclick=()=>{failedModels.clear();requestLayers();};

const movementOverlay=$('#movement-overlay'),movementFrame=$('#movement-frame');
function openMovements(hash='',recordHistory=true){
 if(recordHistory&&!history.state?.fisiobenMovement)history.pushState({fisiobenMovement:true},'',location.href);
 pauseMotion();setPanel(null);movementOverlay.hidden=false;
 const target='./movements.html?embedded=1'+hash;
 if(movementFrame.getAttribute('src')!==target)movementFrame.src=target;
 document.querySelector('.app-menu').open=false;
}
function closeMovements(back=true){
 if(back&&history.state?.fisiobenMovement)history.back();
 movementFrame.contentWindow?.postMessage({type:'fisioben-pause'},location.origin);
 movementOverlay.hidden=true;resize();draw();
}
document.addEventListener('click',e=>{
 const a=e.target.closest('a');if(!a||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
 const url=new URL(a.href,location.href);
 if(url.origin!==location.origin)return;
 if(url.pathname.endsWith('/movements.html')){e.preventDefault();openMovements(url.hash);}
 if(a.classList.contains('brand')){e.preventDefault();setPanel(null);home();}
});
$('#close-movements').onclick=()=>closeMovements();
window.addEventListener('popstate',()=>{if(!history.state?.fisiobenMovement)closeMovements(false);else openMovements('',false);});
window.addEventListener('message',e=>{
 if(e.origin!==location.origin||e.source!==movementFrame.contentWindow)return;
 if(e.data?.type==='fisioben-return'){
  closeMovements(false);history.replaceState(null,'',location.pathname+location.search+(e.data.muscle?'#muscle='+encodeURIComponent(e.data.muscle):location.hash));if(e.data.muscle)selectLinkedCard();
 }
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!movementOverlay.hidden)closeMovements();});
async function updateCacheLabel(){
 const saved=await cachedModels();
 $('#cache-status').textContent=saved.length===4?'Atlante salvato su questo dispositivo':saved.length+' / 4 modelli salvati sul dispositivo';
}
$('#preload-atlas').onclick=async()=>{
 if(warming||!initialModelReady||!viewReady)return;
 warming=true;$('#preload-atlas').disabled=true;
 navigator.storage?.persist?.().catch(()=>{});
 try{
  for(const [i,sys] of ['muscular','skeletal','nervous','joints'].entries()){
   $('#preload-atlas').textContent='Precaricamento '+(i+1)+'/4…';
   await load(sys);if(cacheWrites.has(sys))await cacheWrites.get(sys);
  }
  const saved=await cachedModels();
  toast(saved.length===4?'Atlante salvato: riapertura senza download né decompressione Draco.':'Atlante pronto in memoria. Spazio locale insufficiente o salvataggio non disponibile.');
 }catch(error){toast('Precaricamento interrotto. Puoi riprovare.');}
 finally{warming=false;$('#preload-atlas').disabled=!viewReady;$('#preload-atlas').textContent='Precarica atlante';updateCacheLabel();}
};
updateCacheLabel();
// Hook for automated checks of the 3D view.
window.fisioben={load,fitBox:(min,max,dir)=>fit(new THREE.Box3(new THREE.Vector3(...min),new THREE.Vector3(...max)),new THREE.Vector3(...dir),false),get state(){return {selected,isolated:isolated?isolated.size:0,pipeline:!!pipeline?.ok,highQuality,lab:{ready:!!lab.rig,joint:lab.joint,moved:lab.moved.size,state:{...lab.state}}};},select:id=>select(id),openMotion,setControl:(id,v)=>{const c=currentJoint().controls.find(x=>x.id===id);if(c)setControl(c,v);renderMotionControls();},setGesture:(id,phase=0)=>{$('#motion-joint').value='gesture:'+id;setGesture(id);lab.phase=phase;poseLab();},lab};
