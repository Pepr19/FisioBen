// Switching transparent changes Three's OPAQUE shader define, so invalidate once.
export function applyMaterialOpacity(material,alpha,enabled=true){
 const opacity=Math.max(0,Math.min(1,Number.isFinite(alpha)?alpha:1));
 const transparent=opacity<1;
 if(material.transparent!==transparent){material.transparent=transparent;material.needsUpdate=true;}
 material.opacity=opacity;material.depthWrite=!transparent;
 material.visible=enabled&&opacity>0;
 material.forceSinglePass=true;
 return material.visible;
}
