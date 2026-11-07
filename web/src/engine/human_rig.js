import * as THREE from 'three';

// UnityPlayer 7A967673EA4F48258125F6D6920C5CDD1:
// HumanSetupAxes B7C450, SetupAxes B8D9A0, AxesUnproject B8A5B0,
// HumanComputeRootXform B7DAC0, HumanComputeBoneMassCenter B7D270.
// These are native default tables, not measurements fitted to one character.
const DEG = Math.PI / 180;
const IDENTITY = [0, 0, 0, 1];
const BODY = [
  'Hips', 'LeftUpperLeg', 'RightUpperLeg', 'LeftLowerLeg', 'RightLowerLeg',
  'LeftFoot', 'RightFoot', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head',
  'LeftShoulder', 'RightShoulder', 'LeftUpperArm', 'RightUpperArm',
  'LeftLowerArm', 'RightLowerArm', 'LeftHand', 'RightHand',
  'LeftToes', 'RightToes', 'LeftEye', 'RightEye', 'Jaw',
];
const MASS = [12, 10, 10, 4, 4, .8, .8, 2.5, 12, 12, 1, 4, .5, .5, 2, 2, 1.5, 1.5, .5, .5, .2, .2, 0, 0, 0];
// Native body table 181C6A710: [u.xyz, v.xyz, min.xyz, max.xyz, sign.xyz, axis override].
const AXES = [
  [[0,0,0],[-1,0,0],[-40,-40,-40],[40,40,40],[1,1,1],0],
  [[-.268,0,0],[1,0,0],[-60,-60,-90],[60,60,50],[1,1,1],0],
  [[-.268,0,0],[1,0,0],[-60,-60,-90],[60,60,50],[-1,-1,1],0],
  [[.839,0,0],[1,0,0],[-90,0,-80],[90,0,80],[1,1,-1],0],
  [[.839,0,0],[1,0,0],[-90,0,-80],[90,0,80],[-1,1,-1],0],
  [[0,0,0],[1,0,0],[0,-30,-50],[0,30,50],[1,1,1],-2],
  [[0,0,0],[1,0,0],[0,-30,-50],[0,30,50],[1,-1,1],-2],
  [[0,0,0],[-1,0,0],[-40,-40,-40],[40,40,40],[1,1,1],0],
  [[0,0,0],[-1,0,0],[-40,-40,-40],[40,40,40],[1,1,1],0],
  [[0,0,0],[-1,0,0],[-20,-20,-20],[20,20,20],[1,1,1],0],
  [[0,0,0],[-1,0,0],[-40,-40,-40],[40,40,40],[1,1,1],0],
  [[0,0,0],[-1,0,0],[-40,-40,-40],[40,40,40],[1,1,1],2],
  [[0,0,0],[0,0,1],[0,-15,-15],[0,15,30],[1,1,-1],0],
  [[0,0,0],[0,0,1],[0,-15,-15],[0,15,30],[1,1,1],0],
  [[0,.268,.364],[0,0,1],[-90,-100,-60],[90,100,100],[1,1,-1],0],
  [[0,-.268,-.364],[0,0,1],[-90,-100,-60],[90,100,100],[-1,1,1],0],
  [[0,.839,0],[0,1,0],[-90,0,-80],[90,0,80],[1,1,-1],0],
  [[0,-.839,0],[0,1,0],[-90,0,-80],[90,0,80],[-1,1,1],0],
  [[0,0,0],[0,0,1],[0,-40,-80],[0,40,80],[1,1,-1],0],
  [[0,0,0],[0,0,1],[0,-40,-80],[0,40,80],[1,1,1],0],
  [[0,0,0],[1,0,0],[0,0,-50],[0,0,50],[1,1,1],3],
  [[0,0,0],[1,0,0],[0,0,-50],[0,0,50],[1,1,1],3],
  [[0,0,0],[1,0,0],[0,-20,-10],[0,20,15],[1,1,-1],3],
  [[0,0,0],[1,0,0],[0,-20,-10],[0,20,15],[1,-1,-1],3],
  [[.09,0,0],[1,0,0],[0,-10,-10],[0,10,10],[1,1,-1],3],
];
// Native Human2SkeletonPose 181C6BB00 is stored z,y,x.
const MUSCLES = [
  [-1,-1,-1],[23,22,21],[31,30,29],[25,-1,24],[33,-1,32],
  [-1,27,26],[-1,35,34],[2,1,0],[5,4,3],[8,7,6],[11,10,9],[14,13,12],
  [-1,38,37],[-1,47,46],[41,40,39],[50,49,48],[43,-1,42],[52,-1,51],
  [-1,45,44],[-1,54,53],[-1,-1,28],[-1,-1,36],[-1,16,15],[-1,18,17],[-1,20,19],
];

