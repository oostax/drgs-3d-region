import type { ExpressionSpecification } from 'maplibre-gl';
import { Color, createExpression } from '@maplibre/maplibre-gl-style-spec';
import type { LightingState } from './solar';

/** Region-independent visual families; a family is an illustration, not a recovered facade. */
export type BuildingProfileKind = 'neutral' | 'apartments' | 'panel' | 'brick' | 'house' | 'office' | 'retail' | 'education' | 'hospital' | 'industrial' | 'warehouse' | 'garage' | 'shed' | 'religious' | 'historic' | 'utility'
  | 'residential' | 'contemporary' | 'kindergarten' | 'university' | 'clinic' | 'medical' | 'stadium' | 'sports' | 'civic' | 'cultural' | 'hotel' | 'transport' | 'agricultural' | 'greenhouse' | 'commercial' | 'outbuilding';
export type BuildingSurface = 'plaster' | 'panel' | 'brick' | 'wood' | 'metal' | 'stone' | 'glass' | 'plain';
export type BuildingProfile = {
  kind: BuildingProfileKind; surface: BuildingSurface; facadeColor: string; roofColor: string; sourceFacadeColor: boolean; sourceRoofColor: boolean;
  rawFacadeColor: string | null; rawRoofColor: string | null;
  facadeVariant: 0 | 1 | 2; roofMaterial: string | null;
  height: number; base: number; eaves: number; floors: number; floorHeight: number; heightEstimated: boolean; floorsEstimated: boolean;
  windows: 'none' | 'regular' | 'wide' | 'narrow' | 'industrial'; windowSpacing: number; roofShape: string | null; roofHeight: number; roofDirection: number | null; tiny: boolean;
};
type Properties = Record<string, unknown>;
const numeric = (value: unknown) => { const n = typeof value === 'string' ? Number(value.replace(/\s*m$/i, '').replace(',', '.')) : Number(value); return Number.isFinite(n) && n > 0 ? n : null; };
const token = (value: unknown) => typeof value === 'string' ? value.toLowerCase().trim() : '';
const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));
const toHex = (c: Color) => '#' + c.rgb.slice(0, 3).map((n) => Math.round(n * 255).toString(16).padStart(2, '0')).join('');
const FACADE_COLOR_KEYS = ['facade_color', 'building:colour', 'building:color'];
const ROOF_COLOR_KEYS = ['roof_color', 'roof:colour', 'roof:color'];
// Names and near-primary RGB codes describe pigment families; natural numeric shades stay exact.
const CSS_COLOR_NAMES = `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`.split(' ');
const PIGMENT_OVERRIDES: Record<string, [string, string]> = {
  red: ['#b58170', '#906557'], blue: ['#899dab', '#667e8b'], green: ['#8f9b7f', '#697b63'],
  yellow: ['#d4c293', '#b0a079'], brown: ['#9b8170', '#78695b'], white: ['#e0ded3', '#b5b8af'], black: ['#555954', '#454b47'],
};
function pigment(c: Color, roof: boolean): string {
  const [r, g, b] = c.rgb, low = Math.min(r, g, b), high = Math.max(r, g, b), middle = (low + high) / 2;
  // Compress chroma while preserving light/dark distinctions and the source hue.
  const lightness = (roof ? 0.24 : 0.34) + middle * (roof ? 0.46 : 0.52);
  const chroma = Math.min(high - low, roof ? 0.22 : 0.24);
  return toHex(new Color(...[r, g, b].map((channel) => lightness + (high === low ? 0 : (channel - middle) / (high - low) * chroma)) as [number, number, number], 1));
}
const namedPigments = new Map(CSS_COLOR_NAMES.map((name) => {
  const parsed = Color.parse(name)!;
  return [parsed.toString(), PIGMENT_OVERRIDES[name] ?? [pigment(parsed, false), pigment(parsed, true)]] as const;
}));
function isExceptionallySaturated(c: Color) {
  const [r, g, b] = c.rgb, low = Math.min(r, g, b), high = Math.max(r, g, b);
  return high - low >= 0.5 && low <= high * 0.22;
}
function sourceColor(properties: Properties, keys: string[], roof: boolean) {
  const candidates = keys.map((key) => properties[key]).filter((value): value is string => typeof value === 'string');
  const valid = candidates.filter((value) => { const parsed = Color.parse(value); return parsed && parsed.a >= 0.9; });
  const raw = valid.find((value) => value.includes('#')) ?? valid[0] ?? null;
  if (raw === null) return { raw: candidates[0] ?? null, color: null };
  const parsed = Color.parse(raw)!;
  const categorical = !raw.includes('#') && !raw.includes('(') || isExceptionallySaturated(parsed);
  return { raw, color: categorical ? namedPigments.get(parsed.toString())?.[roof ? 1 : 0] ?? pigment(parsed, roof) : toHex(parsed) };
}
const palette: Record<BuildingProfileKind, { facade: string; roof: string; surface: BuildingSurface; fallback: number; floor: number; spacing: number; windows: BuildingProfile['windows'] }> = {
  neutral: { facade: '#d8d3c5', roof: '#92958e', surface: 'plaster', fallback: 8, floor: 3, spacing: 3.4, windows: 'none' },
  apartments: { facade: '#d4d1c6', roof: '#8e928c', surface: 'plaster', fallback: 9, floor: 3, spacing: 3.2, windows: 'regular' },
  panel: { facade: '#c9cbc4', roof: '#858b87', surface: 'panel', fallback: 9, floor: 3, spacing: 3.2, windows: 'regular' },
  brick: { facade: '#ad8670', roof: '#858781', surface: 'brick', fallback: 9, floor: 3, spacing: 3.3, windows: 'regular' },
  house: { facade: '#dad2c0', roof: '#8e928a', surface: 'plaster', fallback: 3.2, floor: 3.2, spacing: 3.8, windows: 'regular' },
  office: { facade: '#ccd0cb', roof: '#8b918e', surface: 'plaster', fallback: 7.2, floor: 3.6, spacing: 3.3, windows: 'wide' },
  retail: { facade: '#d6d0c2', roof: '#93968e', surface: 'plaster', fallback: 4, floor: 4, spacing: 5.2, windows: 'wide' },
  education: { facade: '#d7cebb', roof: '#93978e', surface: 'plaster', fallback: 6.6, floor: 3.3, spacing: 3.2, windows: 'regular' },
  hospital: { facade: '#dce0d5', roof: '#959b93', surface: 'plaster', fallback: 6.8, floor: 3.4, spacing: 3.2, windows: 'regular' },
  industrial: { facade: '#c2c5bf', roof: '#858d89', surface: 'plain', fallback: 6, floor: 5, spacing: 5, windows: 'industrial' },
  warehouse: { facade: '#bfc4bf', roof: '#939b95', surface: 'plain', fallback: 5, floor: 5, spacing: 6, windows: 'none' },
  garage: { facade: '#c3bdaa', roof: '#91948a', surface: 'plain', fallback: 2.8, floor: 2.8, spacing: 4, windows: 'none' },
  shed: { facade: '#c5c0b0', roof: '#8c9186', surface: 'plain', fallback: 2.5, floor: 2.5, spacing: 4, windows: 'none' },
  religious: { facade: '#e0daca', roof: '#989c91', surface: 'plaster', fallback: 6, floor: 4, spacing: 5, windows: 'none' },
  historic: { facade: '#d8cfba', roof: '#92968b', surface: 'plaster', fallback: 6, floor: 3.5, spacing: 3.5, windows: 'narrow' },
  utility: { facade: '#c8c6ba', roof: '#96998f', surface: 'plain', fallback: 3, floor: 3, spacing: 4, windows: 'none' },
  residential: { facade: '#d1cbbf', roof: '#92988f', surface: 'plaster', fallback: 3.2, floor: 3.1, spacing: 3.5, windows: 'regular' },
  contemporary: { facade: '#d6d8d0', roof: '#88958d', surface: 'plaster', fallback: 9, floor: 3.2, spacing: 3.4, windows: 'wide' },
  kindergarten: { facade: '#ddd0aa', roof: '#8d9c90', surface: 'plaster', fallback: 6.2, floor: 3.1, spacing: 3.2, windows: 'wide' },
  university: { facade: '#cec5b3', roof: '#8d968e', surface: 'plaster', fallback: 10.5, floor: 3.5, spacing: 3.2, windows: 'narrow' },
  clinic: { facade: '#d2ddd3', roof: '#91a197', surface: 'plaster', fallback: 6.6, floor: 3.3, spacing: 3.2, windows: 'regular' },
  medical: { facade: '#d8ded2', roof: '#97a299', surface: 'plaster', fallback: 3.4, floor: 3.4, spacing: 3.4, windows: 'regular' },
  stadium: { facade: '#b9c7c4', roof: '#8a9b98', surface: 'plain', fallback: 8, floor: 4, spacing: 6.4, windows: 'none' },
  sports: { facade: '#c9d2ca', roof: '#8b9f99', surface: 'plain', fallback: 7, floor: 7, spacing: 5.4, windows: 'industrial' },
  civic: { facade: '#d7cebc', roof: '#8d9690', surface: 'plaster', fallback: 7.2, floor: 3.6, spacing: 3.6, windows: 'narrow' },
  cultural: { facade: '#dbccb4', roof: '#95968b', surface: 'plaster', fallback: 7.2, floor: 3.6, spacing: 4.2, windows: 'narrow' },
  hotel: { facade: '#d6cabc', roof: '#8f958f', surface: 'plaster', fallback: 9.6, floor: 3.2, spacing: 3.1, windows: 'regular' },
  transport: { facade: '#c8cfca', roof: '#879994', surface: 'plain', fallback: 6, floor: 6, spacing: 5.4, windows: 'wide' },
  agricultural: { facade: '#c8c1a8', roof: '#90998a', surface: 'plain', fallback: 4.5, floor: 4.5, spacing: 5.8, windows: 'none' },
  greenhouse: { facade: '#b7d2c2', roof: '#9caf9f', surface: 'glass', fallback: 3.5, floor: 3.5, spacing: 2, windows: 'wide' },
  commercial: { facade: '#d0cec2', roof: '#949b94', surface: 'plaster', fallback: 3.6, floor: 3.6, spacing: 4.2, windows: 'wide' },
  outbuilding: { facade: '#c9c6b6', roof: '#929a8e', surface: 'plain', fallback: 2.8, floor: 2.8, spacing: 4, windows: 'none' },
};

