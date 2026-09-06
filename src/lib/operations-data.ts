import { all, hasTable, safeJson } from './db';
import { sourceStatus, type SourceStatus } from './source-status';
import type { Mode } from './types';

type CountByName = { name: string; count: number };
type StaffVersion = { id: string; sourceId: string; fileName: string; count: number; uniqueEmployees: number; pilotCount: number; period: Record<string, unknown>; roles: CountByName[] };
type StaffComparison = { leftVersion: string; rightVersion: string; common: number; onlyLeft: number; onlyRight: number; changedEmployees: number; changesByField: { field: string; label: string; count: number }[] };
type Cluster = { gosb: string; tb: string; name: string; cluster2025: number | null; cluster2026: number | null; unresolved: boolean };
type SummaryView = { sourceId: string; sheet: string; filters: Record<string, string | null>; year: null; columns: string[]; rows: { bank: string; values: Record<string, number | null>; isTotal: boolean }[] };
export type OperationsPayload = {
  scope: { label: string; municipalityAllocation: false };
  sources: SourceStatus;
  staff: { versions: StaffVersion[]; comparison: StaffComparison | null };
  clusters: { rows: Cluster[]; unresolvedCount: number };
  bankSummary: { views: SummaryView[] };
  limits: string[];
};
type StaffData = Record<string, unknown> & { source?: { source_id?: string }; period?: Record<string, unknown> };
const asText = (value: unknown) => typeof value === 'string' ? value : value == null ? '' : String(value);
const asNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const staffFields: Record<string, string> = { division_3: 'Подразделение 03 уровня', division_4: 'Подразделение 04 уровня', division_5: 'Подразделение 05 уровня', position: 'Должность', assigned_role: 'Назначенная роль', role: 'Роль', segment: 'Сегмент', name: 'ФИО' };

