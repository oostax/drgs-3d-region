import { enrichmentStatus, enrichClients } from '@/lib/client-enrichment';
import { syncPublicOrganizationLocations } from '@/lib/organization-locations';
import { boundedJson, isLocalWorkRequest, privateHeaders } from '@/lib/local-access';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  if (!isLocalWorkRequest(request)) return Response.json({ error: 'Только локальный рабочий режим.' }, { status: 403, headers: privateHeaders });
  try { return Response.json(enrichmentStatus(), { headers: privateHeaders }); }
  catch { return Response.json({ error: 'Локальный портфель не подключён.' }, { status: 503, headers: privateHeaders }); }
}
export async function POST(request: Request) {
  if (!isLocalWorkRequest(request)) return Response.json({ error: 'Только локальный рабочий режим.' }, { status: 403, headers: privateHeaders });
  try {
    const input = await boundedJson(request);
    if (input.action === 'local') return Response.json(syncPublicOrganizationLocations('work'), { headers: privateHeaders });
    if (input.action !== 'external' || !Array.isArray(input.orgIds) || !input.orgIds.every(id => typeof id === 'string')) throw new Error('Некорректный пакет организаций.');
    return Response.json(await enrichClients(input.orgIds as string[], input.consent === true, request.signal), { headers: privateHeaders });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : 'Не удалось сопоставить адреса.' }, { status: 400, headers: privateHeaders }); }
}
