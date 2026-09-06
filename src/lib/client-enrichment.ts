import { db } from './db';
import { loadClientPortfolio } from './client-portfolio';
import { ensureLocationSchema, organizationLocation, validCoordinates } from './organization-locations';
import type { AddressCandidate } from './planning-types';

const endpoint = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party';
const evidence = 'https://dadata.ru/api/find-party/';
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const string = (v: unknown) => typeof v === 'string' ? v.trim() : '';
let busy = false;
/** Only the company ID is sent. No portfolio amounts, names, contacts or event texts. */
export async function lookupCompany(inn: string, token: string, signal?: AbortSignal): Promise<AddressCandidate | null> {
  if (!/^\d{10}$/.test(inn)) return null; // EGRIP does not publish an entrepreneur's exact residential address.
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]), headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Token ${token}` }, body: JSON.stringify({ query: inn, branch_type: 'MAIN', type: 'LEGAL', count: 10 }) });
  if (!response.ok) throw new Error(response.status === 429 ? 'Лимит сервиса исчерпан; продолжите позже.' : 'Сервис адресов не ответил. Проверьте ключ и доступность.');
  const reader = response.body?.getReader(); if (!reader) throw new Error('Пустой ответ сервиса.');
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 1000000) { await reader.cancel(); throw new Error('Ответ сервиса слишком большой.'); } chunks.push(item.value); } } finally { reader.releaseLock(); }
  const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const rows = Array.isArray(body.suggestions) ? body.suggestions.map(record).filter(row => { const d = record(row.data); return d.inn === inn && d.type === 'LEGAL' && d.branch_type === 'MAIN'; }) : [];
  if (rows.length !== 1) return null;
  const d = record(rows[0].data), address = record(d.address), geo = record(address.data), name = record(d.name);
  const value = string(address.unrestricted_value) || string(address.value); if (!value) return null;
  const lng = string(geo.geo_lon), lat = string(geo.geo_lat), p: [number, number] = [Number(lng), Number(lat)];
  const exact = ['0', 0].includes(geo.qc_geo as string | number) && !!string(geo.house) && !!lng && !!lat && validCoordinates(p) && Math.abs(p[1]) <= 85.051129;
  return { id: `dadata:${inn}`, inn, name: string(name.full_with_opf) || string(rows[0].value) || inn, addressKind: 'legal', address: value, coordinates: exact ? p : null, precision: exact ? 'building' : 'territory', sourceUrl: evidence, identitySourceUrl: evidence, coordinateSourceUrl: evidence, checkedAt: new Date().toISOString(), confirmedByUser: false, requiresMeetingConfirmation: true, note: exact ? 'Юридический адрес ЕГРЮЛ, геокодирование DaData до дома. Не место встречи.' : 'Юридический адрес найден; точность координат до дома не подтверждена.' };
}
function schema() {
  ensureLocationSchema();
  db().exec('CREATE TABLE IF NOT EXISTS client_location_lookups(inn TEXT PRIMARY KEY,status TEXT NOT NULL,checked_at TEXT NOT NULL)');
}
export function enrichmentStatus() {
  const data = loadClientPortfolio();
  const missing = data.rows.filter(r => (r.offers || r.ambiguousOffers) && !r.point);
  return { configured: !!process.env.ATLAS_DADATA_TOKEN, pending: missing.length, orgIds: missing.map(r => r.id), individual: missing.filter(r => r.inn.length === 12).length,
    message: 'Внешнему сервису DaData отправляются только ИНН. Сам запрос может раскрыть состав клиентского списка; продолжайте только при разрешённой передаче. Условия и лимиты зависят от вашего аккаунта.' };
}
export async function enrichClients(orgIds: string[], consent: boolean, signal?: AbortSignal) {
  if (!consent) throw new Error('Нужно явное согласие на передачу ИНН внешнему сервису.');
  if (!process.env.ATLAS_DADATA_TOKEN) throw new Error('Добавьте ATLAS_DADATA_TOKEN в локальный .env и перезапустите сервер.');
  if (!orgIds.length || orgIds.length > 5 || orgIds.some(id => typeof id !== 'string' || id.length > 200)) throw new Error('Выберите от 1 до 5 организаций на пакет.');
  if (busy) throw new Error('Сопоставление уже выполняется. Дождитесь окончания текущего пакета.');
  busy = true;
  const results: { id: string; status: string; message: string }[] = [];
  try {
    schema(); const portfolio = loadClientPortfolio(), known = new Map(portfolio.rows.map(r => [r.id, r]));
    const cache = new Map<string, AddressCandidate | null>();
    for (const id of [...new Set(orgIds)]) {
      if (signal?.aborted) break;
      const org = known.get(id); if (!org || !(org.offers || org.ambiguousOffers)) throw new Error('Организация не входит в выбранный клиентский портфель.');
      if (org.point) { results.push({ id, status: 'retained', message: 'Подтверждённая точка сохранена.' }); continue; }
      if (org.inn.length !== 10) { results.push({ id, status: 'manual', message: 'Для ИП или некорректного ИНН требуется адрес офиса/встречи из разрешённого источника.' }); continue; }
      let candidate: AddressCandidate | null;
      try { if (!cache.has(org.inn)) cache.set(org.inn, await lookupCompany(org.inn, process.env.ATLAS_DADATA_TOKEN, signal)); candidate = cache.get(org.inn)!; }
      catch { results.push({ id, status: 'error', message: 'Сервис адресов недоступен, запрос отменён или исчерпан лимит. Проверьте ключ и повторите позже.' }); break; }
      const status = db().transaction(() => {
        // Re-read AFTER the network request. A concurrent manual correction wins.
        const location = organizationLocation('work', org)!;
        if (location.legalAddress?.confirmedByUser) return 'retained';
        if (!candidate) return 'not_found';
        const current = location.legalAddress;
        const conflicting = Boolean(current && (current.address !== candidate.address || current.coordinates && JSON.stringify(current.coordinates) !== JSON.stringify(candidate.coordinates)));
        if (conflicting) {
          location.candidates = [...location.candidates.filter(c => c.id !== candidate!.id), candidate];
        } else location.legalAddress = candidate;
        location.status = [location.legalAddress, location.office, location.meeting].some(p => p?.confirmedByUser) ? 'verified' : [location.legalAddress, location.office].some(p => p?.coordinates && ['building', 'site'].includes(p.precision)) ? 'source_exact' : 'candidate';
        location.updatedAt = new Date().toISOString(); location.note = 'Сопоставление по точному ИНН. Юридический адрес не используется как место встречи.';
        db().prepare('INSERT INTO organization_locations(org_id,data_json,updated_at) VALUES(?,?,?) ON CONFLICT(org_id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at').run(id, JSON.stringify(location), location.updatedAt);
        return conflicting ? 'candidate' : candidate.coordinates ? 'located' : 'address_only';
      })();
      db().prepare('INSERT INTO client_location_lookups VALUES(?,?,?) ON CONFLICT(inn) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at').run(org.inn, status, new Date().toISOString());
      results.push({ id, status, message: ({ located: 'Найден точный юридический адрес.', address_only: 'Адрес найден без точных координат.', candidate: 'Найден другой адрес; требуется выбор.', retained: 'Ручной адрес сохранён.', not_found: 'Однозначный адрес не найден.' } as Record<string, string>)[status] });
    }
    return { results };
  } finally { busy = false; }
}