export function mul(a, b) {
  const [x,y,z,w] = a, [X,Y,Z,W] = b;
  return [w*X+x*W+y*Z-z*Y, w*Y-x*Z+y*W+z*X, w*Z+x*Y-y*X+z*W, w*W-x*X-y*Y-z*Z];
}
export function inv(q) { return [-q[0],-q[1],-q[2],q[3]]; }
function norm(q) { const s = Math.hypot(...q); return q.map(v => v/s); }
export function rotate(q, v) {
  const [x,y,z,w] = q, [X,Y,Z] = v;
  const a=y*Z-z*Y, b=z*X-x*Z, c=x*Y-y*X;
  return [X+2*(w*a+y*c-z*b),Y+2*(w*b+z*a-x*c),Z+2*(w*c+x*b-y*a)];
}
const add = (a,b) => a.map((x,i) => x+b[i]);
const sub = (a,b) => a.map((x,i) => x-b[i]);
const scale = (a,s) => a.map(x => x*s);
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit = v => scale(v,1/Math.hypot(...v));
const average = (...v) => scale(v.reduce(add,[0,0,0]),1/v.length);
const radians = (m,lo,hi) => m < 0 ? -m*lo : m*hi;
function frame(x,y,z) {
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
    new THREE.Vector3(...x),new THREE.Vector3(...y),new THREE.Vector3(...z),
  )).normalize().toArray();
}

// Native type=1 ZYRoll: roll tangent x, coupled swing tangents y,z, w=1.
// This is NOT Euler XYZ, nor the old fitted ZY quaternion formula.
function muscleQuat(angles, sign) {
  const [x,y,z] = angles.map((a,i) => Math.tan(a*.5)*sign[i]);
  return norm([x,y+x*z,z-x*y,1]);
}
function project(q, sign, min, max) {
  if (q[3] < 0) q = q.map(x => -x);
  const x=q[0]/q[3], y=q[1]/q[3], z=q[2]/q[3], d=1+x*x;
  return [x,(y-x*z)/d,(z+x*y)/d].map((v,i) => {
    const angle=2*Math.atan(v)*sign[i];
    return angle < 0 ? (min[i] < 0 ? -angle/min[i] : 0) : (max[i] > 0 ? angle/max[i] : 0);
  });
}

/** Character-specific default HumanDescription constructed from the assembled rig.
 * No character calibration constants, height ratios, or neutral animation samples.
 * The input is the same humanoid map and unanimated skeleton used by BuildHumanAvatar.
 */
