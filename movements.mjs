import {movements,poseAt,clampAngle,directionAt,positionLabel,tipAt} from './movements-data.mjs';
const $=s=>document.querySelector(s), ns='http://www.w3.org/2000/svg';
let current,angle=0,phase=0,playing=false,lastTime=0,raf=0,cards=new Map();
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
function svg(tag,attrs={},text){const el=document.createElementNS(ns,tag);Object.entries(attrs).forEach(([k,v])=>el.setAttribute(k,v));if(text)el.textContent=text;return el;}
function textNode(tag,text,cls){const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e;}
function segment(parent,x1,y1,x2,y2,mobile=false,width=42){
  parent.append(svg('line',{x1,y1,x2,y2,stroke:mobile?'#8db6a0':'#c7d4c2','stroke-width':width+3,'stroke-linecap':'round'}));
  parent.append(svg('line',{x1,y1,x2,y2,stroke:mobile?'#c4deca':'#e0e7d8','stroke-width':width,'stroke-linecap':'round'}));
  parent.append(svg('line',{x1,y1,x2,y2,stroke:mobile?'#317d62':'#81977f','stroke-width':7,'stroke-linecap':'round'}));
  for(const [cx,cy] of [[x1,y1],[x2,y2]])parent.append(svg('circle',{cx,cy,r:7,fill:mobile?'#317d62':'#81977f'}));
}
function drawDiagram(){
  const m=current,g=$('#anatomy-drawing');g.replaceChildren();
  const pivot={x:265,y:m.kind==='foot'?250:200};
  if(m.kind==='shoulder'){
    g.append(svg('path',{d:'M 300 62 Q 330 48 360 62 L 380 115 L 372 290 Q 335 310 295 290 L 280 115 Z',fill:'#dfe7d8',stroke:'#b9c9b6','stroke-width':2}));
    g.append(svg('circle',{cx:330,cy:32,r:24,fill:'#dfe7d8',stroke:'#b9c9b6','stroke-width':2}));
    pivot.x=280;pivot.y=115;segment(g,280,115,330,95,false,25);
  }else if(m.kind==='hip'){
    g.append(svg('path',{d:'M 225 75 L 300 75 L 310 155 Q 295 192 265 200 Q 230 185 218 155 Z',fill:'#dfe7d8',stroke:'#b9c9b6','stroke-width':2}));
    segment(g,265,150,265,200,false,32);
  }else if(m.kind==='hand'){segment(g,95,200,265,200,false,38);}
  else{segment(g,pivot.x,pivot.y-130,pivot.x,pivot.y,false,m.kind==='knee'?55:43);}
  const base=tipAt(m,0,m.kind==='shoulder'?205:140);
  g.append(svg('line',{x1:pivot.x,y1:pivot.y,x2:pivot.x+base.x,y2:pivot.y+base.y,stroke:'#9eb49d','stroke-width':2,'stroke-dasharray':'5 6'}));
  const rot=svg('g',{id:'moving-segment',transform:`translate(${pivot.x} ${pivot.y}) rotate(${m.sign*angle})`});
  if(m.kind==='foot'){
    rot.append(svg('path',{d:'M -21 -15 Q 0 -30 18 -12 L 45 3 L 137 10 Q 155 12 153 28 L -20 28 Q -35 12 -21 -15 Z',fill:'#c4deca',stroke:'#8db6a0','stroke-width':2}));
    rot.append(svg('path',{d:'M 0 0 L 45 16 L 134 19',fill:'none',stroke:'#317d62','stroke-width':7,'stroke-linecap':'round'}));
  }else if(m.kind==='hand'){
    rot.append(svg('path',{d:'M 0 -17 L 60 -24 Q 85 -28 100 -14 L 142 -10 Q 152 0 142 10 L 95 14 L 72 27 L 48 26 L 0 17 Z',fill:'#c4deca',stroke:'#8db6a0','stroke-width':2}));
    rot.append(svg('line',{x1:0,y1:0,x2:132,y2:0,stroke:'#317d62','stroke-width':7,'stroke-linecap':'round'}));
  }else{
    segment(rot,0,0,0,m.kind==='shoulder'?205:140,true,m.kind==='hip'?52:37);
    if(m.kind==='hip')segment(rot,0,140,-85,140,true,28);
    if(m.kind==='knee')segment(rot,0,140,45,145,true,23);
    if(m.kind==='arm')segment(rot,0,140,0,164,true,23);
  }
  g.append(rot);
  const a=tipAt(m,0,47),b=tipAt(m,angle,47);
  if(Math.abs(angle)>.5)g.append(svg('path',{d:`M ${pivot.x+a.x} ${pivot.y+a.y} A 47 47 0 0 ${m.sign*angle>0?1:0} ${pivot.x+b.x} ${pivot.y+b.y}`,fill:'none',stroke:'#b79b59','stroke-width':3}));
  g.append(svg('circle',{cx:pivot.x,cy:pivot.y,r:11,fill:'#f6faf2',stroke:'#39795b','stroke-width':3}));
  g.append(svg('circle',{cx:pivot.x,cy:pivot.y,r:3,fill:'#39795b'}));
  const end=tipAt(m,angle,m.kind==='shoulder'?205:140);
  g.append(svg('text',{x:Math.max(65,Math.min(460,pivot.x+end.x+26)),y:Math.max(46,Math.min(390,pivot.y+end.y+26)),fill:'#285f47','font-size':13,'font-family':'sans-serif'},m.moving));
  const fixedX=m.kind==='shoulder'?380:m.kind==='hand'?110:310;
  g.append(svg('text',{x:fixedX,y:m.kind==='hand'?166:85,fill:'#6e856f','font-size':13,'font-family':'sans-serif'},m.fixed));
  if(m.kind!=='shoulder')g.append(svg('text',{x:410,y:365,fill:'#78917b','font-size':10,'font-family':'sans-serif'},m.kind==='hand'?'↓ Lato palmare':'Anteriore →'));
  $('#diagram-title').textContent=m.name+': '+m.title;
  $('#diagram-desc').textContent=`${m.plane}. ${m.fixed} fisso; ${m.moving} mobile. ${positionLabel(m,angle)}, ${Math.round(angle)} gradi illustrativi.`;
}
function renderAngle(){
  $('#angle').value=String(Math.round(angle));$('#angle-value').textContent=Math.round(angle)+'°';
  $('#angle').setAttribute('aria-valuetext',Math.round(angle)+' gradi: '+positionLabel(current,angle));
  $('#direction-label').textContent=playing?'Direzione: '+(directionAt(phase)==='up'?current.first:current.second):positionLabel(current,angle)+' · schema fermo';
  document.querySelectorAll('.muscle-group').forEach(e=>e.classList.toggle('active-direction',playing&&e.dataset.direction===directionAt(phase)));
  drawDiagram();
}
function stop(){playing=false;cancelAnimationFrame(raf);raf=0;lastTime=0;$('#play').textContent='▶ Avvia';$('#play').setAttribute('aria-pressed','false');$('#motion-status').textContent='In pausa';renderAngle();}
function tick(time){
  if(!playing)return;
  if(lastTime)phase+=Math.max(time-lastTime,0)/8000*Number($('#speed').value);
  lastTime=time;
  if(phase>=1){if(!$('#loop').checked){phase=1;angle=current.min;stop();$('#motion-status').textContent='Ciclo completato';return;}phase%=1;}
  angle=poseAt(current,phase);renderAngle();raf=requestAnimationFrame(tick);
}
function renderMuscles(){
  const target=$('#muscle-groups');target.replaceChildren();
  for(const [key,title] of [['up',current.first],['down',current.second]]){
    const group=textNode('section','','muscle-group');group.dataset.direction=key;group.append(textNode('h4',title));
    for(const id of current[key]){const card=cards.get(id);if(!card)continue;const a=textNode('a',card.name+' ↗');a.href='./#muscle='+encodeURIComponent(id);group.append(a);}
    if(!cards.size)group.append(textNode('p','Schede non caricate. Riapri il laboratorio per riprovare.'));
    target.append(group);
  }
}
function setPhaseFromAngle(){phase=Math.acos(1-2*(angle-current.min)/(current.max-current.min))/(2*Math.PI);}
function choose(id){
  current=movements.find(m=>m.id===id)||movements[0];angle=0;setPhaseFromAngle();stop();
  $('#angle').min=current.min;$('#angle').max=current.max;$('#angle').value='0';
  $('#motion-title').textContent=current.title;$('#motion-plane').textContent=current.plane;$('#joint-name').textContent=current.name;
  $('#motion-description').textContent=current.description;$('#motion-note').textContent=current.note;
  $('#range-min').textContent=current.min+'°';$('#range-max').textContent=current.max+'°';
  document.querySelectorAll('[data-movement]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.movement===current.id)));
  renderMuscles();renderAngle();
}
for(const m of movements){const b=textNode('button',m.name);b.dataset.movement=m.id;b.onclick=()=>{location.hash=m.id;};$('#movement-tabs').append(b);}
window.addEventListener('hashchange',()=>choose(location.hash.slice(1)));
$('#play').onclick=()=>{if(playing){stop();return;}if(phase>=1)phase=0;playing=true;lastTime=0;$('#play').textContent='Ⅱ Pausa';$('#play').setAttribute('aria-pressed','true');$('#motion-status').textContent='In movimento';raf=requestAnimationFrame(tick);};
$('#reset-motion').onclick=()=>{angle=0;setPhaseFromAngle();stop();};
$('#angle').oninput=()=>{angle=clampAngle(current,Number($('#angle').value));setPhaseFromAngle();stop();};
// No autoplay; pause on tab change and on newly requested reduced motion.
document.addEventListener('visibilitychange',()=>{if(document.hidden&&playing)stop();});
reduced.addEventListener('change',()=>{if(reduced.matches&&playing)stop();});
choose(location.hash.slice(1));
fetch('./data/muscle-cards.json?v=2').then(r=>{if(!r.ok)throw new Error('cards');return r.json();}).then(data=>{cards=new Map(data.cards.map(c=>[c.id,c]));renderMuscles();renderAngle();}).catch(()=>renderMuscles());

if(window.parent!==window&&new URLSearchParams(location.search).has('embedded')){
 document.body.classList.add('embedded');
 document.addEventListener('click',e=>{
  const a=e.target.closest('a');if(!a)return;
  const url=new URL(a.href,location.href);
  if(url.origin===location.origin&&!url.pathname.endsWith('/movements.html')){
   e.preventDefault();stop();parent.postMessage({type:'fisioben-return',muscle:new URLSearchParams(url.hash.slice(1)).get('muscle')},location.origin);
  }
 });
 window.addEventListener('message',e=>{if(e.origin===location.origin&&e.source===parent&&e.data?.type==='fisioben-pause')stop();});
}
