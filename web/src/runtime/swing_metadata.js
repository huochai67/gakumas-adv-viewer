// Native GetChainLoopLength measures the assembled skeleton before animation.
// Both exporters use glTF coordinates; reflection leaves these distances unchanged.
export function setSwingChainRestLengths(nodes, chains) {
  const parents = new Int32Array(nodes.length).fill(-1);
  for (let i = 0; i < nodes.length; i++) {
    for (const child of nodes[i].children || []) parents[child] = i;
  }
  const positions = new Map();
  const position = (index) => {
    if (positions.has(index)) return positions.get(index);
    let x = 0, y = 0, z = 0;
    for (let i = index; i >= 0; i = parents[i]) {
      const node = nodes[i];
      const s = node.scale || [1, 1, 1];
      const q = node.rotation || [0, 0, 0, 1];
      const p = node.translation || [0, 0, 0];
      x *= s[0]; y *= s[1]; z *= s[2];
      const tx = 2 * (q[1] * z - q[2] * y);
      const ty = 2 * (q[2] * x - q[0] * z);
      const tz = 2 * (q[0] * y - q[1] * x);
      const nx = x + q[3] * tx + q[1] * tz - q[2] * ty + p[0];
      const ny = y + q[3] * ty + q[2] * tx - q[0] * tz + p[1];
      z += q[3] * tz + q[0] * ty - q[1] * tx + p[2];
      x = nx; y = ny;
    }
    const result = [x, y, z];
    positions.set(index, result);
    return result;
  };
  for (const chain of chains) {
    for (const layer of chain.layers) {
      let length = 0;
      const count = layer.nodes.length;
      const segments = layer.around ? count : Math.max(0, count - 1);
      for (let i = 0; i < segments; i++) {
        if (layer.nodes[i] < 0 || layer.nodes[(i + 1) % count] < 0) continue;
        const a = position(layer.nodes[i]);
        const b = position(layer.nodes[(i + 1) % count]);
        length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      }
      layer.restLength = length;
    }
  }
}
