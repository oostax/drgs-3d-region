import { all, hasTable, one, safeJson } from './db';
import type { Mode } from './types';

export const SOURCE_KINDS: Record<string, string> = {
  'clients_detail_2026-08-21 14_08.xlsx':'client_cards','for_model.xlsx':'model_details',
  'итоги за июль (1).xlsx':'july_results','Настроение_КМ_2026-08-31-114752 (1).csv':'mood_survey',
  'Получатели ФОТ (март, июль).xlsx': 'recipients', 'Объем ФОТ (март, июль).xlsx': 'payroll',
  'обращения 2025-2026_свод.xlsx': 'complaint_summaries', 'штат.xlsx': 'staff', 'штатка.xlsx': 'staff',
  'лиды и сделки в работе 3 квартал.xlsx': 'offers_current', 'встречи 1,2,3 квартал.xlsx': 'meetings',
  'кластеризация ГОСБ_2025-2026.xlsx': 'clusters', '3 квартал на 23-08-2026.xlsx': 'offers_q3',
  '2 квартал.xlsx': 'offers_q2', '1 квартал.xlsx': 'offers_q1', 'Сбер_июль_2026.xlsx': 'incidents',
};
const uploadPrefix = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;
export function canonicalSourceName(name: string): string {
  const candidate = name.replace(uploadPrefix, '');
  return Object.hasOwn(SOURCE_KINDS, candidate) ? candidate : name;
}
export function sourceKind(name: string) {
  const canonical = canonicalSourceName(name);
  return Object.hasOwn(SOURCE_KINDS, canonical) ? SOURCE_KINDS[canonical] : undefined;
}
export type SourceStatusItem = {
  id: string; fileName: string; kind: string; status: string; rowsRead: number; rowsKept: number;
  importedAt: string | null; period: Record<string, unknown>; quality: Record<string, number>;
  counters: Record<string, number>; progress: Record<string, number>; error: string | null; isCurrent: boolean;
  questions?:{question:string;respondents:number;counts:Record<string,number>;average:number|null}[];
};
export type SourceStatus = { items: SourceStatusItem[]; counts: { complete: number; running: number; error: number }; selectedSourceIds: Record<string, string> };
type ImportRow = { id: string; file_name: string; kind: string; status: string; rows_read: number; rows_kept: number; imported_at: string | null; period: string | null; report_json: string | null; error: string | null };

/** Running replacements never displace the last successful source. */
export function currentSourceId(kind: string, fileName?: string): string | null {
  if (!hasTable('imports')) return null;
  return one<{ id: string }>(`SELECT id FROM imports WHERE kind=? AND status='complete'${fileName ? ' AND file_name=?' : ''} ORDER BY imported_at DESC,rowid DESC LIMIT 1`, kind, ...(fileName ? [fileName] : []))?.id ?? null;
}
export function selectedSourceIds(): Record<string, string> {
  if (!hasTable('imports')) return {};
  const selected: Record<string, string> = {};
  for (const row of all<Pick<ImportRow, 'id' | 'kind' | 'file_name'>>("SELECT id,kind,file_name FROM imports WHERE status='complete' ORDER BY imported_at DESC,rowid DESC")) {
    const key = row.kind === 'staff' ? `staff:${canonicalSourceName(row.file_name)}` : row.kind;
    if (!(key in selected)) selected[key] = row.id;
  }
  return selected;
}
export function offerSourceSelection(snapshot: string): { tracked: boolean; sourceId: string | null } {
  if (!hasTable('imports')) return { tracked: false, sourceId: null };
  return { tracked: true, sourceId: currentSourceId(`offers_${snapshot}`) };
}
function numericReport(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, n]) => typeof n === 'number' && Number.isFinite(n))) as Record<string, number>;
}
export function sourceStatus(mode: Mode): SourceStatus | null {
  if (mode === 'public') return null;
  const selected = selectedSourceIds();
  const rows = hasTable('imports') ? all<ImportRow>('SELECT * FROM imports ORDER BY imported_at DESC,rowid DESC') : [];
  const items = rows.map((row): SourceStatusItem => {
    const report = safeJson<Record<string, unknown>>(row.report_json, {});
    const fileName = canonicalSourceName(row.file_name);
    const key = row.kind === 'staff' ? `staff:${fileName}` : row.kind;
    return { id: row.id, fileName, kind: row.kind, status: row.status, rowsRead: row.rows_read, rowsKept: row.rows_kept, importedAt: row.imported_at,
      period: safeJson<Record<string, unknown>>(row.period, {}), quality: numericReport(report.quality), counters: numericReport(report.counters), progress: numericReport(report.progress),
      questions:Array.isArray(report.questions)?report.questions.filter(q=>q&&typeof q.question==='string'&&Number.isFinite(q.respondents)).map(q=>({question:q.question,respondents:q.respondents,counts:numericReport(q.counts),average:typeof q.average==='number'?q.average:null})):undefined,
      error: row.error ? 'Источник не обработан полностью. Проверьте формат и повторите импорт.' : null, isCurrent: selected[key] === row.id };
  });
  return { items, selectedSourceIds: selected, counts: { complete: items.filter(i => i.status === 'complete').length, running: items.filter(i => i.status === 'running').length, error: items.filter(i => i.status === 'error').length } };
}
