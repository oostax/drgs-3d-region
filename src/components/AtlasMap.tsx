'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import { type GeoJSONSource, type Map as LibreMap, type MapMouseEvent, type ExpressionSpecification } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import type { FeatureCollection, Geometry, Point } from 'geojson';
import { LANDMARK_BUILDING_IDS, LandmarkMapLayer } from '../lib/map-landmarks';
import { MapLifeLayer } from '../lib/map-life';
import { SignalSceneLayer } from '../lib/map-signal-scenes';
import { makeEventScenes, sceneKind } from '../lib/signal-scenes';
import { installDomSignalMarkers } from '../lib/map-dom-signal-markers';
import { installDomBankMarkers } from '../lib/map-dom-bank-markers';
import { addMapMarkers, upgradeMapMarkers, ensureSignalMarkers } from '../lib/map-markers';
import { applyMapLighting } from '../lib/map-appearance';
import { SolarLightLayer, spatialLightingAmount } from '../lib/map-solar-light';
import { interpolateLighting } from '../lib/solar-transition';
import { configureRussiaMap, RUSSIA_VIEW_BOUNDS } from '../lib/map-russia';
import { BuildingDetailsLayer } from '../lib/map-building-details';
import { buildingSurfacePattern, registerBuildingSurfaces } from '../lib/map-building-surface';
import { recreateMapGpuLayers } from '../lib/map-gpu-layers';
import { BUILDING_MIN_ZOOM, BUILDING_MAX_ZOOM, buildingTileSourceUrl, configureBuildingTileLod } from '../lib/building-lod';
import { signalMarker } from '../lib/signal-markers';
import {signalPriority} from '../lib/signal-priority';
import { BUILDING_PROFILE, BUILDING_HEIGHT, BUILDING_BODY_HEIGHT, BUILDING_BASE, BUILDING_ROOF_COLOR } from '../lib/building-materials';
import { getSceneTime, type LightingState, type SceneAppearance } from '../lib/solar';
import { LANDMARKS } from '../lib/landmarks';
import type { BankOffice, Signal, Territory } from '../lib/types';
import 'maplibre-gl/dist/maplibre-gl.css';
import {normalizeSceneLifecycle} from '../lib/scene-lifecycle';
import { cameraTerritory } from '../lib/map-camera-scope';
import { SIGNAL_CLUSTER_PROPERTIES, signalGroupCounts, installMarkerGroups } from '../lib/map-marker-groups';
import { spreadCoincidentMarkers, MARKER_SPREAD_ZOOM } from '../lib/map-marker-layout';
import {addClientLayers,refreshClientLayers} from '../lib/map-client-layer';
import {sberOfficeRole} from '../lib/sber-structure';
import type {ClientMapPoint} from '../lib/client-map-types';
import {naturalMapPitch} from '../lib/map-camera-mode';
import { signalHasVerifiedMapLocation } from '../lib/signal-location';
import { activeSignalHighlightIds } from '../lib/map-signal-selection';

export type AtlasMapLayers = { signals: boolean; banks: boolean; buildings: boolean; landmarks: boolean; boundaries: boolean; terrain: boolean };
export type AtlasMapStatus = { ready?: boolean; zoom: number; networkError: boolean; webgl: boolean; center?: [number, number]; bbox?: [number, number, number, number]; bearing?: number; pitch?: number };
export type AtlasMapBuilding = { id: string; coordinates: [number, number]; height: number; estimated: boolean; floors: number | null };
export type AtlasMapProps = {
  territories: Territory[]; signals: Signal[]; offices: BankOffice[]; territoryId: string;
  selectedSignalId?:string|null;
  highlightedSignalId?:string|null;
  highlightedTerritoryId?:string|null;
  unreadSignalIds?:readonly string[]; recentSignalIds?:readonly string[];
  focus: { bbox?: [number, number, number, number]; coordinates: [number, number]; zoom: number; pitch?: number; bearing?: number; nonce: number } | null;
  layers: AtlasMapLayers; is3D: boolean;
  onCameraTerritory?: (id: string) => void;
  onHoverTerritory?: (id: string) => void;
  cameraScopeEnabled?: boolean;
  onTerritory: (id: string) => void; onSignal: (id: string) => void;
  onSignalGroup?: (territoryId: string) => void;
  onSignalStack?: (ids: string[]) => void;
  onOfficeStack?: (ids: string[]) => void;
  onOffice: (id: string) => void; onLandmark: (id: string) => void;
  onStatus: (status: AtlasMapStatus) => void;
  onRegion?: (id: string, name: string, coordinates: [number, number]) => void;
  onBuilding?: (building: AtlasMapBuilding) => void;
  appearance?: SceneAppearance;
  panelOpen?: boolean;
  bankFocus?: boolean;
  route?: FeatureCollection;
  clients?: ClientMapPoint[];
  clientsVisible?: boolean;
  onClient?: (id:string)=>void;
  focusedOrganization?: { id: string; name: string; coordinates: [number, number]; addressKind: string } | null;
};
export type { SceneAppearance };

type Properties = Record<string, string | number | boolean>;
type Points = FeatureCollection<Point, Properties>;
const FONT = ['Noto Sans Regular'];
const EMPTY_POINTS: Points = { type: 'FeatureCollection', features: [] };
const REGIONAL_KINDS = ['district', 'urban_district'];
const INITIAL_CENTER: [number, number] = [51, 55.35];
const INITIAL_ZOOM = 6.35;
const DEFAULT_APPEARANCE: SceneAppearance = { timeMode: 'auto', hour: 12, life: true };
const protocolKey = Symbol.for('sber-atlas.pmtiles-protocol');
const maskedMaps = new WeakMap<LibreMap, boolean>();
const markerPoints = new WeakMap<LibreMap, Points>();
const markerSpread = new WeakMap<LibreMap, boolean>();

function registerTiles() {
  const registry = globalThis as typeof globalThis & { [protocolKey]?: Protocol };
  if (!registry[protocolKey]) {
    const protocol = new Protocol({ metadata: true });
    maplibregl.addProtocol('pmtiles', protocol.tile); registry[protocolKey] = protocol;
  }
}

const validCoordinates = (coordinates: [number, number] | null | undefined): coordinates is [number, number] =>
  Boolean(coordinates && coordinates.length === 2 && coordinates.every(Number.isFinite) && Math.abs(coordinates[0]) <= 180 && Math.abs(coordinates[1]) <= 85);
const signalCountLabel = (count: number) => `${count} ${count % 100 >= 11 && count % 100 <= 14 ? 'сигналов' : count % 10 === 1 ? 'сигнал' : count % 10 >= 2 && count % 10 <= 4 ? 'сигнала' : 'сигналов'}`;

