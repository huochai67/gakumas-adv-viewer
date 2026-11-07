// Native Quartz math, exclusively in Unity coordinates (no render-space reflection).
// Evidence under tmp/ghidra-task-exam: adv_out_cstm63/{013,015,020..024}_*.c,
// adv_out_quartz_fix/{009..018,021,024,028,038,039}_*.c and rotation_asm.txt.
// Settings retain their serialized field structure; bindings perform the native
// ConvertToUnity operation once before passing them to these Calc ports.
import { Quaternion, Vector3 } from 'three';

const D = 0.01745329238474369, R = 57.295780181884766;
const _e = new Vector3(), _e2 = new Vector3(), _v = new Vector3();
const _q = new Quaternion(), _b = new Quaternion(), _t = new Quaternion();
const _unityFrom = new Vector3(), _unityTo = new Vector3();
const ORDERS = ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'];
const CONNECTIONS = ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'];

export function quartzInverse(out, q) {
  const n = 1 / (q.x*q.x + q.y*q.y + q.z*q.z + q.w*q.w);
  return out.set(-q.x*n, -q.y*n, -q.z*n, q.w*n);
}

// 0x1809BC900 / ThreeAxisRot 0x1809BC7A0: signed radians, no asin clamp.
export function quartzEuler(out, q, order = 4) {
  const x=q.x, y=q.y, z=q.z, w=-q.w;
  let a,b,c,d,e, first,second,third;
  switch (order) {
    case 0: a=-2*(z*y-w*x); b=w*w-x*x-y*y+z*z; c=2*(w*y+z*x); d=-2*(y*x-z*w); e=w*w+x*x-y*y-z*z; break;
    case 1: a=2*(z*y+w*x); b=w*w-x*x+y*y-z*z; c=-2*(y*x-z*w); d=2*(w*y+z*x); e=w*w+x*x-y*y-z*z; break;
    case 2: a=2*(w*y+z*x); b=w*w-x*x-y*y+z*z; c=-2*(z*y-w*x); d=2*(z*w+y*x); e=w*w-x*x+y*y-z*z; break;
    case 3: a=-2*(z*x-w*y); b=w*w+x*x-y*y-z*z; c=2*(z*w+y*x); d=-2*(z*y-w*x); e=w*w-x*x+y*y-z*z; break;
    case 4: a=-2*(y*x-z*w); b=w*w-x*x+y*y-z*z; c=2*(z*y+w*x); d=-2*(z*x-w*y); e=w*w-x*x-y*y+z*z; break;
    case 5: a=2*(z*w+y*x); b=w*w+x*x-y*y-z*z; c=-2*(z*x-w*y); d=2*(z*y+w*x); e=w*w-x*x-y*y+z*z; break;
    default: throw new RangeError(`Quartz rotation order ${order}`);
  }
  first=-Math.atan2(d,e); second=-Math.asin(c); third=-Math.atan2(a,b);
  switch(order) {
    case 0: return out.set(third,second,first);
    case 1: return out.set(third,first,second);
    case 2: return out.set(second,third,first);
    case 3: return out.set(first,third,second);
    case 4: return out.set(second,first,third);
    default: return out.set(first,second,third);
  }
}

// 0x1809BCFE0: Unity.Mathematics orders are extrinsic; inputs are degrees.
export function quartzQuaternion(out, x, y, z, order = 4) {
  return quaternionRadians(out,x*D,y*D,z*D,order);
}

function quaternionRadians(out,x,y,z,order) {
  const axes=ORDERS[order];
  if (!axes) throw new RangeError(`Quartz rotation order ${order}`);
  out.identity();
  for(let i=0;i<3;i++) {
    const axis=axes[i], angle=(axis==='X'?x:axis==='Y'?y:z)*0.5;
    const s=Math.sin(angle), c=Math.cos(angle);
    _t.set(axis==='X'?s:0,axis==='Y'?s:0,axis==='Z'?s:0,c);
    out.premultiply(_t);
  }
  return out;
}

// 0x1809BC300: native axis-angle from raw cross, including antiparallel axis.
export function quartzFromTo(out, from, to) {
  const ax=from.x, ay=from.y, az=from.z, bx=to.x, by=to.y, bz=to.z;
  const an=ax*ax+ay*ay+az*az, bn=bx*bx+by*by+bz*bz;
  const ai=an>1.1754943508222875e-38?1/Math.sqrt(an):0;
  const bi=bn>1.1754943508222875e-38?1/Math.sqrt(bn):0;
  const dot=(ax*bx+ay*by+az*bz)*ai*bi;
  if(dot>=1) return out.identity();
  let x,y,z,angle;
  if(dot<=-1) {
    x=0; y=az; z=-ay;
    if(x*x+y*y+z*z<1e-10) { x=-az; y=0; z=ax; }
    angle=3.1415927410125732;
  } else { x=ay*bz-az*by; y=az*bx-ax*bz; z=ax*by-ay*bx; angle=Math.acos(dot); }
  const n=x*x+y*y+z*z;
  // Antiparallel branch passes its raw perpendicular directly to AxisAngle
  // (0x1809B69F0 does not normalize); only the general branch normalizes.
  const scale=dot<=-1?Math.sin(angle*0.5):n>1.1754943508222875e-38?Math.sin(angle*0.5)/Math.sqrt(n):0;
  return out.set(x*scale,y*scale,z*scale,Math.cos(angle*0.5));
}

