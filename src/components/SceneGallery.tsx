'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import * as THREE from 'three';
import {ArrowLeft,Pause,Play,Search,RotateCcw,Plus,Minus,Maximize2} from 'lucide-react';
import {sceneCatalog,type SceneRecipe} from '@/lib/scene-catalog';
import {sceneStoryboard} from '@/lib/scene-storyboards';
import {createScenePreview} from '@/lib/map-signal-scenes';
import './scene-gallery.css';

function Preview({recipe,state,animate}:{recipe:SceneRecipe;state:string;animate:boolean}) {
 const host=useRef<HTMLDivElement>(null),controls=useRef({reset:()=>{},zoom:(_factor:number)=>{}}),[error,setError]=useState('');
 useEffect(()=>{
  const parent=host.current;if(!parent)return;
  let renderer:THREE.WebGLRenderer;
  try{renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});}catch{setError('3D недоступно. Рецепт и правила сцены показаны ниже.');return;}
  setError('');renderer.setPixelRatio(Math.min(devicePixelRatio,1.75));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;renderer.setClearColor('#e9eee5',1);renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;parent.appendChild(renderer.domElement);
  const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,2000);camera.up.set(0,0,1);
  const preview=createScenePreview(recipe,state);scene.add(preview.root);
  const sun=new THREE.DirectionalLight('#fff6e4',2.5);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);sun.shadow.bias=-.00025;sun.shadow.normalBias=.05;scene.add(sun,sun.target,new THREE.HemisphereLight('#f5fbff','#8b907b',1.8));
  const context=new THREE.Group(),contextGeometry=new THREE.BoxGeometry(1,1,1);
  const contextMaterials=['#d5c7ac','#526d70','#e9dfca','#536357','#fcf0cd'].map(color=>new THREE.MeshStandardMaterial({color,roughness:.85}));
  const box=(material:number,x:number,y:number,z:number,w:number,d:number,h:number)=>{const mesh=new THREE.Mesh(contextGeometry,contextMaterials[material]);mesh.position.set(x,y,z);mesh.scale.set(w,d,h);context.add(mesh);};
  const storyboard=sceneStoryboard(recipe);
  if(preview.attachment.type==='building'&&!storyboard?.selfContained){
   box(0,0,0,6,20,16,12);box(3,0,0,12.15,20.6,16.6,.3);
   for(const z of [2.5,5.5,8.5]){
    for(const x of [-7,-3.5,0,3.5,7])for(const y of [-8.04,8.04])box(1,x,y,z,1.5,.1,1.8);
    for(const y of [-5,-1.5,2,5.5])for(const x of [-10.04,10.04])box(1,x,y,z,.1,1.5,1.8);
    box(2,0,0,z+1.35,20.2,16.2,.16);
   }
   box(1,0,-8.1,1.2,1.7,.12,2.4);box(2,0,-9,2.6,3,2,.18);box(2,0,-9,.12,3,2,.24);
  }
  if(preview.attachment.type==='street'&&!storyboard?.selfContained){
   box(3,0,0,.02,44,7,.07);
   for(const y of [-4,4])box(2,0,y,.12,44,1.3,.22);
   for(let x=-20;x<21;x+=5)box(4,x,0,.065,2,.12,.012);
  }
  scene.add(context);
  const bounds=new THREE.Box3().setFromObject(preview.root).union(new THREE.Box3().setFromObject(context));
  if(bounds.isEmpty())bounds.set(new THREE.Vector3(-8,-6,0),new THREE.Vector3(8,6,8));
  const size=bounds.getSize(new THREE.Vector3()),target=bounds.getCenter(new THREE.Vector3());
  const floorGeometry=new THREE.BoxGeometry(Math.max(14,size.x+6),Math.max(12,size.y+6),.4),floorMaterial=new THREE.MeshStandardMaterial({color:'#c5d0b9',roughness:1});
  const floor=new THREE.Mesh(floorGeometry,floorMaterial);floor.position.set(target.x,target.y,Math.min(0,bounds.min.z)-.25);floor.receiveShadow=true;scene.add(floor);
  preview.root.traverse(object=>{if(object instanceof THREE.Mesh){object.castShadow=true;object.receiveShadow=true;}});
  context.traverse(object=>{if(object instanceof THREE.Mesh){object.castShadow=true;object.receiveShadow=true;}});
  const reach=Math.max(size.x,size.y,size.z,16);sun.position.copy(target).add(new THREE.Vector3(-reach*.65,-reach*.75,reach*1.8));sun.target.position.copy(target);Object.assign(sun.shadow.camera,{left:-reach,right:reach,top:reach,bottom:-reach,near:.1,far:reach*5});sun.shadow.camera.updateProjectionMatrix();
  parent.dataset.sceneStory=storyboard?.variant??recipe.family;parent.dataset.sceneBounds=JSON.stringify(size.toArray());
  let frame=0,last=0,stopped=false,angle=-.95,tilt=.56,zoom=1,down=false,previousX=0,previousY=0;
  const draw=()=>{if(stopped)return;renderer.render(scene,camera);};
  // Cache real model vertices. An axis-aligned box wastes space above streets and around cranes.
  const framingPoints:THREE.Vector3[]=[];
  scene.updateMatrixWorld(true);
  for(const root of [preview.root,context,floor])root.traverse(object=>{
   if(!(object instanceof THREE.Mesh))return;
   const positions=object.geometry.getAttribute('position');
   for(let index=0;index<positions.count;index++)framingPoints.push(new THREE.Vector3().fromBufferAttribute(positions,index).applyMatrix4(object.matrixWorld));
  });
  let aspect=1;
  const fit=()=>{
   const direction=new THREE.Vector3(Math.cos(angle)*Math.cos(tilt),Math.sin(angle)*Math.cos(tilt),Math.sin(tilt));
   camera.position.copy(target).add(direction);camera.lookAt(target);camera.updateMatrixWorld(true);
   const right=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,0),up=new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld,1);
   let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
   for(const point of framingPoints){const x=point.dot(right),y=point.dot(up);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
   const centre=right.clone().multiplyScalar((minX+maxX)/2).addScaledVector(up,(minY+maxY)/2).addScaledVector(direction,target.dot(direction));
   const halfHeight=Math.max(5,(maxY-minY)/2,(maxX-minX)/(2*aspect))*1.12*zoom;
   camera.left=-halfHeight*aspect;camera.right=halfHeight*aspect;camera.top=halfHeight;camera.bottom=-halfHeight;
   camera.position.copy(centre).addScaledVector(direction,Math.max(100,size.length()*4));camera.lookAt(centre);camera.updateProjectionMatrix();draw();
  };
  controls.current={reset:()=>{angle=-.95;tilt=.56;zoom=1;fit();},zoom:factor=>{zoom=Math.max(.55,Math.min(2,zoom*factor));fit();}};
  const resize=()=>{const w=parent.clientWidth,h=parent.clientHeight;renderer.setSize(w,h);aspect=w/Math.max(1,h);fit();};
  const observer=new ResizeObserver(resize);observer.observe(parent);resize();
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canAnimate=animate&&preview.animated&&!reduced;
  const loop=(now:number)=>{frame=0;if(stopped||document.hidden)return;if(now-last>=33){preview.update(now/1000);draw();last=now;}frame=requestAnimationFrame(loop);};
  const visibility=()=>{if(document.hidden){cancelAnimationFrame(frame);frame=0;}else if(canAnimate&&!frame){last=0;frame=requestAnimationFrame(loop);}};
  document.addEventListener('visibilitychange',visibility);visibility();
  const pointerDown=(e:PointerEvent)=>{down=true;previousX=e.clientX;previousY=e.clientY;renderer.domElement.setPointerCapture(e.pointerId);};
  const pointerMove=(e:PointerEvent)=>{if(!down)return;angle-=(e.clientX-previousX)*.006;tilt=Math.max(.15,Math.min(1.25,tilt+(e.clientY-previousY)*.004));previousX=e.clientX;previousY=e.clientY;fit();};
  const pointerUp=()=>{down=false;};
  renderer.domElement.addEventListener('pointerdown',pointerDown);renderer.domElement.addEventListener('pointermove',pointerMove);renderer.domElement.addEventListener('pointerup',pointerUp);
  return()=>{stopped=true;cancelAnimationFrame(frame);document.removeEventListener('visibilitychange',visibility);controls.current={reset:()=>{},zoom:()=>{}};observer.disconnect();preview.dispose();floorGeometry.dispose();floorMaterial.dispose();contextGeometry.dispose();contextMaterials.forEach(m=>m.dispose());sun.shadow.map?.dispose();renderer.dispose();renderer.domElement.remove();};
 },[recipe,state,animate]);
 return <div className="scene-preview"><div ref={host} className="scene-canvas" aria-label={`Демонстрация: ${recipe.topic}`}>{error&&<p role="status">{error}</p>}</div><div className="scene-camera-tools" aria-label="Камера сцены"><button aria-label="Приблизить сцену" onClick={()=>controls.current.zoom(.83)}><Plus size={18}/></button><button aria-label="Отдалить сцену" onClick={()=>controls.current.zoom(1.2)}><Minus size={18}/></button><button aria-label="Показать сцену целиком" onClick={()=>controls.current.reset()}><Maximize2 size={17}/></button><button aria-label="Сбросить поворот сцены" onClick={()=>controls.current.reset()}><RotateCcw size={17}/></button></div></div>;
}
export default function SceneGallery(){
 const [search,setSearch]=useState(''),[group,setGroup]=useState('Все группы'),[id,setId]=useState(sceneCatalog.recipes.find(r=>r.topic==='Возведение каркаса')?.id??sceneCatalog.recipes.find(r=>r.family==='road_work')?.id??sceneCatalog.recipes[0].id),[state,setState]=useState('in_progress'),[animate,setAnimate]=useState(true);
 useEffect(()=>{const topic=new URLSearchParams(location.search).get('topic');if(topic&&sceneCatalog.recipes.some(r=>r.id===topic))setId(topic);},[]);
 const groups=[...new Set(sceneCatalog.recipes.map(r=>r.group))];
 const filtered=useMemo(()=>sceneCatalog.recipes.filter(r=>(group==='Все группы'||r.group===group)&&(`${r.group} ${r.topic}`).toLocaleLowerCase('ru-RU').includes(search.toLocaleLowerCase('ru-RU'))),[search,group]);
 const recipe=sceneCatalog.recipes.find(r=>r.id===id)!;
 const storyboard=sceneStoryboard(recipe);
 return <main className="scene-gallery"><header><a href="/"><ArrowLeft size={17}/>К карте</a><h1>Галерея сцен</h1><p>247 тем обращений · 53 новостных сценария · версия {sceneCatalog.version}</p></header><div className="gallery-workspace"><aside className="gallery-index"><label className="gallery-search"><Search size={18}/><input aria-label="Найти тему" placeholder="Найти тему" value={search} onChange={e=>setSearch(e.target.value)}/></label><label className="gallery-group">Группа<select value={group} onChange={e=>setGroup(e.target.value)}><option>Все группы</option>{groups.map(g=><option key={g}>{g}</option>)}</select></label><p className="gallery-count">{filtered.length} тем</p><div className="gallery-topic-list">{filtered.map(r=><button key={r.id} aria-pressed={id===r.id} onClick={()=>setId(r.id)}><span>{r.topic}</span><small>{r.group}</small></button>)}{!filtered.length&&<p>Тем не найдено. Измените запрос.</p>}</div></aside><section className="gallery-stage"><div className="gallery-scene-title"><h2>{recipe.topic}</h2><button aria-label={animate?'Остановить анимацию':'Включить анимацию'} onClick={()=>setAnimate(v=>!v)}>{animate?<Pause size={18}/>:<Play size={18}/>}</button></div><p className="gallery-story">{storyboard?.summary}</p><Preview recipe={recipe} state={state} animate={animate}/><p className="gallery-demo-note">3D-иллюстрация темы. На карте используется геометрия связанного объекта. Перетащите для поворота.</p><div className="gallery-states" aria-label="Состояние события">{Object.entries({...sceneCatalog.states,archive:'Архивная иллюстрация'}).map(([value,label])=><button key={value} aria-pressed={state===value} onClick={()=>setState(value)}>{label}</button>)}</div><dl className="gallery-recipe"><div><dt>Семейство</dt><dd>{sceneCatalog.families[recipe.family as keyof typeof sceneCatalog.families].label}</dd></div><div><dt>Привязка</dt><dd>{recipe.geometry.map(g=>({building:'здание',site:'площадка',street:'улица'}[g])).join(', ')}</dd></div><div><dt>Проверка активности</dt><dd>Через {recipe.activityTtlHours>=24?`${recipe.activityTtlHours/24} дн.`:`${recipe.activityTtlHours} ч.`}</dd></div><div><dt>Если адрес не подтверждён</dt><dd>Тематическая сводка территории</dd></div></dl><p className="gallery-rule">Техника включается только при свежем подтверждении работ. Стадии строительства показываются по источнику. Отмена и закрытие обращения не подтверждают завершённый ремонт.</p></section></div></main>;
}