export function operationsData(mode: Mode): OperationsPayload | null {
  // Presentation requests must return before any private database call.
  if (mode === 'public') return null;
  const sources = sourceStatus('work')!;
  const bySource = new Map(sources.items.map(s => [s.id, s]));
  const completed = new Set(sources.items.filter(s => s.status === 'complete').map(s => s.id));
  const groups = new Map<string, { version: StaffVersion; employees: Map<string, StaffData>; roles: Map<string, number> }>();
  if (hasTable('staff')) {
    for (const row of all<{ source_version: string; employee_id: string | null; data_json: string }>('SELECT source_version,employee_id,data_json FROM staff ORDER BY source_version,employee_id')) {
      const data = safeJson<StaffData>(row.data_json, {});
      const sourceId = data.source?.source_id ?? '';
      if (sourceId && !completed.has(sourceId)) continue;
      let group = groups.get(row.source_version);
      if (!group) {
        group = { version: { id: row.source_version, sourceId, fileName: bySource.get(sourceId)?.fileName ?? row.source_version.split(':')[0], count: 0, uniqueEmployees: 0, pilotCount: 0, period: data.period ?? {}, roles: [] }, employees: new Map(), roles: new Map() };
        groups.set(row.source_version, group);
      }
      group.version.count++;
      if (row.employee_id) group.employees.set(row.employee_id, data);
      if (['division_3', 'division_4', 'division_5'].some(k => asText(data[k]).toLocaleLowerCase('ru-RU').includes('татарстан'))) group.version.pilotCount++;
      const role = asText(data.assigned_role || data.role) || 'Не указана';
      group.roles.set(role, (group.roles.get(role) ?? 0) + 1);
    }
  }
  const versions = [...groups.values()].map(({ version, employees, roles }) => ({ ...version, uniqueEmployees: employees.size,
    roles: [...roles].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count) }));
  versions.sort((a, b) => (bySource.get(b.sourceId)?.importedAt ?? '').localeCompare(bySource.get(a.sourceId)?.importedAt ?? '') || a.fileName.localeCompare(b.fileName, 'ru'));
  const findActive = (name: string) => versions.find(v => v.fileName === name && v.sourceId === sources.selectedSourceIds[`staff:${name}`]);
  const left = findActive('штат.xlsx') ?? versions[0];
  const right = findActive('штатка.xlsx') ?? versions.find(v => v.id !== left?.id);
  let comparison: StaffComparison | null = null;
  if (left && right && left.id !== right.id) {
    const a = groups.get(left.id)!.employees, b = groups.get(right.id)!.employees;
    const common = [...a.keys()].filter(id => b.has(id));
    const changesByField = Object.entries(staffFields).map(([field, label]) => ({ field, label,
      count: common.filter(id => asText(a.get(id)![field]) !== asText(b.get(id)![field])).length }));
    comparison = { leftVersion: left.id, rightVersion: right.id, common: common.length,
      onlyLeft: a.size - common.length, onlyRight: b.size - common.length,
      changedEmployees: common.filter(id => Object.keys(staffFields).some(field => asText(a.get(id)![field]) !== asText(b.get(id)![field]))).length,
      changesByField: changesByField.filter(c => c.count > 0) };
  }

  const clusters: Cluster[] = [];
  if (hasTable('bank_clusters')) {
    for (const row of all<{ gosb: string; data_json: string }>('SELECT gosb,data_json FROM bank_clusters')) {
      const data = safeJson<Record<string, unknown> & { source?: { source_id?: string } }>(row.data_json, {});
      if (data.source?.source_id && data.source.source_id !== sources.selectedSourceIds.clusters) continue;
      clusters.push({ gosb: row.gosb, tb: asText(data.tb), name: asText(data.name), cluster2025: asNumber(data.cluster_2025), cluster2026: asNumber(data.cluster_2026), unresolved: row.gosb.startsWith('unresolved:') });
    }
  }
  clusters.sort((a, b) => Number(b.gosb === '8610') - Number(a.gosb === '8610') || a.name.localeCompare(b.name, 'ru'));
  const views = new Map<string, SummaryView>();
  if (hasTable('complaint_summaries')) {
    for (const row of all<{ data_json: string }>('SELECT data_json FROM complaint_summaries ORDER BY rowid')) {
      const data = safeJson<{ source?: { source_id?: string }; sheet?: string; filters?: Record<string, string | null>; row_label?: string; values?: Record<string, unknown> }>(row.data_json, {});
      const sourceId = data.source?.source_id ?? '';
      if (sourceId && sourceId !== sources.selectedSourceIds.complaint_summaries) continue;
      const sheet = data.sheet ?? '';
      const key = `${sourceId}:${sheet}`;
      let view = views.get(key);
      if (!view) { view = { sourceId, sheet, filters: data.filters ?? {}, year: null, columns: Object.keys(data.values ?? {}), rows: [] }; views.set(key, view); }
      const bank = data.row_label ?? '';
      view.rows.push({ bank, values: Object.fromEntries(Object.entries(data.values ?? {}).map(([k, v]) => [k, asNumber(v)])), isTotal: /общий итог|всего/i.test(bank) });
    }
  }
  return { scope: { label: 'Портфель ГОСБ 8610; штат и сводки — в исходном банковском разрезе', municipalityAllocation: false }, sources,
    staff: { versions, comparison }, clusters: { rows: clusters, unresolvedCount: clusters.filter(c => c.unresolved).length }, bankSummary: { views: [...views.values()] },
    limits: ['Текущие предложения отобраны по ГОСБ 8610; исторические — по ИНН организаций пилотного портфеля.',
      'ГОСБ и подразделение сотрудника не определяют муниципалитет клиента. Показатели не распределяются по карте без адресной связи.',
      'Версии штата сравниваются по табельному номеру и не складываются.',
      'Листы сводных обращений содержат разные фильтры. Год не установлен; это не сравнение 2025 и 2026 годов.',
      'Суммы разных снимков предложений не складываются. Даты снимков требуют подтверждения.'] };
}