// 0x1809BA2F0 / 0x1809BAC10. All three arguments are radians.
function bend(out,x,y,z,rollFirst) {
  const ty=Math.tan(y*0.5), tz=Math.tan(-z*0.5);
  const n=2/(ty*ty+tz*tz+1);
  _e2.set(1,0,0); _v.set(n-1,n*tz,n*ty);
  quartzFromTo(_b,_e2,_v);
  _q.set(Math.sin(-x*0.5),0,0,Math.cos(-x*0.5));
  return rollFirst?out.multiplyQuaternions(_b,_q):out.multiplyQuaternions(_q,_b);
}
export function quartzBendRoll(out,x,y,z) { return bend(out,x,y,z,false); }
export function quartzRollBend(out,x,y,z) { return bend(out,x,y,z,true); }
// 0x1809BA610 constructs Rz * Ry * Rx, then extracts its quaternion.
export function quartzMatrix(out,x,y,z) { return quaternionRadians(out,x,y,z,0); }

export function quartzFormatDegree(x) { return x>180?x-360:x < -180?x+360:x; }
function nativeMin(a,b) { return Number.isNaN(a)||b<a?b:a; }
function nativeMax(a,b) { return Number.isNaN(a)||a<b?b:a; }
export function quartzSingle(x,c,min,max) { return nativeMax(nativeMin(x,max),min)*c; }
export function quartzDual(x,a,b,min,max) { return (a-b)*nativeMax(nativeMin(x,max),min); }
export function quartzTriple(x,a,b,c,min,max) { return Math.min(x-min,0)*a+x*b+Math.max(x-max,0)*c; }

export function quartzExchange(out,x,y,z,connection=0) {
  const axes=CONNECTIONS[connection];
  if(!axes) throw new RangeError(`Quartz axis connection ${connection}`);
  return out.set(axes[0]==='X'?x:axes[0]==='Y'?y:z,axes[1]==='X'?x:axes[1]==='Y'?y:z,axes[2]==='X'?x:axes[2]==='Y'?y:z);
}

// 0x1809BB530: reconstruct ZXY from degrees, derive X bend direction,
// remove shortest swing on the RIGHT (q * inverse(swing)), signed axis-angle roll.
export function quartzDecompose(out,x,y,z,mode=2) {
  if(mode===0) return out.set(x,y,z);
  quartzQuaternion(_q,x,y,z,4);
  const qx=_q.x,qy=_q.y,qz=_q.z,qw=_q.w;
  const vx=1-2*(qy*qy+qz*qz), vy=2*(qx*qy+qw*qz), vz=2*(qx*qz-qw*qy);
  const by=-2*Math.atan2(vz,vx+1)*R, bz=2*Math.atan2(vy,vx+1)*R;
  if(mode===1) return out.set(x,by,bz);
  _e2.set(1,0,0); _v.set(vx,vy,vz); quartzFromTo(_b,_e2,_v);
  quartzInverse(_b,_b); _q.multiply(_b);
  const n=Math.sqrt(_q.x*_q.x+_q.y*_q.y+_q.z*_q.z);
  let roll=2*Math.acos(Math.max(-1,Math.min(1,_q.w)))*R;
  if(n>0 && (_q.x*vx+_q.y*vy+_q.z*vz)/n<0) roll=-roll;
  return out.set(roll,by,bz);
}

// 0x1809BAF90: Y-axis variant; its residual reconstruction is always ZXY,
// even when the direction quaternion uses a different serialized order.
export function quartzDecomposeY(out,x,y,z,order=4) {
  quartzQuaternion(_q,x,y,z,order);
  const qx=_q.x,qy=_q.y,qz=_q.z,qw=_q.w;
  const vx=2*(qx*qy-qw*qz), vy=1-2*(qx*qx+qz*qz), vz=2*(qy*qz+qw*qx);
  const by=2*Math.atan2(vz,vy+1)*R, bz=-2*Math.atan2(vx,vy+1)*R;
  quartzQuaternion(_q,x,y,z,4);
  _e2.set(0,1,0); _v.set(vx,vy,vz); quartzFromTo(_b,_e2,_v);
  quartzInverse(_b,_b); _q.multiply(_b);
  const n=Math.sqrt(_q.x*_q.x+_q.y*_q.y+_q.z*_q.z);
  let roll=2*Math.acos(Math.max(-1,Math.min(1,_q.w)))*R;
  if(n>0 && (_q.x*vx+_q.y*vy+_q.z*vz)/n<0) roll=-roll;
  return out.set(roll,by,bz);
}

