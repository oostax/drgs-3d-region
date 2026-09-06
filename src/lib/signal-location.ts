import type { Signal } from './types';

const MAP_PRECISIONS = new Set<Signal['precision']>(['building', 'site', 'street']);

/** A signal may become a map marker only after its real-world location is evidenced. */
export function signalHasVerifiedMapLocation(
  signal: Pick<Signal, 'address' | 'coordinates' | 'precision'>,
): boolean {
  const coordinates = signal.coordinates;
  return Boolean(
    signal.address?.trim()
      && MAP_PRECISIONS.has(signal.precision)
      && coordinates
      && coordinates.length === 2
      && coordinates.every(Number.isFinite)
      && Math.abs(coordinates[0]) <= 180
      && Math.abs(coordinates[1]) <= 85,
  );
}
