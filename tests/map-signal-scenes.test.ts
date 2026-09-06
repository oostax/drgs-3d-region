import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MercatorCoordinate } from 'maplibre-gl';
import type { Feature, Geometry, Polygon, Position } from 'geojson';
import { SignalSceneLayer, getScenePresentation, getSceneClosureGates, getSceneSiteLayout, getSceneVisibleRanges, getSceneViewportPoint, getSceneWorkZones, resolveSceneAttachment, type EventScene, type SceneAttachment, type SceneKind } from '../src/lib/map-signal-scenes';
import { getLightingState } from '../src/lib/solar';
import { SimulationClock } from '../src/lib/map-life-stability';

const kinds: SceneKind[] = ['construction', 'roads', 'utilities', 'landscaping', 'social', 'investment', 'culture'];
const origin = MercatorCoordinate.fromLngLat([49.12, 55.79]), unit = origin.meterInMercatorCoordinateUnits();
const metres = (x: number, y: number): [number, number] => { const point = new MercatorCoordinate(origin.x + x * unit, origin.y - y * unit).toLngLat(); return [point.lng, point.lat]; };
const rectangle = (x = 0, y = 0): Polygon => ({ type: 'Polygon', coordinates: [[metres(x - 12, y - 8), metres(x + 12, y - 8), metres(x + 12, y + 8), metres(x - 12, y + 8), metres(x - 12, y - 8)]] });
const building = (x = 0, y = 0, properties: Record<string, unknown> = { height: 18 }): Feature<Geometry> => ({ type: 'Feature', id: `building-${x}-${y}`, geometry: rectangle(x, y), properties });
const event = (id: string, kind: SceneKind = 'construction', precision: EventScene['precision'] = 'building', x = 0): EventScene => ({ id, title: id, kind, precision, coordinates: metres(x, 0), planned: false, lifecycle: { status: 'under_construction', asOf: new Date().toISOString(), sourceUrl: 'https://example.org/verified-current-event', currentStatusVerified: true, animationEligible: true, note: 'Current source fixture' } });
type Model = { root: THREE.Group; detail: THREE.Group; animated: boolean; update: (time: number) => void; dispose: () => void };
type Entry = { event: EventScene; attachment: SceneAttachment; model: Model; scene: THREE.Scene; projection: THREE.Matrix4 | null; phase: number };
type Internals = { map: unknown; renderer: unknown; entries: Map<string, Entry>; clock: SimulationClock; timer: ReturnType<typeof setTimeout> | null; settleTimer: ReturnType<typeof setTimeout> | null; dirty: boolean; entry: (event: EventScene, signature: string, attachment: SceneAttachment) => Entry; reconcile: () => void };
function setup(scenes: EventScene[] = [], mobile = false, reducedMotion = false, initialBuildings: Feature<Geometry>[] = [building()]) {
  let zoom = 16, enabled = true, animated = false, shifted = false, moving = false, currentScenes=scenes, features = initialBuildings;
  const layer = new SignalSceneLayer({ scenes: () => currentScenes, enabled: () => enabled, animate: () => animated, lighting: () => getLightingState(12), mobile, reducedMotion });
  const state = layer as unknown as Internals;
  state.map = { getZoom: () => zoom, isMoving:()=>moving, getTerrain: () => null, getSource: () => ({}), querySourceFeatures: (source: string, options: { sourceLayer: string }) => source === 'atlas-buildings' && options.sourceLayer === 'building' ? features : [], getCanvas: () => ({ clientWidth: 800, clientHeight: 600, width: 800, height: 600 }), project: () => ({ x: shifted ? 420 : 400, y: 300 }), triggerRepaint: () => {}, off: () => {} };
  return { layer, state, zoom: (value: number) => { zoom = value; }, enable: (value: boolean) => { enabled = value; }, animate: (value: boolean) => { animated = value; }, pan: () => { shifted = true; }, moving:(value:boolean)=>{moving=value;}, scenes:(value:EventScene[])=>{currentScenes=value;}, buildings: (value: Feature<Geometry>[]) => { features = value; } };
}

