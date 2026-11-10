import {matchesEntry} from './anatomy.mjs';
// Search scope is anatomical, independent of the current scene or visible layers.
export function searchCatalog(entries,options,getCard,label,aliases,latin){
 return [...entries].filter(e=>matchesEntry(e,getCard(e),options,label(e),aliases(e),latin(e)))
  .sort((a,b)=>label(a).localeCompare(label(b),'it')||a.name.localeCompare(b.name));
}
export function searchLayer(entry){
 const layers=entry.layers||[entry.sys];
 if(layers.includes(entry.sys))return entry.sys;
 return ['muscular','tendon','skeletal','nervous','joints','fascia','other'].find(x=>layers.includes(x));
}