// Native ToUnityEuler (0x1809964C0) is signed ZXY degrees.
export function quartzUnityEuler(out,q) { return quartzEuler(out,q,4).multiplyScalar(R); }

// 0x1809B9BB0: extract XYZ angles from Rz * Ry * Rx using matrix indices
// 9,10,8,4,0. This is not an interchangeable Three.js Euler accessor.
export function quartzAxisEuler(out,x,y,z) {
  const sx=Math.sin(x),cx=Math.cos(x),sy=Math.sin(y),cy=Math.cos(y),sz=Math.sin(z),cz=Math.cos(z);
  return out.set(Math.atan2(sz*sy*cx-cz*sx,cy*cx)*R,
    Math.asin(-(cz*sy*cx+sz*sx))*R,Math.atan2(cz*sy*sx-sz*cx,cz*cy)*R);
}

// Rotation Calc 0x1809AEE60 deliberately has a mixed-unit path. Assembly
// rotation_asm.txt 0x1809AEEB0..0x1809AEF18 passes ToEuler radians unchanged
// to the degree-based decomposer; 0x1809AF0C6 passes its numeric output to
// radian BendRoll without another conversion. Preserve that native behavior:
// adding a degree-to-radian conversion here makes elbow Receive almost static.
export function quartzRotation(out,referenceQuaternion,s) {
  quartzEuler(_e,referenceQuaternion,s.rotationOrder);
  quartzDecompose(_e,_e.x,_e.y,_e.z,s.decomposeType);
  const c=s.coefficient,lo=s.limitMin,hi=s.limitMax;
  const x=quartzSingle(quartzFormatDegree(_e.x),c.x,lo.x,hi.x);
  const y=quartzSingle(quartzFormatDegree(_e.y),c.y,lo.y,hi.y);
  const z=quartzSingle(quartzFormatDegree(_e.z),c.z,lo.z,hi.z);
  if(s.composeType===0) return quartzBendRoll(out,-x,-y,-z);
  if(s.composeType===1) return quartzRollBend(out,-x,-y,-z);
  if(s.composeType===2) return quartzMatrix(out,x,y,z);
  quartzExchange(_e,x,y,z,s.connectionAxis);
  return quartzQuaternion(out,_e.x*R,_e.y*R,_e.z*R,4);
}

// Skirt Calc 0x1809AF300 explicitly converts radians to degrees before the
// Y-roll inverse decomposition, swaps Y/Z, then converts the result to radians.
export function quartzSkirt(out,initialReferenceQuaternion,referenceQuaternion,s) {
  quartzInverse(_q,initialReferenceQuaternion); _q.multiply(referenceQuaternion);
  quartzEuler(_e,_q,s.rotationOrder).multiplyScalar(R);
  quartzDecomposeY(_e,_e.x,_e.y,_e.z,s.rotationOrder);
  const x=quartzFormatDegree(_e.x),y=quartzFormatDegree(_e.z),z=quartzFormatDegree(_e.y);
  const a=s.innerCoefficient,b=s.outerCoefficient,lo=s.limitMin,hi=s.limitMax;
  return quartzBendRoll(out,
    (b.x*x+quartzDual(x,a.x,b.x,lo.x,hi.x))*D,
    (b.y*y+quartzDual(y,a.y,b.y,lo.y,hi.y))*D,
    (b.z*z+quartzDual(z,a.z,b.z,lo.z,hi.z))*D);
}

// Frill Calc 0x1809AADF0; explicit native arguments keep schema mapping at
// the binding boundary. Unlike Rotation, these decomposer inputs are degrees.
export function quartzFrill(out,referenceQuaternion,rotationOrder,a,b,c,lo,hi,connectionAxis,decomposeType,composeType) {
  quartzUnityEuler(_e,referenceQuaternion);
  quartzDecompose(_e,_e.x,_e.y,_e.z,decomposeType);
  const x=quartzTriple(quartzFormatDegree(_e.x),a.x,b.x,c.x,lo.x,hi.x)*D;
  const y=quartzTriple(quartzFormatDegree(_e.y),a.y,b.y,c.y,lo.y,hi.y)*D;
  const z=quartzTriple(quartzFormatDegree(_e.z),a.z,b.z,c.z,lo.z,hi.z)*D;
  if(composeType===0) return quartzBendRoll(out,x,y,z);
  if(composeType===1) return quartzRollBend(out,x,y,z);
  if(composeType===2) return quartzMatrix(out,-x,-y,-z);
  quartzAxisEuler(_e,x,y,z);
  quartzQuaternion(_q,_e.x,_e.y,_e.z,4);
  quartzEuler(_e,_q,rotationOrder);
  quartzExchange(_e,_e.x,_e.y,_e.z,connectionAxis);
  return quartzQuaternion(out,_e.x*R,_e.y*R,_e.z*R,4);
}