function withDocument(run: (document: { hidden: boolean }) => void) { const original = Object.getOwnPropertyDescriptor(globalThis, 'document'), document = { hidden: false, removeEventListener: () => {} }; Object.defineProperty(globalThis, 'document', { configurable: true, value: document }); try { run(document); } finally { if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document'); } }
const args = { defaultProjectionData: { mainMatrix: new THREE.Matrix4().toArray() } };
const renderer = () => ({ resetState: () => {}, setViewport: () => {}, render: (scene: THREE.Scene) => scene.updateMatrixWorld(true), dispose: () => {} });

test('one metre remains one metre from zoom 14 to 19; area signals never have a 3D scene', () => {
  for (const precision of ['building', 'site', 'street', 'territory', 'settlement'] as const) for (const zoom of [12, 14, 16.5, 19]) {
    const presentation = getScenePresentation(event(precision, 'social', precision), zoom);
    assert.equal(presentation.scale, 1); assert.deepEqual(presentation.offset, [0, 0, 0]); assert.equal(presentation.angle, 0);
    if (['territory', 'settlement'].includes(precision)) { assert.equal(presentation.visible, false); assert.equal(resolveSceneAttachment(event(precision, 'construction', precision), [building()]), null); }
  }
  const { layer, state } = setup([event('area', 'construction', 'territory'), event('town', 'social', 'settlement')]); state.reconcile(); assert.equal(state.entries.size, 0); layer.onRemove();
});

test('transient source features without geometry cannot disable every scene', () => {
  const scene = event('transient');
  assert.doesNotThrow(() => resolveSceneAttachment(scene, [
    { type: 'Feature', properties: {}, geometry: undefined } as unknown as Feature<Geometry>,
    building(),
  ]));
  assert.ok(resolveSceneAttachment(scene, [building()]));
});

test('buildings bind only to a containing real footprint and respect polygon holes', () => {
  assert.equal(resolveSceneAttachment(event('far'), [building(120, 0)]), null);
  const withHole = building(); (withHole.geometry as Polygon).coordinates.push([metres(-2, -2), metres(2, -2), metres(2, 2), metres(-2, 2), metres(-2, -2)]);
  assert.equal(resolveSceneAttachment(event('hole'), [withHole]), null);
  const attachment = resolveSceneAttachment(event('right'), [building(120), building()])!;
  assert.equal(attachment.sourceId, 'building-0-0'); assert.equal(attachment.height, 18); assert.equal(attachment.walls.length, 4);
  for (const point of attachment.path) { assert.ok(Math.abs(point[0]) <= 12.001); assert.ok(Math.abs(point[1]) <= 8.001); }
  assert.equal(resolveSceneAttachment(event('floors'), [building(0, 0, { num_floors: 4 })])!.height, 12);
  assert.equal(resolveSceneAttachment(event('unknown-height'), [building(0, 0, {})])!.height, 8);
  const part: Feature<Geometry> = { type: 'Feature', id: 'small-building-part', properties: { height: 4, atlasSceneFootprintRole: 'part' }, geometry: { type: 'Polygon', coordinates: [[metres(-3, -2), metres(3, -2), metres(3, 2), metres(-3, 2), metres(-3, -2)]] } };
  assert.equal(resolveSceneAttachment(event('whole-building'), [part, building()])!.sourceId, 'building-0-0', 'a porch or building part cannot shrink a scene intended for the whole linked building');
});

test('a confirmed site requires its own polygon and does not bind to a nearby residential building', () => {
  assert.equal(resolveSceneAttachment(event('school', 'social', 'site'), [building()]), null);
  const site = { ...event('school', 'social', 'site'), geometry: rectangle() };
  const attachment = resolveSceneAttachment(site, [building(30)])!;
  assert.equal(attachment.type, 'site'); assert.equal(attachment.height, 0);
  const { layer, state } = setup(); const entry = state.entry(site, 'site', attachment); entry.model.update(20); entry.model.root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(entry.model.root);
  assert.ok(bounds.max.z < 2, 'site has human-sized crew and pegs, not an invented school');
  let maximumTriangle = 0;
  entry.model.root.traverse((object) => { if (!(object instanceof THREE.Mesh)) return; const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry; const positions = geometry.getAttribute('position'); for (let index = 0; index < positions.count; index += 3) { const a = new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld), b = new THREE.Vector3().fromBufferAttribute(positions, index + 1).applyMatrix4(object.matrixWorld), c = new THREE.Vector3().fromBufferAttribute(positions, index + 2).applyMatrix4(object.matrixWorld); maximumTriangle = Math.max(maximumTriangle, new THREE.Triangle(a, b, c).getArea()); } if (geometry !== object.geometry) geometry.dispose(); });
  assert.ok(maximumTriangle < 1, 'no platform, broad ground plane, or replacement building');
  entry.model.dispose(); entry.scene.clear(); layer.onRemove();
});

test('street presentation covers the full linked road without turning its extent into a source claim', () => {
  const street = event('street', 'roads', 'street'), geometry: Geometry = { type: 'LineString', coordinates: [metres(-100, 10), metres(100, 10)] };
  const provided = resolveSceneAttachment({ ...street, geometry }, [building()], [])!;
  assert.equal(provided.type, 'street'); assert.ok(Math.abs(provided.length - 200) < 0.02);
  for (const [x, y] of provided.path) { assert.ok(Math.abs(x) <= 100.01); assert.ok(Math.abs(y - 10) < 0.01); }
  assert.equal(resolveSceneAttachment(street, [building()], []), null);
  const road: Feature<Geometry> = { type: 'Feature', id: 'road', properties: { class: 'residential' }, geometry };
  assert.equal(resolveSceneAttachment(street, [], [road])!.sourceId, 'road');
  assert.equal(resolveSceneAttachment(street, [], [{ ...road, geometry: { type: 'LineString', coordinates: [metres(-100, 70), metres(100, 70)] } }]), null);
  assert.equal(resolveSceneAttachment({ ...street, geometry }, [], [{ ...road, id: 'wrong-road', geometry: { type: 'LineString', coordinates: [metres(-100, 0), metres(100, 0)] } }])!.sourceId, 'verified:street');
});

test('source-backed accessories remain finite, bounded and do not reproduce whole buildings', () => {
  const { layer, state } = setup();
  for (const kind of kinds) { const scene = kind === 'roads' ? { ...event(kind, kind, 'street'), geometry: { type: 'LineString', coordinates: [metres(-30, 0), metres(30, 0)] } as Geometry } : event(kind, kind), attachment = resolveSceneAttachment(scene, [building()])!, entry = state.entry(scene, kind, attachment);
    for (const t of [0, 9, 1000]) { entry.model.update(t); entry.model.root.updateMatrixWorld(true); const bounds = new THREE.Box3().setFromObject(entry.model.root); assert.ok([...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)); assert.ok(bounds.max.x - bounds.min.x < 70); assert.ok(bounds.max.z < 46); if (kind !== 'construction') assert.ok(bounds.max.z < 4, `${kind}: no fabricated office, school or stage`); }
    entry.model.dispose(); entry.scene.clear();
  }
  layer.onRemove();
});

test('missing tiles suppress geometry until a matching footprint arrives, then preserve it through pan and LOD', () => {
  const { layer, state, buildings, pan, zoom } = setup([event('repair')], false, false, []); state.reconcile(); assert.equal(state.entries.size, 0);
  buildings([building()]); layer.refresh(); state.reconcile(); const before = state.entries.get('repair')!; assert.ok(before);
  state.clock.step(1000, true); state.clock.step(6000, true); pan(); zoom(19); buildings([]); layer.refresh(); state.reconcile();
  assert.equal(state.entries.get('repair'), before); assert.equal(state.clock.elapsed, 5); layer.onRemove();
});

test('camera motion defers reconciliation and cannot erase already visible scenes', () => {
  const {layer,state,moving,scenes}=setup([event('repair')]);
  state.reconcile();const before=state.entries.get('repair');assert.ok(before);
  moving(true);scenes([]);layer.refresh();state.reconcile();
  assert.equal(state.entries.get('repair'),before);
  moving(false);state.reconcile();assert.equal(state.entries.size,0);layer.onRemove();
});

test('a scene change during camera flight schedules a settled retry without a page reload', async () => {
  const first=event('first'), second=event('second');
  const {layer,state,moving,scenes}=setup([first]);state.reconcile();assert.ok(state.entries.has('first'));
  moving(true);scenes([second]);layer.refresh();state.reconcile();assert.ok(state.entries.has('first'));assert.ok(state.settleTimer);
  moving(false);await new Promise(resolve=>setTimeout(resolve,100));assert.equal(state.settleTimer,null);assert.equal(state.dirty,true);
  state.reconcile();assert.ok(state.entries.has('second'));assert.equal(state.entries.has('first'),false);layer.onRemove();
});

test('selecting an already cached signal rebuilds its focused scene', () => {
  const background=event('same-signal','roads','street');background.geometry={type:'LineString',coordinates:[metres(-120,0),metres(120,0)]};background.coverageMode='linked-object-illustration';background.recipe={family:'roads',topic:'Ремонт дороги',icon:'construction'};
  const {layer,state,scenes}=setup([background]);state.reconcile();const before=state.entries.get(background.id);assert.ok(before);assert.equal(Boolean(before.model.root.userData.focusedAtSignal),false);
  scenes([{...background,selected:true}]);layer.refresh();state.reconcile();const selected=state.entries.get(background.id);assert.ok(selected);assert.notEqual(selected,before);assert.equal(selected.model.root.userData.focusedAtSignal,true);layer.onRemove();
});

test('temporary source gaps retain an existing scene until grounded geometry returns', () => {
  const scene=event('repair');const {layer,state,buildings,scenes}=setup([scene]);
  state.reconcile();const before=state.entries.get('repair');assert.ok(before);
  scenes([{...scene,display:'archive'}]);buildings([]);layer.refresh();state.reconcile();
  assert.equal(state.entries.get('repair'),before);assert.equal(state.entries.get('repair')?.event.display,'archive');layer.onRemove();
});

test('desktop and mobile retain bounded source-backed working sets', () => {
  const scenes = Array.from({ length: 20 }, (_, index) => event(String(index), 'social', 'building', index * 50));
  for (const mobile of [false, true]) { const { layer, state } = setup(scenes, mobile, false, scenes.map((_, index) => building(index * 50))); state.reconcile(); assert.equal(state.entries.size, mobile ? 5 : 12); layer.onRemove(); assert.equal(state.entries.size, 0); }
});

test('render never inflates the physical model with zoom, reduced motion stays static, hidden tabs stop', () => withDocument((document) => {
  const { layer, state, animate, zoom } = setup([event('crane')], false, true); state.renderer = renderer(); animate(true);
  zoom(14); layer.render({} as never, args as never); const entry = state.entries.get('crane')!, before = entry.model.root.matrix.clone();
  zoom(19); layer.render({} as never, args as never); assert.deepEqual(entry.model.root.matrix.toArray(), before.toArray()); assert.deepEqual(entry.model.root.scale.toArray(), [1, 1, 1]); assert.deepEqual(entry.model.root.position.toArray(), [0, 0, 0]); assert.equal(state.timer, null); assert.equal(state.clock.elapsed, 0);
  document.hidden = true; layer.render({} as never, args as never); assert.equal(entry.projection, null); assert.equal(state.timer, null); layer.onRemove();
}));

test('disabled layer clears picking and cancels repaint callbacks', () => { const { layer, state, enable } = setup([event('repair')]); state.reconcile(); const entry = state.entries.get('repair')!; entry.projection = new THREE.Matrix4(); state.timer = setTimeout(() => assert.fail('paused callback fired'), 200); state.renderer = renderer(); enable(false); layer.render({} as never, {} as never); assert.equal(state.timer, null); assert.equal(entry.projection, null); layer.onRemove(); });

test('render failure resets shared GL state and stops further frames', () => withDocument(() => { const { layer, state } = setup([event('repair')]); let resets = 0, renders = 0; state.renderer = { ...renderer(), resetState: () => { resets++; }, render: () => { renders++; throw new Error('context failure'); } }; layer.render({} as never, args as never); assert.equal(resets, 2); assert.equal(renders, 1); assert.equal(state.timer, null); layer.render({} as never, args as never); assert.equal(renders, 1); layer.onRemove(); }));

test('non-work topics never acquire roadwork cones or a maintenance vehicle from a street attachment', () => {
  const { layer, state } = setup();
  const cases: [NonNullable<EventScene['topic']>, NonNullable<EventScene['icon']>, string][] = [['social','hand-heart','social-assistance'],['social','accessibility','accessible-assistance'],['education','school','education-arrival'],['health','heart-pulse','medical-assistance']];
  const orange = new THREE.Color('#dc8550');
  for(const [topic,icon,effect] of cases) {
    const scene: EventScene={...event(topic,'social','street'),topic,icon,geometry:{type:'LineString',coordinates:[metres(-50,0),metres(50,0)]}};
    const attachment=resolveSceneAttachment(scene)!;const entry=state.entry(scene,topic,attachment);entry.model.update(2);entry.model.root.updateMatrixWorld(true);
    assert.equal(entry.model.root.userData.effect,effect);
    const bounds=new THREE.Box3().setFromObject(entry.model.root);assert.ok(bounds.max.x-bounds.min.x<5);assert.ok(bounds.max.z<2,'people and small accessories stay at human scale');
    entry.model.root.traverse(object=>{if(object instanceof THREE.Mesh){const materials=Array.isArray(object.material)?object.material:[object.material];for(const material of materials)assert.ok(!(material as THREE.MeshStandardMaterial).color.equals(orange),'no generic orange cones or work van');}});
    entry.model.dispose();entry.scene.clear();
  }
  for(const [icon,effect] of [['droplets','water-maintenance'],['heater','heating-maintenance'],['zap','power-maintenance']] as const){const scene={...event(icon,'utilities'),icon};const entry=state.entry(scene,icon,resolveSceneAttachment(scene,[building()])!);assert.equal(entry.model.root.userData.effect,effect);entry.model.dispose();entry.scene.clear();}
  layer.onRemove();
});

test('unverified or expired activity creates no physical meshes and revokes an existing scene', () => {
  const active=event('repair');const {layer,state}=setup([active]);state.reconcile();assert.equal(state.entries.size,1);
  active.lifecycle={...active.lifecycle!,animationEligible:false};state.reconcile();assert.equal(state.entries.size,0);
  const variants=[{...active,lifecycle:undefined},{...active,lifecycle:{...active.lifecycle!,animationEligible:true,asOf:new Date(Date.now()-31*86_400_000).toISOString()}}];
  for(const scene of variants){assert.equal(getScenePresentation(scene,19).visible,false);const entry=state.entry(scene,'inactive',resolveSceneAttachment(scene,[building()])!);let meshes=0;entry.model.root.traverse(object=>{if(object instanceof THREE.Mesh)meshes++;});assert.equal(meshes,0);entry.model.dispose();entry.scene.clear();}
  const point={...event('unlocated-site','construction','site'),geometry:{type:'Point',coordinates:metres(0,0)} as Geometry};assert.equal(resolveSceneAttachment(point,[building()]),null);
  assert.equal(resolveSceneAttachment({...point,geometry:rectangle(100)},[]),null,'a distant first polygon must never be accepted as the site');
  layer.onRemove();
});

test('static reports render a bounded symbol without starting equipment motion', () => {
  const line: Geometry={type:'LineString',coordinates:[metres(-30,0),metres(30,0)]};
  const scene:EventScene={...event('defect','road_defect','street'),display:'static',activityKind:'road_defect',geometry:line,
    live:{regionId:'RU-TA',topic:'Дороги',state:'reported',severity:'medium',confidence:'low',sourceKind:'community',eventTime:new Date(Date.now()-60_000).toISOString(),lastEvidenceAt:new Date().toISOString(),lastMeaningfulAt:new Date(Date.now()-60_000).toISOString(),ongoing:true,locationConfidence:'street',evidenceCount:1,duplicateCount:0,revision:1,activityKind:'road_defect',explicitActivity:false,notifyEligible:false}};
  assert.equal(getScenePresentation(scene,16).visible,true);
  const {layer,state}=setup();const attachment=resolveSceneAttachment(scene)!;const entry=state.entry(scene,'static',attachment);
  let meshes=0;entry.model.root.traverse(object=>{if(object instanceof THREE.Mesh)meshes++;});
  assert.ok(meshes>0);assert.equal(entry.model.animated,false);assert.equal(entry.model.root.userData.effect,'reported-road-defect');
  const bounds=new THREE.Box3().setFromObject(entry.model.root);assert.ok(bounds.max.z<1);
  entry.model.dispose();entry.scene.clear();layer.onRemove();
});

test('explicit community road repair can animate without claiming official origin', () => {
  const meaningful=new Date(Date.now()-60_000).toISOString(),line:Geometry={type:'LineString',coordinates:[metres(-30,0),metres(30,0)]};
  const scene:EventScene={...event('community-repair','road_repair','street'),display:'active',activityKind:'road_repair',geometry:line,
    live:{regionId:'RU-TA',topic:'Дороги',state:'in_progress',severity:'high',confidence:'low',sourceKind:'community',eventTime:meaningful,lastEvidenceAt:new Date().toISOString(),lastMeaningfulAt:meaningful,ongoing:true,locationConfidence:'street',evidenceCount:2,duplicateCount:0,revision:1,activityKind:'road_repair',explicitActivity:true,notifyEligible:false}};
  const {layer,state}=setup();const entry=state.entry(scene,'active',resolveSceneAttachment(scene)!);
  assert.equal(entry.model.animated,true);assert.equal(entry.model.root.userData.effect,'road-maintenance');
  entry.model.dispose();entry.scene.clear();layer.onRemove();
});


test('whole-street scenes retain every supplied section without bridging gaps',()=>{
 const subject={...event('whole-road','roads','street'),entireStreet:true,geometry:{type:'MultiLineString',coordinates:[[metres(0,0),metres(100,0)],[metres(200,0),metres(300,0)]]} as Geometry};
 const attachment=resolveSceneAttachment(subject);
 assert.ok(attachment);assert.equal(attachment.walls.length,2);
 assert.ok(Math.abs(attachment.length-200)<.01);
 const local=resolveSceneAttachment({...subject,entireStreet:false});
 assert.ok(local&&Math.abs(local.length-200)<.01,'linked-object illustration retains full source geometry even when work extent is unspecified');
});

test('whole-road crews cover separate sections while meshes and animation have a bounded budget', () => {
  const scene: EventScene = { ...event('long-repair', 'roads', 'street'), entireStreet: true, geometry: { type: 'MultiLineString', coordinates: [[metres(0, 0), metres(600, 0)], [metres(800, 0), metres(1400, 0)]] } };
  const attachment = resolveSceneAttachment(scene)!;
  assert.ok(attachment);
  for (const mobile of [false, true]) {
    const zones = getSceneWorkZones(attachment, mobile);
    assert.equal(zones.length, mobile ? 8 : 12);
    assert.ok(zones.some(zone => zone.center < 600) && zones.some(zone => zone.center > 600));
    for (const zone of zones) assert.ok(zone.end <= 600.01 || zone.start >= 599.99, 'a crew stays in one source section');
    const { layer, state } = setup([], mobile), entry = state.entry(scene, 'long', attachment);
    entry.model.update(20); entry.model.root.updateMatrixWorld(true);
    assert.equal(entry.model.root.userData.workZones, mobile ? 8 : 12);
    assert.equal(entry.model.root.userData.sourceScope, 'whole-street');
    let meshes = 0, verticesInGap = 0;
    entry.model.root.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      meshes++;
      const position = object.geometry.getAttribute('position');
      for (let index = 0; index < position.count; index++) {
        const point = new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld);
        if (point.x > 605 && point.x < 795) verticesInGap++;
      }
    });
    assert.ok(meshes <= 64, `${meshes} meshes exceeds the street draw-call budget`);
    assert.equal(verticesInGap, 0, 'no road surface, equipment or worker connects the two supplied road sections');
    entry.model.dispose(); entry.scene.clear(); layer.onRemove();
  }
  assert.equal(resolveSceneAttachment({ ...scene, coordinates: metres(0, 500) }), null, 'whole-street geometry must still match the event');
});

