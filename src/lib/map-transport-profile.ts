/** Physical dimensions are source values when present, otherwise class-based illustration. */
export type RoadGeometryProfile = { width: number; lanes: number; laneWidth: number; roadClass: string; estimated: boolean };
export const ROAD_ASPHALT_COLOR = '#69757b';
const positive = (value: unknown) => { const n = Number(String(value ?? '').replace(/\s*m\s*$/, '')); return Number.isFinite(n) && n > 0 ? n : null; };
export function roadGeometryProfile(properties: Record<string, unknown> = {}): RoadGeometryProfile {
  const roadClass = String(properties.roadClass ?? properties.class ?? 'minor');
  const oneWay = [true, 1, -1, 'yes', '1', '-1'].includes(properties.oneway as string | number | boolean);
  const major = ['motorway', 'trunk', 'primary'].includes(roadClass), service = ['service', 'track'].includes(roadClass) || properties.subclass === 'service';
  const lanesValue = positive(properties.lanes), widthValue = positive(properties.width);
  const lanes = Math.max(1, Math.min(8, Math.round(lanesValue ?? (service || oneWay ? 1 : major ? 4 : 2))));
  const nominalLane = major ? 3.25 : service ? 3.1 : 2.9;
  const width = Math.max(3, Math.min(36, widthValue ?? lanes * nominalLane + 0.6));
  return { width, lanes, laneWidth: (width - 0.6) / lanes, roadClass, estimated: widthValue === null };
}
export function roadLaneOffset(profile: RoadGeometryProfile) {
  return profile.lanes === 1 ? 0 : Math.min(profile.width / 2 - 1.15, profile.laneWidth / 2);
}
export function railwayKind(p: Record<string, unknown>): 'rail' | 'tram' | null {
  if (p.brunnel === 'tunnel' || p.tunnel === 'yes' || ['subway', 'abandoned', 'disused', 'construction', 'proposed'].includes(String(p.subclass ?? p.railway))) return null;
  const value = String(p.subclass ?? p.railway ?? p.class);
  return ['tram', 'light_rail'].includes(value) ? 'tram' : p.class === 'rail' || value === 'rail' ? 'rail' : null;
}
export function walkablePath(p: Record<string, unknown>) {
  if (p.brunnel === 'tunnel' || p.access === 'private' || p.foot === 'no') return false;
  const value = String(p.subclass ?? p.class);
  return ['footway', 'pedestrian', 'path', 'steps'].includes(value) || value === 'cycleway' && ['yes', 'designated'].includes(String(p.foot));
}
