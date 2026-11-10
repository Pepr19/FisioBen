// Anatomical source files are loaded only when their main systems are requested.
export function modelsForLayers(active){
 const out=[];
 if(['muscular','tendon','fascia'].some(x=>active.has(x)))out.push('muscular');
 if(active.has('skeletal'))out.push('skeletal');
 if(active.has('nervous'))out.push('nervous');
 if(active.has('joints')||active.has('other'))out.push('joints');
 if(active.has('other')&&!out.includes('nervous'))out.push('nervous');
 return out;
}