test('utility work spans the actual facade and only explicit excavation creates a trench', () => {
  const { layer, state } = setup();
  for (const excavationConfirmed of [false, true]) {
    const scene: EventScene = { ...event('water', 'utilities'), icon: 'droplets', excavationConfirmed };
    const entry = state.entry(scene, 'water', resolveSceneAttachment(scene, [building()])!);
    entry.model.update(2); entry.model.root.updateMatrixWorld(true);
    assert.equal(entry.model.root.userData.placement, 'building-perimeter');
    assert.equal(entry.model.root.userData.excavation, excavationConfirmed);
    assert.ok(entry.model.root.userData.spanMetres >= 79);
    assert.ok(entry.model.root.userData.workZones >= 4);
    const bounds = new THREE.Box3().setFromObject(entry.model.root);
    assert.ok(bounds.max.x - bounds.min.x >= 16, 'the service area covers a meaningful part of the facade');
    assert.ok(bounds.max.z < 4, 'the service scene keeps real vehicle and human dimensions');
    entry.model.dispose(); entry.scene.clear();
  }
  layer.onRemove();
});

test('construction layouts keep equipment inside concave sites and avoid holes', () => {
  const geometry: Polygon = { type: 'Polygon', coordinates: [[metres(-40, -30), metres(40, -30), metres(40, 30), metres(8, 30), metres(8, 0), metres(-40, 0), metres(-40, -30)], [metres(15, -20), metres(25, -20), metres(25, -10), metres(15, -10), metres(15, -20)]] };
  const scene: EventScene = { ...event('site-work', 'construction', 'site'), coordinates: metres(0, -15), geometry };
  const attachment = resolveSceneAttachment(scene)!;
  assert.equal(attachment.holes?.length, 1);
  const pads = getSceneSiteLayout(attachment);
  assert.ok(pads.length >= 3);
  for (const pad of pads) {
    const worldX = pad.x, worldY = pad.y - 15;
    assert.ok(worldY < 0 || worldX > 8, 'no placement inside the missing corner of an L-shaped parcel');
    assert.ok(worldX < 15 || worldX > 25 || worldY < -20 || worldY > -10, 'no equipment in a courtyard hole');
    assert.ok(pad.clearance >= 1.2);
  }
  const { layer, state } = setup(), entry = state.entry(scene, 'site', attachment);
  assert.equal(entry.model.root.userData.placement, 'confirmed-site-footprint');
  assert.ok(entry.model.root.userData.workZones >= 3);
  entry.model.dispose(); entry.scene.clear(); layer.onRemove();
});

