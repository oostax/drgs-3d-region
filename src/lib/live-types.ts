import type { Precision, Signal } from './types';

export type LiveEventState = 'reported'|'planned'|'in_progress'|'paused'|'resolved'|'cancelled'|'unknown';
export type LiveSeverity = 'low'|'medium'|'high'|'critical';
export type LiveConfidence = 'low'|'medium'|'high';
export type LiveSourceKind = 'official'|'media'|'community'|'bank'|'utility';
export type LiveActivityKind = 'road_defect'|'road_repair'|'construction'|'utility_fault'|'utility_repair'|'waste'|'cleanup'|'flood'|'snow_ice'|'emergency'|'fire'|'place_event'|'generic';

export type LiveEvidence = {
  id:string; documentId:string|null; sourceId:string|null; label:string; url:string;
  publishedAt:string|null; observedAt:string; eventTime:string|null; quote?:string;
  sourceKind:LiveSourceKind; supports:'report'|'status'|'location'|'resolution'|'dispute';
};

export type LiveEventHistoryItem = {
  state:LiveEventState; at:string; label:string; sourceUrl:string|null; sourcePublishedAt?:string|null;
};

export type LiveEventMeta = {
  regionId:string; topic:string; state:LiveEventState; severity:LiveSeverity;
  confidence:LiveConfidence; sourceKind:LiveSourceKind; eventTime:string|null;
  lastEvidenceAt:string; lastMeaningfulAt:string; ongoing:boolean;
  locationConfidence:Precision|'unknown'; evidenceCount:number; duplicateCount:number;
  revision:number; activityKind:LiveActivityKind; explicitActivity:boolean; notifyEligible:boolean;
  outcome?:'problem'|'improvement'|'development'|'information';
  evidence?:LiveEvidence[]; history?:LiveEventHistoryItem[];
  timing?:import('./signal-timing').SignalTiming;
};

export type LiveSignal = Signal & { live:LiveEventMeta };

export type LiveWorkerStatus = {
  state:'starting'|'idle'|'running'|'offline'|'error'; heartbeatAt:string|null;
  lastSuccessAt:string|null; queueDepth:number; analysisQueueDepth:number;
  lagSeconds:number|null; message:string;
};

export type LiveSignalsResponse = {
  signals:LiveSignal[]; cursor:string; asOf:string; total:number; hasMore:boolean;
  worker:LiveWorkerStatus;
};

export type LiveSignalChangesResponse = {
  upserts:LiveSignal[]; removed:string[]; cursor:string; asOf:string; reset:boolean;
  worker:LiveWorkerStatus;
};

export type LiveSourceAdapter = 'rss'|'atom'|'html'|'telegram'|'api';
export type LiveSourceStatus = 'discovered'|'active'|'unavailable'|'needs_adapter'|'rights_review'|'duplicate'|'irrelevant'|'disabled';
export type LiveCoverageLevel = 'direct'|'inherited_district'|'inherited_region'|'missing';
export type LiveSourceItem = {
  id:string; name:string; regionId:string; territoryId:string|null; url:string;
  adapter:LiveSourceAdapter; sourceKind:LiveSourceKind; status:LiveSourceStatus;
  intervalSeconds:number; languages:string[]; topics:string[]; coverageTerritoryIds:string[];
  fetchAllowed:boolean; aiAllowed:boolean; displayAllowed:boolean; rightsNote:string;
  provenanceUrl:string; lastAttemptAt:string|null; lastSuccessAt:string|null;
  latestPublicationAt:string|null; error:string|null;
};

export type LiveCoverageItem = {
  territoryId:string; territoryName:string; parentId:string|null; level:LiveCoverageLevel; health?:'missing'|'unavailable'|'quiet'|'active';
  sourceIds:string[]; lastSuccessAt:string|null; latestPublicationAt:string|null;
};

export type LiveSourcesResponse = {
  sources:LiveSourceItem[]; coverage:LiveCoverageItem[]; worker:LiveWorkerStatus;
  summary:{candidates:number;active:number;territories:number;direct:number;inherited:number;missing:number};
};

export type SignalRelevanceReason = 'public_event_match'|'client_project'|'client_disruption'|'competitor_change'|'branch_service_issue'|'nearby_only';
export type SignalRelevanceItem = {
  reason:SignalRelevanceReason; label:string; explanation:string; confidence:LiveConfidence;
  organizationId:string|null; organizationName:string|null; inn:string|null; gosb:string|null;
  offerIds:string[]; sourceUrls:string[]; relationship:'exact_inn'|'name_address_candidate'|'nearby'|'competitor'|'none';
};
export type SignalRelevanceResponse = {signalId:string;snapshot:string;items:SignalRelevanceItem[];limitations:string[]};
