import { loadClientPortfolio, portfolioActions, summarizePortfolio } from '@/lib/client-portfolio';
import { analyticsSignals, recentAnalyticsSignals } from '@/lib/territory-analytics';
import { isLocalWorkRequest, privateHeaders } from '@/lib/local-access';
import { snapshotOf } from '@/lib/types';
export const runtime = 'nodejs';
import { csvCell } from '@/lib/portfolio-csv';
export async function GET(request: Request) {
  if (!isLocalWorkRequest(request)) return Response.json({ error: 'Клиенты доступны только локально в рабочем режиме.' }, { status: 403, headers: privateHeaders });
  const q = new URL(request.url).searchParams, snapshot = snapshotOf(q.get('snapshot'));
  try {
    const data = loadClientPortfolio(snapshot), clients = data.rows.filter(r => r.offers > 0 || r.ambiguousOffers > 0);
    const term = (q.get('q') || '').slice(0, 200).trim().toLocaleLowerCase('ru-RU');
    let rows = (q.get('scope') === 'all' ? data.rows : clients).filter(r => (!term || [r.name, r.inn, r.gosb, ...r.managers].join(' ').toLocaleLowerCase('ru-RU').includes(term)) && (!q.get('territory') || r.scopes.includes(q.get('territory')!)));
    if (q.get('location') === 'located') rows = rows.filter(r => r.point);
    if (q.get('location') === 'missing') rows = rows.filter(r => !r.point);
    if (q.get('stage')) rows = rows.filter(r => r.stages.includes(q.get('stage')!));
    if (q.get('product')) rows = rows.filter(r => r.products.includes(q.get('product')!));
    // Enrich action evidence once for both the filtered list and the unpaginated map.
    const signals = recentAnalyticsSignals(analyticsSignals(), 45, new Date().toISOString());
    const byInn = new Map<string, typeof signals>();
    for (const signal of signals) if (signal.organizationInn) { const list = byInn.get(signal.organizationInn) || []; list.push(signal); byInn.set(signal.organizationInn, list); }
    for (const row of rows) row.actions = portfolioActions(row, data.sourceLabel, snapshot, byInn.get(row.inn) || []);
    if (q.get('action')) rows = rows.filter(r => r.actions.some(a => a.rule === q.get('action')));
    const summary = summarizePortfolio(rows);
    if (q.get('map') === 'true') return Response.json({ items: rows.flatMap(r => r.point ? [r.point] : []), total: rows.length, located: summary.located, unlocated: summary.unlocated, portfolioInns: [...new Set(clients.map(r => r.inn).filter(Boolean))], offersAvailable: data.offersAvailable }, { headers: privateHeaders });
    rows.sort((a, b) => q.get('sort') === 'name' ? a.name.localeCompare(b.name, 'ru') : q.get('sort') === 'income' ? (b.income ?? -Infinity) - (a.income ?? -Infinity) || a.id.localeCompare(b.id) : b.stalled - a.stalled || b.actions.length - a.actions.length || b.offers - a.offers || a.id.localeCompare(b.id));
    if (q.get('export') === 'missing') {
      const pending = rows.filter(r => !r.point);
      return new Response('\uFEFF' + ['inn;name;gosb;address;addressKind;longitude;latitude;reason', ...pending.map(r => [r.inn, r.name, r.gosb, '', 'legal', '', '', r.locationReason].map(csvCell).join(';'))].join('\n'), { headers: { ...privateHeaders, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="clients-needing-addresses.csv"' } });
    }
    const offset = Math.max(0, Math.floor(Number(q.get('offset')) || 0)), page = rows.slice(offset, offset + 40);
    return Response.json({ items: page, total: rows.length, offset, summary, all: data.summary, offersAvailable: data.offersAvailable, sourceLabel: data.sourceLabel, notes: data.notes,
      filters: { products: [...new Set(data.rows.flatMap(r => r.products))].sort(), stages: [...new Set(data.rows.flatMap(r => r.stages))].sort() } }, { headers: privateHeaders });
  } catch { return Response.json({ error: 'Портфель не подключён или временно недоступен. Проверьте завершённый источник сделок и повторите расчёт.' }, { status: 503, headers: privateHeaders }); }
}