test('a whole street stays visible as the camera leaves its address marker, without treating gaps as roads', () => {
  const scene: EventScene = { ...event('viewport-road', 'roads', 'street'), coordinates: [-200, 300], entireStreet: true, geometry: { type: 'LineString', coordinates: [[-200, 300], [1100, 300]] } };
  const project = ([x, y]: [number, number]) => ({ x, y });
  assert.ok(getSceneViewportPoint(scene, project, 800, 600));
  assert.ok(getSceneViewportPoint({ ...scene, entireStreet: false }, project, 800, 600));
  assert.equal(getSceneViewportPoint({ ...scene, geometry: { type: 'MultiLineString', coordinates: [[[-200, 300], [-100, 300]], [[950, 300], [1100, 300]]] } }, project, 800, 600), null);
});

test('a long linked street concentrates detailed work inside the visible camera section', () => {
  const scene: EventScene = { ...event('long-viewport-work', 'roads', 'street'), geometry: { type: 'LineString', coordinates: [metres(0, 0), metres(14000, 0)] }, coverageMode: 'linked-object-illustration' };
  const attachment = resolveSceneAttachment(scene)!;
  const project = (point: [number, number]) => { const coordinate = MercatorCoordinate.fromLngLat(point); return { x: ((coordinate.x - origin.x) / unit - 7000) * 2 + 400, y: 300 }; };
  attachment.visibleRanges = getSceneVisibleRanges(attachment, scene.coordinates, project, 800, 600);
  const zones = getSceneWorkZones(attachment);
  assert.ok(zones.length >= 3 && zones.length <= 12);
  assert.ok(zones.every(zone => zone.center > 6780 && zone.center < 7220), 'equipment belongs to the currently visible 435 m, not six remote locations on the 14 km road');
  const { layer, state } = setup(), entry = state.entry(scene, 'camera-work', attachment);
  assert.equal(entry.model.root.userData.coverageMode, 'linked-object-illustration');
  assert.equal(entry.model.root.userData.workZones, zones.length);
  assert.ok(entry.model.root.userData.spanMetres > 13999);
  entry.model.dispose(); entry.scene.clear(); layer.onRemove();
});