const tintPigment = (base: string, tint: string, amount: number) => {
  const a = Color.parse(base)!.rgb, b = Color.parse(tint)!.rgb;
  return toHex(new Color(...a.map((channel, i) => channel + (b[i] - channel) * amount) as [number, number, number], 1));
};
// Quiet mineral tones add variety where source colors are absent. These do not assert
// that a building is made of sandstone, concrete, or any other specific material.
const paletteVariants = Object.fromEntries(Object.entries(palette).map(([kind, entry]) => [kind, {
  facade: kind === 'neutral' ? [entry.facade, '#e3dccb', '#c4cbc8'] : [entry.facade, tintPigment(entry.facade, '#f3ecdc', 0.26), tintPigment(entry.facade, '#9babaa', 0.2)],
  roof: kind === 'neutral' ? ['#637b76', '#97705c', '#687981'] : [tintPigment(entry.roof, '#4e6668', 0.38), tintPigment(entry.roof, '#9b745b', 0.5), tintPigment(entry.roof, '#52716e', 0.42)],
}])) as Record<BuildingProfileKind, { facade: [string, string, string]; roof: [string, string, string] }>;

/** Appearance may inherit a parent's tags; all dimensions stay on the original feature. */
export function classifyBuilding(properties: Properties, areaM2 = Infinity, appearance: Properties = properties): BuildingProfile {
  const kind = evaluateProfile(appearance), material = token(appearance.facade_material || appearance['building:material']);
  const defaults = palette[kind], tiny = Number.isFinite(areaM2) && areaM2 < 15;
  // The area of a loaded tile fragment must never resize only the detail overlay.
  const { height, base, knownFloors, heightEstimated } = getBuildingDimensions(properties);
  const roofShape = token(properties.roof_shape || properties['roof:shape']) || null;
  const roofHeight = evaluateRoofHeight(properties);
  const eaves = height - roofHeight, minFloor = Math.max(0, Number(properties.min_floor ?? properties['building:min_level']) || 0);
  const floors = Math.max(1, knownFloors ? knownFloors - minFloor : Math.round((eaves - base) / defaults.floor));
  const floorHeight = (eaves - base) / floors;
  let surface = defaults.surface;
  if (material === 'brick') surface = 'brick'; else if (['concrete_panels', 'panel'].includes(material)) surface = 'panel'; else if (['wood', 'timber', 'timber_framing'].includes(material)) surface = 'wood'; else if (['metal', 'steel', 'aluminium'].includes(material)) surface = 'metal'; else if (['stone', 'sandstone', 'limestone'].includes(material)) surface = 'stone'; else if (material === 'glass' && kind !== 'religious' && !tiny) surface = 'glass'; else if (['plaster', 'concrete', 'cement_block', 'clay', 'plastic'].includes(material)) surface = material === 'plaster' ? 'plaster' : 'plain';
  const facadeSource = sourceColor(appearance, FACADE_COLOR_KEYS, false), roofSource = sourceColor(properties, ROOF_COLOR_KEYS, true);
  const sourceFacade = facadeSource.color, sourceRoof = roofSource.color, variant = facadeVariant(properties);
  const rawDirection = properties.roof_direction ?? properties['roof:direction'], direction = rawDirection === undefined ? NaN : Number(rawDirection);
  return { kind, surface, facadeVariant: variant, roofMaterial: token(properties.roof_material || properties['roof:material']) || null, facadeColor: sourceFacade ?? paletteVariants[kind].facade[variant], roofColor: sourceRoof ?? paletteVariants[kind].roof[variant], sourceFacadeColor: Boolean(sourceFacade), sourceRoofColor: Boolean(sourceRoof), rawFacadeColor: facadeSource.raw, rawRoofColor: roofSource.raw, height, base, eaves, floors, floorHeight, heightEstimated, floorsEstimated: !knownFloors, windows: tiny || floorHeight < 2 || kind === 'religious' ? 'none' : kind === 'neutral' && knownFloors ? 'regular' : defaults.windows, windowSpacing: defaults.spacing, roofShape, roofHeight, roofDirection: Number.isFinite(direction) ? ((direction % 360) + 360) % 360 : null, tiny };
}

