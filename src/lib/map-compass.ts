import type { Map as LibreMap } from 'maplibre-gl';

export type CompassPose = { bearing: number; pitch: number; maxPitch: number };
export type CompassCamera = {
  read: () => CompassPose;
  write: (pose: Partial<Pick<CompassPose, 'bearing' | 'pitch'>>) => void;
  begin: () => void;
  end: () => void;
  interacting: () => boolean;
  subscribe: (listener: () => void) => () => void;
  refresh: () => void;
  dispose: () => void;
};

export function wrapBearing(degrees: number): number {
  return Number.isFinite(degrees) ? ((degrees + 180) % 360 + 360) % 360 - 180 : 0;
}

/** Clockwise angle from north. Ignore the centre, where angle is undefined. */
export function compassAngle(x: number, y: number): number | null {
  return Number.isFinite(x) && Number.isFinite(y) && Math.hypot(x, y) >= 24
    ? Math.atan2(x, -y) * 180 / Math.PI : null;
}

export function ringBearing(bearing: number, previous: number, next: number): number {
  // The rose moves with the pointer; map bearing is the inverse rose rotation.
  return wrapBearing(bearing - wrapBearing(next - previous));
}

export function tiltCompass(pose: CompassPose, dx: number, dy: number): CompassPose {
  return {
    ...pose,
    bearing: wrapBearing(pose.bearing - (Number.isFinite(dx) ? dx * 0.6 : 0)),
    pitch: Math.max(0, Math.min(pose.maxPitch, pose.pitch - (Number.isFinite(dy) ? dy * 0.5 : 0))),
  };
}

/** Small public-API bridge: compass drags never replay a stale React focus,
 * change zoom/centre/padding, or implicitly turn a flat map into 3D. */
export function createCompassCamera(map: LibreMap, settled: () => void): CompassCamera {
  let disposed = false, dragging = false;
  let last: CompassPose = { bearing: map.getBearing(), pitch: map.getPitch(), maxPitch: map.getMaxPitch() };
  const listeners = new Set<() => void>();
  const read = () => disposed ? last : (last = { bearing: map.getBearing(), pitch: map.getPitch(), maxPitch: map.getMaxPitch() });
  const refresh = () => { if (!disposed) { read(); for (const listener of listeners) listener(); } };
  map.on('move', refresh); map.on('resize', refresh); map.on('idle', refresh);
  return {
    read,
    write(pose) {
      if (disposed) return;
      const next: { bearing?: number; pitch?: number } = {};
      if (Number.isFinite(pose.bearing)) next.bearing = wrapBearing(pose.bearing!);
      if (Number.isFinite(pose.pitch)) next.pitch = Math.max(0, Math.min(map.getMaxPitch(), pose.pitch!));
      if (Object.keys(next).length) map.jumpTo(next);
    },
    begin() { if (!disposed) { dragging = true; map.stop(); } },
    end() { if (!disposed && dragging) { dragging = false; settled(); } },
    interacting: () => dragging,
    subscribe(listener) { if (!disposed) listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    dispose() {
      if (disposed) return;
      read(); disposed = true; dragging = false;
      map.off('move', refresh); map.off('resize', refresh); map.off('idle', refresh); listeners.clear();
    },
  };
}
