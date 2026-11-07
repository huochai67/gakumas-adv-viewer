import { mul, inv } from './human_rig.js';
import { axesProject, axesUnproject } from './human_twist.js';

// UnityPlayer 7A967673EA4F48258125F6D6920C5CDD1. All vectors and XYZW
// quaternions are in Unity actor space, not the renderer's reflected space.
const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub = (a,b) => [a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const scale = (v,s) => v.map(x=>x*s);
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const length = v => Math.sqrt(dot(v,v));
const norm = q => scale(q,1/Math.sqrt(q[0]*q[0]+q[1]*q[1]+q[2]*q[2]+q[3]*q[3]));
// SSE min/max select the second operand for unordered comparisons.
const nativeMax = (a,b) => a>b?a:b;
const nativeMin = (a,b) => a<b?a:b;

function localFromWorld(state,bone,q) {
  // SkeletonPoseComputeLocal B8E1A0: inverse(parent global) * global.
  return bone.parent?norm(mul(inv(state.worldRotations.get(bone.parent)),q)):q;
}

function nlerp(a,b,t) {
  const sign=a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3]<0?-1:1;
  return norm(a.map((x,i)=>x+(sign*b[i]-x)*t));
}

function fromTo(a,b) {
  // B8CC50/B8D4E0 use this unguarded quaternion, not a fallback bend axis.
  const c=cross(a,b);
  return norm([c[0],c[1],c[2],dot(a,b)+Math.sqrt(dot(a,a)*dot(b,b))]);
}

function trigPolynomial(turns) {
  // The native SIMD sine/cosine polynomial, shared by B8CC50 and B34C80.
  const x=.25-Math.abs(turns-Math.trunc(turns)), x2=x*x, x4=x2*x2;
  return ((x2*-76.56862+81.60182)*x4+x2*-41.34166+6.283185+x4*x4*39.657032)*x;
}

function triangleAngle(opposite,a,b) {
  // B8CA80: law of cosines, clamped before the native atan polynomial.
  const cosine=nativeMin(nativeMax(((a*a+b*b)-opposite*opposite)/(a*b)/2,-1),1);
  const tangent=Math.abs(Math.sqrt(1-cosine*cosine)/cosine);
  // JS cannot issue RCPPS; retain both native Newton refinements after 1/x.
  // Ordinary finite results differ only by floating-point evaluation precision.
  const reciprocal=1/tangent;
  const refined=(2.0000005-tangent*reciprocal)*reciprocal;
  const x=tangent>1?refined*(2-tangent*refined):tangent;
  const x2=x*x, x4=x2*x2, x6=x4*x2, x8=x6*x2, x10=x8*x2;
  const angle=x*(x2*-.3332646+.99999946+x4*.19881524+x6*-.13487266+x8*.08387136+x10*-.037013143+x2*x10*.007862508);
  const acute=tangent>1?1.5707964-angle:angle;
  return cosine<0 || Object.is(cosine,-0)?3.1415927-acute:acute;
}

const powerFloat=new Float32Array(1);
const powerBits=new Int32Array(powerFloat.buffer);
function nativeFourthPower(x) {
  // B8CC50: exp2(4*log2(x)) approximations, not Math.pow(x,4).
  // 181D7E200 clamps the exponent to -127; the resulting zero exponent bits
  // deliberately make weight=1 produce an exact zero old-pose contribution.
  powerFloat[0]=x;
  const bits=powerBits[0], exponent=bits>>23;
  powerBits[0]=(bits&0x807fffff)|0x3f800000;
  const mantissa=powerFloat[0]-1;
  const log=(mantissa*mantissa*(mantissa*.19438113-.6322882)+(exponent-127)+mantissa*1.4379071)*4;
  const clamped=nativeMax(log,-127), integral=Math.floor(clamped), fraction=clamped-integral;
  powerBits[0]=(integral+127)*0x800000;
  return (fraction*.6822701+1+fraction*fraction*.31772992)*powerFloat[0];
}

/** Skeleton2BoneAdjustLength B8C870. Mutates lower/end local translations. */
export function adjustLimbLength(state,upper,lower,end,target,stretch) {
  const positions=state.worldPositions;
  const a=positions.get(upper), b=positions.get(lower), c=positions.get(end);
  const ratio=length(sub(target,a))/(length(sub(b,a))+length(sub(c,b)));
  if (1-stretch<ratio) {
    const t=nativeMin(1,nativeMax(0,(ratio-(1-stretch))/(stretch*2)));
    const factor=t*stretch*t+1;
    state.localPositions.set(lower,scale(state.localPositions.get(lower),factor));
    state.localPositions.set(end,scale(state.localPositions.get(end),factor));
    state.updateWorld();
  }
}

