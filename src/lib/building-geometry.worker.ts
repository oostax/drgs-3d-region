import { buildBuildingGeometry, packBuildingGeometry, geometryTransferList, type BuildingGeometryInput } from './building-detail-geometry';

const scope = self as unknown as { onmessage: ((event: MessageEvent<{ id: number; inputs: BuildingGeometryInput[] }>) => void) | null; postMessage: (value: unknown, transfer?: ArrayBuffer[]) => void };
scope.onmessage = ({ data }) => {
  try {
    const items = data.inputs.map(input => packBuildingGeometry(input.key, buildBuildingGeometry(input)));
    scope.postMessage({ id: data.id, items }, geometryTransferList(items));
  } catch (error) { scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) }); }
};