export class HumanRig {
  constructor(nodes, meta, bind) {
    this.bones = [];
    this.byName = new Map();
    this.byNode = new Map();
    this.tposeMuscles = new Float32Array(95);
    const makeBone = humanName => {
      const node = nodes.get(meta.humanoid?.[humanName]);
      if (!node) return null;
      const b = bind.get(node);
      const bone = { node, humanName, name: node.userData.skeletonName,
        position: [b.pos.x,b.pos.y,-b.pos.z],
        rotation: [b.quat.x,b.quat.y,-b.quat.z,-b.quat.w] };
      this.byNode.set(node,bone);
      this.byName.set(humanName,bone);
      this.bones.push(bone);
      return bone;
    };
    this.body = BODY.map(makeBone);
    for (const side of ['Left','Right']) for (const finger of ['Thumb','Index','Middle','Ring','Little']) {
      for (const segment of ['Proximal','Intermediate','Distal']) makeBone(`${side}${finger}${segment}`);
    }
    for (const bone of this.bones) {
      let parent=bone.node.parent;
      while (parent && !this.byNode.has(parent)) parent=parent.parent;
      bone.parent=this.byNode.get(parent) || null;
      const pq=bone.parent?.rotation || IDENTITY;
      bone.bindLocal=mul(inv(pq),bone.rotation);
    }
    const body=this.body;
    const first = (...ids) => ids.find(i => body[i]);
    const child=[7,3,4,5,6,null,null,first(8,9,10,11),first(9,10,11),first(10,11),11,
      first(10,8,7),14,15,16,17,18,19,16,17,5,6,null,null,null];
    const factors=[1,1,1,1,1,0,0,1,1,1,1,body[10]?-1:body[8]?-.5:-.25,1,1,1,1,1,1,-.5,-.5,.5,.5,.1,.1,.1];
    for (let i=0;i<body.length;i++) {
      if (!body[i]) continue;
      if (i===5 || i===6) factors[i]=-body[i].position[1];
      this.setup(body[i],body[child[i]],factors[i],AXES[i],MUSCLES[i],true);
    }
    for (let side=0;side<2;side++) for (let finger=0;finger<5;finger++) {
      const prefix=`${side===0?'Left':'Right'}${['Thumb','Index','Middle','Ring','Little'][finger]}`;
      const f=['Proximal','Intermediate','Distal'].map(s=>this.byName.get(prefix+s));
      for (let seg=0;seg<3;seg++) {
        if (!f[seg]) continue;
        const thumb=finger===0;
        const u=thumb ? (seg===0?[0,.125,.125]:[0,-.2,0]) : (seg===0?[0,[.08,.04,-.04,-.08][finger-1],.3]:[0,0,.33]);
        const spread=thumb?25:(finger===2||finger===3?7.5:20);
        const min=seg===0?[0,-spread,thumb?-20:-50]:[0,0,thumb?-40:-45];
        const max=seg===0?[0,spread,thumb?20:50]:[0,0,thumb?35:45];
        const sign=thumb ? [-1,seg===0?-1:1,1] : [-1,seg===0 && finger<=2?-1:1,-1];
        const target=seg===0?f[1]:(seg===1?(f[2]||f[0]):f[1]);
        const factor=seg===0||seg===1&&f[2]?1:-.75;
        const base=55+side*20+finger*4;
        this.setup(f[seg],target,factor,[u,thumb?[0,1,0]:[0,0,1],min,max,sign,0],
          [-1,seg===0?base+1:-1,base+(seg===0?0:seg+1)],side===0);
      }
    }
    this.mass=MASS.slice();
    for (const [from,to] of [[10,9],[12,9],[13,9],[9,8],[8,7],[20,5],[21,6]]) {
      if (!body[from]) { this.mass[to]+=this.mass[from]; this.mass[from]=0; }
    }
    this.center=this.massCenter(body.map(b=>b?.position));
    // HumanSetupAxes stores m_RootX.translation.y directly as m_Scale (B7C4BD).
    this.humanScale=this.center[1];
    if (!(this.humanScale>0)) throw new Error('Humanoid bind mass center must be above the actor origin');
    this.bodyRotation=this.orientation(body.map(b=>b?.position));
    this.comToHips=sub(body[0].position,this.center);
    this._muscles=new Float32Array(95);
  }

