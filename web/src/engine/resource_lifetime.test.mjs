import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'three') specifier = new URL('../../vendor/three.module.js', import.meta.url).href;
    else if (specifier.startsWith('three/addons/')) {
      specifier = new URL(`../../vendor/${specifier.slice('three/addons/'.length)}`, import.meta.url).href;
    }
    return nextResolve(specifier, context);
  },
});
globalThis.location = { search: '' };
globalThis.Audio = class extends EventTarget {};
const THREE = await import('../../vendor/three.module.js');
const { ViewerEngine } = await import('./ViewerEngine.js');

function stage(name) {
  const geometry = new THREE.PlaneGeometry();
  const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const material = new THREE.MeshBasicMaterial({ map: texture });
  const skyTarget = new THREE.WebGLRenderTarget(1, 1);
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
  const disposed = { geometry: 0, material: 0, texture: 0, sky: 0 };
  for (const [resource, key] of [[geometry, 'geometry'], [material, 'material'], [texture, 'texture'], [skyTarget, 'sky']]) {
    resource.addEventListener('dispose', () => disposed[key]++);
  }
  return { sceneName: name, group, textures: new Set([texture]), skyTexture: skyTarget.texture, skyTarget, disposed };
}

function engine() {
  const value = Object.create(ViewerEngine.prototype);
  Object.assign(value, {
    scene: new THREE.Scene(), env3dCache: new Map(), bgTextures: new Map(),
    bgImages: new Map(), bgMeta: {}, storyTimeline: null, assetSceneName: 'studio',
    envInfo: null, skyTexture: null, activeEnv3dName: null,
  });
  return value;
}

test('scene eviction releases shared GPU resources once and retains current asset/story scenes', () => {
  const e = engine();
  e.assetSceneName = 'asset';
  e.storyTimeline = { backgrounds: new Map([['bg', { src: 'story' }]]) };
  const old = stage('old'), asset = stage('asset'), story = stage('story');
  for (const entry of [old, asset, story]) {
    e.env3dCache.set(entry.sceneName, entry);
    e.scene.add(entry.group);
  }
  e.envInfo = old;
  e.skyTexture = old.skyTexture;
  e.scene.background = old.skyTexture;
  e.activeEnv3dName = 'old';
  e._pruneSceneResources();
  assert.deepEqual([...e.env3dCache.keys()], ['asset', 'story']);
  assert.deepEqual(old.disposed, { geometry: 1, material: 1, texture: 1, sky: 1 });
  assert.deepEqual(asset.disposed, { geometry: 0, material: 0, texture: 0, sky: 0 });
  assert.deepEqual(story.disposed, { geometry: 0, material: 0, texture: 0, sky: 0 });
  assert.equal(old.group.parent, null);
  assert.equal(e.envInfo, null);
  assert.equal(e.scene.background, null);
  e.storyTimeline = null;
  e._pruneSceneResources();
  assert.deepEqual([...e.env3dCache.keys()], ['asset']);
  assert.equal(story.disposed.sky, 1);
  assert.equal(old.disposed.sky, 1);
});

test('2D eviction revokes old blob URLs but keeps backgrounds needed for story seeking', async () => {
  const e = engine();
  e.storyTimeline = { backgrounds: new Map([['bg', { src: 'keep' }]]) };
  const urls = {};
  for (const name of ['old', 'keep']) {
    urls[name] = URL.createObjectURL(new Blob([name]));
    e.bgMeta[name] = { blobUrl: urls[name] };
    e.bgTextures.set(name, new THREE.Texture());
  }
  let disposed = 0;
  e.bgTextures.get('old').addEventListener('dispose', () => disposed++);
  try {
    e._pruneSceneResources();
    assert.equal(disposed, 1);
    assert.deepEqual(Object.keys(e.bgMeta), ['keep']);
    assert.deepEqual([...e.bgTextures.keys()], ['keep']);
    await assert.rejects(fetch(urls.old));
    assert.equal(await (await fetch(urls.keep)).text(), 'keep');
  } finally {
    for (const url of Object.values(urls)) URL.revokeObjectURL(url);
  }
});