test('a street scene keeps its verified geometry when the camera pan or zoom changes', () => {
  const scene: EventScene = { ...event('fixed-road', 'roads', 'street'), geometry: { type: 'LineString', coordinates: [metres(-190, 0), metres(190, 0)] } };
  const { layer, state } = setup([scene]);
  state.reconcile();
  const before = state.entries.get(scene.id)!;
  assert.ok(before);
  const map = state.map as { project: (coordinates: [number, number]) => { x: number; y: number } };
  map.project = () => ({ x: 620, y: 260 });
  layer.refresh(); state.reconcile();
  const after = state.entries.get(scene.id)!;
  assert.equal(after, before, 'camera position does not replace the signal scene');
  assert.equal(after.model, before.model, 'the same fixed roadwork geometry remains attached to the signal');
  assert.equal(after.attachment.visibleRanges, undefined);
  layer.onRemove();
});

test('a selected street with unknown work boundaries focuses one visible scene at the signal', () => {
  const scene: EventScene = { ...event('selected-road', 'roads', 'street'), selected: true, coverageMode: 'linked-object-illustration', geometry: { type: 'LineString', coordinates: [metres(-1200, 0), metres(1200, 0)] } };
  const attachment = resolveSceneAttachment(scene)!;
  const { layer, state } = setup(), entry = state.entry(scene, 'selected-road', attachment);
  assert.equal(entry.model.root.userData.focusedAtSignal, true);
  assert.equal(entry.model.root.userData.workZones, 1);
  const focus = entry.model.root.userData.workZoneChainages[0];
  assert.ok(Math.abs(focus - attachment.length / 2) < 60, 'work composition stays beside the selected address anchor');
  entry.model.dispose(); entry.scene.clear(); layer.onRemove();
});

