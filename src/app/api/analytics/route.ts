import { territoryAnalytics } from '@/lib/territory-analytics';
import { isLocalWorkRequest, privateHeaders } from '@/lib/local-access';
import { snapshotOf } from '@/lib/types';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams, mode = q.get('mode') === 'work' ? 'work' : 'public';
  if (mode === 'work' && !isLocalWorkRequest(request)) return Response.json({ error: 'Рабочая аналитика доступна только локально.' }, { status: 403, headers: privateHeaders });
  const days = Number(q.get('days') || 45);
  if (![30, 45, 60, 180].includes(days)) return Response.json({ error: 'Недопустимый период.' }, { status: 400, headers: privateHeaders });
  try { return Response.json(territoryAnalytics(mode, q.get('territory') || 'RU-TA', days, snapshotOf(q.get('snapshot'))), { headers: privateHeaders }); }
  catch (e) { return Response.json({ error: e instanceof RangeError ? e.message : 'Не удалось рассчитать аналитику. Проверьте источники и повторите.' }, { status: e instanceof RangeError ? 404 : 503, headers: privateHeaders }); }
}