const sourceToken = (...keys: string[]): ExpressionSpecification => ['downcase', ['to-string', ['coalesce', ...keys.map(key => ['get', key]), '']]] as ExpressionSpecification;
const SOURCE_CLASS = sourceToken('class', 'building:use', 'building');
const SOURCE_SUBTYPE = sourceToken('subtype');
const matches = (expression: ExpressionSpecification, values: string[]): ExpressionSpecification => ['in', expression, ['literal', values]];
const matchClass = (values: string[]) => matches(SOURCE_CLASS, values);
const trueTag = (key: string): ExpressionSpecification => ['!', matches(sourceToken(key), ['', 'no', 'false', '0'])];
const matchTag = (key: string, values: string[]) => matches(sourceToken(key), values);

// Overture class is the specific purpose; subtype is its broad fallback. These tables also
// accept OSM's architectural building=* and use tags without inspecting IDs or names.
const classes: Record<string, Exclude<BuildingProfileKind, 'neutral' | 'panel' | 'brick' | 'contemporary'>> = {};
const register = (kind: typeof classes[string], values: string[]) => { for (const value of values) classes[value] = kind; };
register('religious', ['church', 'cathedral', 'mosque', 'chapel', 'temple', 'synagogue', 'monastery', 'shrine', 'wayside_shrine', 'religious']);
register('garage', ['garage', 'garages', 'carport', 'parking']);
register('shed', ['shed', 'hut', 'cabin', 'roof', 'shelter', 'beach_hut', 'boathouse']);
register('utility', ['service', 'transformer_tower', 'water_tower', 'toilets', 'substation', 'utility', 'guardhouse', 'digester']);
register('education', ['school', 'education']);
register('kindergarten', ['kindergarten']);
register('university', ['college', 'university']);
register('hospital', ['hospital']);
register('clinic', ['clinic', 'doctors']);
register('medical', ['medical']);
register('warehouse', ['warehouse', 'storage_tank', 'silo', 'hangar', 'slurry_tank']);
register('industrial', ['industrial', 'factory', 'manufacture']);
register('retail', ['retail', 'supermarket', 'kiosk', 'mall']);
register('office', ['office']);
register('apartments', ['apartments', 'dormitory', 'residential_apartments']);
register('house', ['house', 'detached', 'semidetached_house', 'semi', 'terrace', 'bungalow', 'dwelling_house', 'farm', 'allotment_house', 'stilt_house']);
register('residential', ['residential']);
register('commercial', ['commercial']);
register('outbuilding', ['outbuilding']);
register('stadium', ['stadium', 'grandstand']);
register('sports', ['sports_centre', 'sports_hall', 'arena']);
register('civic', ['civic', 'public', 'government', 'townhall', 'fire_station', 'post_office', 'courthouse']);
register('cultural', ['library', 'museum', 'theatre', 'theater', 'cinema', 'community_centre']);
register('hotel', ['hotel', 'hostel', 'guest_house']);
register('transport', ['train_station', 'transportation', 'station', 'terminal']);
register('agricultural', ['agricultural', 'farm_auxiliary', 'barn', 'cowshed', 'stable', 'sty']);
register('greenhouse', ['greenhouse', 'glasshouse']);
const classProfile: ExpressionSpecification = ['match', SOURCE_CLASS, ...Object.entries(classes).flatMap(([source, kind]) => [source, kind]), 'neutral'] as ExpressionSpecification;
const subtypeProfile: ExpressionSpecification = ['match', SOURCE_SUBTYPE,
  'residential', 'residential', 'commercial', 'commercial', 'education', 'education', 'medical', 'medical',
  'industrial', 'industrial', 'religious', 'religious', 'civic', 'civic', 'agricultural', 'agricultural',
  'outbuilding', 'outbuilding', 'service', 'utility', 'neutral'];
