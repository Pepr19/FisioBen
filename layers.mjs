export const layerNames={muscular:'Muscoli',tendon:'Tendini',skeletal:'Ossa',nervous:'Nervi e sistema nervoso',joints:'Legamenti e cartilagini',fascia:'Fasce e borse',other:'Altri tessuti'};
export const layerColors={muscular:'#a23b32',tendon:'#e4d6b6',skeletal:'#d8cba9',nervous:'#e2ad2e',joints:'#63a59f',fascia:'#b9bfce',other:'#c48b95'};
export const defaultOpacities={muscular:1,tendon:1,skeletal:1,nervous:0,joints:0,fascia:0,other:0};
export const presets={
 muscles:{...defaultOpacities},
 nerves:{muscular:.08,tendon:0,skeletal:.18,nervous:1,joints:0,fascia:0,other:0},
 tendons:{muscular:.15,tendon:1,skeletal:.65,nervous:0,joints:.55,fascia:0,other:0},
 bones:{muscular:0,tendon:0,skeletal:1,nervous:0,joints:1,fascia:0,other:0},
 all:{muscular:.28,tendon:1,skeletal:.45,nervous:1,joints:.5,fascia:.07,other:0}
};
export function materialLayer(system,name=''){
 const n=name.toLowerCase();
 if(/tendon/.test(n))return 'tendon';
 if(/fascia|bursa/.test(n))return 'fascia';
 if(/ligament|cartilage|articular capsule|suture/.test(n))return 'joints';
 if(/bone|teeth|dentine/.test(n))return 'skeletal';
 if(system==='nervous')return /nerve|brain|nucleus|lobe|cerebell|white matter|lcr/.test(n)?'nervous':'other';
 if(system==='skeletal')return 'skeletal';
 if(system==='joints')return 'other';
 if(/fat|mucosa|gland/.test(n))return 'other';
 return 'muscular';
}
export function entryVisible(entry,enabled){return (entry.layers||[entry.sys]).some(l=>enabled.has(l));}
