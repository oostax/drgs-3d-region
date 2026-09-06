import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedRoute, drivableRoad, geometryKey, makeRoad, rebasePoint, roadPosition, SimulationClock, stableHash, seededRandom, StableRoadCache, treeCell, worldPoint, type StableRoad, type WorldPoint } from '../src/lib/map-life-stability';
import { MapLifeLayer } from '../src/lib/map-life';

const road = (id: string, points: WorldPoint[], oneWay = false) => makeRoad(id, id, points, 0, oneWay);
test('world tree identities and appearance seeds survive camera pan, zoom and rebase', () => {
  const tree = treeCell(221415, 280061), original = { ...tree, style: seededRandom(stableHash(`tree:${tree.id}:appearance`))() };
  for (const [origin, scale] of [[worldPoint([49.12, 55.79]), 1], [worldPoint([49.125, 55.794]), 0.99], [worldPoint([48.74, 55.75]), 1.02]] as [WorldPoint, number][]) {
    const next = treeCell(221415, 280061), local = rebasePoint(next.point, origin, scale);
    assert.deepEqual(next, tree); assert.equal(seededRandom(stableHash(`tree:${next.id}:appearance`))(), original.style);
    assert.ok(Math.abs(local[0] / scale + origin[0] - tree.point[0]) < 1e-8);
    assert.ok(Math.abs(local[1] / scale + origin[1] - tree.point[1]) < 1e-8);
  }
});
test('tile clipping and simplified LOD retain the original road object and distances', () => {
  const cache = new StableRoadCache(), first = makeRoad('way:part-a', 'way:12', [[0, 0], [100, 0], [200, 0]]);
  cache.add(first); cache.add(makeRoad('way:lower-lod', 'way:12', [[25, 0.8], [180, 0.8]]));
  assert.equal(cache.roads.size, 1); assert.equal(cache.roads.get(first.id), first);
  assert.deepEqual(roadPosition(first, 123), { x: 123, y: 0, angle: 0 });
  assert.equal(geometryKey(first.points), geometryKey(first.points.toReversed()));
});
test('later clipped geometry adds only uncovered tails and preserves the first part', () => {
  const cache = new StableRoadCache(), first = makeRoad('way:original', 'way:42', [[0, 0], [100, 0], [200, 0]]);
  cache.add(first); cache.add(makeRoad('way:extended', 'way:42', [[0, 0], [300, 0]]));
  assert.equal(cache.roads.size, 2); assert.equal(cache.roads.get(first.id), first);
  const tail = [...cache.roads.values()].find((value) => value !== first)!; assert.deepEqual(tail.points, [[200, 0], [300, 0]]);
  const route = connectedRoute([...cache.roads.values()], first, 12, false, 1000); assert.equal(route.length, 300);
});
test('shared internal OSM vertices allow a car to turn before the end of a long way', () => {
  const main = road('main', [[0, 0], [400, 0], [800, 0]]), turning = road('turn', [[400, 0], [400, 800]]);
  const variants = Array.from({ length: 10 }, (_, seed) => connectedRoute([main, turning], main, seed, false, 1000));
  assert.ok(variants.some((route) => route.points.some(([x, y]) => x === 400 && y === 800)));
});
test('connected routes span several blocks, use only connected edges and respect one-way', () => {
  const roads = [road('a', [[0, 0], [400, 0]], true), road('b', [[400, 0], [400, 400]], true), road('c', [[400, 400], [800, 400]], true), road('d', [[800, 400], [800, 900]], true), road('wrong-way', [[0, 400], [400, 0]], true), road('across-river', [[410, 0], [1000, 0]], true)];
  const route = connectedRoute(roads, roads[0], 25, false, 1600);
  assert.equal(route.length, 1700); assert.deepEqual(route.points, [[0, 0], [400, 0], [400, 400], [800, 400], [800, 900]]);
  assert.deepEqual(connectedRoute(roads.toReversed(), roads[0], 25, false, 1600).points, route.points);
  assert.deepEqual(connectedRoute([roads[0], roads[4]], roads[0], 25).points, roads[0].points);
});
test('late neighboring tiles extend a route without changing its existing positions or phase', () => {
  const first = road('a', [[0, 0], [400, 0]]), next = road('b', [[400, 0], [800, 0]]), later = road('c', [[800, 0], [800, 500]]);
  const before = connectedRoute([first], first, 42), after = connectedRoute([first, next, later], before, 42, false, 1000);
  assert.equal(after.length, 1300);
  for (const phase of [0, 120, 350, 400]) assert.deepEqual(roadPosition(after, phase), roadPosition(before, phase));
});
test('simulation pauses and hidden/reduced-motion gaps never advance the phase', () => {
  const clock = new SimulationClock(); clock.step(1000, true); clock.step(3000, true); assert.equal(clock.elapsed, 2);
  clock.step(3100, false); clock.step(60000, false); clock.step(70000, true); assert.equal(clock.elapsed, 2);
  clock.step(71000, true); assert.equal(clock.elapsed, 3);
  assert.equal(roadPosition(road('open', [[0, 0], [100, 0]]), 130).x, 100, 'open routes must not wrap a visible car to their start');
});
test('footpaths, pedestrian streets and cycleways never receive cars', () => {
  for (const cls of ['path', 'footway', 'cycleway', 'pedestrian', 'steps', 'rail', 'track']) assert.equal(drivableRoad({ class: cls }), false);
  assert.equal(drivableRoad({ class: 'minor', subclass: 'footway' }), false); assert.equal(drivableRoad({ roadClass: 'residential' }), true);
});
test('road cache has a bounded working set while keeping nearby canonical fragments', () => {
  const cache = new StableRoadCache(); for (let i = 0; i < 100; i++) cache.add(road(`${i}`, [[i * 100, 0], [i * 100 + 50, 0]]));
  cache.prune([0, 0], 2000, 10); assert.equal(cache.roads.size, 10); assert.ok(cache.roads.has('0')); assert.ok(!cache.roads.has('99'));
});