const detailUseProfile: ExpressionSpecification = ['case',
  matchTag('amenity', ['place_of_worship']), 'religious',
  matchTag('amenity', ['kindergarten']), 'kindergarten',
  matchTag('amenity', ['school']), 'education',
  matchTag('amenity', ['college', 'university']), 'university',
  matchTag('amenity', ['hospital']), 'hospital',
  matchTag('amenity', ['clinic', 'doctors', 'dentist']), 'clinic',
  matchTag('leisure', ['stadium']), 'stadium',
  matchTag('leisure', ['sports_centre', 'sports_hall', 'fitness_centre', 'swimming_pool']), 'sports',
  ['any', matchTag('tourism', ['museum', 'gallery']), matchTag('amenity', ['library', 'theatre', 'cinema', 'arts_centre', 'community_centre'])], 'cultural',
  matchTag('amenity', ['townhall', 'courthouse', 'fire_station', 'police', 'post_office']), 'civic',
  matchTag('tourism', ['hotel', 'hostel', 'guest_house', 'motel']), 'hotel',
  matchTag('power', ['substation', 'transformer']), 'utility',
  'neutral'];
const broadClasses = ['', 'yes', 'unknown', 'residential', 'commercial', 'civic', 'public', 'education', 'medical'];
const purposeProfile: ExpressionSpecification = ['case',
  ['all', matchClass(broadClasses), ['!=', detailUseProfile, 'neutral']], detailUseProfile,
  ['!=', classProfile, 'neutral'], classProfile,
  trueTag('historic'), 'historic',
  trueTag('shop'), 'retail', trueTag('office'), 'office',
  subtypeProfile];
