import * as THREE from 'three';
import { seededRandom, stableHash } from './map-life-stability';

const smoothstep = (low: number, high: number, value: number) => { const t = Math.max(0, Math.min(1, (value - low) / (high - low))); return t * t * (3 - 2 * t); };

/** Altitudes are metres above the map's sea-level datum, with a generous roof clearance. */
export function safeCloudAltitude(terrain: number, highestRoof: number, layer = 0) {
  return Math.max(terrain + 900, highestRoof + 600) + layer * 110;
}

/** Clouds belong to the skyline; dissolve before close inspection or a camera/deck crossing. */
export function cloudVisibility(zoom: number, pitch: number, cameraAltitude: number, cloudAltitude: number) {
  if (![zoom, pitch, cameraAltitude, cloudAltitude].every(Number.isFinite)) return 0;
  return smoothstep(14.5, 15.2, zoom) * (1 - smoothstep(16.15, 17.15, zoom)) * smoothstep(18, 42, pitch) * smoothstep(180, 440, Math.abs(cameraAltitude - cloudAltitude));
}

let densityPixels: Uint8Array | null = null;
function densityTexture() {
  const size = 128;
  if (!densityPixels) {
    densityPixels = new Uint8Array(size * size * 4);
    const noise = (x: number, y: number) => {
      const ix = Math.floor(x), iy = Math.floor(y), fx = smoothstep(0, 1, x - ix), fy = smoothstep(0, 1, y - iy);
      const n = (a: number, b: number) => (stableHash(`${a}:${b}:cloud`) % 65536) / 65535;
      const a = n(ix, iy) * (1 - fx) + n(ix + 1, iy) * fx, b = n(ix, iy + 1) * (1 - fx) + n(ix + 1, iy + 1) * fx;
      return a * (1 - fy) + b * fy;
    };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const u = x / (size - 1) * 2 - 1, v = y / (size - 1) * 2 - 1;
      const broad = noise(u * 2.4 + 11, v * 2.4 + 19), fine = noise(u * 7.1 + 31, v * 7.1 + 17);
      const radius = Math.hypot(u, v), edge = 0.73 + broad * 0.17 + fine * 0.06;
      const density = (1 - smoothstep(edge - 0.38, edge, radius)) * (0.79 + broad * 0.14 + fine * 0.07);
      densityPixels.set([255, 255, 255, Math.round(Math.max(0, density) * 255)], (y * size + x) * 4);
    }
  }
  const texture = new THREE.DataTexture(densityPixels, size, size, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter; texture.generateMipmaps = true; texture.needsUpdate = true; return texture;
}

/** One cached 64 KiB density mask, no volume texture or raymarching. */
export function createCloudMaterial() {
  const texture = densityTexture();
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uDensity: { value: texture }, uRight: { value: new THREE.Vector3(1, 0, 0) }, uUp: { value: new THREE.Vector3(0, 0, 1) },
      uTowardCamera: { value: new THREE.Vector3(0, -1, 0) }, uSun: { value: new THREE.Vector3(0.4, -0.3, 0.85).normalize() },
      uOpacity: { value: 0 }, uNight: { value: 0 },
    },
    vertexShader: `
      attribute vec2 aSize;
      uniform vec3 uRight;
      uniform vec3 uUp;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec3 center = (modelMatrix * vec4(position, 1.0)).xyz;
        vec2 corner = uv * 2.0 - 1.0;
        vec3 world = center + uRight * corner.x * aSize.x + uUp * corner.y * aSize.y;
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D uDensity;
      uniform vec3 uRight;
      uniform vec3 uUp;
      uniform vec3 uTowardCamera;
      uniform vec3 uSun;
      uniform float uOpacity;
      uniform float uNight;
      varying vec2 vUv;
      void main() {
        float density = texture2D(uDensity, vUv).a;
        float alpha = density * uOpacity;
        if (alpha < 0.003) discard;
        vec2 p = vUv * 2.0 - 1.0;
        float front = sqrt(max(0.02, 1.0 - dot(p, p)));
        vec3 normal = normalize(uRight * p.x * 0.65 + uUp * p.y * 0.8 + uTowardCamera * front);
        float sun = max(0.0, dot(normal, uSun));
        float upper = smoothstep(-0.65, 0.7, normal.z);
        vec3 shade = mix(vec3(0.54, 0.62, 0.68), vec3(1.0, 0.985, 0.95), 0.25 + sun * 0.5 + upper * 0.25);
        vec3 night = mix(vec3(0.17, 0.23, 0.29), vec3(0.47, 0.55, 0.61), upper * 0.65 + sun * 0.35);
        gl_FragColor = vec4(mix(shade, night, uNight * 0.84), alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthTest: true, depthWrite: false, depthFunc: THREE.LessEqualDepth,
    side: THREE.DoubleSide, forceSinglePass: true, blending: THREE.NormalBlending,
  });
  material.name = 'atlas-soft-cloud-density'; material.addEventListener('dispose', () => texture.dispose()); return material;
}

/** Five overlapping soft puffs in real metre coordinates, batched into one draw. */
export function createCloudGroup(seed: string, material: THREE.ShaderMaterial, mobile = false) {
  const rng = seededRandom(stableHash(seed)), positions: number[] = [], uv: number[] = [], sizes: number[] = [];
  const count = mobile ? 4 : 6;
  for (let i = 0; i < count; i++) {
    const x = (i - (count - 1) / 2) * 50 + (rng() - 0.5) * 18, y = (rng() - 0.5) * 45;
    const z = Math.sin(i / (count - 1) * Math.PI) * 35 + (rng() - 0.5) * 12;
    const width = 57 + rng() * 31, height = 39 + rng() * 25;
    for (const corner of [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]]) { positions.push(x, y, z); uv.push(...corner); sizes.push(width, height); }
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 2));
  const cloud = new THREE.Mesh(geometry, material); cloud.frustumCulled = false; cloud.name = 'soft-cloud-puffs';
  const group = new THREE.Group(); group.name = seed; group.add(cloud); return group;
}

/** The map supplies a combined projection/view matrix, so ordinary THREE.Sprite billboarding is incorrect. */
export function updateCloudView(material: THREE.ShaderMaterial, inverseProjection: THREE.Matrix4) {
  const right = material.uniforms.uRight.value as THREE.Vector3, up = material.uniforms.uUp.value as THREE.Vector3, toward = material.uniforms.uTowardCamera.value as THREE.Vector3;
  const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(inverseProjection);
  right.set(1, 0, 0).applyMatrix4(inverseProjection).sub(origin).normalize();
  up.set(0, 1, 0).applyMatrix4(inverseProjection).sub(origin).normalize(); toward.crossVectors(right, up).normalize();
  return new THREE.Vector3(0, 0, -1).applyMatrix4(inverseProjection).z;
}