test('an old explicit repair keeps a full static work composition instead of a miniature exhibit', () => {
  const scene: EventScene = { ...event('old-work', 'roads', 'street'), lastKnownWork: true, display: 'archive', coverageMode: 'linked-object-illustration', geometry: { type: 'LineString', coordinates: [metres(-400, 0), metres(400, 0)] } };
  const { layer, state } = setup(), entry = state.entry(scene, 'archive-work', resolveSceneAttachment(scene)!);
  assert.equal(entry.model.root.userData.presentation, 'last-known-stage-illustration');
  assert.equal(entry.model.root.userData.effect, 'road-maintenance');
  assert.equal(entry.model.animated, false);
  assert.ok(entry.model.root.userData.workZones >= 8);
  entry.model.root.updateMatrixWorld(true);
  const before = new THREE.Box3().setFromObject(entry.model.root);
  assert.ok(before.max.x - before.min.x >= 799);
  entry.model.update(100); entry.model.root.updateMatrixWorld(true);
  assert.deepEqual(new THREE.Box3().setFromObject(entry.model.root), before);
  entry.model.dispose(); entry.scene.clear(); layer.onRemove();
});

test('planned road restrictions retain asphalt and use sparse entry gates without paint or repetitive arrows', () => {
  const scene: EventScene = { ...event('planned-closure', 'roads', 'street'), planned: true, display: 'static', recipe: { family: 'traffic', topic: 'Ограничение движения', icon: 'construction' }, geometry: { type: 'LineString', coordinates: [metres(-150, 0), metres(150, 0)] } };
  const { layer, state } = setup(), entry = state.entry(scene, 'closure', resolveSceneAttachment(scene)!);
  assert.equal(entry.model.root.userData.effect, 'planned-road-restriction');
  assert.equal(entry.model.animated, false);
  assert.ok(entry.model.root.userData.spanMetres >= 299);
  assert.ok(entry.model.root.userData.workZones >= 1 && entry.model.root.userData.workZones <= 3);
  assert.equal(entry.model.root.userData.roadSurface, 'unchanged');
  const bounds = new THREE.Box3().setFromObject(entry.model.root);
  assert.ok(bounds.max.x - bounds.min.x >= 299);
  assert.ok(bounds.max.z < 3.5, 'closure consists of entry gates and road signs, not working machinery');
  let largestTriangle = 0;
  entry.model.root.updateMatrixWorld(true);
  entry.model.root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const positions = object.geometry.getAttribute('position');
    for (let index = 0; index < positions.count; index += 3) {
      const a = new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld), b = new THREE.Vector3().fromBufferAttribute(positions, index + 1).applyMatrix4(object.matrixWorld), c = new THREE.Vector3().fromBufferAttribute(positions, index + 2).applyMatrix4(object.matrixWorld);
      largestTriangle = Math.max(largestTriangle, new THREE.Triangle(a, b, c).getArea());
    }
  });
  assert.ok(largestTriangle < 6, 'no full road surface ribbon remains in a closure composition');
  entry.model.dispose(); entry.scene.clear(); layer.onRemove();
});

