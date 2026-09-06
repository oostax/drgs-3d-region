import regions from '../../config/regions.json';
export const DEFAULT_REGION_ID=regions.defaultRegion;
export const regionConfigs=regions.regions;
export function getRegionConfig(id=DEFAULT_REGION_ID){const config=regionConfigs.find(region=>region.id===id);if(!config)throw new Error(`Регион ${id} ещё не настроен`);return config;}
