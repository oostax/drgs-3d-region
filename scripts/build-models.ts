/** Run: npx tsx scripts/build-models.ts [--check]. All inputs are local geometry. */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { LANDMARKS, LANDMARK_COORDINATES_VERIFIED_AT, LANDMARK_MODEL_ATTRIBUTION } from '../src/lib/landmarks';
import { createLandmarkModel, disposeLandmarkModel } from '../src/lib/landmark-models';

// GLTFExporter uses browser FileReader for Blob buffers; no DOM is needed for
// these texture-free meshes. Node's Blob supplies the underlying implementation.
class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;
  async readAsArrayBuffer(blob: Blob) { this.result = await blob.arrayBuffer(); this.onloadend?.(); }
  async readAsDataURL(blob: Blob) {
    this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
    this.onloadend?.();
  }
}
globalThis.FileReader ??= NodeFileReader as unknown as typeof FileReader;

async function main() {
  if (process.argv.includes('--preview')) {
    const { build } = await import('esbuild');
    await build({
      bundle: true, format: 'esm', minify: true, outfile: 'public/models/preview.js',
      stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
        import * as THREE from 'three';
        import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
        import { createLandmarkModel } from './src/lib/landmark-models';
        import { LANDMARKS } from './src/lib/landmarks';
        const canvas=document.querySelector('#canvas');
        const renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:true});
        renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor(0xe7ece4,0);
        renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.2;
        const panels=LANDMARKS.map((landmark,index)=>{
          const element=document.createElement('section');element.className='panel';
          element.innerHTML='<span class="number">0'+(index+1)+'</span><div class="label"><h2>'+landmark.name+'</h2><div class="meta">'+landmark.subtitle+'</div></div>';
          document.querySelector('#gallery').append(element);
          const scene=new THREE.Scene();scene.background=new THREE.Color(0xe7ece4);
          const model=createLandmarkModel(landmark.modelKind,'high');scene.add(model);
          const box=new THREE.Box3().setFromObject(model),sphere=box.getBoundingSphere(new THREE.Sphere());
          const camera=new THREE.PerspectiveCamera(38,1,0.1,3000);camera.up.set(0,0,1);
          camera.position.copy(sphere.center).add(new THREE.Vector3(1.15,-1.5,1.0).normalize().multiplyScalar(sphere.radius*3.4));
          const controls=new OrbitControls(camera,element);controls.target.copy(sphere.center);controls.enablePan=false;controls.minDistance=sphere.radius*1.5;controls.maxDistance=sphere.radius*6;controls.maxPolarAngle=Math.PI*.49;controls.update();
          scene.add(new THREE.HemisphereLight(0xeaf4ec,0x637f64,2.2));
          const sun=new THREE.DirectionalLight(0xffedcc,3);sun.position.set(-70,-95,140);scene.add(sun);
          const fill=new THREE.DirectionalLight(0xc9efed,1.2);fill.position.set(70,80,45);scene.add(fill);
          return {element,scene,camera,controls};
        });
        function render(){
          const width=innerWidth,height=innerHeight;
          if(canvas.width!==Math.round(width*renderer.getPixelRatio())||canvas.height!==Math.round(height*renderer.getPixelRatio()))renderer.setSize(width,height,false);
          renderer.setScissorTest(false);renderer.clear();renderer.setScissorTest(true);
          for(const p of panels){const r=p.element.getBoundingClientRect();if(r.bottom<0||r.top>height)continue;
            p.camera.aspect=r.width/r.height;p.camera.updateProjectionMatrix();
            renderer.setViewport(r.left,height-r.bottom,r.width,r.height);renderer.setScissor(r.left,height-r.bottom,r.width,r.height);renderer.render(p.scene,p.camera);
          }requestAnimationFrame(render);
        }render();
      ` },
    });
    console.log('Model preview: /models/preview.html');
    return;
  }
  const checkOnly = process.argv.includes('--check');
  const directory = path.join(process.cwd(), 'public/models');
  const manifest: Record<string, unknown>[] = [];
  if (!checkOnly) await mkdir(directory, { recursive: true });
  for (const landmark of LANDMARKS) {
    for (const detail of ['high', 'low'] as const) {
      const model = createLandmarkModel(landmark.modelKind, detail);
      model.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(model);
      const size = bounds.getSize(new THREE.Vector3()).toArray();
      const triangles = model.userData.triangles as number;
      const budget = detail === 'high' ? 300_000 : 30_000;
      if (!size.every(Number.isFinite) || size.some((value) => value <= 0) || Math.abs(bounds.min.z) > 0.01 || triangles > budget) {
        throw new Error(`Invalid geometry ${landmark.id}/${detail}: ${JSON.stringify({ size, triangles, min: bounds.min.toArray() })}`);
      }
      model.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          const array = object.geometry.getAttribute('position').array;
          for (const value of array) if (!Number.isFinite(value)) throw new Error(`Non-finite vertex: ${landmark.id}/${detail}`);
        }
      });
      const filename = `${landmark.id}-${detail}.glb`;
      let bytes = 0;
      if (!checkOnly) {
        // glTF convention is Y-up. The procedural API remains Z-up for MapLibre.
        const scene = new THREE.Scene();
        const axisConversion = new THREE.Group(); axisConversion.rotation.x = -Math.PI / 2;
        axisConversion.add(model); scene.add(axisConversion); scene.updateMatrixWorld(true);
        const binary = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: true });
        if (!(binary instanceof ArrayBuffer)) throw new Error('GLTFExporter did not produce GLB');
        bytes = binary.byteLength;
        await writeFile(path.join(directory, filename), Buffer.from(binary));
      }
      manifest.push({ id: landmark.id, kind: landmark.modelKind, detail, url: `/models/${filename}`, triangles, drawCalls: model.children.length, sizeMeters: size, glbUpAxis: 'Y', proceduralUpAxis: 'Z', bytes });
      console.log(`${landmark.id} ${detail}: ${triangles.toLocaleString('en-US')} triangles; ${model.children.length} instanced batches${bytes ? `; ${Math.round(bytes / 1024)} KiB` : ''}`);
      disposeLandmarkModel(model);
    }
  }
  if (!checkOnly) await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    attribution: LANDMARK_MODEL_ATTRIBUTION,
    coordinatesVerifiedAt: LANDMARK_COORDINATES_VERIFIED_AT,
    note: 'Original architectural interpretations. Footprint coordinates verified; decorative proportions approximate. GLB is Y-up. Runtime procedural API is Z-up.',
    landmarks: LANDMARKS,
    assets: manifest,
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
