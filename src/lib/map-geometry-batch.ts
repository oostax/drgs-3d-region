import * as THREE from 'three';

/** Refill an inactive batch without allocating or re-uploading its GPU storage.
 * The caller owns two sets (visible/staging) and swaps them only when complete.
 * All inputs are non-indexed, as produced by the facade geometry builders.
 */
export function refillGeometryBatch(previous: THREE.BufferGeometry | undefined, parts: readonly THREE.BufferGeometry[]) {
  if (!parts.length) return null;
  const names = Object.keys(parts[0].attributes);
  const count = parts.reduce((sum, part) => sum + part.getAttribute('position').count, 0);
  if (!count) return null;
  for (const part of parts) {
    if (part.index || Object.keys(part.attributes).length !== names.length || names.some(name => {
      const attribute = part.getAttribute(name), first = parts[0].getAttribute(name);
      return !attribute || attribute.itemSize !== first.itemSize || attribute.count !== part.getAttribute('position').count;
    })) throw new Error('Incompatible facade batch geometry');
  }
  const reusable = previous && previous.getAttribute('position').count >= count &&
    Object.keys(previous.attributes).length === names.length && names.every(name => previous.getAttribute(name)?.itemSize === parts[0].getAttribute(name).itemSize);
  const geometry = reusable ? previous : new THREE.BufferGeometry();
  if (!reusable) {
    previous?.dispose();
    // Bounded slack absorbs small camera changes without allocating exact-sized
    // buffers again. Cap is <1.5x current vertices, not an unbounded high-water mark.
    const capacity = Math.ceil(count * 1.2);
    for (const name of names) {
      const first = parts[0].getAttribute(name);
      geometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(capacity * first.itemSize), first.itemSize, first.normalized).setUsage(THREE.DynamicDrawUsage));
    }
  }
  for (const name of names) {
    const attribute = geometry.getAttribute(name) as THREE.BufferAttribute;
    let offset = 0;
    for (const part of parts) { const data = (part.getAttribute(name) as THREE.BufferAttribute).array; attribute.array.set(data, offset); offset += data.length; }
    attribute.clearUpdateRanges(); attribute.addUpdateRange(0, offset); attribute.needsUpdate = true;
  }
  geometry.setDrawRange(0, count);
  return geometry;
}
