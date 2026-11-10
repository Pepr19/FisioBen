// Dual-quaternion skinning on the GPU.
// Three.js blends bone matrices linearly; around joints with large rotations (elbow, knee,
// forearm twist) that collapses the volume of the limb. Here the three skinning chunks of the
// built-in shaders are replaced so that every material (standard, basic, depth, our own
// ShaderMaterials) blends rigid transforms as dual quaternions instead.
// The "bone texture" holds two texels per rig segment: the real and the dual quaternion of the
// transform that maps rest-pose world coordinates to posed world coordinates.
import * as THREE from 'three';

const PARS = /* glsl */`
#ifdef USE_SKINNING
	uniform mat4 bindMatrix;
	uniform mat4 bindMatrixInverse;
	uniform highp sampler2D boneTexture;
	// Rigid transform stored as a dual quaternion (real r, dual d) applied to a point.
	vec3 fbRigid( vec4 r, vec4 d, vec3 p ) {
		return p + 2.0 * cross( r.xyz, cross( r.xyz, p ) + r.w * p ) + 2.0 * ( r.w * d.xyz - d.w * r.xyz + cross( r.xyz, d.xyz ) );
	}
	vec3 fbRigidAt( int i, vec3 p ) {
		return fbRigid( texelFetch( boneTexture, ivec2( i, 0 ), 0 ), texelFetch( boneTexture, ivec2( i + 1, 0 ), 0 ), p );
	}
#endif`;

const BASE = /* glsl */`
#ifdef USE_SKINNING
	// The first index carries a flag (+128): blend positions linearly instead of blending the transforms.
	bool fbStretch = skinIndex.x > 127.5;
	ivec4 fbIndex = ivec4( mod( skinIndex, 128.0 ) + 0.5 ) * 2;
	vec4 fbFirst = texelFetch( boneTexture, ivec2( fbIndex.x, 0 ), 0 );
	vec4 fbReal = fbFirst * skinWeight.x;
	vec4 fbDual = texelFetch( boneTexture, ivec2( fbIndex.x + 1, 0 ), 0 ) * skinWeight.x;
	if ( skinWeight.y > 0.0 ) {
		vec4 fbQ = texelFetch( boneTexture, ivec2( fbIndex.y, 0 ), 0 );
		float fbW = dot( fbFirst, fbQ ) < 0.0 ? - skinWeight.y : skinWeight.y;
		fbReal += fbQ * fbW; fbDual += texelFetch( boneTexture, ivec2( fbIndex.y + 1, 0 ), 0 ) * fbW;
	}
	if ( skinWeight.z > 0.0 ) {
		vec4 fbQ = texelFetch( boneTexture, ivec2( fbIndex.z, 0 ), 0 );
		float fbW = dot( fbFirst, fbQ ) < 0.0 ? - skinWeight.z : skinWeight.z;
		fbReal += fbQ * fbW; fbDual += texelFetch( boneTexture, ivec2( fbIndex.z + 1, 0 ), 0 ) * fbW;
	}
	if ( skinWeight.w > 0.0 ) {
		vec4 fbQ = texelFetch( boneTexture, ivec2( fbIndex.w, 0 ), 0 );
		float fbW = dot( fbFirst, fbQ ) < 0.0 ? - skinWeight.w : skinWeight.w;
		fbReal += fbQ * fbW; fbDual += texelFetch( boneTexture, ivec2( fbIndex.w + 1, 0 ), 0 ) * fbW;
	}
	float fbNorm = 1.0 / max( length( fbReal ), 1e-8 );
	fbReal *= fbNorm; fbDual *= fbNorm;
#endif`;

const NORMAL = /* glsl */`
#ifdef USE_SKINNING
	vec3 fbN = transpose( mat3( bindMatrixInverse ) ) * objectNormal;
	fbN += 2.0 * cross( fbReal.xyz, cross( fbReal.xyz, fbN ) + fbReal.w * fbN );
	objectNormal = normalize( transpose( mat3( bindMatrix ) ) * fbN );
	#ifdef USE_TANGENT
		vec3 fbT = mat3( bindMatrix ) * objectTangent;
		fbT += 2.0 * cross( fbReal.xyz, cross( fbReal.xyz, fbT ) + fbReal.w * fbT );
		objectTangent = normalize( mat3( bindMatrixInverse ) * fbT );
	#endif
#endif`;

const VERTEX = /* glsl */`
#ifdef USE_SKINNING
	vec3 fbP = ( bindMatrix * vec4( transformed, 1.0 ) ).xyz;
	if ( fbStretch ) {
		// A sheet of muscle spanning a ball joint runs straight between its attachments.
		vec3 fbSum = skinWeight.x * fbRigidAt( fbIndex.x, fbP );
		if ( skinWeight.y > 0.0 ) fbSum += skinWeight.y * fbRigidAt( fbIndex.y, fbP );
		if ( skinWeight.z > 0.0 ) fbSum += skinWeight.z * fbRigidAt( fbIndex.z, fbP );
		if ( skinWeight.w > 0.0 ) fbSum += skinWeight.w * fbRigidAt( fbIndex.w, fbP );
		fbP = fbSum;
	} else fbP = fbRigid( fbReal, fbDual, fbP );
	transformed = ( bindMatrixInverse * vec4( fbP, 1.0 ) ).xyz;
#endif`;

let installed = false;
/** Replace the skinning chunks once, before any skinned program is compiled. */
export function installDualQuatSkinning() {
  if (installed) return; installed = true;
  THREE.ShaderChunk.skinning_pars_vertex = PARS;
  THREE.ShaderChunk.skinbase_vertex = BASE;
  THREE.ShaderChunk.skinnormal_vertex = NORMAL;
  THREE.ShaderChunk.skinning_vertex = VERTEX;
}

/**
 * Minimal stand-in for THREE.Skeleton: the renderer only needs update() and boneTexture.
 * The texture is refreshed by the binder when the pose changes, not once per frame.
 */
export class DualQuatSkeleton {
  constructor(count) {
    this.data = new Float32Array(count * 8);
    for (let i = 0; i < count; i++) this.data[i * 8 + 3] = 1;   // identity
    this.boneTexture = new THREE.DataTexture(this.data, count * 2, 1, THREE.RGBAFormat, THREE.FloatType);
    this.boneTexture.minFilter = this.boneTexture.magFilter = THREE.NearestFilter;
    this.boneTexture.generateMipmaps = false; this.boneTexture.needsUpdate = true;
  }
  set(dq) { this.data.set(dq); this.boneTexture.needsUpdate = true; }
  update() {}
  computeBoneTexture() {}
  dispose() { this.boneTexture.dispose(); }
}

/** Vertex shader lines for hand-written ShaderMaterials that must follow skinned meshes. */
export const SKIN_PARS = '#include <skinning_pars_vertex>';
export const SKIN_POSITION = 'vec3 transformed = position;\n#include <skinbase_vertex>\n#include <skinning_vertex>';
export const SKIN_POSITION_NORMAL = 'vec3 transformed = position; vec3 objectNormal = normal;\n#include <skinbase_vertex>\n#include <skinnormal_vertex>\n#include <skinning_vertex>';
