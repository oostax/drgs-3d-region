import { LngLat, type LayerSpecification, type LngLatBoundsLike, type Map as LibreMap } from 'maplibre-gl';

export const RUSSIA_MASK_SOURCE = 'atlas-russia-mask';
export const RUSSIA_MASK_LAYER = 'atlas-russia-mask';
export const RUSSIA_MASK_COLOR = '#142d3b';

export const RUSSIA_VIEW_BOUNDS: LngLatBoundsLike = [[19, 41], [190, 82]];

/** Width limits repeated worlds; portrait height may extend beyond Mercator. */
export function constrainRussiaViewport(center: LngLat, zoom: number, viewportWidth: number) {
  const minimumZoom = Math.max(0.25, Math.log2(Math.max(1, viewportWidth) * 360 / (512 * 220)));
  // Pick the world containing Russia, including Chukotka's negative longitudes.
  const longitude = center.lng + 360 * Math.round((103.5 - center.lng) / 360);
  return {
    center: new LngLat(Math.max(15, Math.min(192, longitude)), Math.max(39, Math.min(83, center.lat))),
    zoom: Math.max(minimumZoom, Math.min(20, zoom)),
  };
}

/** Apply once at map creation; world wrapping here is needed only at Chukotka. */
export function configureRussiaMap(map: LibreMap) {
  map.setRenderWorldCopies(true);
  map.setMinZoom(0.25);
  map.setMaxZoom(20);
  map.setTransformConstrain((center, zoom) => constrainRussiaViewport(center, zoom, map.getContainer().clientWidth));
  // The default Mercator constraint raises zoom to fill tall screens and moves
  // their center towards the equator. Only the custom geographic clamp applies.
  map.setMaxBounds(null);
}

/**
 * Insert above every basemap label and below the application's analytic layers.
 * Call after addAtlasLayers; the insertion point is the last basemap layer.
 * beforeId can override that point when a different style needs it.
 * A single inverse fill hides all foreign geometry without adding `within`
 * expressions to each vector layer or downloading a second boundary dataset.
 */
export function addRussiaMask(map: LibreMap, beforeId?: string) {
  const layers = map.getStyle().layers ?? [];
  const lastBaseIndex = layers.findLastIndex((layer) => !layer.id.startsWith('atlas-'));
  const insertionPoint = beforeId ?? layers[lastBaseIndex + 1]?.id;
  if (!map.getSource(RUSSIA_MASK_SOURCE)) {
    map.addSource(RUSSIA_MASK_SOURCE, {
      type: 'geojson',
      data: '/data/russia-mask.geojson',
      tolerance: 0,
      maxzoom: 14,
    });
  }
  if (!map.getLayer(RUSSIA_MASK_LAYER)) {
    map.addLayer({
      id: RUSSIA_MASK_LAYER,
      type: 'fill',
      source: RUSSIA_MASK_SOURCE,
      paint: {
        'fill-color': RUSSIA_MASK_COLOR,
        // Keep this in the ordered translucent pass, after basemap symbols.
        // The difference from 1 is far below an 8-bit color channel's precision.
        'fill-opacity': 0.999999,
        'fill-antialias': false,
      },
    }, insertionPoint);
  }
  hideCountryLabels(map);
}

/** The single-country product already identifies Russia in its navigation. */
function hideCountryLabels(map: LibreMap) {
  for (const layer of map.getStyle().layers ?? []) {
    if (isCountryLabel(layer)) map.setLayoutProperty(layer.id, 'visibility', 'none');
  }
}

function isCountryLabel(layer: LayerSpecification) {
  return layer.type === 'symbol' && layer.id.startsWith('label_country_');
}

/** Keep the outside canvas consistent with the current sky/lighting palette. */
export function setRussiaMaskColor(map: LibreMap, color: string) {
  if (map.getLayer(RUSSIA_MASK_LAYER)) map.setPaintProperty(RUSSIA_MASK_LAYER, 'fill-color', color);
}