const materialToken = sourceToken('facade_material', 'building:material');
const startYear: ExpressionSpecification = ['to-number', ['slice', sourceToken('start_date', 'building:year'), 0, 4], 0];
export const BUILDING_PROFILE: ExpressionSpecification = ['let', 'purpose', purposeProfile, ['case',
  ['all', ['==', ['var', 'purpose'], 'apartments'], matches(materialToken, ['concrete_panels', 'panel'])], 'panel',
  ['all', ['==', ['var', 'purpose'], 'apartments'], ['==', materialToken, 'brick']], 'brick',
  // A recent source date selects a contemporary drawing, never a guessed construction date.
  ['all', matches(['var', 'purpose'], ['apartments', 'residential']), ['>=', startYear, 2000], ['<=', startYear, 2099]], 'contemporary',
  ['var', 'purpose']]];
const compiledProfile = createExpression(BUILDING_PROFILE, 'building-profile');
if (compiledProfile.result !== 'success') throw new Error('Invalid building profile expression');
const evaluateProfile = (properties: Properties) => compiledProfile.value.evaluate({ zoom: 0 }, { type: 'Polygon', properties }) as BuildingProfileKind;

/** IDs select only a shared decorative phase and fallback pigment; no ID keeps the default. */
export const BUILDING_FACADE_VARIANT: ExpressionSpecification = ['match', ['slice', sourceToken('building_id', 'id'), -1],
  ['1', '4', '7', 'a', 'd'], 1, ['2', '5', '8', 'b', 'e'], 2, 0];