test('real layer rebuild preserves overlapping tree placements and vehicle identity after zoom, pan and empty source response', () => {
  let center = { lng: 49.12, lat: 55.79 }, zoom = 15.8, sourceAvailable = true;
  const features = [
    { type: 'Feature', properties: { id: 'way/tree-park', kind: 'green' }, geometry: { type: 'Polygon', coordinates: [[[49.10, 55.77], [49.14, 55.77], [49.14, 55.81], [49.10, 55.81], [49.10, 55.77]]] } },
    { type: 'Feature', properties: { id: 'way/street', class: 'residential' }, geometry: { type: 'LineString', coordinates: [[49.11, 55.79], [49.12, 55.79], [49.13, 55.79]] } },
  ];
  const layer = new MapLifeLayer({ enabled: () => true, animate: () => false, offices: () => [], banksVisible: () => false, lighting: () => ({} as never), mobile: true, reducedMotion: false });
  type State = { map: unknown; data: unknown[]; vehicles: { id: string; road: StableRoad; distance: number; bornAt: number }[]; visibleTrees: { id: string; point: WorldPoint }[]; clock: SimulationClock; worldOrigin: WorldPoint; localScale: number };
  const state = layer as unknown as State;
  state.map = { getZoom: () => zoom, getCenter: () => center, getTerrain: () => null, getSource: () => ({}), querySourceFeatures: (_source: string, options: { sourceLayer: string }) => sourceAvailable && options.sourceLayer === 'transportation' ? [features[1]] : [], triggerRepaint: () => {} };
  state.data = [features[0]];
  layer.rebuild(); assert.ok(state.visibleTrees.length > 100); assert.ok(state.vehicles.length > 0);
  const trees = new Map(state.visibleTrees.map((tree) => [tree.id, [...tree.point]])), cars = new Map(state.vehicles.map((vehicle) => [vehicle.id, vehicle]));
  state.clock.step(1000, true); state.clock.step(6000, true);
  const positions = new Map(state.vehicles.map((vehicle) => [vehicle.id, roadPosition(vehicle.road, vehicle.distance + 5 * 8)]));
  center = { lng: 49.121, lat: 55.7905 }; zoom = 17; sourceAvailable = false; layer.rebuild();
  assert.equal(state.clock.elapsed, 5); assert.equal(state.vehicles.length, cars.size); assert.equal(state.visibleTrees.length, trees.size);
  for (const tree of state.visibleTrees) assert.deepEqual(tree.point, trees.get(tree.id));
  for (const vehicle of state.vehicles) { assert.equal(vehicle, cars.get(vehicle.id)); assert.deepEqual(roadPosition(vehicle.road, vehicle.distance + 5 * 8), positions.get(vehicle.id)); }
});