// 0x1809BBB10: non-inverse Y roll decomposer, degrees in/out.
export function quartzDecomposeYRoll(out,x,y,z) {
  quartzQuaternion(_q,x,y,z,2);
  const qx=_q.x,qy=_q.y,qz=_q.z,qw=_q.w;
  const vx=2*(qx*qy-qw*qz),vy=1-2*(qx*qx+qz*qz),vz=2*(qy*qz+qw*qx);
  return out.set(y,2*Math.atan2(vz,vy+1)*R,-2*Math.atan2(vx,vy+1)*R);
}

// Hair Calc 0x1809ABD00 returns a quaternion and translation; output arguments
// avoid allocating the native value tuple on every evaluation.
export function quartzHair(out,outPosition,headQuaternion,neckQuaternion,s) {
  quartzEuler(_e,headQuaternion,2).multiplyScalar(R);
  quartzDecomposeYRoll(_e,_e.x,_e.y,_e.z);
  const hx=quartzFormatDegree(_e.y),hy=quartzFormatDegree(_e.x),hz=quartzFormatDegree(_e.z);
  let c=s.headTranslateCoefficient,lo=s.headTranslateLimitMin,hi=s.headTranslateLimitMax;
  quartzExchange(outPosition,quartzSingle(hx,c.x,lo.x,hi.x),quartzSingle(hy,c.y,lo.y,hi.y),quartzSingle(hz,c.z,lo.z,hi.z),s.translateConnectionAxis);
  c=s.headRotateCoefficient; lo=s.headRotateLimitMin; hi=s.headRotateLimitMax;
  const ax=quartzSingle(hx,c.x,lo.x,hi.x),ay=quartzSingle(hy,c.y,lo.y,hi.y),az=quartzSingle(hz,c.z,lo.z,hi.z);
  quartzEuler(_e,neckQuaternion,2).multiplyScalar(R);
  quartzDecomposeYRoll(_e,_e.x,_e.y,_e.z);
  c=s.neckRotateCoefficient; lo=s.neckRotateLimitMin; hi=s.neckRotateLimitMax;
  const x=(ax+quartzSingle(quartzFormatDegree(_e.y),c.x,lo.x,hi.x))*D;
  const y=(ay+quartzSingle(quartzFormatDegree(_e.x),c.y,lo.y,hi.y))*D;
  const z=(az+quartzSingle(quartzFormatDegree(_e.z),c.z,lo.z,hi.z))*D;
  if(s.composeType===0) quartzBendRoll(out,x,y,z);
  else if(s.composeType===1) quartzRollBend(out,x,y,z);
  else if(s.composeType===2) quartzMatrix(out,-x,-y,-z);
  else {
    quartzAxisEuler(_e,x,y,z); quartzQuaternion(out,_e.x,_e.y,_e.z,4);
    quartzEuler(_e,out,0); quartzQuaternion(out,_e.x*R,_e.y*R,_e.z*R,4);
  }
  quartzEuler(_e,out,s.rotationOrder);
  quartzExchange(_e,_e.x,_e.y,_e.z,s.rotateConnectionAxis);
  return quartzQuaternion(out,_e.x*R,_e.y*R,_e.z*R,4);
}

// Poncho CalcRotation 0x1809AE150: direction in parent-local coordinates.
export function quartzPonchoRotation(out,origin,parentWorldQuaternion,targetA,targetB,weight,bindDirection) {
  _v.set(targetA.x*weight+targetB.x*(1-weight)-origin.x,
    targetA.y*weight+targetB.y*(1-weight)-origin.y,
    targetA.z*weight+targetB.z*(1-weight)-origin.z);
  const length=_v.length();
  if(length>1e-5) _v.multiplyScalar(1/length); else _v.set(0,0,0);
  quartzInverse(_q,parentWorldQuaternion); _v.applyQuaternion(_q);
  return quartzUnityFromTo(out,bindDirection,_v);
}

// UnityEngine Quaternion.FromToRotation has different zero-vector semantics
// from the ActorAnimation helper above. Bindings call this engine variant.
export function quartzUnityFromTo(out,from,to) {
  const a=from.lengthSq(),b=to.lengthSq();
  if(a===0 || b===0) return out.identity();
  _unityFrom.copy(from).multiplyScalar(1/Math.sqrt(a));
  _unityTo.copy(to).multiplyScalar(1/Math.sqrt(b));
  return out.setFromUnitVectors(_unityFrom,_unityTo);
}
