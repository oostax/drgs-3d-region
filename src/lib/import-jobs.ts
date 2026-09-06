import { appPath, appRoot } from './runtime-paths';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { all, db, databasePath, privateDirectory, hasTable } from './db';
import { canonicalSourceName, SOURCE_KINDS, sourceKind, sourceStatus } from './source-status';

export const SOURCE_FILES = Object.keys(SOURCE_KINDS);
type Job = { id: string; file_name: string; status: string; started_at: string; completed_at: string | null; error: string | null;
  owner_pid: number | null; owner_identity: string | null; worker_pid: number | null; worker_identity: string | null; source_hash: string | null };
const globalJobs = globalThis as unknown as { atlasImportRuntime?: { active: Set<string> } };
const runtime = globalJobs.atlasImportRuntime ??= { active: new Set() };
const migrated = new WeakSet<object>();

function ensureJobSchema() {
  const database = db();
  if (migrated.has(database)) return;
  database.transaction(() => {
    const columns = new Set((database.prepare('PRAGMA table_info(import_jobs)').all() as { name: string }[]).map(c => c.name));
    for (const [name, type] of Object.entries({ owner_pid: 'INTEGER', owner_identity: 'TEXT', worker_pid: 'INTEGER', worker_identity: 'TEXT', source_hash: 'TEXT' })) {
      if (!columns.has(name)) database.exec(`ALTER TABLE import_jobs ADD COLUMN ${name} ${type}`);
    }
  }).immediate();
  migrated.add(database);
}
export function processIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    // Read-only birth time prevents an unrelated reused PID holding the queue.
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 }).trim() || null;
  } catch { return null; }
}
function sameProcess(pid: number | null, identity: string | null) {
  if (!pid) return false;
  const observed = processIdentity(pid);
  return observed !== null && (identity === null || identity === observed);
}
/** Reconcile after restart without killing workers or deleting imported data. */
export function reconcileImportJobs() {
  ensureJobSchema();
  for (const job of all<Job>("SELECT * FROM import_jobs WHERE status='running'")) {
    if (runtime.active.has(job.id) || sameProcess(job.worker_pid, job.worker_identity)) continue;
    if (!job.worker_pid && sameProcess(job.owner_pid, job.owner_identity)) continue;
    const source = job.source_hash && hasTable('imports') ? db().prepare('SELECT status FROM imports WHERE file_hash=?').get(job.source_hash) as { status: string } | undefined : undefined;
    const complete = source?.status === 'complete';
    db().prepare("UPDATE import_jobs SET status=?,completed_at=?,error=? WHERE id=? AND status='running'").run(complete ? 'complete' : 'error', new Date().toISOString(),
      complete ? null : 'Задание прервано после перезапуска. Загруженные данные сохранены; файл можно импортировать повторно.', job.id);
  }
}
export function getImportStatus() {
  reconcileImportJobs();
  const sources = SOURCE_FILES.map(name => ({ name, available: fs.existsSync(/* turbopackIgnore: true */ path.join(os.homedir(), 'Downloads', name)) }));
  const imports = sourceStatus('work')!.items.map(row => ({ id: row.id, file_name: row.fileName, kind: row.kind, status: row.status, rows_read: row.rowsRead, rows_kept: row.rowsKept,
    imported_at: row.importedAt, period: JSON.stringify(row.period), is_current: row.isCurrent, report: { quality: row.quality, counters: row.counters, progress: row.progress,questions:row.questions }, error: row.error }));
  const jobs = all('SELECT id,file_name,status,started_at,completed_at,error FROM import_jobs ORDER BY started_at DESC LIMIT 30');
  return { sources, imports, jobs };
}
export function importArguments(filePath: string, displayName: string, targetDb = databasePath) {
  const kind = sourceKind(displayName);
  if (!kind) throw new Error('Неизвестный источник. Сохраните исходное название одной из поддерживаемых книг.');
  return [appPath('scripts', 'import_xlsx.py'), '--file', filePath, '--kind', kind, '--db', targetDb];
}
async function hashFile(filePath: string) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(/* turbopackIgnore: true */ filePath)) hash.update(chunk);
  return hash.digest('hex');
}
export function launchImport(filePath: string, displayName: string) {
  const args = importArguments(filePath, displayName);
  if (!fs.existsSync(/* turbopackIgnore: true */ appPath('scripts', 'import_xlsx.py'))) throw new Error('Модуль импорта ещё подготавливается.');
  if (!fs.statSync(/* turbopackIgnore: true */ filePath).isFile()) throw new Error('Выберите файл XLSX.');
  reconcileImportJobs();
  const id = randomUUID();
  const ownerIdentity = processIdentity(process.pid);
  db().transaction(() => {
    if (db().prepare("SELECT id FROM import_jobs WHERE status='running'").get()) throw new Error('Дождитесь завершения текущего импорта.');
    db().prepare('INSERT INTO import_jobs(id,file_name,status,started_at,owner_pid,owner_identity) VALUES(?,?,?,?,?,?)').run(id, canonicalSourceName(displayName), 'running', new Date().toISOString(), process.pid, ownerIdentity);
  }).immediate();
  runtime.active.add(id);
  let settled = false;
  const finish = (success: boolean) => {
    if (settled) return;
    settled = true;
    runtime.active.delete(id);
    db().prepare("UPDATE import_jobs SET status=?,completed_at=?,error=? WHERE id=? AND status='running'").run(success ? 'complete' : 'error', new Date().toISOString(), success ? null : 'Файл не обработан полностью: проверьте формат и заголовки.', id);
  };
  // Hash asynchronously, persist it, then start an independent worker. A new
  // server can recognize a still-running worker or a committed completed hash.
  void hashFile(filePath).then(hash => {
    db().prepare('UPDATE import_jobs SET source_hash=? WHERE id=?').run(hash, id);
    const bundled = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3');
    const python = process.env.ATLAS_PYTHON || (fs.existsSync(/* turbopackIgnore: true */ bundled) ? bundled : 'python3');
    const child = spawn(python, args, { cwd: appRoot, stdio: 'ignore', detached: process.platform !== 'win32' });
    child.once('spawn', () => {
      db().prepare('UPDATE import_jobs SET worker_pid=?,worker_identity=? WHERE id=?').run(child.pid ?? null, child.pid ? processIdentity(child.pid) : null, id);
      child.unref();
    });
    child.once('error', () => finish(false));
    child.once('close', code => finish(code === 0));
  }).catch(() => finish(false));
  return { id, status: 'running' };
}
export function launchKnownImport(fileName: string) {
  if (!SOURCE_FILES.includes(fileName)) throw new Error('Выберите файл из списка источников.');
  const filePath = path.join(os.homedir(), 'Downloads', fileName);
  if (!fs.existsSync(/* turbopackIgnore: true */ filePath)) throw new Error('Файл не найден в папке загрузок.');
  return launchImport(filePath, fileName);
}
export function uploadDirectory() {
  const dir = path.join(privateDirectory, 'uploads');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
