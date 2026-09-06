import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILDING_MIN_ZOOM, BUILDING_MAX_ZOOM, configureBuildingTileLod, buildingTileSourceUrl } from '../src/lib/building-lod';

// Exercise the installed MapLibre coverage algorithm without a browser or WebGL.
// Runtime URLs avoid pulling the dependency's source tree into application typechecking.
const { MercatorTransform } = await import(new URL('../node_modules/maplibre-gl/src/geo/projection/mercator_transform.ts', import.meta.url).href);
const { coveringTiles, createCalculateTileZoomFunction } = await import(new URL('../node_modules/maplibre-gl/src/geo/projection/covering_tiles.ts', import.meta.url).href);
const { LngLat } = await import(new URL('../node_modules/maplibre-gl/src/geo/lng_lat.ts', import.meta.url).href);

function cover(zoom: number, pitch: number, minzoom: number) {
  const transform = new MercatorTransform();
  transform.resize(1440, 900);
  transform.setMaxPitch(75);
  transform.setCenter(new LngLat(49.122, 55.795));
  transform.setZoom(zoom);
  transform.setPitch(pitch);
  let calculateTileZoom;
  configureBuildingTileLod({ setSourceTileLodParams(levels: number, ratio: number) {
    calculateTileZoom = createCalculateTileZoomFunction(levels, ratio);
  } } as Parameters<typeof configureBuildingTileLod>[0]);
  return coveringTiles(transform, { tileSize: 512, minzoom, maxzoom: BUILDING_MAX_ZOOM,
    reparseOverscaled: true, calculateTileZoom }) as { canonical: { z: number; x: number; y: number }; overscaledZ: number; key: string }[];
}

test('low-zoom pyramid fills distant coverage without replacing near detail tiles', () => {
  const before = cover(14, 65, 13);
  const after = cover(14, 65, BUILDING_MIN_ZOOM);
  assert(after.some(tile => tile.canonical.z === 12));
  assert(after.length > before.length);
  assert.deepEqual(after.filter(tile => tile.canonical.z >= 13).map(tile => tile.key), before.map(tile => tile.key));
});

test('Kazan pitched city view no longer discards the complete building source at z13', () => {
  assert.equal(cover(13, 75, 13).length, 0);
  const visible = cover(13, 75, BUILDING_MIN_ZOOM);
  assert(visible.length > 0);
  assert(visible.every(tile => tile.canonical.z >= BUILDING_MIN_ZOOM && tile.canonical.z <= BUILDING_MAX_ZOOM));
});

test('street zoom overzooms existing z15 data and uses a fresh local range-cache key', () => {
  const visible = cover(18, 65, BUILDING_MIN_ZOOM);
  assert(visible.some(tile => tile.canonical.z === 15 && tile.overscaledZ > 15));
  assert(visible.every(tile => tile.canonical.z <= 15));
  const url = new URL(buildingTileSourceUrl('http://127.0.0.1:3200').slice('pmtiles://'.length));
  assert.equal(url.origin, 'http://127.0.0.1:3200');
  assert.equal(url.pathname, '/api/tiles/buildings');
  assert.equal(url.searchParams.get('v'), 'lod10-ba327015');
});
