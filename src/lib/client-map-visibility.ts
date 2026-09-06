/** Focused client browsing must not put DOM bank/signal pins over client hits.
 * This is a view projection, never a mutation of the saved layer preferences.
 */
export function clientViewLayers<T extends { banks: boolean; signals: boolean; landmarks: boolean }>(layers: T, focused: boolean): T {
  return focused ? { ...layers, banks: false, signals: false, landmarks: false } : layers;
}
