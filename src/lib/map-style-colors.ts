import { Color } from '@maplibre/maplibre-gl-style-spec';
import type { ExpressionSpecification } from 'maplibre-gl';

export type SurfaceRole = 'ground' | 'residential' | 'industrial' | 'park' | 'wood' | 'grass' | 'farmland' | 'water' | 'snow' | 'sand' | 'asphalt' | 'pavement' | 'roadEdge' | 'rail' | 'building' | 'boundary' | 'label' | 'halo';
export const SURFACE_PALETTE: Record<SurfaceRole, { day: string; night: string }> = {
  ground: { day: '#b9c1b0', night: '#242823' }, residential: { day: '#c4cac0', night: '#2b2e29' }, industrial: { day: '#b4bcb9', night: '#2a2d2b' },
  park: { day: '#a1b493', night: '#253027' }, wood: { day: '#8fa789', night: '#222c24' }, grass: { day: '#aebc9f', night: '#2a3227' }, farmland: { day: '#bcc2a4', night: '#303329' },
  water: { day: '#5794a8', night: '#102f42' }, snow: { day: '#e2e8e7', night: '#4b4e48' }, sand: { day: '#cecbb6', night: '#3d3f35' },
  asphalt: { day: '#717d82', night: '#383d3c' }, pavement: { day: '#b9bcb2', night: '#494c43' }, roadEdge: { day: '#adb4ac', night: '#51544b' }, rail: { day: '#838d8d', night: '#4a4e47' },
  building: { day: '#c5c9c4', night: '#3c3e37' }, boundary: { day: '#788e83', night: '#646d60' }, label: { day: '#374e48', night: '#d0d3c8' }, halo: { day: '#e2e8df', night: '#242b25' },
};

export function mixCssColor(from: string, to: string, amount: number, preserveAlpha = true) {
  const first = Color.parse(from), second = Color.parse(to); if (!first || !second) return to;
  const t = Math.max(0, Math.min(1, amount)), [r, g, b, a] = first.rgb, next = second.rgb;
  return new Color(r + (next[0] - r) * t, g + (next[1] - g) * t, b + (next[2] - b) * t, preserveAlpha ? a : a + (next[3] - a) * t, false).toString();
}

export function surfaceRole(id: string, type: string, property: string): SurfaceRole {
  if (property.includes('halo')) return 'halo'; if (property.startsWith('text-') || property.startsWith('icon-')) return 'label';
  if (/water|ocean|river|lake/.test(id)) return 'water';
  if (/glacier|ice|snow/.test(id)) return 'snow'; if (/sand|beach|dune/.test(id)) return 'sand';
  if (/wood|forest/.test(id)) return 'wood'; if (/park|garden|recreation|cemetery/.test(id)) return 'park'; if (/grass|scrub|heath/.test(id)) return 'grass'; if (/farmland|orchard|crop/.test(id)) return 'farmland';
  if (/building/.test(id) || type === 'fill-extrusion') return 'building';
  if (/rail/.test(id)) return 'rail'; if (/boundary|border/.test(id)) return 'boundary';
  if (/casing|_edge/.test(id)) return 'roadEdge'; if (/path|pedestrian|footway|pier|plaza|pavement/.test(id)) return 'pavement';
  if (/road|highway|motorway|bridge|tunnel|aeroway/.test(id)) return 'asphalt';
  if (/residential|neighbourhood/.test(id)) return 'residential'; if (/industrial|commercial/.test(id)) return 'industrial'; return 'ground';
}

/** Rewrite color outputs, never match labels/conditions or zoom stops. Dynamic colors are tinted at their leaf. */
export function themedColorValue(value: unknown, role: SurfaceRole, night: number): unknown {
  const palette = SURFACE_PALETTE[role];
  const recolor = (color: string) => mixCssColor(mixCssColor(color, palette.day, role === 'label' || role === 'halo' ? 1 : 0.84), palette.night, night);
  if (typeof value === 'string' && Color.parse(value)) return recolor(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const legacy = value as Record<string, unknown>;
    if (Array.isArray(legacy.stops)) return { ...legacy, stops: legacy.stops.map((stop) => { const pair = stop as unknown[]; return [pair[0], themedColorValue(pair[1], role, night)]; }), ...(legacy.default !== undefined ? { default: themedColorValue(legacy.default, role, night) } : {}) };
  }
  if (Array.isArray(value)) {
    const result = [...value], operation = value[0];
    if (['interpolate', 'interpolate-hcl', 'interpolate-lab'].includes(operation)) { for (let i = 4; i < result.length; i += 2) result[i] = themedColorValue(result[i], role, night); return result; }
    if (operation === 'step') { result[2] = themedColorValue(result[2], role, night); for (let i = 4; i < result.length; i += 2) result[i] = themedColorValue(result[i], role, night); return result; }
    if (operation === 'match') { for (let i = 3; i < result.length - 1; i += 2) result[i] = themedColorValue(result[i], role, night); result[result.length - 1] = themedColorValue(result.at(-1), role, night); return result; }
    if (operation === 'case') { for (let i = 2; i < result.length - 1; i += 2) result[i] = themedColorValue(result[i], role, night); result[result.length - 1] = themedColorValue(result.at(-1), role, night); return result; }
    if (operation === 'coalesce') return [operation, ...value.slice(1).map((output) => themedColorValue(output, role, night))];
    if (operation === 'let') { result[result.length - 1] = themedColorValue(result.at(-1), role, night); return result; }
    if (operation === 'literal' && typeof value[1] === 'string' && Color.parse(value[1])) return recolor(value[1]);
    if (['rgb', 'rgba'].includes(operation) && value.slice(1).every((item) => typeof item === 'number')) return recolor(`${operation}(${value.slice(1).join(',')})`);
    const target = mixCssColor(palette.day, palette.night, night);
    // Leaf interpolation avoids nesting a ['zoom'] expression under an unsupported operator.
    return ['interpolate', ['linear'], 0.84 + night * 0.16, 0, ['to-color', value, target], 1, target];
  }
  return mixCssColor(palette.day, palette.night, night);
}

/** Legacy deterministic helper, retained for compatibility. Building materials no longer use IDs to choose appearance. */
const tailHash: ExpressionSpecification[] = [1, 2, 3, 4].map((offset, index): ExpressionSpecification => ['*', [1, 3, 5, 7][index], ['max', 0, ['index-of', ['slice', ['var', 'building_key'], ['max', 0, ['-', ['length', ['var', 'building_key']], offset]], ['max', 0, ['-', ['length', ['var', 'building_key']], offset - 1]]], '0123456789abcdefghijklmnopqrstuvwxyz']]]);
export const BUILDING_VARIANT: ExpressionSpecification = ['let', 'building_key', ['to-string', ['coalesce', ['get', 'building_id'], ['get', 'id'], ['id'], '0']], ['%', ['+', ...tailHash], 8]];
