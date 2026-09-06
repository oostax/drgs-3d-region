/** New private endpoints require both explicit work mode and a loopback origin. */
export function isLocalWorkRequest(request: Request) {
  const url = new URL(request.url), host = request.headers.get('host') || url.host, origin = request.headers.get('origin');
  try { return url.searchParams.get('mode') === 'work' && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) && request.headers.get('sec-fetch-site') !== 'cross-site' && (!origin || new URL(origin).host === host); } catch { return false; }
}
export const privateHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
export async function boundedJson(request: Request, max = 16384): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader(); if (!reader) throw new Error('Пустой запрос.');
  let size = 0; const chunks: Uint8Array[] = [];
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > max) { await reader.cancel(); throw new Error('Запрос слишком большой.'); } chunks.push(value); } } finally { reader.releaseLock(); }
  const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Некорректный запрос.');
  return data as Record<string, unknown>;
}
