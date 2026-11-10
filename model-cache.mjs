import {ObjectLoader} from 'three';
import {snapshotScene} from './scene-snapshot.mjs';
export const CACHE_VERSION='anatomy-20261024-three185-v1';
const STORE='models';
let opening;
function database(){
 if(!opening)opening=new Promise((resolve,reject)=>{
  if(!globalThis.indexedDB){reject(new Error('Local storage unavailable'));return;}
  const req=indexedDB.open('fisioben-anatomy',1);
  const timer=setTimeout(()=>reject(new Error('Storage timeout')),2500);
  req.onupgradeneeded=()=>req.result.createObjectStore(STORE);
  req.onerror=()=>{clearTimeout(timer);reject(req.error);};
  req.onsuccess=()=>{clearTimeout(timer);req.result.onversionchange=()=>req.result.close();resolve(req.result);};
  req.onblocked=()=>{clearTimeout(timer);reject(new Error('Storage blocked'));};
 });
 return opening;
}
const key=sys=>CACHE_VERSION+':'+sys;
async function operation(mode,action){
 const db=await database();
 return new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,mode),req=action(tx.objectStore(STORE));
  tx.oncomplete=()=>resolve(req?.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Storage aborted'));
 });
}
export async function restoreModel(sys){
 try{
  const record=await operation('readonly',s=>s.get(key(sys)));
  if(!record)return null;
  return new ObjectLoader().parse(record);
 }catch(error){console.warn('FisioBen cache read',error.message);return null;}
}
export function captureModel(root){try{return snapshotScene(root);}catch(error){console.warn('FisioBen cache snapshot',error.message);return null;}}
export async function saveModel(sys,snapshot){
 if(!snapshot)return false;
 try{await operation('readwrite',s=>s.put(snapshot,key(sys)));return true;}
 catch(error){console.warn('FisioBen cache write',error.message);return false;}
}
export async function cachedModels(){
 try{return (await operation('readonly',s=>s.getAllKeys())).filter(k=>k.startsWith(CACHE_VERSION+':')).map(k=>k.slice(CACHE_VERSION.length+1));}catch{return [];}
}
