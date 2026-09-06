import { getSceneTime, type LightingState, type SceneAppearance } from './solar';

type SunDirection = LightingState['sunDirection'];
const RAD = Math.PI / 180;
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const mix = (from: number, to: number, progress: number) => from + (to - from) * progress;
const wrap = (value: number, period: number) => ((value % period) + period) % period;

function mixCircular(from: number, to: number, progress: number, period: number) {
  const distance = wrap(to - from + period / 2, period) - period / 2;
  return wrap(from + distance * progress, period);
}

function normalize(vector: SunDirection): SunDirection {
  const length = Math.hypot(...vector);
  return length > 0 ? [vector[0] / length, vector[1] / length, vector[2] / length] : [0, 0, 1];
}

/** Travel along the unit sphere, including a stable arc for opposite directions. */
function mixSunDirection(from: SunDirection, to: SunDirection, progress: number): SunDirection {
  const start = normalize(from), end = normalize(to);
  if (progress === 0) return start;
  if (progress === 1) return end;
  const dot = clamp(start[0] * end[0] + start[1] * end[1] + start[2] * end[2], -1, 1);
  if (dot > 0.9995) return normalize([mix(start[0], end[0], progress), mix(start[1], end[1], progress), mix(start[2], end[2], progress)]);

  let tangent: SunDirection = [end[0] - start[0] * dot, end[1] - start[1] * dot, end[2] - start[2] * dot];
  if (Math.hypot(...tangent) < 1e-10) {
    // An antipodal pair has infinitely many arcs. Choose the least-aligned axis
    // deterministically, so the sun never collapses to a zero vector mid-flight.
    const axis = start.map(Math.abs).indexOf(Math.min(...start.map(Math.abs)));
    const projection = start[axis];
    tangent = [-start[0] * projection, -start[1] * projection, -start[2] * projection];
    tangent[axis] += 1;
  }
  tangent = normalize(tangent);
  const angle = Math.acos(dot) * progress, cosine = Math.cos(angle), sine = Math.sin(angle);
  return normalize([start[0] * cosine + tangent[0] * sine, start[1] * cosine + tangent[1] * sine, start[2] * cosine + tangent[2] * sine]);
}

/** Numeric lighting values remain continuous when a time or region changes. */
export function interpolateLighting(from: LightingState, to: LightingState, progress: number): LightingState {
  const t = clamp(progress);
  return {
    ...(t < 0.5 ? from : to),
    localHour: mixCircular(from.localHour, to.localHour, t, 24),
    sunAzimuth: mixCircular(from.sunAzimuth, to.sunAzimuth, t, 360),
    sunElevation: mix(from.sunElevation, to.sunElevation, t),
    brightness: mix(from.brightness, to.brightness, t),
    nightAmount: mix(from.nightAmount, to.nightAmount, t),
    sunDirection: mixSunDirection(from.sunDirection, to.sunDirection, t),
  };
}

/** Earth-fixed sun vector: X at Greenwich, Y at 90°E, Z at the North Pole. */
export function getWorldSunDirection(appearance: SceneAppearance, date = new Date()): SunDirection {
  const { sunDirection } = getSceneTime(appearance, { date, coordinates: [0, 0] });
  return [sunDirection[2], sunDirection[0], sunDirection[1]];
}

/** Same twilight interval as getLightingState, evaluated anywhere on Earth. */
export function geographicNightAmount(longitude: number, latitude: number, worldSun: SunDirection) {
  const lon = longitude * RAD, lat = latitude * RAD;
  const elevation = Math.asin(clamp(Math.cos(lat) * Math.cos(lon) * worldSun[0] + Math.cos(lat) * Math.sin(lon) * worldSun[1] + Math.sin(lat) * worldSun[2], -1, 1)) / RAD;
  const twilight = clamp((elevation + 8) / 14);
  return 1 - twilight * twilight * (3 - 2 * twilight);
}