/** Label points express area attribution; they never become invented addresses. */
export function makeSignalMapData(signals: Signal[], territories: Territory[], unreadIds:readonly string[]=[], recentIds:readonly string[]=[]) {
  const unread=new Set(unreadIds),recent=new Set(recentIds);
  const territoryIndex = new Map(territories.map((territory) => [territory.id, territory]));
  const aggregates = new Map<string, { territory: Territory; signals: Signal[] }>();
  const points: Points = { type: 'FeatureCollection', features: [] };
  const objects:GeoJSON.FeatureCollection<GeoJSON.Polygon|GeoJSON.MultiPolygon>={type:'FeatureCollection',features:[]};
  const streets: GeoJSON.FeatureCollection<GeoJSON.LineString|GeoJSON.MultiLineString> = { type:'FeatureCollection', features:[] };
  const streetKeys = new Set<string>();
  for (const signal of signals) {
    // Never turn a municipality or settlement centroid into an apparent event address.
    if (!signalHasVerifiedMapLocation(signal)) continue;
    if(['building','site'].includes(signal.precision)&&signal.siteGeometry&&['Polygon','MultiPolygon'].includes(signal.siteGeometry.type))objects.features.push({type:'Feature',properties:{id:signal.id,color:signalMarker(signal).color},geometry:signal.siteGeometry as GeoJSON.Polygon|GeoJSON.MultiPolygon});
    if(signal.precision==='street' && signal.siteGeometry && ['LineString','MultiLineString'].includes(signal.siteGeometry.type)) {
      const key=`${signal.territoryId}:${signal.siteBbox?.join(',')||signal.id}`;
      if(!streetKeys.has(key)) {
        streetKeys.add(key);
        streets.features.push({type:'Feature',properties:{id:signal.id,color:signalMarker(signal).color,historical:signal.visibility==='private'},geometry:signal.siteGeometry as GeoJSON.LineString|GeoJSON.MultiLineString});
      }
    }
    if (validCoordinates(signal.coordinates)) {
      const marker=signalMarker(signal),priority=signalPriority(signal),live=signal.live,ageDays=live?.lastMeaningfulAt?Math.max(0,(Date.now()-Date.parse(live.lastMeaningfulAt))/86_400_000):0;
      points.features.push({ type: 'Feature', id: signal.id, properties: { ...signalGroupCounts([signal]), id: signal.id, category: signal.category, kind: sceneKind(signal) ?? 'signal', unreadCount:unread.has(signal.id)?1:0, recentCount:recent.has(signal.id)?1:0, marker: marker.imageId, markerLabel: marker.label, markerColor: marker.color, statusColor:marker.faceColor??marker.color, markerApproximate: marker.approximate ?? false, markerLocationLabel: marker.locationLabel ?? '', title: signal.title, precision: signal.precision, priorityRank:priority.rank,priorityColor:priority.color,priorityBadge:priority.badge,priorityPulse:priority.pulse,historical:priority.historical,severity:live?.severity??'low', confidence:live?.confidence??'medium', sourceKind:live?.sourceKind??'official', eventState:priority.historical?'archive':normalizeSceneLifecycle(signal).state, ageOpacity:Number.isFinite(ageDays)?Math.max(.48,1-ageDays/120):.72 }, geometry: { type: 'Point', coordinates: signal.coordinates } });
      // Exact objects also count in the territory summary at regional scales.
    }
    const territory = signal.territoryId ? territoryIndex.get(signal.territoryId) : null;
    if (!territory || !validCoordinates(territory.center)) continue;
    let group = aggregates.get(territory.id);
    if (!group) { group = { territory, signals: [] }; aggregates.set(territory.id, group); }
    group.signals.push(signal);
  }
  const topicNames: Record<string, string> = { construction: 'Строительство', infrastructure: 'Инфраструктура', investment: 'Инвестиции', tourism: 'Туризм', planning: 'Развитие территории', utilities:'ЖКХ',roads:'Дороги',flood:'Подтопления',fire:'Пожары',waste:'Отходы',weather:'Погодные риски',ecology:'Экология',education:'Образование',transport:'Транспорт',health:'Здравоохранение',other:'Другие темы' };
  const areaMarker = (group:Signal[])=>{const markers=group.map(signalMarker);const sameGroup=markers.every(m=>m.group===markers[0].group), sameIcon=markers.every(m=>m.imageId===markers[0].imageId);return sameIcon?markers[0].imageId:`atlas-category-${sameGroup?markers[0].group:'other'}-layers`;};
  const areas: Points = { type: 'FeatureCollection', features: [...aggregates.values()].map(({ territory, signals: group }) => ({
    type: 'Feature', id: territory.id,
    properties: { ...signalGroupCounts(group), territoryId: territory.id, count: group.length, marker:areaMarker(group), fallbackCount:0, unreadCount:group.filter(signal=>unread.has(signal.id)).length, recentCount:group.filter(signal=>recent.has(signal.id)).length, label: String(group.length), summary: `${signalCountLabel(group.length)} с подтверждённым местом`, signalCount: group.length, signalId: group.length === 1 ? group[0].id : '', precision: 'territory', name: territory.name, topics: [...new Set(group.map((signal) => topicNames[signal.category] || signal.category))].slice(0, 2).map((name) => name.length > 30 ? name.slice(0, 29) + '…' : name).join(' · ') },
    geometry: { type: 'Point', coordinates: territory.center! },
  })) };
  points.features.sort((a,b) => String(a.id).localeCompare(String(b.id)));
  return { points, areas, streets, objects, territoryIds: [...aggregates.keys()] };
}

export function makeOfficeMapData(offices: BankOffice[]): Points {
  return { type: 'FeatureCollection', features: offices.filter((office) => !sberOfficeRole(office) && validCoordinates(office.coordinates) && office.precision === 'building' && Boolean(office.coordinateSourceUrl)).map((office) => ({
    type: 'Feature', id: office.id, properties: { id: office.id, bank: office.bank, label: office.bank === 'sber' ? 'Сбер' : office.bank === 'akbars' ? 'Ак Барс' : office.bank === 'vtb' ? 'ВТБ' : office.bank === 'psb' ? 'ПСБ' : 'ГПБ' },
    geometry: { type: 'Point', coordinates: office.coordinates! },
  })) };
}

function setVisibility(map: LibreMap, ids: string[], visible: boolean) {
  if (!map.getLayer('atlas-region-line')) return;
  for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
}

function refreshSignals(map: LibreMap, props: AtlasMapProps) {
  if (!map.getLayer('atlas-region-line')) return;
  ensureSignalMarkers(map, props.signals);
  const signalData = makeSignalMapData(props.signals, props.territories, props.unreadSignalIds, props.recentSignalIds);
  (map.getSource('atlas-signal-areas') as GeoJSONSource | undefined)?.setData(EMPTY_POINTS);
  markerPoints.set(map, signalData.points);
  refreshMarkerLayout(map);
  (map.getSource('atlas-signal-streets') as GeoJSONSource | undefined)?.setData(signalData.streets);
  (map.getSource('atlas-signal-objects') as GeoJSONSource | undefined)?.setData(signalData.objects);
}

function refreshMarkerLayout(map: LibreMap) {
  const points = markerPoints.get(map); if (!points) return;
  const settled = !map.isMoving();
  const display = settled ? spreadCoincidentMarkers(points, map) : {points, links: {type:'FeatureCollection' as const, features:[]}};
  (map.getSource('atlas-signal-points') as GeoJSONSource | undefined)?.setData(display.points);
  (map.getSource('atlas-signal-marker-links') as GeoJSONSource | undefined)?.setData(display.links);
  if (map.getLayer('atlas-signal-marker-links')) map.setPaintProperty('atlas-signal-marker-links','line-opacity',settled ? .55 : 0);
  markerSpread.set(map, settled && map.getZoom() >= MARKER_SPREAD_ZOOM);
}

function refreshOffices(map:LibreMap,offices:BankOffice[]){(map.getSource('atlas-offices') as GeoJSONSource|undefined)?.setData(makeOfficeMapData(offices));}
function refreshRoute(map:LibreMap,route:FeatureCollection|undefined){(map.getSource('atlas-route') as GeoJSONSource|undefined)?.setData(route??{type:'FeatureCollection',features:[]});}
function refreshOrganization(map:LibreMap,organization:AtlasMapProps['focusedOrganization']){(map.getSource('atlas-focused-org') as GeoJSONSource|undefined)?.setData({type:'FeatureCollection',features:organization?[{type:'Feature',properties:{id:organization.id,name:organization.name,label:/legal|юрид/i.test(organization.addressKind)?`${organization.name}\nЮридический адрес`:organization.name},geometry:{type:'Point',coordinates:organization.coordinates}}]:[]});}
function refreshData(map:LibreMap,props:AtlasMapProps){refreshSignals(map,props);refreshOffices(map,props.offices);refreshRoute(map,props.route);refreshOrganization(map,props.focusedOrganization);refreshClientLayers(map,props.clients||[],Boolean(props.clientsVisible));}

function refreshLandmarkMasks(map: LibreMap, props: AtlasMapProps, modelsAvailable = true) {
  if (!map.getLayer('atlas-region-line')) return;
  const hidden = props.layers.landmarks && !props.bankFocus && props.is3D && modelsAvailable && map.getZoom() >= 13.8;
  if (maskedMaps.get(map) === hidden) return;
  const ids = Object.values(LANDMARK_BUILDING_IDS).flat();
  for (const [layer, property] of [['atlas-building-3d', 'id'], ['atlas-building-parts-3d', 'building_id'], ['atlas-building-roofs', 'id'], ['atlas-building-part-roofs', 'building_id']]) {
    if (map.getLayer(layer)) map.setFilter(layer, hidden ? ['!', ['in', ['get', property], ['literal', ids]]] : null);
  }
  maskedMaps.set(map, hidden);
}

function refreshVisibility(map: LibreMap, props: AtlasMapProps, modelsAvailable = true) {
  if (!map.getLayer('atlas-region-line')) return;
  const layers = {...props.layers, signals: props.layers.signals && !props.bankFocus, landmarks: props.layers.landmarks && !props.bankFocus};
  setVisibility(map, ['atlas-signal-marker-links','atlas-signal-objects-line','atlas-signal-object-focus','atlas-signal-streets-line', 'atlas-signal-area-fill', 'atlas-signal-clusters', 'atlas-signal-cluster-count', 'atlas-signal-areas-circle', 'atlas-signal-area-fallback', 'atlas-signal-areas-label', 'atlas-signal-areas-card', 'atlas-signal-topics', 'atlas-signal-point-clusters', 'atlas-signal-point-cluster-count', 'atlas-signal-point-highlight', 'atlas-signal-point-contrast', 'atlas-signal-points-circle', 'atlas-signal-confidence', 'atlas-signal-priority-badge'], layers.signals);
  setVisibility(map, ['atlas-bank-clusters', 'atlas-bank-cluster-count', 'atlas-banks-circle', 'atlas-bank-label','atlas-head-offices','atlas-head-office-names'], layers.banks);
  setVisibility(map, ['atlas-building-3d', 'atlas-building-parts-3d', 'atlas-building-roofs', 'atlas-building-part-roofs'], layers.buildings && props.is3D);
  setVisibility(map, ['atlas-building-flat'], layers.buildings && !props.is3D);
  setVisibility(map, ['atlas-building-purpose'], layers.buildings && !props.bankFocus);
  for (const id of ['atlas-building-3d', 'atlas-building-parts-3d', 'atlas-building-roofs', 'atlas-building-part-roofs']) if(map.getLayer(id)) map.setPaintProperty(id,'fill-extrusion-opacity',props.bankFocus ? 0.18 : 1);
  if(map.getLayer('atlas-building-flat')) map.setPaintProperty('atlas-building-flat','fill-opacity',props.bankFocus ? 0.16 : 0.9);
  setVisibility(map, ['building'], layers.buildings); // Basemap footprints fill the gap below z13.
  setVisibility(map, ['atlas-district-hit', 'atlas-district-hover', 'atlas-district-lines', 'atlas-settlement-lines', 'atlas-region-line', 'atlas-russia-lines',], layers.boundaries);
  setVisibility(map, ['atlas-landmark-label', 'atlas-landmark-dot'], layers.landmarks);
  refreshLandmarkMasks(map, props, modelsAvailable);
  if (layers.terrain && props.is3D) {
    if (!map.getSource('atlas-dem')) {
      map.addSource('atlas-dem', { type: 'raster-dem', tiles: ['/api/terrain/{z}/{x}/{y}.png'], encoding: 'terrarium', bounds:[47.2370189,53.9742444,54.2656971,56.6781671], tileSize: 256, maxzoom: 12, attribution: '<a href="https://registry.opendata.aws/terrain-tiles/">Mapzen Terrain Tiles</a>' });
    }
    if (!map.getTerrain()) map.setTerrain({ source: 'atlas-dem', exaggeration: 1 });
  } else if (map.getTerrain()) map.setTerrain(null);
  map.triggerRepaint();
}

