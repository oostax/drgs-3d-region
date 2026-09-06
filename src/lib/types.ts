export type Mode = 'work' | 'public';
export type View = 'overview' | 'signals' | 'organizations' | 'banks' | 'places';
export type Coordinates = [number, number];
export type Precision = 'territory' | 'settlement' | 'street' | 'building' | 'site';
export type SignalUsefulness = {
  version:'useful-v1';score:number;level:'useful'|'context'|'noise';showOnMap:boolean;
  reasons:string[];dimensions:{specificity:number;actionability:number;significance:number};supportedFacts:string[];
};
export type Territory = {
  id: string; oktmo?: string; name: string; kind: string; parentId: string | null;
  center: Coordinates | null; bbox?: [number,number,number,number] | null;
  geometry?: GeoJSON.Geometry | null; geometryStatus: string; sourceUrl: string; asOf?: string;
};
export type Signal = {
  signalUsefulness?:SignalUsefulness;
  siteZoom?:number;siteBbox?:[number,number,number,number];siteGeometry?:GeoJSON.Geometry;geographyNote?:string;
  id: string; title: string; summary: string; category: string; territoryId: string | null;
  coordinates: Coordinates | null; precision: Precision; sourceUrl: string; publishedAt: string;
  checkedAt: string; facts: string[]; hypothesis: string; nextStep: string; visibility: 'public'|'private';
  count?: number; sourceName?: string;
  closedAt?: string;
  residentReport?: { openCount:number; inProgressCount:number; closedCount:number; firstAt:string|null; lastAt:string|null };
  categoryBreakdown?: {name:string;count:number}[];
  addressCandidates?:string[];address?:string;addressSourceUrl?:string;coordinateSourceUrl?:string;locationVerificationMethod?:string;organizationInn?:string;
  lifecycle?:{status:'planned'|'under_construction'|'completed'|'not_applicable'|'unknown';asOf:string;sourceUrl:string;currentStatusVerified:boolean;animationEligible:boolean;note:string};
  relatedSources?:{label:string;url:string}[];
  live?:import('./live-types').LiveEventMeta;
};
export type BankOffice = {
  id: string; bank: string; name: string; address: string; territoryId: string | null;
  coordinates: Coordinates | null; precision: Precision | null; sourceUrl: string; checkedAt: string;
  coordinateSourceUrl?: string | null;
};
export type Manifest = {
  schemaVersion?: number; generatedAt?: string;
  sources: {id:string;url:string;status:string;lastAttemptAt?:string;lastSuccessAt?:string;error?:string|null}[];
  coverage: Record<string,unknown>; limitations: string[];
};
export type AtlasPayload = {
  mode: Mode; territories: Territory[]; signals: Signal[]; offices: BankOffice[]; manifest: Manifest;
  summary: {incidents: number|null; offers: number|null; organizations: number|null; expectedIncome: number|null; meetings: number[]|null; imported: number};
  topics: {name:string;count:number}[]; snapshot: string; territoryId: string;
};
export type Offer = {id:string;offer_id:string;snapshot:string;product:string;amount:number|null;expected_income:number|null;stage:string;stage_date:string|null;sourceLabel?:string;sourceDateInferred?:boolean};
export type Organization = {
  id: string; inn: string; gosb: string; name: string;
  offerCount: number; expectedIncome: number|null; geoStatus: 'unlocated'|'verified'|'source_exact'|'candidate';
  location?: import('./planning-types').OrganizationLocation;
  payroll?: {fot_march:number|null;fot_july:number|null;recipients_march:number|null;recipients_july:number|null;cumulative_april:number|null;cumulative_august:number|null};
  meetings?: {q1:number|null;q2:number|null;q3:number|null;conflict:number};
  offers?: Offer[]; sourceNames?: string[]; details?: Record<string,unknown>;
  offerChanges?: {comparedSnapshot:string;added:number;removed:number;changed:number;incomeDelta:number|null;comparable:boolean;note:string};
  offerSource?: {snapshot:string;fileName:string;date:string|null;dateInferred:boolean;label:string;qualityNotes:string[]};
};
export type Dossier = {
  id:string;mode:Mode;title:string;territoryId:string;territoryName:string;updatedAt:string;
  signalIds:string[];organizationIds:string[];facts:string[];hypotheses:string[];questions:string;actions:string;notes:string;sources:{label:string;url?:string}[];
};
export const SNAPSHOTS = [{id:'current',label:'Последний срез'},{id:'q3',label:'III квартал'},{id:'q2',label:'II квартал'},{id:'q1',label:'I квартал'}];
export const modeOf = (value: string|null|undefined): Mode => value === 'public' ? 'public' : 'work';
export const snapshotOf = (value: string|null|undefined) => SNAPSHOTS.some(s=>s.id===value) ? value! : 'current';