const evaluateFacadeVariant = numberEvaluator(BUILDING_FACADE_VARIANT, 'building-facade-variant');
const facadeVariant = (properties: Properties) => evaluateFacadeVariant(properties) as 0 | 1 | 2;
function profileExpression(field: 'facade' | 'roof' | 'fallback'): ExpressionSpecification { return ['match', BUILDING_PROFILE, ...Object.entries(palette).filter(([kind]) => kind !== 'neutral').flatMap(([kind, profile]) => [kind, profile[field]]), palette.neutral[field]] as ExpressionSpecification; }
function fallbackPigmentExpression(field: 'facade' | 'roof'): ExpressionSpecification {
  const colors = (kind: BuildingProfileKind): ExpressionSpecification => ['match', ['var', 'paletteVariant'], 1, paletteVariants[kind][field][1], 2, paletteVariants[kind][field][2], paletteVariants[kind][field][0]];
  return ['let', 'paletteVariant', BUILDING_FACADE_VARIANT, ['match', BUILDING_PROFILE,
    'neutral', colors('neutral'),
    ...Object.keys(palette).filter(kind => kind !== 'neutral').flatMap(kind => [kind, colors(kind as BuildingProfileKind)]), colors('neutral')]] as ExpressionSpecification;
}
export const BUILDING_BASE: ExpressionSpecification = ['max', 0, ['to-number', ['get', 'min_height'], 0]];
const SOURCE_HEIGHT: ExpressionSpecification = ['to-number', ['get', 'height'], 0];
// Null/zero num_floors must not mask a valid building:levels value.
const PRIMARY_FLOORS: ExpressionSpecification = ['to-number', ['get', 'num_floors'], 0];
const SOURCE_FLOORS: ExpressionSpecification = ['case', ['>', PRIMARY_FLOORS, 0], PRIMARY_FLOORS, ['to-number', ['get', 'building:levels'], 0]];
export const BUILDING_HEIGHT: ExpressionSpecification = ['max', ['+', BUILDING_BASE, 0.5], ['case', ['>', SOURCE_HEIGHT, 0], SOURCE_HEIGHT, ['>', SOURCE_FLOORS, 0], ['*', SOURCE_FLOORS, 3], profileExpression('fallback')]];
const PITCHED_ROOFS = ['gabled', 'gable', 'hipped', 'hip', 'pyramidal', 'skillion', 'shed', 'sawtooth', 'barrel', 'round'];
const BUILDING_ROOF_HEIGHT: ExpressionSpecification = ['min', ['max', 0, ['-', ['-', BUILDING_HEIGHT, BUILDING_BASE], 1]], ['max', 0, ['to-number', ['get', 'roof_height'], ['get', 'roof:height'], 0]]];
/** Tagged roof heights belong inside total height, so the vector body stops at the eaves. */
export const BUILDING_BODY_HEIGHT: ExpressionSpecification = ['case', matches(sourceToken('roof_shape', 'roof:shape'), PITCHED_ROOFS), ['-', BUILDING_HEIGHT, BUILDING_ROOF_HEIGHT], BUILDING_HEIGHT];
export function getBuildingRenderCap(profile: BuildingProfile) { return profile.roofShape && PITCHED_ROOFS.includes(profile.roofShape) && profile.roofHeight > 0 ? profile.eaves : profile.height; }
// Same compression as pigment(), in the style expression's 0–255 channel space.
function numericPigmentExpression(roof: boolean): ExpressionSpecification {
  const channels = [0, 1, 2].map(index => ['at', index, ['to-rgba', ['var', 'parsed']]] as ExpressionSpecification);
  const low: ExpressionSpecification = ['min', channels[0], channels[1], channels[2]], high: ExpressionSpecification = ['max', channels[0], channels[1], channels[2]];
  const color: ExpressionSpecification = ['rgb', ...channels.map(channel => ['round', ['+',
    ['+', (roof ? 0.24 : 0.34) * 255, ['*', ['var', 'pigmentMiddle'], roof ? 0.46 : 0.52]],
    ['case', ['==', ['var', 'pigmentHigh'], ['var', 'pigmentLow']], 0,
      ['*', ['/', ['-', channel, ['var', 'pigmentMiddle']], ['-', ['var', 'pigmentHigh'], ['var', 'pigmentLow']]],
        ['min', ['-', ['var', 'pigmentHigh'], ['var', 'pigmentLow']], (roof ? 0.22 : 0.24) * 255]]],
  ]])] as ExpressionSpecification;
  return ['let', 'pigmentLow', low, ['let', 'pigmentHigh', high,
    ['let', 'pigmentMiddle', ['/', ['+', ['var', 'pigmentLow'], ['var', 'pigmentHigh']], 2], color]]] as ExpressionSpecification;
}
function sourceColorExpression(keys: string[], roof: boolean): ExpressionSpecification {
  const candidate = (key: string, hexOnly: boolean): ExpressionSpecification => ['let', 'candidate', ['get', key], ['let', 'parsed', ['to-color', ['var', 'candidate'], 'transparent'],
    ['case', ['all', ['==', ['typeof', ['var', 'candidate']], 'string'], ['>=', ['at', 3, ['to-rgba', ['var', 'parsed']]], 0.9], hexOnly ? ['in', '#', ['to-string', ['var', 'candidate']]] : true], ['var', 'candidate'], null]]];
  const raw: ExpressionSpecification = ['coalesce', ...keys.map((key) => candidate(key, true)), ...keys.map((key) => candidate(key, false))];
  const channels = [0, 1, 2].map(index => ['at', index, ['to-rgba', ['var', 'parsed']]] as ExpressionSpecification);
  const low: ExpressionSpecification = ['min', channels[0], channels[1], channels[2]], high: ExpressionSpecification = ['max', channels[0], channels[1], channels[2]];
  const exceptionallySaturated: ExpressionSpecification = ['all', ['>=', ['-', high, low], 127.5], ['<=', low, ['*', high, 0.22]]];
  return ['let', 'raw', raw, ['let', 'parsed', ['to-color', ['var', 'raw'], 'transparent'],
    ['case', ['==', ['var', 'raw'], null], ['to-color', fallbackPigmentExpression(roof ? 'roof' : 'facade')],
      ['any', exceptionallySaturated, ['all', ['!', ['in', '#', ['to-string', ['var', 'raw']]]], ['!', ['in', '(', ['to-string', ['var', 'raw']]]]]],
      ['to-color', ['match', ['to-string', ['var', 'parsed']], ...Array.from(namedPigments).flatMap(([key, values]) => [key, values[roof ? 1 : 0]]), ['to-string', numericPigmentExpression(roof)]]],
      ['rgb', ['at', 0, ['to-rgba', ['var', 'parsed']]], ['at', 1, ['to-rgba', ['var', 'parsed']]], ['at', 2, ['to-rgba', ['var', 'parsed']]]]]]] as ExpressionSpecification;
}
export const BUILDING_FACADE_COLOR: ExpressionSpecification = sourceColorExpression(FACADE_COLOR_KEYS, false);
export const BUILDING_ROOF_COLOR: ExpressionSpecification = sourceColorExpression(ROOF_COLOR_KEYS, true);

