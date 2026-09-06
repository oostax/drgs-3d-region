export type SceneAppearance = { timeMode: 'auto' | 'manual'; hour: number; life: boolean };
export type LightingPhase = 'night' | 'dawn' | 'morning' | 'day' | 'sunset' | 'twilight';
export type LightingState = {
  localHour: number; phase: LightingPhase; sunElevation: number; sunAzimuth: number;
  brightness: number; nightAmount: number; timezone: string; sunDirection: [number, number, number];
};
const RAD = Math.PI / 180;
const clamp = (n: number, min = 0, max = 1) => Math.max(min, Math.min(max, n));
const smooth = (n: number) => { const t = clamp(n); return t * t * (3 - 2 * t); };

function localDateParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23', timeZoneName: 'shortOffset' }).formatToParts(date);
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const offset = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(p.timeZoneName);
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour + +p.minute / 60 + +p.second / 3600, offset: offset ? (offset[1] === '-' ? -1 : 1) * (+offset[2] + +(offset[3] || 0) / 60) : 0 };
}

/** Continuous seasonal sun position. Approximation from NOAA General Solar Position
 * Calculations: https://gml.noaa.gov/grad/solcalc/solareqns.PDF (not a weather feed).
 * hour is civil local time in the supplied IANA timezone, on date's local date.
 */
export function getLightingState(hour: number, date = new Date(), coordinates: [number, number] = [49.12, 55.79], timezone = 'Europe/Moscow'): LightingState {
  const local = localDateParts(date, timezone);
  const localHour = ((hour % 24) + 24) % 24;
  const day = (Date.UTC(local.year, local.month - 1, local.day) - Date.UTC(local.year, 0, 0)) / 86400000;
  const days = (Date.UTC(local.year + 1, 0, 1) - Date.UTC(local.year, 0, 1)) / 86400000;
  const gamma = Math.PI * 2 / days * (day - 1 + (localHour - 12) / 24);
  const equation = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const declination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const h = ((localHour * 60 + equation + 4 * coordinates[0] - local.offset * 60) / 4 - 180) * RAD;
  const latitude = coordinates[1] * RAD;
  const elevation = Math.asin(clamp(Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * Math.cos(declination) * Math.cos(h), -1, 1)) / RAD;
  const azimuth = ((Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(latitude) - Math.tan(declination) * Math.cos(latitude)) / RAD + 180) % 360 + 360) % 360;
  const morning = azimuth < 180;
  const nightAmount = 1 - smooth((elevation + 8) / 14);
  const phase: LightingPhase = elevation < -8 ? 'night' : elevation < -1 ? morning ? 'dawn' : 'twilight' : elevation < 10 ? morning ? 'dawn' : 'sunset' : morning && localHour < 11 ? 'morning' : 'day';
  return { localHour, phase, sunElevation: elevation, sunAzimuth: azimuth, brightness: 0.13 + 0.87 * smooth((elevation + 8) / 40), nightAmount, timezone,
    sunDirection: [Math.sin(azimuth * RAD) * Math.cos(elevation * RAD), Math.cos(azimuth * RAD) * Math.cos(elevation * RAD), Math.sin(elevation * RAD)] };
}

export function getSceneTime(appearance: SceneAppearance, options: { date?: Date; coordinates?: [number, number]; timezone?: string } = {}): LightingState {
  const date = options.date ?? new Date(), timezone = options.timezone ?? 'Europe/Moscow';
  return getLightingState(appearance.timeMode === 'auto' ? localDateParts(date, timezone).hour : appearance.hour, date, options.coordinates, timezone);
}