test('work surfaces follow the terrain at their own vertices rather than the height of a distant marker', () => {
  const scene: EventScene = { ...event('sloped-work', 'roads', 'street'), geometry: { type: 'LineString', coordinates: [metres(0, 0), metres(400, 0)] } };
  const attachment = resolveSceneAttachment(scene)!; attachment.heightAt = x => x * 0.05;
  const { layer, state } = setup(), entry = state.entry(scene, 'slope', attachment);
  entry.model.root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(entry.model.root);
  assert.ok(bounds.max.z > 20, 'far road geometry rises with the terrain');
  assert.ok(bounds.min.z > -1);
  entry.model.dispose(); entry.scene.clear(); layer.onRemove();
});

test('empty, offscreen and already attached scene passes do not materialize all basemap tiles',()=>{
 const scenes:EventScene[]=[];const {layer,state}=setup(scenes);const map=state.map as {querySourceFeatures:(source:string,options:{sourceLayer:string})=>Feature<Geometry>[];project:()=>{x:number;y:number}};
 const query=map.querySourceFeatures;let reads=0;map.querySourceFeatures=(...args)=>{reads++;return query(...args);};
 state.reconcile();assert.equal(reads,0);
 scenes.push(event('visible'));map.project=()=>({x:-5000,y:300});state.reconcile();assert.equal(reads,0);
 map.project=()=>({x:400,y:300});state.reconcile();assert.equal(reads,2,'only the building and building_part sources are needed');assert.equal(state.entries.size,1);
 reads=0;state.reconcile();assert.equal(reads,0,'unchanged attachments survive pan/zoom without rereading every source feature');
 scenes.push({...event('own-street','roads','street'),geometry:{type:'LineString',coordinates:[metres(-100,0),metres(100,0)]}});state.reconcile();assert.equal(reads,0,'an explicit source street does not need a basemap lookup');
 layer.onRemove();
});
test('removing one scene disposes its own geometry while shared materials live until layer removal',()=>{
 const scenes=[event('a'),event('b','construction','building',50)];const {layer,state}=setup(scenes,false,false,[building(),building(50)]);state.reconcile();
 const a=state.entries.get('a')!,b=state.entries.get('b')!,materials=new Set<THREE.Material>();let geometriesDisposed=0,materialsDisposed=0;
 a.model.root.traverse(object=>{if(object instanceof THREE.Mesh){object.geometry.addEventListener('dispose',()=>geometriesDisposed++);const list=Array.isArray(object.material)?object.material:[object.material];for(const m of list)materials.add(m);}});
 for(const material of materials)material.addEventListener('dispose',()=>materialsDisposed++);
 scenes.shift();state.reconcile();assert.ok(geometriesDisposed>0);assert.equal(materialsDisposed,0);assert.equal(state.entries.get('b'),b);
 layer.onRemove();assert.equal(materialsDisposed,materials.size);
});

test('an offscreen animated scene cannot keep repainting a visible static scene',()=>{
 const scenes=[event('working'),{...event('static','construction','building',50),display:'completed' as const}];const {layer,state,animate}=setup(scenes,false,false,[building(),building(50)]);state.reconcile();
 assert.equal(state.entries.get('working')!.model.animated,true);assert.equal(state.entries.get('static')!.model.animated,false);
 const map=state.map as {project:(coordinates:[number,number])=>{x:number;y:number}};
 map.project=coordinates=>({x:coordinates[0]===scenes[0].coordinates[0]?-5000:400,y:300});state.renderer=renderer();animate(true);
 layer.render({} as never,args as never);assert.equal(state.entries.get('working')!.projection,null);assert.ok(state.entries.get('static')!.projection);assert.equal(state.timer,null);layer.onRemove();
});