function addAtlasLayers(map: LibreMap, lighting: LightingState) {
  const firstLabel = map.getStyle().layers.find((layer) => layer.type === 'symbol')?.id;
  addMapMarkers(map);
  map.addSource('atlas-boundaries', { type: 'geojson', data: '/data/tatarstan-boundaries.geojson', promoteId: 'territoryId' });
  map.addSource('atlas-russia', { type: 'geojson', data: '/data/russia-regions.geojson', promoteId: 'id' });
  map.addLayer({ id: 'atlas-russia-ground', type: 'fill', source: 'atlas-russia', paint: { 'fill-color': '#b9c1b0' } }, map.getStyle().layers.find(layer => layer.type !== 'background')?.id);
  applyMapLighting(map, lighting, true);
  map.addSource('atlas-russia-label-points', { type: 'geojson', data: '/data/russia-region-labels.geojson' });
  map.addLayer({ id: 'atlas-russia-hit', type: 'fill', source: 'atlas-russia', maxzoom: 6, paint: { 'fill-color': '#5f856c', 'fill-opacity': 0.035 } }, firstLabel);
  map.addLayer({ id: 'atlas-russia-lines', type: 'line', source: 'atlas-russia', maxzoom: 8.5, paint: { 'line-color': '#809889', 'line-width': 0.8, 'line-opacity': 0.55 } }, firstLabel);
  map.addSource('atlas-region-context', {type:'geojson', data:'/data/region-context.geojson', tolerance:1.5, maxzoom:8});
  map.addLayer({id:'atlas-region-context-ground',type:'fill',source:'atlas-region-context',paint:{'fill-color':'#b9c1b0','fill-opacity':1,'fill-antialias':false}});
  map.addLayer({id:'atlas-region-context-lines',type:'line',source:'atlas-region-context',maxzoom:10,paint:{'line-color':'#849389','line-width':.7,'line-opacity':.5}});
  map.addLayer({ id: 'atlas-russia-labels', type: 'symbol', source: 'atlas-russia-label-points', minzoom: 2, maxzoom: 10, layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 10, 'text-max-width': 12, 'text-padding': 12 }, paint: { 'text-color': '#536e5c', 'text-halo-color': '#f5f4e8', 'text-halo-width': 1.5 } });
  map.addLayer({ id: 'atlas-district-hit', type: 'fill', source: 'atlas-boundaries', minzoom: 6.5, maxzoom: 13, filter: ['in', ['get', 'kind'], ['literal', REGIONAL_KINDS]], paint: { 'fill-color': '#2b8b6f', 'fill-opacity': 0.001 } }, firstLabel);
  map.addLayer({ id: 'atlas-district-hover', type: 'fill', source: 'atlas-boundaries', minzoom: 6.5, maxzoom: 13, filter: ['==', ['get', 'territoryId'], ''], paint: { 'fill-color': '#2b8b6f', 'fill-opacity': 0.08 } }, firstLabel);
  map.addLayer({ id: 'atlas-region-line', type: 'line', source: 'atlas-boundaries', filter: ['==', ['get', 'kind'], 'region'], paint: { 'line-color': '#496d57', 'line-width': 0.65, 'line-opacity': 0.22 } }, firstLabel);
  map.addLayer({ id: 'atlas-district-lines', type: 'line', source: 'atlas-boundaries', maxzoom: 13, filter: ['in', ['get', 'kind'], ['literal', REGIONAL_KINDS]], paint: { 'line-color': '#719079', 'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.6, 11, 1.2], 'line-opacity': 0.22 } }, firstLabel);
  map.addLayer({ id: 'atlas-settlement-lines', type: 'line', source: 'atlas-boundaries', minzoom: 10, filter: ['==', ['get', 'kind'], 'settlement'], paint: { 'line-color': '#879c80', 'line-width': 0.9, 'line-dasharray': [3, 3], 'line-opacity': 0.65 } }, firstLabel);

  map.addSource('atlas-buildings', { type: 'vector', url: buildingTileSourceUrl(window.location.origin), minzoom: BUILDING_MIN_ZOOM, maxzoom: BUILDING_MAX_ZOOM, attribution: '© OpenStreetMap contributors · Microsoft / Overture Maps · ODbL · Фасады и кровли — архитектурная стилизация' });
  configureBuildingTileLod(map);
  const height = BUILDING_BODY_HEIGHT;
  const base = BUILDING_BASE;
  registerBuildingSurfaces(map);
  for (const sourceLayer of ['building', 'building_part']) map.addLayer({
    id: sourceLayer === 'building' ? 'atlas-building-3d' : 'atlas-building-parts-3d', type: 'fill-extrusion', source: 'atlas-buildings', 'source-layer': sourceLayer, minzoom: BUILDING_MIN_ZOOM,
    paint: { 'fill-extrusion-color': '#b7ad95', 'fill-extrusion-pattern': buildingSurfacePattern(), 'fill-extrusion-height': height, 'fill-extrusion-base': base, 'fill-extrusion-opacity': 1, 'fill-extrusion-vertical-gradient': true },
  }, firstLabel);
  for (const sourceLayer of ['building', 'building_part']) map.addLayer({ id: sourceLayer === 'building' ? 'atlas-building-roofs' : 'atlas-building-part-roofs', type: 'fill-extrusion', source: 'atlas-buildings', 'source-layer': sourceLayer, minzoom: BUILDING_MIN_ZOOM, paint: { 'fill-extrusion-color': '#637b76', 'fill-extrusion-pattern': buildingSurfacePattern(true), 'fill-extrusion-height': ['+', height, 0.05], 'fill-extrusion-base': height, 'fill-extrusion-opacity': 1, 'fill-extrusion-vertical-gradient': false } }, firstLabel);
  map.addLayer({ id: 'atlas-building-flat', type: 'fill', source: 'atlas-buildings', 'source-layer': 'building', minzoom: BUILDING_MIN_ZOOM, paint: { 'fill-color': '#d8ceb5', 'fill-outline-color': '#c3baa5', 'fill-opacity': 0.9 } }, firstLabel);
  // Architectural signs remain on the facade; collision-managed map labels keep
  // confirmed civic purposes readable before individual letters resolve in 3D.
  map.addLayer({ id: 'atlas-building-purpose', type: 'symbol', source: 'atlas-buildings', 'source-layer': 'building', minzoom: 15.8,
    filter: ['in', BUILDING_PROFILE, ['literal', ['education', 'kindergarten', 'hospital', 'clinic', 'university', 'stadium', 'sports']]],
    layout: { 'text-field': ['match', BUILDING_PROFILE, 'education', 'Школа', 'kindergarten', 'Детский сад', 'hospital', 'Больница', 'clinic', 'Клиника', 'university', 'Учебный корпус', 'stadium', 'Стадион', 'sports', 'Спорткомплекс', ''], 'text-font': FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 15.8, 10, 18, 13], 'text-max-width': 12, 'text-padding': 16, 'text-optional': true },
    paint: { 'text-color': '#365d58', 'text-halo-color': '#f7f6ed', 'text-halo-width': 1.8 },
  });
  map.addSource('atlas-route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'atlas-route-casing', type: 'line', source: 'atlas-route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#fff8e5', 'line-width': 7, 'line-opacity': 0.85 } });
  map.addLayer({ id: 'atlas-route-line', type: 'line', source: 'atlas-route', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#29956e', 'line-width': 3.5, 'line-dasharray': [2, 1.5] } });
  map.addLayer({ id: 'atlas-route-stops', type: 'circle', source: 'atlas-route', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 12, 'circle-color': '#2d8e68', 'circle-stroke-color': '#fffbea', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'atlas-route-stop-label', type: 'symbol', source: 'atlas-route', filter: ['==', ['geometry-type'], 'Point'], layout: { 'text-field': ['to-string', ['get', 'stop']], 'text-font': FONT, 'text-size': 11, 'text-allow-overlap': true }, paint: { 'text-color': '#fffdf0' } });
  addClientLayers(map);
  map.addSource('atlas-focused-org', { type: 'geojson', data: EMPTY_POINTS });
  map.addLayer({ id: 'atlas-focused-org-dot', type: 'circle', source: 'atlas-focused-org', paint: { 'circle-radius': 9, 'circle-color': '#328f87', 'circle-stroke-color': '#fff8e5', 'circle-stroke-width': 3 } });
  map.addLayer({ id: 'atlas-focused-org-label', type: 'symbol', source: 'atlas-focused-org', layout: { 'text-field': ['get', 'label'], 'text-font': FONT, 'text-size': 12, 'text-max-width': 22, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-allow-overlap': true }, paint: { 'text-color': '#245b58', 'text-halo-color': '#fffbe8', 'text-halo-width': 2 } });
  map.addSource('atlas-landmark-points', { type: 'geojson', data: { type: 'FeatureCollection', features: LANDMARKS.map((landmark) => ({ type: 'Feature', properties: { id: landmark.id, name: landmark.name }, geometry: { type: 'Point', coordinates: landmark.coordinates } })) } });
  map.addLayer({ id: 'atlas-landmark-dot', type: 'circle', source: 'atlas-landmark-points', minzoom: 10, maxzoom: 15, paint: { 'circle-radius': 4.5, 'circle-color': '#8c7851', 'circle-stroke-color': '#fffdf1', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'atlas-landmark-label', type: 'symbol', source: 'atlas-landmark-points', minzoom: 13, layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-max-width': 12, 'text-optional': true }, paint: { 'text-color': '#405d4b', 'text-halo-color': '#ffffed', 'text-halo-width': 1.5 } });

  map.addSource('atlas-signal-areas', { type: 'geojson', data: EMPTY_POINTS, cluster: true, clusterRadius: 58, clusterMaxZoom: 10, clusterProperties: { ...SIGNAL_CLUSTER_PROPERTIES, total: ['+', ['get', 'count']], unread_count:['+',['get','unreadCount']], recent_count:['+',['get','recentCount']] } });
  // One geographic hierarchy at every scale: no handoff from district centres.
  map.addSource('atlas-signal-points', { type: 'geojson', data: EMPTY_POINTS, cluster: true, clusterRadius: 44, clusterMaxZoom: 14, clusterProperties: { ...SIGNAL_CLUSTER_PROPERTIES, unread_count: ['+', ['get', 'unreadCount']], recent_count: ['+', ['get', 'recentCount']] } });
  map.addSource('atlas-signal-marker-links',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'atlas-signal-marker-links',type:'line',source:'atlas-signal-marker-links',minzoom:MARKER_SPREAD_ZOOM,paint:{'line-color':['get','color'],'line-width':1.3,'line-opacity':.55}});
  map.addSource('atlas-signal-streets',{type:'geojson',data:{type:'FeatureCollection',features:[]},tolerance:1});
  map.addSource('atlas-signal-objects',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
  map.addLayer({id:'atlas-signal-objects-line',type:'line',source:'atlas-signal-objects',minzoom:13.5,paint:{'line-color':['get','color'],'line-width':3,'line-opacity':.85}});
  map.addLayer({id:'atlas-signal-object-focus',type:'line',source:'atlas-signal-objects',filter:['==',['get','id'],''],paint:{'line-color':'#e3a542','line-width':6,'line-opacity':.95}});
  map.addLayer({id:'atlas-signal-streets-line',type:'line',source:'atlas-signal-streets',minzoom:12.5,paint:{'line-color':['get','color'],'line-width':['interpolate',['linear'],['zoom'],12.5,1.5,16,3.5],'line-opacity':['case',['get','historical'],0.35,0.65],'line-dasharray':[2,2]}},firstLabel);
  map.addLayer({ id: 'atlas-signal-clusters', type: 'circle', source: 'atlas-signal-areas', filter: ['has', 'point_count'], paint: { 'circle-radius': ['step', ['get', 'point_count'], 23, 5, 28, 20, 33], 'circle-color': '#eee1bd', 'circle-stroke-color': '#ac8a49', 'circle-stroke-width': 1.8, 'circle-opacity': 0.96 } });
  map.addLayer({ id: 'atlas-signal-cluster-count', type: 'symbol', source: 'atlas-signal-areas', filter: ['has', 'point_count'], layout: { 'text-field': ['to-string', ['get', 'total']], 'text-font': FONT, 'text-size': 13, 'text-allow-overlap': true }, paint: { 'text-color': '#594924' } });
  map.addLayer({ id: 'atlas-signal-areas-circle', type: 'circle', source: 'atlas-signal-areas', filter: ['!', ['has', 'point_count']], paint: { 'circle-radius': ['step', ['zoom'], 22, 10, 5], 'circle-color': '#f7efd9', 'circle-opacity': 0.9, 'circle-stroke-color': '#bd9b58', 'circle-stroke-width': 1.5 } });
  map.addLayer({id:'atlas-signal-area-fallback',type:'circle',source:'atlas-signal-areas',minzoom:10,filter:['all',['!', ['has','point_count']],['>',['get','fallbackCount'],0]],paint:{'circle-radius':7,'circle-color':'#87958d','circle-opacity':.82,'circle-stroke-color':'#fffbed','circle-stroke-width':2}});
  map.addLayer({ id: 'atlas-signal-areas-label', type: 'symbol', source: 'atlas-signal-areas', maxzoom: 10, filter: ['!', ['has', 'point_count']], layout: { 'text-field': ['get', 'label'], 'text-font': FONT, 'text-size': 13, 'text-allow-overlap': true }, paint: { 'text-color': '#685124' } });
  map.addLayer({ id: 'atlas-signal-areas-card', type: 'symbol', source: 'atlas-signal-areas', minzoom: 10, filter: ['!', ['has', 'point_count']], layout: { 'text-field': ['concat', ['get', 'summary'], '\n', ['get', 'name']], 'text-font': FONT, 'text-size': 12, 'text-max-width': 24, 'text-offset': [0, 1.05], 'text-anchor': 'top', 'text-padding': 12, 'text-allow-overlap': true }, paint: { 'text-color': '#70562e', 'text-halo-color': '#fff9e9', 'text-halo-width': 2.5 } });
  map.addLayer({ id: 'atlas-signal-topics', type: 'symbol', source: 'atlas-signal-areas', minzoom: 12.5, filter: ['!', ['has', 'point_count']], layout: { 'text-field': ['get', 'topics'], 'text-font': FONT, 'text-size': 10, 'text-max-width': 26, 'text-offset': [0, 4.4], 'text-anchor': 'top', 'text-padding': 12 }, paint: { 'text-color': '#70562e', 'text-halo-color': '#fff9e9', 'text-halo-width': 2 } });
  map.addLayer({id:'atlas-signal-point-highlight',type:'circle',source:'atlas-signal-points',minzoom:10,filter:['==',['get','id'],''],paint:{'circle-radius':['interpolate',['linear'],['zoom'],10,17,18,25],'circle-color':['get','statusColor'],'circle-opacity':.2,'circle-stroke-color':['get','statusColor'],'circle-stroke-width':3}});
  map.addLayer({ id: 'atlas-signal-points-circle', type: 'circle', source: 'atlas-signal-points', minzoom: 10.75, filter:['!', ['has','point_count']], paint: { 'circle-radius': 7, 'circle-color': '#c79b4c', 'circle-stroke-color': '#fff7dd', 'circle-stroke-width': 2.5 } });
  map.addLayer({id:'atlas-signal-confidence',type:'symbol',source:'atlas-signal-points',minzoom:13,filter:['all',['!', ['has','point_count']],['==',['get','confidence'],'low']],layout:{'text-field':'','text-font':FONT,'text-size':10,'text-offset':[1.2,-2.2],'text-allow-overlap':true},paint:{'text-color':'#6c3e28','text-halo-color':'#fffbea','text-halo-width':2}});

  map.addSource('atlas-offices', { type: 'geojson', data: EMPTY_POINTS, cluster: true, clusterRadius: 44, clusterMaxZoom: 14, clusterProperties: { sber_count:['+', ['case',['==',['get','bank'],'sber'],1,0]], vtb_count:['+', ['case',['==',['get','bank'],'vtb'],1,0]], akbars_count:['+', ['case',['==',['get','bank'],'akbars'],1,0]], psb_count:['+', ['case',['==',['get','bank'],'psb'],1,0]], gpb_count:['+', ['case',['==',['get','bank'],'gazprombank'],1,0]] } });
  map.addLayer({ id: 'atlas-bank-clusters', type: 'circle', source: 'atlas-offices', filter: ['has', 'point_count'], paint: { 'circle-radius': ['step', ['get', 'point_count'], 15, 10, 19, 50, 23], 'circle-color': '#49775f', 'circle-stroke-color': '#f9faed', 'circle-stroke-width': 2, 'circle-opacity': 0.92 } });
  map.addLayer({ id: 'atlas-bank-cluster-count', type: 'symbol', source: 'atlas-offices', filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': FONT, 'text-size': 11, 'text-allow-overlap': true }, paint: { 'text-color': '#fffdf0' } });
  map.addLayer({ id: 'atlas-banks-circle', type: 'circle', source: 'atlas-offices', filter: ['!', ['has', 'point_count']], paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 7], 'circle-color': ['match', ['get', 'bank'], 'sber', '#258458', 'akbars', '#72866c', 'vtb', '#567b94', 'psb', '#ae7759', '#788997'], 'circle-stroke-color': '#fffbed', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'atlas-bank-label', type: 'symbol', source: 'atlas-offices', minzoom: 15.3, filter: ['!', ['has', 'point_count']], layout: { 'text-field': ['get', 'label'], 'text-font': FONT, 'text-size': 10, 'text-offset': [0, 1.1], 'text-anchor': 'top' }, paint: { 'text-color': '#385947', 'text-halo-color': '#fffdf0', 'text-halo-width': 1.5 } });
  for(const layer of map.getStyle().layers){if(layer.type==='symbol'&&layer.id.startsWith('poi')){const original=map.getFilter(layer.id);map.setFilter(layer.id,['all',...(original?[original]:[]),['!=',['get','subclass'],'bank'],['!=',['get','class'],'bank']] as maplibregl.FilterSpecification);}}
  upgradeMapMarkers(map);
  map.moveLayer('atlas-head-offices');map.moveLayer('atlas-head-office-names');
  map.setFilter('atlas-signal-points-circle',['!', ['has','point_count']]);
  map.setPaintProperty('atlas-signal-points-circle','icon-opacity',['get','ageOpacity']);
}

function geometryPath(geometry: Geometry, project: (point: number[]) => [number, number]): string {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.flatMap((polygon) => polygon.map((ring) => ring.map((point, index) => { const [x, y] = project(point); return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`; }).join('') + 'Z')).join('');
}

function FlatFallback({ territories }: Pick<AtlasMapProps, 'territories'>) {
  const [boundaries, setBoundaries] = useState<FeatureCollection<Geometry> | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (territories.some((territory) => territory.geometry)) return;
    const controller = new AbortController();
    void fetch('/data/tatarstan-boundaries.geojson', { signal: controller.signal }).then((response) => {
      if (!response.ok) throw new Error('Boundary data unavailable');
      return response.json() as Promise<FeatureCollection<Geometry>>;
    }).then(setBoundaries).catch((error: unknown) => { if (!(error instanceof Error && error.name === 'AbortError')) setFailed(true); });
    return () => controller.abort();
  }, [territories]);
  const paths = useMemo(() => {
    const region = territories.find((territory) => territory.id === 'RU-TA');
    const box = region?.bbox ?? [47.23, 53.97, 54.27, 56.68];
    const project = (point: number[]): [number, number] => [35 + (point[0] - box[0]) / (box[2] - box[0]) * 930, 610 - (point[1] - box[1]) / (box[3] - box[1]) * 570];
    const geometry = new Map(boundaries?.features.map((feature) => [String(feature.properties?.territoryId), feature.geometry]) ?? []);
    return territories.filter((territory) => (REGIONAL_KINDS.includes(territory.kind) || territory.id === 'RU-TA') && (territory.geometry || geometry.has(territory.id)))
      .sort((a, b) => Number(b.id === 'RU-TA') - Number(a.id === 'RU-TA'))
      .map((territory) => ({ territory, path: geometryPath(territory.geometry ?? geometry.get(territory.id)!, project) }));
  }, [territories, boundaries]);
  return <div data-testid="map-fallback" style={{ position: 'absolute', inset: 0, background: '#e6ebdf', display: 'grid', placeItems: 'center' }}>
    <svg viewBox="0 0 1000 650" role="img" aria-label="Обзор муниципалитетов Татарстана без трёхмерной графики" style={{ width: '100%', maxHeight: '85%' }}>
      {paths.map(({ territory, path }) => <path key={territory.id} d={path} aria-label={territory.name} fill={territory.kind === 'region' ? '#d3dfc7' : '#dce5cf'} stroke="#819878" strokeWidth={0.7} />)}
    </svg>
    <div style={{ position: 'absolute', bottom: 28, left: '50%', transform: 'translateX(-50%)', padding: '12px 18px', borderRadius: 14, background: '#fbfcf3', color: '#486451', fontSize: 13, textAlign: 'center', maxWidth: 330 }}><strong>Обзор без 3D</strong><br />{paths.length ? 'Данные и карточки доступны через поиск территории.' : failed ? 'Схема временно недоступна. Выберите территорию через поиск.' : 'Загружаем границы муниципалитетов…'}</div>
  </div>;
}

export default function AtlasMap(props: AtlasMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LibreMap | null>(null);
  const lifeRef = useRef<MapLifeLayer | null>(null);
  const detailsRef = useRef<BuildingDetailsLayer | null>(null);
  const scenesRef = useRef<SignalSceneLayer | null>(null);
  const eventScenes = useMemo(() => makeEventScenes(props.signals, props.territories, Date.now(), props.selectedSignalId), [props.signals, props.territories, props.selectedSignalId]);
  const eventScenesRef = useRef(eventScenes); eventScenesRef.current = eventScenes;
  const lastCamera = useRef<{ focusNonce: number | null; is3D: boolean; panelOpen: boolean } | null>(null);
  const lightingRef = useRef<LightingState | null>(null);
  if (!lightingRef.current) lightingRef.current = getSceneTime(props.appearance ?? DEFAULT_APPEARANCE);
  const worldLightingRef = useRef<LightingState | null>(null);
  if (!worldLightingRef.current) worldLightingRef.current = getSceneTime(props.appearance ?? DEFAULT_APPEARANCE, { coordinates: [0, 0] });
  const solarRef = useRef<SolarLightLayer | null>(null);
  const latest = useRef(props); latest.current = props;
  const loaded = useRef(false);
  const [fallback, setFallback] = useState(false);
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState('initializing');
  const [mapError, setMapError] = useState('');
  const errors = useRef(new Set<string>());
  const lastStatus = useRef('');

  useEffect(() => {
    let cancelled = false;
    loaded.current = false;
    lastCamera.current = null;
    errors.current.clear();
    lastStatus.current = '';
    setReady(false);
    setFallback(false);
    setMapError('');
    let webglActive = true;
    let clearMarkerGroups: (() => void) | null = null;
    let boundaryData: FeatureCollection | null = null;
    let scopeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastHoveredTerritory = '';
    const boundaryAbort = new AbortController();
    let cameraReportTimer: ReturnType<typeof setTimeout> | null = null;
    let lastCameraReportAt = -Infinity;
    const disabled = new URLSearchParams(window.location.search).get('webgl') === '0';
    const report = (webgl = webglActive) => {
      if (cancelled) return;
      if (cameraReportTimer !== null) { clearTimeout(cameraReportTimer); cameraReportTimer = null; }
      lastCameraReportAt = performance.now();
      const current = mapRef.current;
      const viewBounds=current?.getBounds();
      const status: AtlasMapStatus = { ready:loaded.current, zoom: Math.round((current?.getZoom() ?? INITIAL_ZOOM) * 100) / 100, networkError: !navigator.onLine || errors.current.size > 0, webgl, center: current ? [current.getCenter().lng, current.getCenter().lat] : INITIAL_CENTER, bbox:viewBounds?[viewBounds.getWest(),viewBounds.getSouth(),viewBounds.getEast(),viewBounds.getNorth()]:undefined, bearing: current?.getBearing() ?? 0, pitch: current?.getPitch() ?? 0 };
      const signature = JSON.stringify(status);
      if (signature !== lastStatus.current) { lastStatus.current = signature; latest.current.onStatus(status); }
    };
    // MapLibre renders the camera itself. Only the surrounding controls need
    // these snapshots; moveend and errors still publish immediately and exactly.
    const reportCamera = () => {
      const delay = 100 - (performance.now() - lastCameraReportAt);
      if (delay <= 0) report();
      else if (cameraReportTimer === null) cameraReportTimer = setTimeout(() => { cameraReportTimer = null; report(); }, delay);
    };
    if (disabled) { setFallback(true); setPhase('fallback'); report(false); return () => { cancelled = true; }; }
    let map: LibreMap;
    const mobile = window.matchMedia('(max-width: 760px), (pointer: coarse)').matches;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    try {
      // Next/Turbopack cannot infer the v6 ESM worker and its shared sibling.
      // predev/prebuild copy both package files into this same public directory.
      maplibregl.setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');
      registerTiles();
      map = new maplibregl.Map({ container: containerRef.current!, style: '/api/map/style', center: INITIAL_CENTER, zoom: mobile ? 5.1 : INITIAL_ZOOM, pitch: 0, maxPitch: mobile ? 60 : 75, minZoom: 2, maxZoom: 20, attributionControl: { compact: true }, canvasContextAttributes: { antialias: !mobile, preserveDrawingBuffer: false }, pixelRatio: Math.min(window.devicePixelRatio || 1, mobile ? 1.4 : 2), maxTileCacheSize: mobile ? 80 : 160, fadeDuration: reducedMotion ? 0 : 180, touchPitch: true });
      mapRef.current = map;
      configureRussiaMap(map);
      const bounds = containerRef.current!.getBoundingClientRect();
      map.setPadding({ top: 0, right: !mobile && latest.current.panelOpen ? Math.min(340, bounds.width * 0.28) : 0, bottom: mobile && latest.current.panelOpen ? Math.min(220, bounds.height * 0.32) : 0, left: 0 });
      const diagnostics=process.env.NODE_ENV==='development'||(['127.0.0.1','localhost'].includes(location.hostname)&&new URL(location.href).searchParams.has('diagnostics'));
      if(diagnostics){(window as Window & {__atlasMap?:LibreMap}).__atlasMap=map;performance.mark('atlas-map-created');}
      setPhase('style-loading');
    } catch (error) {
      console.warn('Atlas map initialization error', error); setMapError(String(error)); setPhase('fallback');
      setFallback(true); report(false); return () => { cancelled = true; };
    }
    const createGpuLayers = () => {
      const landmarks = new LandmarkMapLayer({ mobile, visible: () => latest.current.layers.landmarks && latest.current.is3D && !latest.current.bankFocus, lighting: () => lightingRef.current!, onError: (error) => { console.warn('Atlas landmark layer error', error); setMapError(String(error)); errors.current.add('landmarks'); refreshLandmarkMasks(map, latest.current, false); report(); } });
      const life = new MapLifeLayer({ mobile, reducedMotion, enabled: () => latest.current.is3D, animate: () => (latest.current.appearance ?? DEFAULT_APPEARANCE).life, offices: () => latest.current.offices, bankFocus: () => Boolean(latest.current.bankFocus), banksVisible: () => latest.current.layers.banks, lighting: () => lightingRef.current!, onError: (error) => { console.warn('Atlas city life layer error', error); setMapError(String(error)); } });
      const scenes = new SignalSceneLayer({mobile, reducedMotion, scenes: () => eventScenesRef.current, enabled: () => latest.current.is3D && latest.current.layers.signals && !latest.current.bankFocus, animate: () => (latest.current.appearance ?? DEFAULT_APPEARANCE).life, lighting: () => lightingRef.current!, onError: error => { console.warn('Atlas event scene error', error); setMapError(String(error)); }});
      const details = new BuildingDetailsLayer({mobile, enabled: () => latest.current.is3D && latest.current.layers.buildings && !latest.current.bankFocus, lighting: () => lightingRef.current!, excludeIds: () => latest.current.layers.landmarks && !errors.current.has('landmarks') ? new Set(Object.values(LANDMARK_BUILDING_IDS).flat()) : new Set<string>(), onError: error => console.warn('Building details layer',error)});
      const solar = new SolarLightLayer(), initialSun = worldLightingRef.current!.sunDirection;
      solar.setSun([initialSun[2], initialSun[0], initialSun[1]]);
      solarRef.current = solar; detailsRef.current = details; scenesRef.current = scenes; lifeRef.current = life;
      return { landmarks, life, scenes, details, solar };
    };
    let gpuLayers: ReturnType<typeof createGpuLayers> | null = null;
    const onClick = (event: MapMouseEvent) => {
      if (!loaded.current || !gpuLayers) return;
      const layerIds = ['atlas-head-offices','atlas-client-points','atlas-client-groups','atlas-signal-clusters', 'atlas-signal-point-clusters', 'atlas-signal-areas-circle', 'atlas-signal-area-fallback', 'atlas-signal-areas-label', 'atlas-signal-areas-card', 'atlas-signal-topics', 'atlas-signal-points-circle', 'atlas-bank-clusters', 'atlas-banks-circle', 'atlas-landmark-label', 'atlas-landmark-dot', 'atlas-building-3d', 'atlas-building-parts-3d', 'atlas-building-flat',].filter((id) => map.getLayer(id));
      const features = map.queryRenderedFeatures(event.point, { layers: layerIds });
      const first = (id: string) => features.find((feature) => feature.layer.id === id);
      const head=first('atlas-head-offices');if(head){latest.current.onOffice(String(head.properties.id));return;}
      const client=first('atlas-client-points');if(client){latest.current.onClient?.(String(client.properties.id));return;}
      const clientGroup=first('atlas-client-groups');if(clientGroup?.geometry.type==='Point'){const source=map.getSource('atlas-clients') as GeoJSONSource;void source.getClusterExpansionZoom(Number(clientGroup.properties.cluster_id)).then(zoom=>{if(!cancelled)map.easeTo({center:clientGroup.geometry.type==='Point'?clientGroup.geometry.coordinates as [number,number]:undefined,zoom:zoom+.5,duration:reducedMotion?0:500});}).catch(()=>{});return;}
      for (const [layer, source] of [['atlas-signal-clusters', 'atlas-signal-points'], ['atlas-signal-point-clusters','atlas-signal-points'], ['atlas-bank-clusters', 'atlas-offices']]) {
        const cluster = first(layer);
        if (cluster?.geometry.type === 'Point') {
          const coordinates = cluster.geometry.coordinates as [number, number];
          const sourceData=map.getSource(source) as GeoJSONSource,clusterId=Number(cluster.properties.cluster_id);
          if(source==='atlas-offices'&&latest.current.onOfficeStack){
            void sourceData.getClusterLeaves(clusterId,Number(cluster.properties.point_count)||100,0).then(items=>{if(!cancelled)latest.current.onOfficeStack?.(items.map(item=>String(item.properties?.id)).filter(Boolean));}).catch(()=>{});
            return;
          }
          void sourceData.getClusterExpansionZoom(clusterId).then((zoom) => {
            if(cancelled)return;
            map.easeTo({ center: coordinates, zoom: zoom + 0.3, duration: reducedMotion ? 0 : 550 });
          }).catch(() => {});
          return;
        }
      }
      const signal = first('atlas-signal-points-circle'); if (signal) { latest.current.onSignal(String(signal.properties.id)); return; }
      const office = first('atlas-banks-circle'); if (office) { latest.current.onOffice(String(office.properties.id)); return; }
      const place = first('atlas-landmark-label') ?? first('atlas-landmark-dot'); if (place) { latest.current.onLandmark(String(place.properties.id)); return; }
      const area = first('atlas-signal-areas-circle') ?? first('atlas-signal-area-fallback') ?? first('atlas-signal-areas-card') ?? first('atlas-signal-areas-label') ?? first('atlas-signal-topics'); if (area) {
        if (latest.current.onSignalGroup) latest.current.onSignalGroup(String(area.properties.territoryId));
        else if (area.properties.signalId) latest.current.onSignal(String(area.properties.signalId));
        else latest.current.onTerritory(String(area.properties.territoryId));
        return;
      }
      const eventScene = gpuLayers.scenes.pick(event.point);
      if (eventScene) { latest.current.onSignal(eventScene); return; }
      if (map.getZoom() < 6 && map.getLayer('atlas-russia-hit')) {
        const region = map.queryRenderedFeatures(event.point, { layers: ['atlas-russia-hit'] })[0];
        if (region) {
          let coordinates: unknown = region.properties.center;
          if (typeof coordinates === 'string') { try { coordinates = JSON.parse(coordinates); } catch { coordinates = null; } }
          const center: [number, number] = Array.isArray(coordinates) && validCoordinates(coordinates as [number, number]) ? coordinates as [number, number] : [event.lngLat.lng, event.lngLat.lat];
          if (latest.current.onRegion) latest.current.onRegion(String(region.properties.id), String(region.properties.name), center);
          else if (region.properties.id === 'RU-TA') latest.current.onTerritory('RU-TA');
          return;
        }
      }
      const landmark = gpuLayers.landmarks.pick(event.point);
      if (landmark) { latest.current.onLandmark(landmark); return; }
      const entrance = gpuLayers.life.pickOffice(event.point);
      if (entrance) { latest.current.onOffice(entrance); return; }
      if (map.getZoom() >= 14 && latest.current.onBuilding) {
        const building = first('atlas-building-parts-3d') ?? first('atlas-building-3d') ?? first('atlas-building-flat');
        if (building) {
          const reportedHeight = Number(building.properties.height);
          const reportedFloors = Number(building.properties.num_floors);
          const measured = Number.isFinite(reportedHeight) && reportedHeight > 0;
          const floors = Number.isFinite(reportedFloors) && reportedFloors > 0 ? reportedFloors : null;
          latest.current.onBuilding({ id: String(building.properties.id), coordinates: [event.lngLat.lng, event.lngLat.lat], height: measured ? reportedHeight : floors ? floors * 3 : 8, estimated: !measured, floors });
          return;
        }
      }
    };
    map.on('style.load', () => {
      if (cancelled) return;
      try {
        setPhase('layers-loading');
        if (!loaded.current) {
          map.setProjection({ type: 'mercator' });
          addAtlasLayers(map, lightingRef.current!);
          map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');
          map.getCanvas().setAttribute('aria-label', 'Интерактивная карта России: регионы, муниципалитеты, сигналы, офисы и здания');
        } else {
          // Context restoration retains vector sources/layers, but never the
          // custom GPU objects or their fetch controllers and interaction refs.
          configureBuildingTileLod(map); maskedMaps.delete(map); errors.current.delete('landmarks');
        }
        clearMarkerGroups?.(); clearMarkerGroups = installMarkerGroups(map);
        gpuLayers = recreateMapGpuLayers(map, createGpuLayers); loaded.current = true;
        refreshData(map, latest.current); refreshVisibility(map, latest.current, !errors.current.has('landmarks')); applyMapLighting(map, lightingRef.current!, true);
        setReady(true); setPhase('ready'); report();
        performance.mark('atlas-map-ready');
      } catch (error) { console.warn('Atlas map layer error', error); setMapError(String(error)); setPhase('layers-error'); errors.current.add('layers'); report(); }
    });
    map.on('click', onClick);
    const onPointerMove = (event: MapMouseEvent) => {
      if (!loaded.current || !map.getLayer('atlas-district-hit')) return;
      const feature = map.queryRenderedFeatures(event.point, { layers: ['atlas-district-hit'] })[0];
      const id = String(feature?.properties?.territoryId ?? '');
      if (!id || id === lastHoveredTerritory) return;
      lastHoveredTerritory = id;
      latest.current.onHoverTerritory?.(id);
    };
    map.on('mousemove', onPointerMove);
    map.on('movestart', () => {
      // Screen-space offsets belong to the settled camera. Discard them before
      // a flight or tilt can stretch their geographic connectors across the view.
      if (map.getLayer('atlas-signal-marker-links')) map.setPaintProperty('atlas-signal-marker-links','line-opacity',0);
      if (!markerSpread.get(map)) return;
      const points = markerPoints.get(map);
      if (points) (map.getSource('atlas-signal-points') as GeoJSONSource | undefined)?.setData(points);
      (map.getSource('atlas-signal-marker-links') as GeoJSONSource | undefined)?.setData({type:'FeatureCollection',features:[]});
      markerSpread.set(map, false);
    });
    map.on('move', reportCamera);
    map.on('zoom', () => { if (loaded.current) refreshLandmarkMasks(map, latest.current, !errors.current.has('landmarks')); });
    const syncCameraScope = () => {
      if (cancelled || !boundaryData || map.isMoving() || latest.current.cameraScopeEnabled === false) return;
      const center = map.getCenter();
      const id = cameraTerritory([center.lng, center.lat], map.getZoom(), latest.current.territories, boundaryData, latest.current.territoryId);
      const scope = id ?? 'RU-TA';
      if (scope !== latest.current.territoryId) latest.current.onCameraTerritory?.(scope);
    };
    // Debounce the settled camera, never fly in response to its own scope change.
    map.on('moveend', () => {
      map.triggerRepaint(); report();
      if (map.getZoom() >= MARKER_SPREAD_ZOOM || markerSpread.get(map)) refreshMarkerLayout(map);
      if (scopeTimer) clearTimeout(scopeTimer);
      scopeTimer = setTimeout(syncCameraScope, 180);
    });
    fetch('/data/tatarstan-boundaries.geojson', {signal:boundaryAbort.signal}).then(r => r.json()).then((data: FeatureCollection) => { boundaryData = data; syncCameraScope(); }).catch(() => {});
    map.on('error', (event) => { console.warn('Atlas map source error', event.error); setMapError(String(event.error)); errors.current.add('sourceId' in event && typeof event.sourceId === 'string' ? event.sourceId : 'basemap'); report(); });
    map.on('sourcedata', (event) => {
      if (event.isSourceLoaded && event.sourceId) {
        let recovered = errors.current.delete(event.sourceId);
        if (event.sourceId === 'openmaptiles') recovered = errors.current.delete('basemap') || recovered;
        if (recovered) report();
      }
    });
    map.on('webglcontextlost', (event) => { event.originalEvent.preventDefault(); webglActive = false; setFallback(true); report(); });
    map.on('webglcontextrestored', () => { webglActive = true; setFallback(false); map.resize(); report(); });
    const onOffline = () => report();
    const onOnline = () => { errors.current.delete('basemap'); map.triggerRepaint(); report(); };
    window.addEventListener('offline', onOffline); window.addEventListener('online', onOnline);
    const resize = new ResizeObserver(() => {
      if (cancelled || mapRef.current !== map) return;
      map.resize();
      const bounds = containerRef.current?.getBoundingClientRect();
      if (bounds) detailsRef.current?.setMobile(bounds.width <= 760 || window.matchMedia('(pointer: coarse)').matches);
      if (bounds && !map.isMoving()) {
        const compact = bounds.width <= 760;
        const padding = { top: 0, right: !compact && latest.current.panelOpen ? Math.min(340, bounds.width * 0.28) : 0, bottom: compact && latest.current.panelOpen ? Math.min(220, bounds.height * 0.32) : 0, left: 0 };
        const current = map.getPadding();
        if (current.right !== padding.right || current.bottom !== padding.bottom) map.setPadding(padding);
      }
    }); if (containerRef.current) resize.observe(containerRef.current);
    report();
    return () => {
      cancelled = true; loaded.current = false; resize.disconnect();
      boundaryAbort.abort(); if (scopeTimer) clearTimeout(scopeTimer); clearMarkerGroups?.();
      markerPoints.delete(map); markerSpread.delete(map);
      if (cameraReportTimer !== null) clearTimeout(cameraReportTimer);
      window.removeEventListener('offline', onOffline); window.removeEventListener('online', onOnline);
      map.off('mousemove', onPointerMove);
      map.remove(); mapRef.current = null; lifeRef.current = null; scenesRef.current = null; detailsRef.current = null; solarRef.current = null;
      if (process.env.NODE_ENV === 'development') {
        const diagnostics = window as Window & { __atlasMap?: LibreMap };
        if (diagnostics.__atlasMap === map) delete diagnostics.__atlasMap;
      }
    };
    // The map is created once. Data, callbacks, selection and controls use refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (ready && loaded.current && mapRef.current) refreshSignals(mapRef.current, latest.current); }, [ready, props.signals, props.territories, props.territoryId, props.unreadSignalIds, props.recentSignalIds]);
  useEffect(() => { if (ready && loaded.current && mapRef.current) refreshOffices(mapRef.current, latest.current.offices); }, [ready, props.offices]);
  useEffect(() => { if (ready && loaded.current && mapRef.current) refreshRoute(mapRef.current, latest.current.route); }, [ready, props.route]);
  useEffect(()=>{const map=mapRef.current;if(!ready||!map)return;const ids=activeSignalHighlightIds(props.panelOpen,props.selectedSignalId,props.highlightedSignalId);if(map.getLayer('atlas-signal-object-focus'))map.setFilter('atlas-signal-object-focus',['==',['get','id'],props.panelOpen?props.selectedSignalId??'':'']);if(map.getLayer('atlas-signal-point-highlight'))map.setFilter('atlas-signal-point-highlight',ids.length?['in',['get','id'],['literal',ids]]:['==',['get','id'],'']);},[ready,props.panelOpen,props.selectedSignalId,props.highlightedSignalId]);
  useEffect(()=>{const map=mapRef.current;if(!ready||!map?.getLayer('atlas-district-hover'))return;map.setFilter('atlas-district-hover',['==',['get','territoryId'],props.highlightedTerritoryId??'']);},[ready,props.highlightedTerritoryId]);
  useEffect(()=>{if(ready&&loaded.current&&mapRef.current)refreshClientLayers(mapRef.current,props.clients||[],Boolean(props.clientsVisible));},[ready,props.clients,props.clientsVisible]);
  useEffect(() => { if (ready && loaded.current && mapRef.current) refreshOrganization(mapRef.current, latest.current.focusedOrganization); }, [ready, props.focusedOrganization]);
  useEffect(() => { if (ready && loaded.current && mapRef.current) {refreshVisibility(mapRef.current, latest.current, !errors.current.has('landmarks')); detailsRef.current?.refresh();} }, [ready, props.layers, props.is3D, props.bankFocus]);
  useEffect(() => {
    const map = mapRef.current, focus = props.focus;
    if (!ready || !loaded.current || !map || !map.getLayer('atlas-region-line') || !containerRef.current) return;
    const previous = lastCamera.current;
    const focusChanged = Boolean(focus && (!previous || previous.focusNonce !== focus.nonce));
    const modeChanged = Boolean(previous && previous.is3D !== props.is3D);
    const panelChanged = !previous || previous.panelOpen !== Boolean(props.panelOpen);
    lastCamera.current = { focusNonce: focus?.nonce ?? null, is3D: props.is3D, panelOpen: Boolean(props.panelOpen) };
    if (!focusChanged && !modeChanged && !panelChanged) return;
    const bounds = containerRef.current.getBoundingClientRect(), compact = bounds.width <= 760;
    const padding = { top: 0, left: 0, right: !compact && props.panelOpen ? Math.min(340, bounds.width * 0.28) : 0, bottom: compact && props.panelOpen ? Math.min(220, bounds.height * 0.32) : 0 };
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Opening a list is UI-only. A stale focus can otherwise be replayed here
    // when the panel changes, throwing a manually positioned city camera back
    // to the regional overview. Padding does not need a camera transition.
    if (panelChanged && !focusChanged && !modeChanged) {
      map.setPadding(padding);
      return;
    }
    if (focusChanged && focus && focus.zoom < 3) {
      const overviewPadding = { top: compact ? 150 : 110, left: compact ? 20 : 70, right: padding.right + 24, bottom: padding.bottom + (compact ? 135 : 100) };
      const camera = map.cameraForBounds(RUSSIA_VIEW_BOUNDS, { padding: overviewPadding, bearing: 0 });
      if (camera) { map.easeTo({ ...camera, pitch: 0, padding, duration: reduced ? 0 : 580, essential: false }); return; }
    }
    if (focusChanged && focus?.bbox && focus.bbox.every(Number.isFinite)) {
      const [west,south,east,north]=focus.bbox;
      if (west<east && south<north) {
        const panel=containerRef.current.closest('.atlas')?.querySelector('.context-panel')?.getBoundingClientRect();
        const visiblePadding={top:100,left:48,right:!compact&&props.panelOpen?Math.max(padding.right,panel?bounds.right-panel.left+32:0):48,bottom:padding.bottom+100};
        const camera=map.cameraForBounds([[west,south],[east,north]],{padding:visiblePadding,maxZoom:focus.zoom,bearing:focus.bearing??0});
        if(camera){map.easeTo({...camera,pitch:props.is3D?Math.min(focus.pitch??40,40):0,padding:visiblePadding,duration:reduced?0:580,essential:false});return;}
      }
    }
    const center = focusChanged && focus ? focus.coordinates : map.getCenter();
    const zoom = focusChanged && focus ? focus.zoom : map.getZoom();
    const naturalPitch = naturalMapPitch(zoom);
    const pitch = !props.is3D ? 0 : focusChanged && focus ? focus.pitch ?? naturalPitch : modeChanged ? naturalPitch : map.getPitch();
    const bearing = focusChanged && focus ? focus.bearing ?? 0 : map.getBearing();
    // One camera transition owns focus, pitch and panel padding. A second easeTo
    // in another effect would cancel the selected object's zoom mid-flight.
    map.easeTo({ center, zoom, pitch, bearing, padding, duration: reduced ? 0 : focusChanged ? 580 : modeChanged ? 350 : 180, essential: false });
  }, [ready, props.focus, props.is3D, props.panelOpen]);

  useEffect(() => {
    const map = mapRef.current; if (!ready || !loaded.current || !map || !map.getLayer('atlas-region-line')) return;
    let disposed = false, frame = 0;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let lastSpatialAmount = spatialLightingAmount(map.getZoom());
    const renderLighting = () => {
      if (disposed || !loaded.current || mapRef.current !== map || !map.getLayer('atlas-region-line')) return;
      applyMapLighting(map, lightingRef.current!, true);
      const direction = worldLightingRef.current!.sunDirection;
      solarRef.current?.setSun([direction[2], direction[0], direction[1]]);
      map.triggerRepaint();
    };
    const onZoomLighting = () => {
      const spatialAmount = spatialLightingAmount(map.getZoom());
      // The geographic palette stops blending at city scale. Its colors do
      // not depend on further zoom changes; the GPU atmosphere still renders.
      if (spatialAmount !== lastSpatialAmount) renderLighting();
      lastSpatialAmount = spatialAmount;
    };
    const visuallyUnchanged = (from: LightingState, target: LightingState) =>
      Math.abs(from.nightAmount - target.nightAmount) < 0.001 && Math.abs(from.brightness - target.brightness) < 0.001 &&
      Math.hypot(...from.sunDirection.map((value, index) => value - target.sunDirection[index])) < 0.0002;
    const update = () => {
      if (disposed || !loaded.current || mapRef.current !== map || !map.getLayer('atlas-region-line')) return;
      cancelAnimationFrame(frame);
      const center = map.getCenter(), appearance = latest.current.appearance ?? DEFAULT_APPEARANCE, date = new Date();
      const target = getSceneTime(appearance, { date, coordinates: [center.lng, center.lat] });
      const worldTarget = getSceneTime(appearance, { date, coordinates: [0, 0] });
      const from = lightingRef.current!, worldFrom = worldLightingRef.current!;
      if (reduced.matches || document.hidden || visuallyUnchanged(from, target) && visuallyUnchanged(worldFrom, worldTarget)) { lightingRef.current = target; worldLightingRef.current = worldTarget; renderLighting(); return; }
      const started = performance.now();
      const animate = (now: number) => {
        if (disposed) return;
        const progress = Math.min(1, (now - started) / 900), eased = progress * progress * (3 - 2 * progress);
        lightingRef.current = interpolateLighting(from, target, eased);
        worldLightingRef.current = interpolateLighting(worldFrom, worldTarget, eased);
        renderLighting();
        if (progress < 1) frame = requestAnimationFrame(animate);
      };
      frame = requestAnimationFrame(animate);
    };
    const onVisibility = () => { if (document.hidden) cancelAnimationFrame(frame); else update(); };
    update(); const timer = setInterval(() => { if (!document.hidden) update(); }, 30000);
    map.on('moveend', update); map.on('zoom', onZoomLighting);
    document.addEventListener('visibilitychange', onVisibility); reduced.addEventListener('change', update);
    return () => { disposed = true; cancelAnimationFrame(frame); clearInterval(timer); map.off('moveend', update); map.off('zoom', onZoomLighting); document.removeEventListener('visibilitychange', onVisibility); reduced.removeEventListener('change', update); };
  }, [ready, props.appearance?.timeMode, props.appearance?.hour]);

  useEffect(() => { if (ready && loaded.current) { lifeRef.current?.rebuild(); mapRef.current?.triggerRepaint(); } }, [ready, props.layers.banks, props.offices, props.is3D, props.bankFocus]);
  useEffect(() => { if (ready && loaded.current) { scenesRef.current?.refresh(); mapRef.current?.triggerRepaint(); } }, [ready, eventScenes, props.is3D, props.layers.signals, props.bankFocus]);
  useEffect(() => { if (ready && loaded.current) mapRef.current?.triggerRepaint(); }, [ready, props.appearance?.life]);

  useEffect(() => {
    const map = mapRef.current; if (!ready || !loaded.current || !map || !map.getLayer('atlas-region-line')) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let timer: ReturnType<typeof setInterval> | null = null;
    let disposed = false;
    const pulse = () => {
      if (disposed || !loaded.current || mapRef.current !== map || !map.getLayer('atlas-region-line')) return;
      const active = (latest.current.appearance ?? DEFAULT_APPEARANCE).life && latest.current.layers.signals && !reduced && !document.hidden;
      const cycle=performance.now()%2200;
      const flash=(center:number)=>Math.max(0,1-Math.abs(cycle-center)/150);
      const pulseOpacity=active?1-Math.max(flash(180),flash(540))*.62:1;
      if(map.getLayer('atlas-signal-clusters')) map.setPaintProperty('atlas-signal-clusters','icon-opacity',['case',['>',['get','unread_count'],0],pulseOpacity,1]);
      if(map.getLayer('atlas-signal-areas-circle')) map.setPaintProperty('atlas-signal-areas-circle','icon-opacity',['case',['>',['get','unreadCount'],0],pulseOpacity,1]);
      if(map.getLayer('atlas-signal-area-fallback')) map.setPaintProperty('atlas-signal-area-fallback','icon-opacity',['case',['>',['get','unreadCount'],0],pulseOpacity,.82]);
      if(map.getLayer('atlas-signal-points-circle')) map.setPaintProperty('atlas-signal-points-circle','icon-opacity',['case',['>',['get','unreadCount'],0],pulseOpacity,['get','ageOpacity']]);
    };
    const sync = () => {
      if (timer) { clearInterval(timer); timer = null; }
      if (disposed || !loaded.current || mapRef.current !== map || !map.getLayer('atlas-region-line')) return;
      pulse();
      if ((latest.current.appearance ?? DEFAULT_APPEARANCE).life && latest.current.layers.signals && !reduced && !document.hidden) timer = setInterval(pulse, window.matchMedia('(max-width:760px)').matches ? 120 : 90);
    };
    sync(); document.addEventListener('visibilitychange', sync);
    return () => { disposed = true; if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', sync); };
  }, [ready, props.appearance?.life, props.layers.signals, props.bankFocus]);

  useEffect(()=>{const map=mapRef.current;if(!ready||!loaded.current||!map||!props.layers.signals||props.bankFocus)return;return installDomSignalMarkers(map,()=>latest.current.signals,id=>latest.current.onSignal(id));},[ready,props.signals,props.layers.signals,props.bankFocus]);
  useEffect(()=>{const map=mapRef.current;if(!ready||!loaded.current||!map||!props.layers.banks)return;return installDomBankMarkers(map,()=>latest.current.offices,id=>latest.current.onOffice(id));},[ready,props.offices,props.layers.banks]);

  return <div className="atlas-map-surface" data-testid="atlas-map" data-atlas-ready={ready} data-map-phase={phase} data-map-error={mapError || undefined} style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#142d3b' }}>
    <div ref={containerRef} style={{ position: 'absolute', inset: 0, visibility: fallback ? 'hidden' : 'visible' }} />
    {fallback && <FlatFallback territories={props.territories} />}
  </div>;
}