/** Skeleton2BoneIK B8CC50. Mutates upper/lower local rotations, not end rotation. */
export function solveLimbIK(state,upper,lower,end,target,weight) {
  const originalUpper=state.localRotations.get(upper);
  const originalLower=state.localRotations.get(lower);
  let prepared;
  if (lower.pre) {
    // SkeletonGetDoF B8C4D0 -> AxesProject B35090; AxesUnproject B8A5B0.
    // Native suppresses the lower swing-Y and retains 90% of swing-Z before IK.
    const dof=axesProject(lower,originalLower);
    prepared=axesUnproject(lower,[dof[0],dof[1]*0,dof[2]*.9]);
  } else {
    // SkeletonGetDoF's axes-index=-1 branch returns raw quaternion tangents.
    const divisor=Math.abs(originalLower[3])<1e-6?1e-6:originalLower[3];
    prepared=norm([originalLower[0]/divisor,(originalLower[1]/divisor)*0,(originalLower[2]/divisor)*.9,1]);
  }
  state.localRotations.set(lower,prepared);
  state.updateWorld();

  const a=state.worldPositions.get(upper), b=state.worldPositions.get(lower), c=state.worldPositions.get(end);
  const ab=sub(b,a), bc=sub(c,b), ac=sub(c,a), goal=sub(target,a);
  const aLength=length(ab), bLength=length(bc);
  const currentAngle=triangleAngle(length(ac),aLength,bLength);
  const targetAngle=triangleAngle(length(goal),aLength,bLength);
  const normal=cross(ab,bc), normalScale=1/length(normal);
  const turns=(currentAngle-targetAngle)*.5*.15915494;
  const sine=trigPolynomial(turns-.25), cosine=trigPolynomial(turns);
  const bend=[normal[0]*normalScale*sine,normal[1]*normalScale*sine,normal[2]*normalScale*sine,cosine];
  const lowerWorld=norm(mul(bend,state.worldRotations.get(lower)));
  const solvedLower=localFromWorld(state,lower,lowerWorld);
  state.localRotations.set(lower,nlerp(originalLower,solvedLower,weight));
  state.updateWorld();

  // Aim the upper only after the weighted lower has been recomputed globally.
  const direction=sub(state.worldPositions.get(end),state.worldPositions.get(upper));
  const upperWorld=mul(fromTo(direction,goal),state.worldRotations.get(upper));
  const solvedUpper=localFromWorld(state,upper,upperWorld);
  state.localRotations.set(upper,nlerp(solvedUpper,originalUpper,nativeFourthPower(1-weight)));
  state.updateWorld();
}

/** Skeleton2BoneAdjustHint B8D4E0, using FullBodySolve's .05 threshold. */
export function adjustLimbHint(state,upper,lower,end,hint,weight) {
  const a=state.worldPositions.get(upper), b=state.worldPositions.get(lower), c=state.worldPositions.get(end);
  const ac=sub(c,a), reach=length(ac);
  if (!(0<reach)) return;
  const axis=scale(ac,1/reach), ab=sub(b,a), ah=sub(hint,a);
  const bend=sub(ab,scale(axis,dot(ab,axis)));
  const desired=sub(ah,scale(axis,dot(ah,axis)));
  const bendLength=length(bend), desiredLength=length(desired);
  if (!(0<bendLength && 0<desiredLength)) return;
  // FullBodySolve B88A60 passes 0x3d4ccccd (.05) as the ninth argument.
  const threshold=(length(ab)+length(sub(c,b)))*.05;
  if (!(threshold<bendLength)) return;
  const twiceThreshold=threshold+threshold;
  const fade=bendLength<=twiceThreshold?1-(twiceThreshold-bendLength)/(twiceThreshold-threshold):1;
  const delta=fromTo(bend,desired), amount=weight*fade;
  // Native scales only quaternion xyz, retaining w; this is not slerp/nlerp.
  const weighted=[delta[0]*amount,delta[1]*amount,delta[2]*amount,delta[3]];
  const world=norm(mul(weighted,state.worldRotations.get(upper)));
  state.localRotations.set(upper,localFromWorld(state,upper,world));
  state.updateWorld();
}
