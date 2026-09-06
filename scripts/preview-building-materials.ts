/** Visual fixture using the production geometry/materials, not a mockup of them. */
import * as THREE from 'three';
import { MercatorCoordinate } from 'maplibre-gl';
import { classifyBuilding, getBuildingLight, type BuildingProfileKind } from '../src/lib/building-materials';
import { makeFacadeTextures, applyGroundFloorTexture } from '../src/lib/building-facade-textures';
import { makeBuildingDetailGeometry } from '../src/lib/map-building-details';
import { loadFacadeArtwork } from '../src/lib/building-facade-artwork';
import { acquireBuildingSignageResources } from '../src/lib/building-signage';
import { getLightingState } from '../src/lib/solar';
import { createSportsDetails } from '../src/lib/map-sports-details';
import { worldPoint, WORLD_SPAN } from '../src/lib/map-life-stability';

const examples: [string, Record<string, unknown>][] = [
  ['Без указанного типа', {}], ['Жилая застройка', {class:'residential'}],
  ['Многоквартирный дом', {class:'apartments'}], ['Панельный дом', {class:'apartments',facade_material:'concrete_panels'}],
  ['Кирпичный дом', {class:'apartments',facade_material:'brick'}], ['Современный жилой дом', {class:'apartments',start_date:'2018'}],
  ['Частный дом', {class:'house'}], ['Офис', {class:'office'}], ['Коммерческое здание', {class:'commercial'}],
  ['Магазин', {class:'retail'}], ['Школа', {class:'school'}], ['Детский сад', {class:'kindergarten'}],
  ['Университет', {class:'university'}], ['Больница', {class:'hospital'}], ['Поликлиника', {class:'clinic'}],
  ['Медицина', {subtype:'medical'}], ['Промышленность', {class:'industrial'}], ['Склад', {class:'warehouse'}],
  ['Гараж', {class:'garage'}], ['Хозяйственная постройка', {class:'shed'}], ['Подсобное здание', {subtype:'outbuilding'}],
  ['Религиозное здание', {class:'church'}], ['Историческое здание', {historic:'yes'}], ['Техническое здание', {class:'service'}],
  ['Стадион / трибуна', {class:'stadium'}], ['Спортивный корпус', {class:'sports_hall'}], ['Общественное здание', {class:'government'}],
  ['Культурный объект', {class:'library'}], ['Гостиница', {class:'hotel'}], ['Транспортный объект', {class:'train_station'}],
  ['Сельхозпостройка', {class:'barn'}], ['Теплица', {class:'greenhouse'}],
];
async function main() {
await loadFacadeArtwork();
const renderer = new THREE.WebGLRenderer({antialias:true,alpha:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,1.5)); renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.toneMapping=THREE.ACESFilmicToneMapping; renderer.toneMappingExposure=1.06;
renderer.domElement.id='catalog-canvas'; document.body.append(renderer.domElement);
const grid=document.querySelector('#catalog')!;
const origin=MercatorCoordinate.fromLngLat([49.12,55.79]), unit=origin.meterInMercatorCoordinateUnits();
const coordinate=(x:number,y:number)=>{const p=new MercatorCoordinate(origin.x+x*unit,origin.y-y*unit).toLngLat();return [p.lng,p.lat];};
function tint(geometry:THREE.BufferGeometry,color:string){const c=new THREE.Color(color),data=new Float32Array(geometry.getAttribute('position').count*3);for(let i=0;i<data.length;i+=3)data.set([c.r,c.g,c.b],i);geometry.setAttribute('color',new THREE.BufferAttribute(data,3));return geometry;}
const signageResources = acquireBuildingSignageResources();
const focus = new URLSearchParams(location.search).get('family');
if(focus) document.body.classList.add('focus');
const models=examples.filter(([,tags])=>!focus||classifyBuilding(tags,336).kind===focus).map(([label,tags],index)=>{
  const kind=String(tags.class ?? tags.subtype ?? 'unknown');
  const low=['house','garage','shed','service','warehouse','greenhouse','barn','kindergarten','stadium','sports_hall'].includes(kind);
  let width=28, depth=15, floors=low?2:5;
  if(kind==='house'){width=14;depth=11;}
  if(kind==='office'||tags.start_date){width=22;depth=20;floors=8;}
  if(['warehouse','industrial','sports_hall','barn'].includes(kind)){width=42;depth=25;floors=kind==='industrial'?3:2;}
  if(kind==='school'||kind==='university'){width=48;depth=29;floors=kind==='school'?3:4;}
  if(kind==='kindergarten'){width=32;depth=23;}
  if(kind==='hospital'){width=48;depth=22;floors=6;}
  if(kind==='clinic'){width=32;depth=20;floors=3;}
  if(kind==='stadium'){width=180;depth=120;floors=3;}
  const outer: [number,number][] = kind==='school'||kind==='university'
    ? [[0,0],[width,0],[width,depth],[width-10,depth],[width-10,11],[10,11],[10,depth],[0,depth],[0,0]]
    : kind==='kindergarten' ? [[0,0],[width,0],[width,12],[12,12],[12,depth],[0,depth],[0,0]]
    : [[0,0],[width,0],[width,depth],[0,depth],[0,0]];
  const rings = [outer.map(([x,y])=>coordinate(x,y))];
  if(kind==='stadium') rings.push([[14,14],[14,depth-14],[width-14,depth-14],[width-14,14],[14,14]].map(([x,y])=>coordinate(x,y)));
  const profile=classifyBuilding({id:`sample-${index%3}`,height:floors*(kind==='industrial'?4:3.2),num_floors:floors,...tags},width*depth);
  const geometry=makeBuildingDetailGeometry(rings,profile,2);
  const textures=makeFacadeTextures(profile), scene=new THREE.Scene();
  const wall=new THREE.MeshStandardMaterial({map:textures.diffuse,normalMap:textures.normal,normalScale:new THREE.Vector2(.48,.48),emissive:'#fff4de',emissiveMap:textures.emissive,roughness:.86,vertexColors:true,side:THREE.DoubleSide});
  applyGroundFloorTexture(wall,profile);
  const roof=new THREE.MeshStandardMaterial({color:profile.roofColor,roughness:.86,side:THREE.DoubleSide});
  const accents=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.84,side:THREE.DoubleSide});
  scene.add(new THREE.Mesh(tint(geometry.walls,profile.facadeColor),wall),new THREE.Mesh(geometry.roof,roof),new THREE.Mesh(geometry.relief,accents));
  if(geometry.signage.getAttribute('position').count) {const sign=new THREE.Mesh(geometry.signage,signageResources.material);sign.renderOrder=10;scene.add(sign);}
  if(kind==='stadium') {
    const worldOrigin=worldPoint(coordinate(0,0)), localScale=1/(WORLD_SPAN*unit);
    scene.add(createSportsDetails([{type:'Feature',properties:{...tags,height:profile.height},geometry:{type:'Polygon',coordinates:rings}}],{mobile:false,center:worldOrigin,radius:1000,toLocal:p=>[(p[0]-worldOrigin[0])*localScale,(p[1]-worldOrigin[1])*localScale],terrain:()=>0}));
  }
  const sky=new THREE.HemisphereLight('#e8e8e2','#b4b5ac',1);sky.position.set(0,0,1);
  const sun=new THREE.DirectionalLight('#fff5df',2),fill=new THREE.DirectionalLight('#e5ebe7',0);scene.add(sky,sun,fill);
  const camera=new THREE.PerspectiveCamera(35,1,.1,1200);camera.up.set(0,0,1);const scale=Math.max(width,depth,profile.height*1.1);camera.position.set(width/2+scale*1.3,depth/2-scale*1.65,profile.height*.4+scale*1.08);if(focus) camera.position.lerp(new THREE.Vector3(width/2,depth/2,profile.height*.45),.38);camera.lookAt(width/2,depth/2,profile.height*.45);
  const article=document.createElement('article'), preview=document.createElement('div'), title=document.createElement('h2');
  preview.className='preview';const link=document.createElement('a');link.href=`?family=${profile.kind}`;link.textContent=label;title.append(link);article.append(preview,title);grid.append(article);
  article.dataset.family=profile.kind satisfies BuildingProfileKind;
  article.dataset.signage=JSON.stringify({count:geometry.signage.getAttribute('position').count,...geometry.signage.userData,positions:Array.from(geometry.signage.getAttribute('position').array)});
  return {scene,camera,preview,wall,sky,sun,fill};
});
let hour=12;
function render(){
  renderer.setSize(innerWidth,innerHeight);renderer.setClearColor(hour===0?'#273438':'#e5e9e2',1);renderer.setScissorTest(false);renderer.clear();renderer.setScissorTest(true);
  const state=getLightingState(hour,new Date('2026-09-04T12:00:00Z')),light=getBuildingLight(state);
  for(const model of models){
    const box=model.preview.getBoundingClientRect();if(box.bottom<0||box.top>innerHeight)continue;
    model.sky.intensity=light.ambientIntensity;model.sun.intensity=light.sunIntensity;model.sun.color.set(light.sunColor);
    model.sun.position.set(-45,-60,70);model.fill.intensity=state.nightAmount*.65;model.fill.position.set(-30,-40,30);
    model.wall.emissiveIntensity=light.warmWindows;model.camera.aspect=box.width/box.height;model.camera.updateProjectionMatrix();
    renderer.setViewport(box.left,innerHeight-box.bottom,box.width,box.height);renderer.setScissor(box.left,innerHeight-box.bottom,box.width,box.height);renderer.render(model.scene,model.camera);
  }
}
document.querySelectorAll<HTMLButtonElement>('[data-hour]').forEach(button=>button.addEventListener('click',()=>{
  hour=Number(button.dataset.hour);document.body.classList.toggle('night',hour===0);
  document.querySelectorAll('[data-hour]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));render();
}));
addEventListener('resize',render);addEventListener('scroll',render,{passive:true});render();

}
void main();