function numberEvaluator(expression: ExpressionSpecification, name: string) {
  const compiled = createExpression(expression, name);
  if (compiled.result !== 'success') throw new Error(`Invalid building expression: ${name}`);
  return (properties: Properties): number => compiled.value.evaluate({ zoom: 0 }, { type: 'Polygon', properties }) as number;
}
const evaluateHeight = numberEvaluator(BUILDING_HEIGHT, 'building-height');
const evaluateRoofHeight = numberEvaluator(BUILDING_ROOF_HEIGHT, 'building-roof-height');
const evaluateBase = numberEvaluator(BUILDING_BASE, 'building-base');
const evaluateSourceHeight = numberEvaluator(SOURCE_HEIGHT, 'building-source-height');
const evaluateSourceFloors = numberEvaluator(SOURCE_FLOORS, 'building-source-floors');

/** Evaluate the exact paint expressions, including their coercion and fallback rules. No parent/area/zoom overrides. */
export function getBuildingDimensions(properties: Properties) {
  const knownFloors = evaluateSourceFloors(properties);
  return { height: evaluateHeight(properties), base: evaluateBase(properties),
    knownFloors: knownFloors > 0 ? knownFloors : null, heightEstimated: !(evaluateSourceHeight(properties) > 0) };
}

/** Architectural exposure keeps night facades readable; only sunlight adds sunset warmth. */
export function getBuildingLight(state: LightingState) {
  const night = clamp(state.nightAmount, 0, 1), warmth = clamp((18 - state.sunElevation) / 18, 0, 1) * (1 - night) ** 2;
  const mix = (a: number, b: number) => Math.round(a + (b - a) * warmth);
  const sunColor = `rgb(255,${mix(246, 191)},${mix(226, 130)})`;
  return { sunColor, ambientColor: '#e8e8e2', ambientIntensity: 0.88 + clamp(state.brightness, 0, 1) * 0.52, sunIntensity: state.sunElevation > -2 ? 0.12 + state.brightness * 2.25 : 0.04, legacyIntensity: 0.18 + state.brightness * 0.36, nightAmount: night, warmWindows: night * 0.68 };
}

/** UV v=integer is always an actual floor boundary, irrespective of map zoom or wall length. */
export function buildingWallUV(lengthMetres: number, profile: BuildingProfile) { return { columns: Math.max(1, Math.floor(lengthMetres / profile.windowSpacing)), rows: profile.floors, metresPerFloor: profile.floorHeight, lowerV: 0, upperV: profile.floors }; }