  setup(bone, child, factor, spec, muscles, left) {
    const [u,v,min,max,sign,axis]=spec;
    let x=[1,0,0], y=[0,0,1], z=[0,1,0];
    bone.length=Math.abs(factor);
    if (child) {
      const d=scale(sub(child.position,bone.position),factor), c=cross(v,d);
      if (Math.hypot(...d)>1e-15 && Math.hypot(...c)>1e-15) { x=unit(d); y=unit(c); z=cross(x,y); }
      if (Math.hypot(...d)>1e-15 && Math.hypot(...c)>1e-15) bone.length*=Math.hypot(...d);
    }
    if (axis) {
      const a=[0,0,0]; a[Math.abs(axis)-1]=Math.sign(axis);
      const c=cross(v,a);
      if (Math.hypot(...c)>1e-15) { x=a; y=unit(c); z=cross(x,y); }
    }
    const a=frame(x,y,z);
    bone.post=norm(mul(inv(bone.rotation),a));
    // SetupAxes B8DE1D: the table center quaternion multiplies A on the LEFT.
    bone.pre=norm(mul(inv(bone.parent?.rotation || IDENTITY),mul(norm([...u,left?1:-1]),a)));
    bone.sign=sign.map((s,i)=>s*(!left && i!==1?-1:1));
    bone.min=min.map(x=>x*DEG); bone.max=max.map(x=>x*DEG); bone.muscles=muscles;
    const m=project(mul(mul(inv(bone.pre),bone.bindLocal),bone.post),bone.sign,bone.min,bone.max);
    muscles.forEach((index,i)=> { if(index>=0) this.tposeMuscles[index]=m[i]; });
  }

  massCenter(p) {
    const c=p.slice(), avg=(...i)=>average(...i.map(j=>p[j]));
    c[0]=avg(1,2,7); c[1]=avg(1,3); c[2]=avg(2,4); c[3]=avg(3,5); c[4]=avg(4,6);
    c[7]=p[8]?avg(7,8):add(scale(p[7],.1),scale(add(p[14],p[15]),.45));
    c[8]=!p[8]?null:p[9]?avg(8,9):p[10]&&p[12]&&p[13]?avg(8,10,12,13):avg(8,14,15);
    c[9]=!p[9]?null:p[10]&&p[12]&&p[13]?avg(9,10,12,13):avg(9,14,15);
    if(p[10]) c[10]=avg(10,11);
    if(p[12]) c[12]=avg(12,14); if(p[13]) c[13]=avg(13,15);
    c[14]=avg(14,16); c[15]=avg(15,17); c[16]=avg(14,18); c[17]=avg(17,19);
    let total=0, result=[0,0,0];
    for(let i=0;i<25;i++) if(p[i] && this.mass[i]) { total+=this.mass[i]; result=add(result,scale(c[i],this.mass[i])); }
    return scale(result,1/total);
  }

  orientation(p) {
    const y=unit(sub(average(p[14],p[15]),average(p[1],p[2])));
    const across=unit(add(sub(p[2],p[1]),sub(p[15],p[14])));
    const z=cross(across,y), x=cross(y,z);
    return frame(x,y,z);
  }

  solve(muscles) {
    const m=this._muscles;
    for(let i=0;i<95;i++) m[i]=muscles?.[i] ?? this.tposeMuscles[i];
    // HumanPoseAdjustForMissingBones B7C8D0, including its asymmetric chest gain.
    const transfer=(from,to,gain=1)=> { m[to]+=m[from]*gain; m[from]=0; };
    if(!this.body[10]) for(let i=0;i<3;i++) transfer(9+i,12+i);
    if(!this.body[9]) for(let i=0;i<3;i++) transfer(6+i,3+i,.5);
    if(!this.body[8]) for(let i=0;i<3;i++) transfer(3+i,i);
    if(!this.body[12]) { transfer(37,39,.15); transfer(38,40,.28125); }
    if(!this.body[13]) { transfer(46,48,.15); transfer(47,49,.28125); }
    const worlds=new Map(), positions=new Map();
    const solve=bone=> {
      if(worlds.has(bone)) return worlds.get(bone);
      const parent=bone.parent, pq=parent?solve(parent):IDENTITY;
      const angles=bone.muscles.map((idx,i)=>radians(idx<0?0:m[idx],bone.min[i],bone.max[i]));
      const local=bone===this.body[0]?bone.bindLocal:mul(mul(bone.pre,muscleQuat(angles,bone.sign)),inv(bone.post));
      const q=norm(mul(pq,local)); worlds.set(bone,q);
      positions.set(bone,parent?add(positions.get(parent),rotate(mul(pq,inv(parent.rotation)),sub(bone.position,parent.position))):bone.position.slice());
      return q;
    };
    for(const bone of this.bones) solve(bone);
    return { worlds, positions };
  }
}
