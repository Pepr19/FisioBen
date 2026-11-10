// Lossless, structured-cloneable snapshots. Typed arrays avoid giant JSON arrays.
export function snapshotScene(root){
 const meta={geometries:{},materials:{},textures:{},images:{},shapes:{},skeletons:{},animations:{},nodes:{}};
 root.traverse(mesh=>{
  if(!mesh.isMesh||meta.geometries[mesh.geometry.uuid])return;
  const g=mesh.geometry;
  if(mesh.isSkinnedMesh||Object.keys(g.morphAttributes).length)throw new Error('Unsupported animated geometry');
  const attribute=a=>{if(a.isInterleavedBufferAttribute)throw new Error('Unsupported interleaved attribute');return {itemSize:a.itemSize,type:a.array.constructor.name,array:a.array,normalized:a.normalized};};
  const data={attributes:{}};
  for(const [name,a] of Object.entries(g.attributes))data.attributes[name]=attribute(a);
  if(g.index)data.index={type:g.index.array.constructor.name,array:g.index.array};
  if(g.groups.length)data.groups=g.groups.map(x=>({...x}));
  if(g.boundingSphere)data.boundingSphere={center:g.boundingSphere.center.toArray(),radius:g.boundingSphere.radius};
  meta.geometries[g.uuid]={uuid:g.uuid,type:'BufferGeometry',name:g.name,data,userData:g.userData};
 });
 const object=structuredClone(root.toJSON(meta).object);
 if(Object.keys(meta.textures).length)throw new Error('Texture cache not supported');
 return {metadata:{version:4.7,type:'Object',generator:'FisioBen'},object,geometries:Object.values(meta.geometries),materials:Object.values(meta.materials)};
}
